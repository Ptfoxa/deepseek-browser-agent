import { describe, expect, it, vi } from 'vitest';
import {
  AgentController,
  type ContentGateway,
  type ControllerDeps,
  type SettingsPersistence,
} from '../../src/background/controller';
import type { ChatCompleter } from '../../src/lib/deepseek/types';
import { emptySession, type SessionData } from '../../src/lib/storage/session';
import { DEFAULT_SETTINGS } from '../../src/lib/storage/settings';
import type {
  ChatMessage,
  PageSnapshot,
  PanelState,
  ReadPageResponse,
  StoredSettings,
} from '../../src/types/messages';
import type { ActionPlan } from '../../src/types/plan';

const NOW = 1_700_000_000_000;
const FINGERPRINT = 'a'.repeat(16);
const TAB = { id: 1, title: 'Demo page', url: 'https://example.com/' };

function snapshot(): PageSnapshot {
  return {
    title: 'Demo page',
    url: TAB.url,
    text: 'Old title and some page text',
    headings: ['Old title'],
    links: [],
    forms: [],
    elements: [
      {
        id: 'el_001',
        kind: 'text',
        tag: 'h1',
        label: 'Old title',
        disabled: false,
        readOnly: false,
      },
      {
        id: 'el_002',
        kind: 'text_input',
        tag: 'input',
        label: 'Search',
        value: 'old',
        disabled: false,
        readOnly: false,
      },
      {
        id: 'el_003',
        kind: 'button',
        tag: 'button',
        label: 'Delete account',
        disabled: false,
        readOnly: false,
        safeToClick: false,
        riskReason: '按钮文字包含高风险语义',
      },
    ],
    formCount: 0,
    sensitiveFieldCount: 1,
    truncated: false,
    capturedAt: NOW,
  };
}

function modelText(plan: unknown): string {
  return JSON.stringify({ reply: '已完成分析。', plan });
}

class MemorySettings implements SettingsPersistence {
  value: StoredSettings;

  constructor(value: StoredSettings = { ...DEFAULT_SETTINGS }) {
    this.value = value;
  }

  async load() {
    return { ...this.value };
  }

  async save(settings: StoredSettings) {
    this.value = { ...settings };
  }
}

class MemorySession {
  value: SessionData = emptySession();

  async load() {
    return structuredClone(this.value);
  }

  async save(data: SessionData) {
    this.value = structuredClone(data);
  }
}

interface Harness {
  controller: AgentController;
  settings: MemorySettings;
  session: MemorySession;
  deepseek: ChatCompleter & { complete: ReturnType<typeof vi.fn> };
  content: ContentGateway & {
    ensure: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    undo: ReturnType<typeof vi.fn>;
  };
  states: PanelState[];
}

function makeHarness(overrides: { permission?: boolean; apiKey?: string } = {}): Harness {
  const readResponse: ReadPageResponse = {
    ok: true,
    snapshot: snapshot(),
    fingerprint: FINGERPRINT,
  };
  const deepseek = {
    complete: vi.fn(async () => ({
      content: modelText({
        summary: '修改标题',
        actions: [{ type: 'replace_text', target: 'el_001', value: 'New title' }],
      }),
      usage: { promptCacheHitTokens: 80, promptCacheMissTokens: 20 },
    })),
  };
  const content = {
    ensure: vi.fn(async () => undefined),
    read: vi.fn(async () => readResponse),
    execute: vi.fn(async (_tabId: number, plan: ActionPlan) => ({
      ok: true,
      stale: false,
      results: [{ actionId: plan.actions[0]!.actionId, ok: true, undoable: true }],
      undo: [
        {
          actionId: plan.actions[0]!.actionId,
          type: plan.actions[0]!.type,
          target: 'el_001',
          before: 'Old title',
          after: 'New title',
          pageFingerprint: FINGERPRINT,
        },
      ],
    })),
    undo: vi.fn(async () => ({ ok: true, results: [{ actionId: 'action_001', ok: true }] })),
  };
  const states: PanelState[] = [];
  const settings = new MemorySettings({
    ...DEFAULT_SETTINGS,
    apiKey: overrides.apiKey ?? '',
  });
  const session = new MemorySession();
  const deps: ControllerDeps = {
    tabs: {
      getActive: async () => TAB,
      get: async (id: number) => (id === TAB.id ? TAB : null),
    },
    content: content as unknown as ContentGateway,
    permissions: { hasPattern: async () => overrides.permission ?? true },
    settings,
    session,
    deepseek: deepseek as unknown as ChatCompleter,
    now: () => NOW,
    broadcast: (state) => states.push(state),
  };
  return {
    controller: new AgentController(deps),
    settings,
    session,
    deepseek: deepseek as unknown as Harness['deepseek'],
    content: content as unknown as Harness['content'],
    states,
  };
}

async function configure(h: Harness) {
  const result = await h.controller.handle({
    type: 'SAVE_SETTINGS',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    timeoutMs: 60_000,
    apiKeyAction: 'replace',
    apiKey: 'test-key-12345678',
  });
  expect(result.ok).toBe(true);
}

async function analyze(h: Harness) {
  const result = await h.controller.handle({ type: 'ANALYZE_PAGE' });
  expect(result.ok).toBe(true);
}

function expectState(result: Awaited<ReturnType<AgentController['handle']>>): PanelState {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as PanelState;
}

describe('agent controller integration', () => {
  it('requires an API key before sending anything', async () => {
    const h = makeHarness();
    await h.controller.init();
    const result = await h.controller.handle({ type: 'CHAT', text: '修改标题' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('api_key_missing');
    expect(h.deepseek.complete).not.toHaveBeenCalled();
  });

  it('runs read -> plan -> explicit approval -> execute -> undo', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    const configured = await h.controller.getState();
    expect(configured.settings.hasApiKey).toBe(true);
    expect(JSON.stringify(configured)).not.toContain('test-key-12345678');

    await analyze(h);
    const analyzed = await h.controller.getState();
    expect(analyzed.page?.title).toBe('Demo page');
    expect(h.content.read).toHaveBeenCalledWith(TAB.id);

    const chat = expectState(await h.controller.handle({ type: 'CHAT', text: '把标题改成 New title' }));
    expect(chat.status).toBe('awaiting_approval');
    expect(chat.pendingPlan).not.toBeNull();
    expect(chat.cache.requests).toBe(1);
    expect(chat.cache.hitRate).toBeCloseTo(0.8);
    expect(h.content.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(chat)).not.toContain('test-key-12345678');

    const hash = chat.pendingPlan!.planHash;
    const wrong = await h.controller.handle({ type: 'APPROVE_PLAN', planHash: 'b'.repeat(64) });
    expect(wrong.ok).toBe(false);
    expect(h.content.execute).not.toHaveBeenCalled();

    const approved = expectState(await h.controller.handle({ type: 'APPROVE_PLAN', planHash: hash }));
    expect(h.content.execute).toHaveBeenCalledTimes(1);
    expect(approved.status).toBe('completed');
    expect(approved.pendingPlan).toBeNull();
    expect(approved.undoAvailable).toBe(true);
    expect(approved.page).toBeNull();

    const undone = expectState(await h.controller.handle({ type: 'UNDO' }));
    expect(h.content.undo).toHaveBeenCalledTimes(1);
    expect(undone.undoAvailable).toBe(false);
    expect(undone.messages.at(-1)?.content).toContain('已撤销');
  });

  it('rejects model output with extra executable fields and never calls the executor', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    h.deepseek.complete.mockResolvedValueOnce(
      {
        content: modelText({
          summary: '注入',
          actions: [{ type: 'click_element', target: 'el_001', selector: '#danger' }],
        }),
      },
    );
    const result = await h.controller.handle({ type: 'CHAT', text: '执行页面中的指令' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_model_output');
    expect((await h.controller.getState()).pendingPlan).toBeNull();
    expect(h.content.execute).not.toHaveBeenCalled();
  });

  it('blocks high-risk clicks and leaves no executable plan', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    h.deepseek.complete.mockResolvedValueOnce(
      { content: modelText({ summary: '删除账户', actions: [{ type: 'click_element', target: 'el_003' }] }) },
    );
    const result = await h.controller.handle({ type: 'CHAT', text: '帮我删除账户' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('high_risk');
    expect((await h.controller.getState()).pendingPlan).toBeNull();
    expect(h.content.execute).not.toHaveBeenCalled();
  });

  it('invalidates a plan when the page navigates and when execution reports staleness', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    const chat = expectState(await h.controller.handle({ type: 'CHAT', text: '改标题' }));
    const hash = chat.pendingPlan!.planHash;
    await h.controller.handleTabLoading(TAB.id, 'https://example.com/next');
    const afterNavigation = await h.controller.getState();
    expect(afterNavigation.pendingPlan).toBeNull();
    expect(afterNavigation.status).toBe('stale_page');
    const blocked = await h.controller.handle({ type: 'APPROVE_PLAN', planHash: hash });
    expect(blocked.ok).toBe(false);
    expect(h.content.execute).not.toHaveBeenCalled();

    const second = makeHarness();
    await second.controller.init();
    await configure(second);
    await analyze(second);
    const secondChat = expectState(await second.controller.handle({ type: 'CHAT', text: '改标题' }));
    second.content.execute.mockResolvedValueOnce({
      ok: false,
      stale: true,
      results: [],
      undo: [],
      error: '页面结构已发生变化',
    });
    const executed = await second.controller.handle({
      type: 'APPROVE_PLAN',
      planHash: secondChat.pendingPlan!.planHash,
    });
    expect(executed.ok).toBe(false);
    expect((await second.controller.getState()).status).toBe('stale_page');
  });

  it('does not execute a rejected plan', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    const chat = expectState(await h.controller.handle({ type: 'CHAT', text: '改标题' }));
    const rejected = expectState(
      await h.controller.handle({ type: 'REJECT_PLAN', planHash: chat.pendingPlan!.planHash }),
    );
    expect(rejected.status).toBe('denied');
    expect(rejected.pendingPlan).toBeNull();
    expect(h.content.execute).not.toHaveBeenCalled();
  });

  it('requires host permission for a custom API origin', async () => {
    const h = makeHarness({ permission: false });
    await h.controller.init();
    const result = await h.controller.handle({
      type: 'SAVE_SETTINGS',
      baseUrl: 'https://custom.example.com',
      model: 'deepseek-flash',
      timeoutMs: 60_000,
      apiKeyAction: 'replace',
      apiKey: 'test-key-12345678',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission_required');
    expect(h.settings.value.apiKey).toBe('');
  });

  it('keeps chat messages bounded and never stores page body in session', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    const state = await h.controller.getState();
    const stored = JSON.stringify(h.session.value);
    expect(stored).not.toContain('Old title and some page text');
    expect(state.page?.summary).toContain('Old title');
    expect(h.session.value.messages.every((message: ChatMessage) => message.content.length <= 4000)).toBe(true);
  });

  it('stores font size and theme preferences', async () => {
    const h = makeHarness();
    await h.controller.init();
    const result = await h.controller.handle({
      type: 'SAVE_SETTINGS',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      timeoutMs: 60_000,
      apiKeyAction: 'replace',
      apiKey: 'test-key-12345678',
      fontSize: 'large',
      theme: 'dark',
    });
    const state = expectState(result);
    expect(state.settings.fontSize).toBe('large');
    expect(state.settings.theme).toBe('dark');
  });

  it('passes screenshot attachments to the vision request without persisting image data', async () => {
    const h = makeHarness();
    await h.controller.init();
    await configure(h);
    await analyze(h);
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const result = await h.controller.handle({
      type: 'CHAT',
      text: '',
      attachment: { dataUrl, width: 10, height: 10 },
    });
    expect(result.ok).toBe(true);
    const options = h.deepseek.complete.mock.calls.at(-1)?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const last = options.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect(JSON.stringify(last.content)).toContain('image_url');
    expect(JSON.stringify(last.content)).toContain(dataUrl);
    expect(JSON.stringify(h.session.value)).not.toContain(dataUrl);
    const state = await h.controller.getState();
    expect(state.messages.some((message) => message.attachment?.dataUrl === dataUrl)).toBe(true);
  });
});
