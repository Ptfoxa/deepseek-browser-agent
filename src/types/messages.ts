import type {
  ActionPlan,
  PlanAction,
  RiskLevel,
  UndoRecord,
} from './plan';

export type TaskStatus =
  | 'idle'
  | 'reading'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'stale_page'
  | 'permission_required';

export interface StoredSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface PublicSettings {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatKind = 'normal' | 'error' | 'success' | 'info';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  at: number;
  kind: ChatKind;
}

export type ElementKind = 'text' | 'text_input' | 'checkbox' | 'select' | 'button';

export interface PageElement {
  id: string;
  kind: ElementKind;
  tag: string;
  label: string;
  value?: string;
  checked?: boolean;
  options?: Array<{ value: string; label: string }>;
  disabled: boolean;
  readOnly: boolean;
  safeToClick?: boolean;
  riskReason?: string;
  formIndex?: number;
}

export interface PageForm {
  index: number;
  method: string;
  action: string;
  fieldCount: number;
  sensitiveFieldCount: number;
}

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  elements: PageElement[];
  forms: PageForm[];
  formCount: number;
  sensitiveFieldCount: number;
  truncated: boolean;
  capturedAt: number;
}

export interface PagePreview {
  title: string;
  url: string;
  textLength: number;
  summary: string;
  headingCount: number;
  linkCount: number;
  elementCount: number;
  formCount: number;
  sensitiveFieldCount: number;
  truncated: boolean;
  readAt: number;
  fingerprint: string;
}

export interface ActionPreview {
  actionId: string;
  type: PlanAction['type'];
  target: string;
  targetLabel: string;
  before: string;
  after: string;
  risk: RiskLevel;
  undoable: boolean;
  note?: string;
}

export interface PendingPlan {
  plan: ActionPlan;
  planHash: string;
  previews: ActionPreview[];
}

export interface PanelError {
  code: string;
  message: string;
}

export interface PanelState {
  status: TaskStatus;
  statusText: string;
  settings: PublicSettings;
  activeTab: TabInfo | null;
  page: PagePreview | null;
  messages: ChatMessage[];
  pendingPlan: PendingPlan | null;
  undoAvailable: boolean;
  undoCount: number;
  lastError: PanelError | null;
  busy: boolean;
}

export interface ContentError {
  code:
    | 'not_supported'
    | 'context_missing'
    | 'stale_page'
    | 'invalid_action'
    | 'target_missing'
    | 'execution_failed'
    | 'undo_conflict'
    | 'invalid_message';
  message: string;
}

export interface ExecuteActionResult {
  actionId: string;
  ok: boolean;
  error?: string;
  undoable: boolean;
  note?: string;
}

export interface ExecuteReport {
  ok: boolean;
  stale: boolean;
  results: ExecuteActionResult[];
  undo: UndoRecord[];
  error?: string;
}

export interface UndoReport {
  ok: boolean;
  results: Array<{ actionId: string; ok: boolean; error?: string }>;
  error?: string;
}

export interface ReadPageResponse {
  ok: true;
  snapshot: PageSnapshot;
  fingerprint: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PanelError };

export type PanelRequest =
  | { type: 'GET_STATE' }
  | {
      type: 'SAVE_SETTINGS';
      baseUrl: string;
      model: string;
      timeoutMs: number;
      apiKeyAction: 'keep' | 'replace' | 'delete';
      apiKey?: string;
    }
  | { type: 'TEST_CONNECTION' }
  | { type: 'ANALYZE_PAGE' }
  | { type: 'CHAT'; text: string }
  | { type: 'APPROVE_PLAN'; planHash: string }
  | { type: 'REJECT_PLAN'; planHash: string }
  | { type: 'CANCEL_REQUEST' }
  | { type: 'UNDO' }
  | { type: 'CLEAR_CHAT' }
  | { type: 'DISMISS_ERROR' };

export type StateUpdateMessage = { type: 'STATE_UPDATE'; state: PanelState };
