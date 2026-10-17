import type {
  ContentError,
  ExecuteReport,
  PanelRequest,
  PanelState,
  ReadPageResponse,
  TabInfo,
  UndoReport,
} from '../types/messages';
import type { ActionPlan, UndoRecord } from '../types/plan';
import { DeepSeekClient } from '../lib/deepseek/client';
import { SessionStore } from '../lib/storage/session';
import { SettingsStore } from '../lib/storage/settings';
import { AgentController, type ContentGateway } from './controller';

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

function mapTab(tab: chrome.tabs.Tab | undefined): TabInfo | null {
  if (!tab || typeof tab.id !== 'number') return null;
  return {
    id: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
  };
}

async function sendToTab<T>(tabId: number, message: unknown, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('与页面脚本通信超时')), timeoutMs);
  });
  const response = await Promise.race([
    chrome.tabs.sendMessage(tabId, message) as Promise<T>,
    timeout,
  ]);
  if (!response) throw new Error('页面脚本没有返回结果');
  return response;
}

const content: ContentGateway = {
  async ensure(tabId) {
    try {
      const pong = await sendToTab<{ ok?: boolean }>(
        tabId,
        { channel: 'DBA', type: 'PING' },
        800,
      );
      if (pong?.ok) return;
    } catch {
      // Inject below.
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    const pong = await sendToTab<{ ok?: boolean }>(tabId, { channel: 'DBA', type: 'PING' }, 2000);
    if (!pong?.ok) throw new Error('页面脚本注入失败');
  },

  async read(tabId) {
    try {
      return await sendToTab<ReadPageResponse | { ok: false; error: ContentError }>(
        tabId,
        { channel: 'DBA', type: 'READ_PAGE' },
        20_000,
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: error instanceof Error ? error.message : '读取页面失败',
        },
      };
    }
  },

  async execute(tabId: number, plan: ActionPlan) {
    try {
      return await sendToTab<ExecuteReport>(
        tabId,
        { channel: 'DBA', type: 'EXECUTE_PLAN', plan },
        45_000,
      );
    } catch (error) {
      return {
        ok: false,
        stale: false,
        results: [],
        undo: [],
        error: error instanceof Error ? error.message : '执行页面操作失败',
      };
    }
  },

  async undo(tabId: number, records: UndoRecord[]) {
    try {
      return await sendToTab<UndoReport>(
        tabId,
        { channel: 'DBA', type: 'UNDO', records },
        30_000,
      );
    } catch (error) {
      return {
        ok: false,
        results: [],
        error: error instanceof Error ? error.message : '撤销失败',
      };
    }
  },
};

const controller = new AgentController({
  tabs: {
    async getActive() {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return mapTab(tabs[0]);
    },
    async get(tabId) {
      try {
        return mapTab(await chrome.tabs.get(tabId));
      } catch {
        return null;
      }
    },
  },
  content,
  permissions: {
    async hasPattern(pattern) {
      return chrome.permissions.contains({ origins: [pattern] });
    },
  },
  settings: new SettingsStore(chrome.storage.local),
  session: new SessionStore(chrome.storage.session),
  deepseek: new DeepSeekClient(),
  broadcast(state: PanelState) {
    void chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => undefined);
  },
});

const ready = controller.init();

function isTrustedPanelSender(sender: chrome.runtime.MessageSender): boolean {
  const prefix = chrome.runtime.getURL('');
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(prefix));
}

function isPanelRequest(value: unknown): value is PanelRequest {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    typeof type === 'string' &&
    [
      'GET_STATE',
      'SAVE_SETTINGS',
      'TEST_CONNECTION',
      'ANALYZE_PAGE',
      'CAPTURE_TAB',
      'CHAT',
      'APPROVE_PLAN',
      'REJECT_PLAN',
      'CANCEL_REQUEST',
      'UNDO',
      'CLEAR_CHAT',
      'DISMISS_ERROR',
    ].includes(type)
  );
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTrustedPanelSender(sender) || !isPanelRequest(message)) return false;
  ready
    .then(async () => {
      if (message.type === 'CAPTURE_TAB') {
        try {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const tab = tabs[0];
          if (!tab || typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
            return {
              ok: false,
              error: { code: 'no_active_tab', message: '没有找到可截图的当前标签页' },
            };
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          return { ok: true, data: { dataUrl } };
        } catch (error) {
          const raw = error instanceof Error ? error.message : '';
          return {
            ok: false,
            error: {
              code: 'capture_failed',
              message: /activeTab|all_urls|capture/i.test(raw)
                ? '当前标签页没有临时截图权限。请点击扩展图标重新打开侧边栏后再截图。'
                : `截图失败：${raw || '请确认当前页面允许扩展访问'}`,
            },
          };
        }
      }
      return controller.handle(message);
    })
    .then((result) => sendResponse(result))
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : '扩展内部错误',
        },
      });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    void controller.handleTabLoading(tabId, changeInfo.url ?? tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void controller.handleTabRemoved(tabId);
});

chrome.tabs.onActivated.addListener(() => {
  void controller.broadcastState();
});
