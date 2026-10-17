import type {
  ChatMessage,
  CacheStats,
  ContentError,
  ExecuteReport,
  FontSize,
  ImageAttachment,
  PagePreview,
  PageSnapshot,
  PanelError,
  PanelRequest,
  PanelState,
  ReadPageResponse,
  StoredSettings,
  TabInfo,
  TaskStatus,
  ThemeMode,
  UndoReport,
} from '../types/messages';
import type {
  ActionPlan,
  UndoRecord,
} from '../types/plan';
import { PageFingerprintSchema } from '../types/plan';
import {
  DeepSeekError,
  describeDeepSeekError,
  hostPermissionPattern,
  normalizeBaseUrl,
} from '../lib/deepseek/client';
import type { ChatCompleter, CompletionResult } from '../lib/deepseek/types';
import { buildPlan, PlanBuildError } from '../lib/planner/build-plan';
import { ModelOutputError, parseModelOutput } from '../lib/planner/parse';
import { buildChatMessages } from '../lib/planner/prompt';
import { approvalMatches, createApproval, hashPlan } from '../lib/security/approval';
import { redactSecrets } from '../lib/security/sanitize';
import { normalizeText, truncate } from '../lib/page/extract';
import type { SessionData, UndoBundle } from '../lib/storage/session';
import { emptySession } from '../lib/storage/session';
import { DEFAULT_SETTINGS, toPublicSettings } from '../lib/storage/settings';

export interface TabGateway {
  getActive(): Promise<TabInfo | null>;
  get(tabId: number): Promise<TabInfo | null>;
}

export interface ContentGateway {
  ensure(tabId: number): Promise<void>;
  read(tabId: number): Promise<ReadPageResponse | { ok: false; error: ContentError }>;
  execute(tabId: number, plan: ActionPlan): Promise<ExecuteReport>;
  undo(tabId: number, records: UndoRecord[]): Promise<UndoReport>;
}

export interface PermissionGateway {
  hasPattern(pattern: string): Promise<boolean>;
}

export interface SettingsPersistence {
  load(): Promise<StoredSettings>;
  save(settings: StoredSettings): Promise<void>;
}

export interface SessionPersistence {
  load(): Promise<SessionData>;
  save(data: SessionData): Promise<void>;
}

export interface ControllerDeps {
  tabs: TabGateway;
  content: ContentGateway;
  permissions: PermissionGateway;
  settings: SettingsPersistence;
  session: SessionPersistence;
  deepseek: ChatCompleter;
  now?: () => number;
  broadcast?: (state: PanelState) => void;
}

interface PageContext {
  tabId: number;
  url: string;
  fingerprint: string;
  snapshot: PageSnapshot;
}

interface ConnectionTestResult {
  message: string;
  model: string;
  latencyMs: number;
}

export type ControllerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PanelError };

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: '就绪',
  reading: '正在读取网页',
  planning: 'DeepSeek 正在规划',
  awaiting_approval: '等待你的授权',
  executing: '正在执行',
  verifying: '正在校验结果',
  completed: '已完成',
  denied: '已拒绝',
  cancelled: '已取消',
  failed: '操作失败',
  stale_page: '页面已变化',
  permission_required: '需要额外权限',
};

const UNSUPPORTED_PREFIXES = [
  'chrome://',
  'chrome-untrusted://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-extension://',
  'file://',
  'data:',
  'blob:',
  'javascript:',
];

const WEB_STORE_URLS = ['https://chromewebstore.google.com', 'https://chrome.google.com/webstore'];

const FONT_SIZES = new Set<FontSize>(['small', 'medium', 'large']);
const THEMES = new Set<ThemeMode>(['light', 'dark', 'system']);
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Partial<ImageAttachment>;
  return (
    typeof attachment.dataUrl === 'string' &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(attachment.dataUrl) &&
    attachment.dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH &&
    Number.isInteger(attachment.width) &&
    Number.isInteger(attachment.height) &&
    (attachment.width ?? 0) > 0 &&
    (attachment.height ?? 0) > 0 &&
    (attachment.width ?? 0) <= 8192 &&
    (attachment.height ?? 0) <= 8192
  );
}

export function unsupportedPageReason(url: string | undefined | null): string | null {
  if (!url) return '无法读取当前标签页地址，请先切换到普通网页。';
  const lower = url.toLowerCase();
  if (UNSUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return '该页面属于浏览器内部页面或受限页面，Chrome 不允许扩展读取。请切换到普通网页。';
  }
  if (WEB_STORE_URLS.some((prefix) => lower.startsWith(prefix))) {
    return 'Chrome 应用商店页面不允许扩展注入脚本，请切换到其他网页。';
  }
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return '仅支持 http/https 普通网页。';
  }
  return null;
}

function summarizeSnapshot(snapshot: PageSnapshot): string {
  const text = normalizeText(snapshot.text);
  if (!text) return '页面没有可读的正文文本（可能是应用界面或空页面）。';
  return truncate(text, 320);
}

function previewFromSnapshot(snapshot: PageSnapshot, fingerprint: string): PagePreview {
  return {
    title: snapshot.title || '（无标题）',
    url: snapshot.url,
    textLength: snapshot.text.length,
    summary: summarizeSnapshot(snapshot),
    headingCount: snapshot.headings.length,
    linkCount: snapshot.links.length,
    elementCount: snapshot.elements.length,
    formCount: snapshot.formCount,
    sensitiveFieldCount: snapshot.sensitiveFieldCount,
    truncated: snapshot.truncated,
    readAt: snapshot.capturedAt,
    fingerprint,
  };
}

export class AgentController {
  private deps: ControllerDeps;
  private settings: StoredSettings = { ...DEFAULT_SETTINGS };
  private session: SessionData = emptySession();
  private pageContext: PageContext | null = null;
  private pagePreview: PagePreview | null = null;
  private status: TaskStatus = 'idle';
  private lastError: PanelError | null = null;
  private busy = false;
  private abortController: AbortController | null = null;
  private cancelRequested = false;
  private lastRequestAt = 0;
  private cacheHitTokens = 0;
  private cacheMissTokens = 0;
  private cacheRequests = 0;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async init(): Promise<void> {
    this.settings = await this.deps.settings.load();
    this.session = await this.deps.session.load();
    this.status = this.session.pendingPlan ? 'awaiting_approval' : 'idle';
    this.pageContext = null;
    this.pagePreview = null;
  }

  private appendMessage(
    role: ChatMessage['role'],
    content: string,
    kind: ChatMessage['kind'],
    attachment?: ImageAttachment,
  ): void {
    const safeContent = redactSecrets(content).slice(0, 4000);
    if (attachment) {
      const withImages = this.session.messages.filter((message) => message.attachment);
      if (withImages.length >= 3) delete withImages[0]!.attachment;
    }
    this.session.messages.push({
      id: `msg_${globalThis.crypto.randomUUID().slice(0, 12)}`,
      role,
      content: safeContent,
      at: this.now(),
      kind,
      ...(attachment ? { attachment } : {}),
    });
    if (this.session.messages.length > 80) {
      this.session.messages = this.session.messages.slice(-80);
    }
  }

  private setError(code: string, message: string): PanelError {
    const error = { code, message: redactSecrets(message).slice(0, 500) };
    this.lastError = error;
    return error;
  }

  private async flush(): Promise<void> {
    try {
      const persisted = {
        ...this.session,
        messages: this.session.messages.map((message) => {
          const copy = { ...message };
          delete copy.attachment;
          return copy;
        }),
      };
      await this.deps.session.save(persisted);
    } catch {
      // A failed session write must not turn a completed page action into a second mutation.
    }
    if (!this.deps.broadcast) return;
    try {
      this.deps.broadcast(await this.getState());
    } catch {
      // Panel may be closed.
    }
  }

  async getState(): Promise<PanelState> {
    let activeTab: TabInfo | null = null;
    try {
      activeTab = await this.deps.tabs.getActive();
    } catch {
      activeTab = null;
    }
    const cacheTotal = this.cacheHitTokens + this.cacheMissTokens;
    const cache: CacheStats = {
      hitTokens: this.cacheHitTokens,
      missTokens: this.cacheMissTokens,
      hitRate: cacheTotal > 0 ? this.cacheHitTokens / cacheTotal : null,
      requests: this.cacheRequests,
    };
    return {
      status: this.status,
      statusText: STATUS_TEXT[this.status],
      settings: toPublicSettings(this.settings),
      activeTab,
      page: this.pagePreview,
      messages: this.session.messages,
      pendingPlan: this.session.pendingPlan,
      undoAvailable: Boolean(this.session.undo?.records.length),
      undoCount: this.session.undo?.records.length ?? 0,
      lastError: this.lastError,
      busy: this.busy,
      cache,
    };
  }

  private recordUsage(usage: CompletionResult['usage']): void {
    if (
      !usage ||
      (usage.promptCacheHitTokens === undefined && usage.promptCacheMissTokens === undefined)
    ) {
      return;
    }
    this.cacheHitTokens += usage.promptCacheHitTokens ?? 0;
    this.cacheMissTokens += usage.promptCacheMissTokens ?? 0;
    this.cacheRequests += 1;
  }

  async broadcastState(): Promise<void> {
    if (!this.deps.broadcast) return;
    try {
      this.deps.broadcast(await this.getState());
    } catch {
      // No panel is listening.
    }
  }

  async handleTabLoading(tabId: number, url?: string): Promise<void> {
    let changed = false;
    const pending = this.session.pendingPlan;
    const pendingAffected = Boolean(pending && pending.plan.tabId === tabId);
    if (pendingAffected) changed = true;
    if (this.pageContext?.tabId === tabId) {
      changed = true;
      this.pageContext = null;
      this.pagePreview = null;
    }
    if (this.session.undo?.tabId === tabId) {
      changed = true;
      this.session.undo = null;
    }
    if (!changed) return;
    if (pendingAffected) {
      this.session.pendingPlan = null;
      this.session.approval = null;
      this.status = 'stale_page';
      this.appendMessage(
        'assistant',
        `页面已重新加载或跳转${url ? `（${truncate(url, 120)}）` : ''}，原操作计划失效。`,
        'info',
      );
    }
    await this.flush();
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    let changed = false;
    if (this.session.pendingPlan?.plan.tabId === tabId) {
      this.session.pendingPlan = null;
      this.session.approval = null;
      this.status = 'stale_page';
      changed = true;
    }
    if (this.pageContext?.tabId === tabId) {
      this.pageContext = null;
      this.pagePreview = null;
      changed = true;
    }
    if (this.session.undo?.tabId === tabId) {
      this.session.undo = null;
      changed = true;
    }
    if (changed) await this.flush();
  }

  async handle(request: PanelRequest): Promise<ControllerResult<PanelState | ConnectionTestResult>> {
    switch (request.type) {
      case 'GET_STATE':
        return { ok: true, data: await this.getState() };
      case 'SAVE_SETTINGS':
        return this.saveSettings(request);
      case 'TEST_CONNECTION':
        return this.testConnection();
      case 'ANALYZE_PAGE':
        return this.analyzePage();
      case 'CAPTURE_TAB':
        return {
          ok: false,
          error: { code: 'internal_error', message: '截图请求应由后台直接处理' },
        };
      case 'CHAT':
        return this.chat(request.text, request.attachment);
      case 'APPROVE_PLAN':
        return this.approvePlan(request.planHash);
      case 'REJECT_PLAN':
        return this.rejectPlan(request.planHash);
      case 'CANCEL_REQUEST':
        return this.cancelRequest();
      case 'UNDO':
        return this.undo();
      case 'CLEAR_CHAT':
        this.session.messages = [];
        this.cacheHitTokens = 0;
        this.cacheMissTokens = 0;
        this.cacheRequests = 0;
        await this.flush();
        return { ok: true, data: await this.getState() };
      case 'DISMISS_ERROR':
        this.lastError = null;
        if (['failed', 'cancelled', 'denied', 'stale_page', 'permission_required'].includes(this.status)) {
          this.status = this.session.pendingPlan ? 'awaiting_approval' : 'idle';
        }
        await this.flush();
        return { ok: true, data: await this.getState() };
    }
  }

  private async saveSettings(request: Extract<PanelRequest, { type: 'SAVE_SETTINGS' }>): Promise<
    ControllerResult<PanelState>
  > {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(request.baseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'API 地址无效';
      const panelError = this.setError('invalid_base_url', message);
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(request.model.trim())) {
      const panelError = this.setError('invalid_model', '模型名称格式无效');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 5_000 || request.timeoutMs > 120_000) {
      const panelError = this.setError('invalid_timeout', '超时时间必须在 5 秒到 120 秒之间');
      await this.flush();
      return { ok: false, error: panelError };
    }
    const fontSize = request.fontSize ?? this.settings.fontSize;
    const theme = request.theme ?? this.settings.theme;
    if (!FONT_SIZES.has(fontSize)) {
      const panelError = this.setError('invalid_font_size', '字体大小选项无效');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (!THEMES.has(theme)) {
      const panelError = this.setError('invalid_theme', '主题选项无效');
      await this.flush();
      return { ok: false, error: panelError };
    }

    const origin = new URL(baseUrl).origin;
    const pattern = hostPermissionPattern(baseUrl);
    let allowed = false;
    try {
      allowed = await this.deps.permissions.hasPattern(pattern);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this.status = 'permission_required';
      const panelError = this.setError(
        'permission_required',
        `尚未授予 ${origin} 的网络访问权限。请在设置页点击保存并允许该站点权限。`,
      );
      await this.flush();
      return { ok: false, error: panelError };
    }

    let apiKey = this.settings.apiKey;
    if (request.apiKeyAction === 'delete') {
      apiKey = '';
    } else if (request.apiKeyAction === 'replace') {
      const candidate = (request.apiKey ?? '').trim();
      if (!/^[A-Za-z0-9._-]{8,512}$/.test(candidate)) {
        const panelError = this.setError(
          'invalid_key_format',
          'API Key 格式无效。仅允许字母、数字以及点、下划线、连字符。',
        );
        await this.flush();
        return { ok: false, error: panelError };
      }
      apiKey = candidate;
    }

    const next: StoredSettings = {
      apiKey,
      baseUrl,
      model: request.model.trim(),
      timeoutMs: request.timeoutMs,
      fontSize,
      theme,
    };
    await this.deps.settings.save(next);
    this.settings = next;
    this.lastError = null;
    this.status = this.session.pendingPlan ? 'awaiting_approval' : 'idle';
    await this.flush();
    return { ok: true, data: await this.getState() };
  }

  private async testConnection(): Promise<ControllerResult<ConnectionTestResult>> {
    if (this.busy) {
      const panelError = this.setError('busy', '已有请求正在进行，请先取消或等待完成');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (!this.settings.apiKey) {
      const panelError = this.setError('api_key_missing', '请先配置 DeepSeek API Key');
      await this.flush();
      return { ok: false, error: panelError };
    }
    this.busy = true;
    const started = this.now();
    const controller = new AbortController();
    this.abortController = controller;
    try {
      await this.waitForRequestSlot(controller.signal);
      const result = await this.deps.deepseek.complete({
        apiKey: this.settings.apiKey,
        baseUrl: this.settings.baseUrl,
        model: this.settings.model,
        messages: [
          { role: 'system', content: 'You are a connectivity check. Reply with OK only.' },
          { role: 'user', content: 'ping' },
        ],
        timeoutMs: Math.min(this.settings.timeoutMs, 20_000),
        signal: controller.signal,
        jsonMode: false,
        maxTokens: 8,
        temperature: 0,
      });
      this.recordUsage(result.usage);
      this.lastError = null;
      return {
        ok: true,
        data: {
          message: '连接成功',
          model: this.settings.model,
          latencyMs: this.now() - started,
        },
      };
    } catch (error) {
      const message = describeDeepSeekError(error);
      const code = error instanceof DeepSeekError ? error.code : 'connection_failed';
      const panelError = this.setError(code, message);
      return { ok: false, error: panelError };
    } finally {
      this.busy = false;
      this.abortController = null;
      await this.flush();
    }
  }

  private async analyzePage(): Promise<ControllerResult<PanelState>> {
    if (this.busy) {
      const panelError = this.setError('busy', '已有任务正在进行');
      await this.flush();
      return { ok: false, error: panelError };
    }
    let tab: TabInfo | null;
    try {
      tab = await this.deps.tabs.getActive();
    } catch {
      tab = null;
    }
    if (!tab) {
      const panelError = this.setError('no_active_tab', '没有找到当前活动标签页');
      await this.flush();
      return { ok: false, error: panelError };
    }
    const unsupported = unsupportedPageReason(tab.url);
    if (unsupported) {
      this.status = 'failed';
      const panelError = this.setError('unsupported_page', unsupported);
      this.appendMessage('assistant', unsupported, 'error');
      await this.flush();
      return { ok: false, error: panelError };
    }

    this.busy = true;
    this.status = 'reading';
    this.lastError = null;
    await this.flush();
    try {
      await this.deps.content.ensure(tab.id);
      const response = await this.deps.content.read(tab.id);
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      if (!PageFingerprintSchema.safeParse(response.fingerprint).success) {
        throw new Error('页面指纹格式无效');
      }
      if (response.snapshot.url !== tab.url) {
        throw new Error('页面地址在读取过程中发生变化');
      }
      this.pageContext = {
        tabId: tab.id,
        url: response.snapshot.url,
        fingerprint: response.fingerprint,
        snapshot: response.snapshot,
      };
      this.pagePreview = previewFromSnapshot(response.snapshot, response.fingerprint);
      this.session.pendingPlan = null;
      this.session.approval = null;
      this.session.undo = null;
      this.status = 'completed';
      this.appendMessage(
        'assistant',
        `已读取「${response.snapshot.title || '当前网页'}」。生成操作计划时，页面标题、地址、正文和可交互元素摘要会发送给 DeepSeek；密码、Cookie 和其他标签页内容不会被读取。`,
        'info',
      );
      await this.flush();
      return { ok: true, data: await this.getState() };
    } catch (error) {
      this.status = 'failed';
      const message =
        error instanceof Error && /Cannot access|cannot be injected|permission/i.test(error.message)
          ? 'Chrome 未授予当前页面的访问权限。请在侧边栏允许当前网站权限后重试。'
          : error instanceof Error
            ? error.message
            : '读取页面失败';
      const panelError = this.setError('read_failed', message);
      this.appendMessage('assistant', `网页读取失败：${message}`, 'error');
      return { ok: false, error: panelError };
    } finally {
      this.busy = false;
      await this.flush();
    }
  }

  private async chat(text: string, attachment?: ImageAttachment): Promise<ControllerResult<PanelState>> {
    let trimmed = text.trim();
    if (!trimmed && attachment) trimmed = '请分析这张截图。';
    if (!trimmed) {
      const panelError = this.setError('invalid_input', '请输入指令');
      return { ok: false, error: panelError };
    }
    if (trimmed.length > 4000) {
      const panelError = this.setError('invalid_input', '指令过长，请控制在 4000 字符以内');
      return { ok: false, error: panelError };
    }
    if (this.busy) {
      const panelError = this.setError('busy', '已有请求正在进行，请先取消或等待完成');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (!this.settings.apiKey) {
      const panelError = this.setError('api_key_missing', '请先在设置中配置 DeepSeek API Key');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (attachment && !isImageAttachment(attachment)) {
      const panelError = this.setError('invalid_attachment', '截图附件格式、尺寸或大小无效');
      return { ok: false, error: panelError };
    }

    this.appendMessage('user', trimmed, 'normal', attachment);
    const history = this.session.messages
      .slice(0, -1)
      .filter((message) => message.kind === 'normal' && message.role !== 'system')
      .slice(-8)
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: truncate(message.content, 1200),
      }));
    const controller = new AbortController();
    this.abortController = controller;
    this.busy = true;
    this.cancelRequested = false;
    this.status = 'planning';
    this.lastError = null;
    await this.flush();

    try {
      await this.waitForRequestSlot(controller.signal);
      const result = await this.deps.deepseek.complete({
        apiKey: this.settings.apiKey,
        baseUrl: this.settings.baseUrl,
        model: this.settings.model,
        messages: buildChatMessages(
          history,
          trimmed,
          this.pageContext?.snapshot ?? null,
          attachment,
        ),
        timeoutMs: this.settings.timeoutMs,
        signal: controller.signal,
        jsonMode: true,
        maxTokens: 1600,
        temperature: 0.2,
      });
      this.recordUsage(result.usage);
      const parsed = parseModelOutput(result.content);
      this.appendMessage('assistant', parsed.reply, 'normal');

      if (!parsed.plan) {
        this.status = 'completed';
        return { ok: true, data: await this.getState() };
      }
      if (!this.pageContext) {
        throw new ModelOutputError('模型返回了操作计划，但当前没有可用的页面上下文');
      }
      const built = buildPlan(parsed.plan, {
        tabId: this.pageContext.tabId,
        snapshot: this.pageContext.snapshot,
        fingerprint: this.pageContext.fingerprint,
        now: this.now(),
      });
      const planHash = await hashPlan(built.plan);
      this.session.pendingPlan = {
        plan: built.plan,
        planHash,
        previews: built.previews,
      };
      this.session.approval = null;
      this.session.undo = null;
      this.status = 'awaiting_approval';
      this.appendMessage(
        'assistant',
        '计划已生成。请在操作预览中核对目标元素、修改前后内容和风险，再决定是否批准。',
        'info',
      );
      return { ok: true, data: await this.getState() };
    } catch (error) {
      if (this.cancelRequested || (error instanceof DeepSeekError && error.code === 'cancelled')) {
        this.status = 'cancelled';
        if (!this.session.messages.some((message) => message.content === '请求已取消。')) {
          this.appendMessage('assistant', '请求已取消。', 'info');
        }
        return { ok: false, error: this.setError('cancelled', '请求已取消') };
      }
      if (error instanceof PlanBuildError) {
        this.status = 'failed';
        const detail = error.detail ? `${error.message}：${error.detail}` : error.message;
        this.appendMessage('assistant', `未执行任何修改。${detail}`, 'error');
        return { ok: false, error: this.setError(error.code, detail) };
      }
      if (error instanceof ModelOutputError) {
        this.status = 'failed';
        this.appendMessage('assistant', `${error.message}，未执行任何修改。`, 'error');
        return { ok: false, error: this.setError('invalid_model_output', error.message) };
      }
      this.status = 'failed';
      const message = describeDeepSeekError(error);
      const code = error instanceof DeepSeekError ? error.code : 'request_failed';
      this.appendMessage('assistant', `请求失败：${message}`, 'error');
      return { ok: false, error: this.setError(code, message) };
    } finally {
      this.busy = false;
      this.abortController = null;
      this.cancelRequested = false;
      await this.flush();
    }
  }

  private async approvePlan(planHash: string): Promise<ControllerResult<PanelState>> {
    const pending = this.session.pendingPlan;
    if (!pending) {
      const panelError = this.setError('no_pending_plan', '没有待确认的计划');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (pending.planHash !== planHash) {
      const panelError = this.setError('plan_mismatch', '授权与当前计划不匹配');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (this.busy) {
      const panelError = this.setError('busy', '已有任务正在进行');
      await this.flush();
      return { ok: false, error: panelError };
    }
    const plan = pending.plan;
    if (this.now() > plan.expiresAt) {
      this.status = 'stale_page';
      this.session.pendingPlan = null;
      this.session.approval = null;
      const panelError = this.setError('plan_expired', '计划已过期，请重新生成并确认');
      await this.flush();
      return { ok: false, error: panelError };
    }
    let tab: TabInfo | null = null;
    try {
      tab = await this.deps.tabs.get(plan.tabId);
    } catch {
      tab = null;
    }
    if (!tab || (tab.url && tab.url !== plan.pageUrl)) {
      this.status = 'stale_page';
      this.session.pendingPlan = null;
      this.session.approval = null;
      this.pageContext = null;
      this.pagePreview = null;
      const panelError = this.setError('stale_page', '目标标签页或页面地址已变化，原授权失效');
      this.appendMessage('assistant', '页面已变化，计划已失效。请重新分析网页。', 'error');
      await this.flush();
      return { ok: false, error: panelError };
    }

    const approval = createApproval(plan, planHash, this.now());
    const match = approvalMatches(approval, plan, planHash, this.now());
    if (!match.ok) {
      this.status = 'stale_page';
      this.session.pendingPlan = null;
      this.session.approval = null;
      const panelError = this.setError('approval_invalid', match.reason);
      await this.flush();
      return { ok: false, error: panelError };
    }

    this.busy = true;
    this.status = 'executing';
    this.lastError = null;
    this.session.approval = { ...approval, consumed: true };
    await this.flush();

    try {
      await this.deps.content.ensure(plan.tabId);
      const report = await this.deps.content.execute(plan.tabId, plan);
      this.status = 'verifying';
      await this.flush();

      if (report.stale) {
        this.status = 'stale_page';
        this.session.pendingPlan = null;
        this.session.approval = null;
        this.pageContext = null;
        this.pagePreview = null;
        const message = report.error ?? '页面已发生变化，计划已失效';
        this.appendMessage('assistant', `${message}。未执行后续操作，请重新分析网页。`, 'error');
        return { ok: false, error: this.setError('stale_page', message) };
      }
      if (!report.ok) {
        this.status = 'failed';
        this.session.undo = report.undo.length
          ? { tabId: plan.tabId, records: report.undo }
          : null;
        this.session.pendingPlan = null;
        this.session.approval = null;
        this.pageContext = null;
        this.pagePreview = null;
        const message = report.error ?? '操作执行失败';
        const partial = report.undo.length ? '已完成的部分可以尝试撤销。' : '未执行任何可撤销的修改。';
        this.appendMessage('assistant', `第 ${report.results.length} 项操作失败：${message}。${partial}`, 'error');
        return { ok: false, error: this.setError('execution_failed', message) };
      }

      this.status = 'completed';
      this.session.undo = report.undo.length
        ? { tabId: plan.tabId, records: report.undo }
        : null;
      this.session.pendingPlan = null;
      this.session.approval = null;
      this.pageContext = null;
      this.pagePreview = null;
      const hasClick = plan.actions.some((action) => action.type === 'click_element');
      this.appendMessage(
        'assistant',
        `已执行 ${report.results.length} 项修改并完成本地校验。这些修改只作用于当前页面 DOM，未保存到网站服务器。${
          hasClick ? '点击操作无法自动撤销。' : ''
        }`,
        'success',
      );
      return { ok: true, data: await this.getState() };
    } catch (error) {
      this.status = 'failed';
      this.session.pendingPlan = null;
      this.session.approval = null;
      const message = error instanceof Error ? error.message : '执行失败';
      this.appendMessage('assistant', `执行失败：${message}`, 'error');
      return { ok: false, error: this.setError('execution_failed', message) };
    } finally {
      this.busy = false;
      await this.flush();
    }
  }

  private async rejectPlan(planHash: string): Promise<ControllerResult<PanelState>> {
    const pending = this.session.pendingPlan;
    if (!pending || pending.planHash !== planHash) {
      const panelError = this.setError('plan_mismatch', '没有匹配的待确认计划');
      await this.flush();
      return { ok: false, error: panelError };
    }
    this.session.pendingPlan = null;
    this.session.approval = null;
    this.status = 'denied';
    this.lastError = null;
    this.appendMessage('assistant', '已拒绝该计划，页面未被修改。', 'info');
    await this.flush();
    return { ok: true, data: await this.getState() };
  }

  private async undo(): Promise<ControllerResult<PanelState>> {
    const bundle: UndoBundle | null = this.session.undo;
    if (!bundle || bundle.records.length === 0) {
      const panelError = this.setError('no_undo', '没有可撤销的修改');
      await this.flush();
      return { ok: false, error: panelError };
    }
    if (this.busy) {
      const panelError = this.setError('busy', '已有任务正在进行');
      await this.flush();
      return { ok: false, error: panelError };
    }
    this.busy = true;
    this.status = 'executing';
    this.lastError = null;
    await this.flush();
    try {
      await this.deps.content.ensure(bundle.tabId);
      const report = await this.deps.content.undo(bundle.tabId, bundle.records);
      this.session.undo = null;
      this.pageContext = null;
      this.pagePreview = null;
      if (!report.ok) {
        this.status = 'failed';
        const message = report.error ?? '撤销失败';
        this.appendMessage('assistant', `撤销未完全成功：${message}`, 'error');
        return { ok: false, error: this.setError('undo_failed', message) };
      }
      this.status = 'completed';
      this.appendMessage('assistant', `已撤销 ${report.results.length} 项修改。`, 'success');
      return { ok: true, data: await this.getState() };
    } catch (error) {
      this.status = 'failed';
      this.session.undo = null;
      const message = error instanceof Error ? error.message : '撤销失败';
      this.appendMessage('assistant', `撤销失败：${message}`, 'error');
      return { ok: false, error: this.setError('undo_failed', message) };
    } finally {
      this.busy = false;
      await this.flush();
    }
  }

  private async cancelRequest(): Promise<ControllerResult<PanelState>> {
    if (!this.abortController) {
      const panelError = this.setError('no_request', '当前没有正在进行的请求');
      await this.flush();
      return { ok: false, error: panelError };
    }
    this.cancelRequested = true;
    this.abortController.abort();
    this.status = 'cancelled';
    this.lastError = { code: 'cancelled', message: '请求已取消' };
    if (!this.session.messages.some((message) => message.content === '请求已取消。')) {
      this.appendMessage('assistant', '请求已取消。', 'info');
    }
    await this.flush();
    return { ok: true, data: await this.getState() };
  }

  private async waitForRequestSlot(signal: AbortSignal): Promise<void> {
    const waitMs = 1100 - (this.now() - this.lastRequestAt);
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DeepSeekError('cancelled', '请求已取消'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.lastRequestAt = this.now();
  }
}
