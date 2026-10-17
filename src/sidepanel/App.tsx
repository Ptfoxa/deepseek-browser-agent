import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ApiResult,
  PanelRequest,
  PanelState,
  StateUpdateMessage,
} from '../types/messages';

const ACTION_LABELS: Record<string, string> = {
  replace_text: '替换文本',
  fill_input: '填写输入框',
  set_checkbox: '设置复选框',
  select_option: '选择下拉项',
  click_element: '点击控件',
};

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const STATUS_TONE: Record<string, string> = {
  idle: 'neutral',
  reading: 'busy',
  planning: 'busy',
  executing: 'busy',
  verifying: 'busy',
  awaiting_approval: 'warn',
  completed: 'ok',
  denied: 'neutral',
  cancelled: 'neutral',
  failed: 'bad',
  stale_page: 'warn',
  permission_required: 'warn',
};

async function send<T = PanelState>(request: PanelRequest): Promise<ApiResult<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as ApiResult<T> | undefined;
    if (!response) {
      return { ok: false, error: { code: 'no_response', message: '扩展后台没有响应，请重新打开侧边栏' } };
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'send_failed',
        message: error instanceof Error ? error.message : '无法连接扩展后台',
      },
    };
  }
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const messageEnd = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const result = await send({ type: 'GET_STATE' });
    if (result.ok) setState(result.data);
    else setNotice({ tone: 'bad', text: result.error.message });
  };

  useEffect(() => {
    void refresh();
    const listener = (message: unknown) => {
      const update = message as StateUpdateMessage;
      if (update?.type === 'STATE_UPDATE' && update.state) {
        setState(update.state);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state?.messages.length, state?.pendingPlan]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const statusTone = state ? STATUS_TONE[state.status] ?? 'neutral' : 'neutral';
  const busy = state?.busy ?? false;

  const run = async (request: PanelRequest) => {
    setNotice(null);
    const result = await send(request);
    if (result.ok) {
      if ('status' in result.data) setState(result.data as PanelState);
    } else {
      setNotice({ tone: 'bad', text: result.error.message });
      const next = await send({ type: 'GET_STATE' });
      if (next.ok) setState(next.data);
    }
    return result;
  };

  const submitChat = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    await run({ type: 'CHAT', text });
  };

  const analyze = async () => {
    await run({ type: 'ANALYZE_PAGE' });
  };

  if (!state) {
    return (
      <div className="loading-screen">
        <div className="brand-mark small">
          <span />
        </div>
        <p>正在连接扩展后台…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div>
            <h1>DeepSeek Browser</h1>
            <p>受控网页助手 · MVP</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`status-pill ${statusTone}`}>
            <i />
            {state.statusText}
          </span>
          <button
            className={`icon-button ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            title="设置"
            aria-label="打开设置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm9 4.9v-2.4l-2.2-.8a7 7 0 0 0-.7-1.7l1-2.1-1.7-1.7-2.1 1a7 7 0 0 0-1.7-.7L13 2.6h-2.4l-.8 2.2a7 7 0 0 0-1.7.7l-2.1-1-1.7 1.7 1 2.1a7 7 0 0 0-.7 1.7l-2.2.8v2.4l2.2.8a7 7 0 0 0 .7 1.7l-1 2.1 1.7 1.7 2.1-1a7 7 0 0 0 1.7.7l.8 2.2H13l.8-2.2a7 7 0 0 0 1.7-.7l2.1 1 1.7-1.7-1-2.1a7 7 0 0 0 .7-1.7l2.2-.8Z" />
            </svg>
          </button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}

      {view === 'settings' ? (
        <SettingsView
          state={state}
          onState={setState}
          onNotice={setNotice}
          onBack={() => setView('chat')}
        />
      ) : (
        <>
          <TabCard state={state} onAnalyze={analyze} busy={busy} />
          {!state.settings.hasApiKey && (
            <button className="banner" onClick={() => setView('settings')}>
              <span className="banner-dot" />
              尚未配置 DeepSeek API Key，点击前往设置
              <span className="banner-arrow">→</span>
            </button>
          )}
          {state.page && <PageCard state={state} />}
          {state.pendingPlan && (
            <PlanCard
              state={state}
              onApprove={() => void run({ type: 'APPROVE_PLAN', planHash: state.pendingPlan!.planHash })}
              onReject={() => void run({ type: 'REJECT_PLAN', planHash: state.pendingPlan!.planHash })}
              busy={busy}
            />
          )}
          {state.undoAvailable && (
            <div className="undo-bar">
              <div>
                <strong>可撤销本次修改</strong>
                <span>{state.undoCount} 项可逆操作</span>
              </div>
              <button disabled={busy} onClick={() => void run({ type: 'UNDO' })}>
                撤销
              </button>
            </div>
          )}

          <main className="chat">
            {state.messages.length === 0 ? (
              <EmptyState onAnalyze={analyze} hasKey={state.settings.hasApiKey} />
            ) : (
              <div className="message-list">
                {state.messages.map((message) => (
                  <article key={message.id} className={`message ${message.role} ${message.kind}`}>
                    <div className="message-meta">
                      <span>
                        {message.role === 'user' ? '你' : message.role === 'assistant' ? 'DeepSeek' : '系统'}
                      </span>
                      <time>{timeLabel(message.at)}</time>
                    </div>
                    <div className="message-body">{message.content}</div>
                  </article>
                ))}
                <div ref={messageEnd} />
              </div>
            )}
          </main>

          <form className="composer" onSubmit={submitChat}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submitChat(event);
                }
              }}
              placeholder={state.page ? '告诉 AI 你想怎样修改当前页面…' : '先分析当前网页，或直接提问…'}
              rows={2}
              maxLength={4000}
              disabled={busy}
            />
            <div className="composer-actions">
              <span className="dom-note">修改仅作用于页面 DOM，不会自动提交</span>
              {busy ? (
                <button
                  type="button"
                  className="cancel-button"
                  onClick={() => void run({ type: 'CANCEL_REQUEST' })}
                >
                  取消请求
                </button>
              ) : (
                <button type="submit" className="send-button" disabled={!draft.trim()}>
                  发送
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function TabCard({
  state,
  onAnalyze,
  busy,
}: {
  state: PanelState;
  onAnalyze: () => Promise<void>;
  busy: boolean;
}) {
  const tab = state.activeTab;
  return (
    <section className="tab-card">
      <div className="tab-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Zm3 3v9h10v-9H7Z" />
        </svg>
      </div>
      <div className="tab-copy">
        <span>当前目标标签页</span>
        <strong>{tab?.title || (tab ? '（无标题页面）' : '未找到活动标签页')}</strong>
        <small>{tab?.url || '请切换到普通网页后重试'}</small>
      </div>
      <button className="analyze-button" disabled={busy || !tab} onClick={() => void onAnalyze()}>
        {state.status === 'reading' ? '读取中…' : '分析当前网页'}
      </button>
    </section>
  );
}

function PageCard({ state }: { state: PanelState }) {
  const page = state.page!;
  return (
    <section className="page-card">
      <div className="section-title">
        <span>页面摘要</span>
        <em>本地生成</em>
      </div>
      <p className="page-summary">{page.summary}</p>
      <div className="metric-grid">
        <div>
          <strong>{formatCount(page.textLength)}</strong>
          <span>正文字符</span>
        </div>
        <div>
          <strong>{page.elementCount}</strong>
          <span>可操作元素</span>
        </div>
        <div>
          <strong>{page.formCount}</strong>
          <span>表单</span>
        </div>
        <div>
          <strong>{page.sensitiveFieldCount}</strong>
          <span>已跳过敏感项</span>
        </div>
      </div>
      <p className="privacy-line">
        生成计划时会把脱敏后的正文、标题、链接和元素摘要发送给 DeepSeek；密码、邮箱、电话、Cookie
        与其他标签页不会读取。
      </p>
      {page.truncated && <p className="privacy-line warn">正文较长，仅截取前 6000 字符。</p>}
    </section>
  );
}

function PlanCard({
  state,
  onApprove,
  onReject,
  busy,
}: {
  state: PanelState;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const pending = state.pendingPlan!;
  return (
    <section className="plan-card">
      <div className="plan-head">
        <div>
          <span className="eyebrow">操作预览</span>
          <h2>{pending.plan.summary}</h2>
        </div>
        <span className="risk-badge">中风险 · 需授权</span>
      </div>
      <div className="action-list">
        {pending.previews.map((preview, index) => (
          <div className="action-row" key={preview.actionId}>
            <div className="action-index">{index + 1}</div>
            <div className="action-main">
              <div className="action-title">
                <strong>{ACTION_LABELS[preview.type] ?? preview.type}</strong>
                <code>{preview.target}</code>
                <span className={`action-risk ${preview.risk}`}>{RISK_LABELS[preview.risk]}</span>
              </div>
              <p className="target-label">{preview.targetLabel}</p>
              <div className="diff">
                <div>
                  <span>修改前</span>
                  <p>{preview.before || '（空）'}</p>
                </div>
                <div>
                  <span>修改后</span>
                  <p>{preview.after || '（空）'}</p>
                </div>
              </div>
              {preview.note && <small className="action-note">{preview.note}</small>}
            </div>
          </div>
        ))}
      </div>
      <p className="approval-note">
        批准仅对本次计划、当前标签页和当前页面状态有效。页面跳转、重新加载或元素内容变化后授权自动失效。
      </p>
      <div className="plan-actions">
        <button className="secondary" disabled={busy} onClick={onReject}>
          拒绝
        </button>
        <button className="primary" disabled={busy} onClick={onApprove}>
          {busy ? '处理中…' : '批准并执行'}
        </button>
      </div>
    </section>
  );
}

function EmptyState({ onAnalyze, hasKey }: { onAnalyze: () => Promise<void>; hasKey: boolean }) {
  return (
    <section className="empty-state">
      <div className="orb">
        <span />
      </div>
      <h2>让 AI 看懂当前网页</h2>
      <p>读取页面 → 生成计划 → 风险检查 → 你确认 → 执行并校验。</p>
      <ol>
        <li className={hasKey ? 'done' : ''}>在设置中配置 DeepSeek API Key</li>
        <li>点击“分析当前网页”</li>
        <li>用自然语言描述想修改的内容</li>
      </ol>
      <button className="primary wide" onClick={() => void onAnalyze()}>
        分析当前网页
      </button>
      <div className="example-chips">
        <span>试试：总结这个页面</span>
        <span>把主标题改成“项目总结”</span>
        <span>勾选“同意条款”</span>
      </div>
    </section>
  );
}

function SettingsView({
  state,
  onState,
  onNotice,
  onBack,
}: {
  state: PanelState;
  onState: (state: PanelState) => void;
  onNotice: (notice: { tone: 'ok' | 'bad'; text: string } | null) => void;
  onBack: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(state.settings.baseUrl);
  const [model, setModel] = useState(state.settings.model);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(Math.round(state.settings.timeoutMs / 1000)));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseUrl(state.settings.baseUrl);
    setModel(state.settings.model);
    setTimeoutSeconds(String(Math.round(state.settings.timeoutMs / 1000)));
  }, [state.settings.baseUrl, state.settings.model, state.settings.timeoutMs]);

  const requestOriginPermission = async (): Promise<boolean> => {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      onNotice({ tone: 'bad', text: 'API 地址格式无效' });
      return false;
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      onNotice({ tone: 'bad', text: 'API 地址必须使用 HTTPS（本地调试可用 localhost）' });
      return false;
    }
    // Chrome match patterns do not support port numbers.
    const pattern = `${parsed.protocol}//${parsed.hostname}/*`;
    if (parsed.origin === 'https://api.deepseek.com') return true;
    try {
      // Call request synchronously from the save click so Chrome retains user activation.
      return await chrome.permissions.request({ origins: [pattern] });
    } catch {
      return chrome.permissions.contains({ origins: [pattern] });
    }
  };

  const save = async () => {
    setSaving(true);
    onNotice(null);
    try {
      const permitted = await requestOriginPermission();
      if (!permitted) {
        onNotice({ tone: 'bad', text: '未授予该 API 地址的网络访问权限，设置未保存' });
        return;
      }
      const result = await send<PanelState>({
        type: 'SAVE_SETTINGS',
        baseUrl,
        model,
        timeoutMs: Math.round(Number(timeoutSeconds) * 1000),
        apiKeyAction: apiKey.trim() ? 'replace' : 'keep',
        apiKey: apiKey.trim() || undefined,
      });
      if (!result.ok) {
        onNotice({ tone: 'bad', text: result.error.message });
        return;
      }
      setApiKey('');
      onState(result.data);
      onNotice({ tone: 'ok', text: '设置已保存' });
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = async () => {
    const result = await send<PanelState>({
      type: 'SAVE_SETTINGS',
      baseUrl,
      model,
      timeoutMs: Math.round(Number(timeoutSeconds) * 1000),
      apiKeyAction: 'delete',
    });
    if (!result.ok) {
      onNotice({ tone: 'bad', text: result.error.message });
      return;
    }
    setApiKey('');
    onState(result.data);
    onNotice({ tone: 'ok', text: 'API Key 已删除' });
  };

  const test = async () => {
    setTesting(true);
    onNotice(null);
    try {
      const result = await send<{ message: string; model: string; latencyMs: number }>({
        type: 'TEST_CONNECTION',
      });
      if (!result.ok) {
        onNotice({ tone: 'bad', text: result.error.message });
        return;
      }
      onNotice({
        tone: 'ok',
        text: `${result.data.message} · ${result.data.model} · ${result.data.latencyMs}ms`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="settings">
      <button className="back-link" onClick={onBack}>
        ← 返回对话
      </button>
      <h2>设置</h2>
      <p className="settings-intro">
        API Key 保存在本机扩展存储中，不会写入源码、构建产物或页面脚本。浏览器本地存储不是专业密钥保险箱，
        建议使用可随时撤销的专用 Key。
      </p>

      <label className="field">
        <span>
          DeepSeek API Key
          {state.settings.hasApiKey && <em className="configured">已配置</em>}
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={state.settings.hasApiKey ? '留空表示不修改，输入新 Key 可替换' : '输入 API Key'}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>API Base URL</span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
        <small>官方默认：https://api.deepseek.com（保存自定义地址时会请求该站点权限）</small>
      </label>

      <label className="field">
        <span>模型名称</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
        <small>官方当前默认：deepseek-flash</small>
      </label>

      <label className="field">
        <span>请求超时（秒）</span>
        <input
          type="number"
          min={5}
          max={120}
          value={timeoutSeconds}
          onChange={(event) => setTimeoutSeconds(event.target.value)}
        />
      </label>

      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button className="secondary" disabled={!state.settings.hasApiKey || testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>
      {state.settings.hasApiKey && (
        <button className="danger-link" onClick={() => void deleteKey()}>
          删除已保存的 API Key
        </button>
      )}

      <section className="info-block">
        <h3>会发送给 DeepSeek 的内容</h3>
        <p>
          点击“分析当前网页”后，扩展读取当前标签页的标题、地址、可见正文（最多 6000 字符）、标题层级、
          链接路径和可交互元素摘要。生成计划时这些脱敏数据会随你的指令发送给 DeepSeek API。
        </p>
        <h3>不会读取或发送</h3>
        <p>
          密码、邮箱、电话、支付字段的值，Cookie、localStorage、会话令牌，以及其他标签页的内容。敏感表单字段会被跳过。
          链接会去除查询参数，正文中的邮箱、手机号和疑似卡号会先脱敏。
        </p>
        <h3>数据保存</h3>
        <p>
          不保存完整网页正文。聊天记录和待确认计划（仅操作预览）保存在
          chrome.storage.session，关闭浏览器后清除。若 Service Worker 被回收，页面上下文会丢失，需要重新分析。
        </p>
        <h3>权限说明</h3>
        <ul>
          <li>activeTab / scripting：仅在你点击分析后读取当前标签页。</li>
          <li>tabs：识别目标标签页及其跳转，使旧授权及时失效。</li>
          <li>storage / sidePanel：保存设置与显示侧边栏。</li>
          <li>host_permissions：仅默认的 DeepSeek API 域名；自定义地址按需单独授权。</li>
        </ul>
      </section>
    </main>
  );
}
