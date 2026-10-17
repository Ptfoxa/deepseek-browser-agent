import { expect, test } from '@playwright/test';
import { chromium, type BrowserContext } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fixture title</title></head>
  <body>
    <h1>Fixture heading</h1>
    <p>Visible paragraph for the extension reader.</p>
    <input id="secret" type="password" value="E2E-SECRET-PASSWORD" aria-label="Password">
    <input type="email" value="e2e@example.com" aria-label="Email">
    <input aria-label="Search" value="old query">
    <button>Open settings</button>
  </body>
</html>`;

let context: BrowserContext;
let server: Server;
let extensionId: string;
let fixtureUrl: string;
let apiBaseUrl: string;
let nextModelPlan: unknown = null;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/chat/completions') {
      request.on('data', () => undefined);
      request.on('end', () => {
        const payload = {
          reply: '计划已生成，请核对预览。',
          plan: nextModelPlan,
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(payload) } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              prompt_cache_hit_tokens: 80,
              prompt_cache_miss_tokens: 20,
            },
          }),
        );
      });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixtureUrl = `${origin}/fixture`;
  apiBaseUrl = origin;

  const dist = resolve(import.meta.dirname, '../../dist');
  // The production manifest intentionally omits permanent localhost access. For the
  // browser fixture only, copy the built extension and grant the fixture origin.
  const testDist = resolve(import.meta.dirname, '../../test-results/e2e-dist');
  await rm(testDist, { recursive: true, force: true });
  await mkdir(testDist, { recursive: true });
  await cp(dist, testDist, { recursive: true });
  const manifestPath = resolve(testDist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push('http://127.0.0.1/*');
  // captureVisibleTab needs activeTab or <all_urls>; grant only in the test copy.
  manifest.host_permissions.push('<all_urls>');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--disable-default-apps',
    ],
  });
  const browser = context.browser();
  if (!browser) throw new Error('Chromium browser handle is unavailable');
  const session = await browser.newBrowserCDPSession();
  const loaded = (await session.send('Extensions.loadUnpacked', {
    path: testDist,
  })) as { id: string };
  extensionId = loaded.id;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

async function openPanel() {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.locator('.app')).toBeVisible();
  return panel;
}

test('loads the MV3 extension and side panel UI', async () => {
  const panel = await openPanel();
  await expect(panel.getByRole('heading', { name: 'DeepSeek Browser', exact: true })).toBeVisible();
  await expect(panel.getByText('当前目标标签页')).toBeVisible();
  const hasKey = await panel.evaluate(async () => {
    const response = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as {
      ok: boolean;
      data?: { settings?: { hasApiKey?: boolean } };
    };
    return response.data?.settings?.hasApiKey;
  });
  expect(typeof hasKey).toBe('boolean');
});

test('reads a real page through the service worker and filters sensitive values', async () => {
  const readUrl = `${fixtureUrl}?case=read`;
  const fixturePage = await context.newPage();
  await fixturePage.goto(readUrl);
  await expect(fixturePage).toHaveTitle('Fixture title');
  const panel = await openPanel();

  const tabId = await panel.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id) throw new Error('fixture tab not found');
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, readUrl);

  const analyzed = await panel.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE' });
  });
  expect(analyzed.ok).toBe(true);
  expect(analyzed.data.page.title).toContain('Fixture title');
  await expect(panel.getByText('Fixture title').first()).toBeVisible();

  const read = await panel.evaluate(
    async (id: number) => chrome.tabs.sendMessage(id, { channel: 'DBA', type: 'READ_PAGE' }),
    tabId,
  );
  expect(read.ok).toBe(true);
  const serialized = JSON.stringify(read.snapshot);
  expect(serialized.includes('E2E-SECRET-PASSWORD')).toBe(false);
  expect(serialized.includes('e2e@example.com')).toBe(false);
  expect(read.snapshot.sensitiveFieldCount).toBeGreaterThanOrEqual(2);
  expect(read.snapshot.elements.some((element: { label: string }) => element.label === 'Search')).toBe(true);

  const missing = await panel.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
  });
  expect(missing.ok).toBe(false);
  expect(missing.error.code).toBe('api_key_missing');
});

test('analyzes the active page from the side-panel button', async () => {
  const analyzeUrl = `${fixtureUrl}?case=button`;
  const fixturePage = await context.newPage();
  await fixturePage.goto(analyzeUrl);
  const panel = await openPanel();
  await panel.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  }, analyzeUrl);
  await panel.locator('.analyze-button').dispatchEvent('click');
  await expect(panel.getByText('页面摘要')).toBeVisible();
});

test('saves and deletes the API key without exposing it to the UI state', async () => {
  const panel = await openPanel();
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.locator('button[title="设置"]').click();
  await expect(panel.getByText('会发送给 DeepSeek 的内容')).toBeVisible();
  await panel.getByRole('button', { name: '大', exact: true }).click();
  await panel.getByRole('button', { name: '夜间', exact: true }).click();
  await panel.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(panel.locator('.notice.ok')).toContainText('设置已保存');
  expect(await panel.evaluate(() => document.documentElement.dataset.fontSize)).toBe('large');
  expect(await panel.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await panel.screenshot({ path: 'test-results/sidepanel-settings.png', fullPage: true });
  const fakeKey = 'test-key-e2e-12345678';
  const saved = await panel.evaluate(async (key: string) => {
    return chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      timeoutMs: 60000,
      apiKeyAction: 'replace',
      apiKey: key,
    });
  }, fakeKey);
  expect(saved.ok).toBe(true);
  expect(saved.data.settings.hasApiKey).toBe(true);
  expect(JSON.stringify(saved.data).includes(fakeKey)).toBe(false);

  const deleted = await panel.evaluate(async () => {
    return chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      timeoutMs: 60000,
      apiKeyAction: 'delete',
    });
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.data.settings.hasApiKey).toBe(false);
});

test('captures the current tab as a PNG for the screenshot tool', async () => {
  const captureUrl = `${fixtureUrl}?case=capture`;
  const fixturePage = await context.newPage();
  await fixturePage.goto(captureUrl);
  const panel = await openPanel();
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  }, captureUrl);
  const result = await panel.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }),
  );
  expect(result.ok, result.error?.message).toBe(true);
  expect(result.data.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(result.data.dataUrl.length).toBeGreaterThan(1000);
});

test('opens the crop modal and attaches a selected screenshot', async () => {
  const captureUrl = `${fixtureUrl}?case=crop`;
  const fixturePage = await context.newPage();
  await fixturePage.goto(captureUrl);
  const panel = await openPanel();
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  }, captureUrl);
  await panel.getByRole('button', { name: '截图当前标签页' }).click();
  await expect(panel.getByText('框选截图')).toBeVisible();
  await panel.screenshot({ path: 'test-results/screenshot-crop.png', fullPage: false });
  await panel.getByRole('button', { name: '选择整个画面' }).click();
  await panel.waitForTimeout(300);
  await panel.getByRole('button', { name: '使用选中截图' }).click();
  await expect(panel.getByText('当前标签页截图')).toBeVisible();
});

test('executes an approved plan against the real DOM and restores it with undo', async () => {
  const executeUrl = `${fixtureUrl}?case=execute`;
  const fixturePage = await context.newPage();
  await fixturePage.goto(executeUrl);
  const panel = await openPanel();

  const tabId = await panel.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id) throw new Error('fixture tab not found');
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, executeUrl);

  const configured = await panel.evaluate(
    async (baseUrl: string) =>
      chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        baseUrl,
        model: 'deepseek-flash',
        timeoutMs: 30000,
        apiKeyAction: 'replace',
        apiKey: 'test-key-e2e-12345678',
        fontSize: 'medium',
        theme: 'light',
      }),
    apiBaseUrl,
  );
  expect(configured.ok).toBe(true);
  const connection = await panel.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }),
  );
  expect(connection.ok).toBe(true);
  expect(connection.data.model).toBe('deepseek-flash');

  const analyzed = await panel.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE' }),
  );
  expect(analyzed.ok).toBe(true);
  const read = await panel.evaluate(
    async (id: number) => chrome.tabs.sendMessage(id, { channel: 'DBA', type: 'READ_PAGE' }),
    tabId,
  );
  const title = read.snapshot.elements.find((element: { kind: string }) => element.kind === 'text');
  expect(title).toBeTruthy();

  nextModelPlan = {
    summary: '修改页面主标题',
    actions: [{ type: 'replace_text', target: title.id, value: 'Updated heading' }],
  };
  const chat = await panel.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'CHAT', text: '把主标题改成 Updated heading' }),
  );
  expect(chat.ok).toBe(true);
  expect(chat.data.status).toBe('awaiting_approval');
  expect(chat.data.pendingPlan).toBeTruthy();
  expect(await fixturePage.locator('h1').textContent()).toBe('Fixture heading');
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.screenshot({ path: 'test-results/sidepanel-plan.png', fullPage: true });

  const approved = await panel.evaluate(
    async (hash: string) =>
      chrome.runtime.sendMessage({ type: 'APPROVE_PLAN', planHash: hash }),
    chat.data.pendingPlan.planHash,
  );
  expect(approved.ok).toBe(true);
  expect(approved.data.status).toBe('completed');
  expect(await fixturePage.locator('h1').textContent()).toBe('Updated heading');
  await expect(panel.getByText('缓存命中率')).toBeVisible();
  await expect(panel.getByText('80%')).toBeVisible();

  const undone = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'UNDO' }));
  expect(undone.ok).toBe(true);
  expect(await fixturePage.locator('h1').textContent()).toBe('Fixture heading');

  await panel.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      timeoutMs: 60000,
      apiKeyAction: 'delete',
    }),
  );
});

test('rejects browser-internal pages without injecting scripts', async () => {
  const internal = await context.newPage();
  await internal.goto('chrome://version');
  const panel = await openPanel();
  const result = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url?.startsWith('chrome://version'));
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
    return chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE' });
  });
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe('unsupported_page');
});
