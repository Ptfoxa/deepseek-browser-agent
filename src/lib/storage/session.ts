import { z } from 'zod';
import type {
  ChatMessage,
  PendingPlan,
} from '../../types/messages';
import type { UndoRecord } from '../../types/plan';
import { ActionPlanSchema, PlanApprovalSchema, UndoRecordSchema } from '../../types/plan';
import type { StorageAreaLike } from './settings';

export const SESSION_KEY = 'dba_session_v1';

const ChatMessageSchema = z
  .object({
    id: z.string().min(1).max(80),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(4000),
    at: z.number().int().nonnegative(),
    kind: z.enum(['normal', 'error', 'success', 'info']),
  })
  .strict();

const ActionPreviewSchema = z
  .object({
    actionId: z.string().max(32),
    type: z.enum(['replace_text', 'fill_input', 'set_checkbox', 'select_option', 'click_element']),
    target: z.string().max(16),
    targetLabel: z.string().max(400),
    before: z.string().max(400),
    after: z.string().max(400),
    risk: z.enum(['low', 'medium', 'high']),
    undoable: z.boolean(),
    note: z.string().max(300).optional(),
  })
  .strict();

const PendingPlanSchema = z
  .object({
    plan: ActionPlanSchema,
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    previews: z.array(ActionPreviewSchema).min(1).max(8),
  })
  .strict();

const UndoBundleSchema = z
  .object({
    tabId: z.number().int().positive(),
    records: z.array(UndoRecordSchema).min(1).max(8),
  })
  .strict();

export const SessionDataSchema = z
  .object({
    messages: z.array(ChatMessageSchema).max(80),
    pendingPlan: PendingPlanSchema.nullable(),
    approval: PlanApprovalSchema.nullable(),
    undo: UndoBundleSchema.nullable(),
  })
  .strict();

export interface UndoBundle {
  tabId: number;
  records: UndoRecord[];
}

export interface SessionData {
  messages: ChatMessage[];
  pendingPlan: PendingPlan | null;
  approval: z.infer<typeof PlanApprovalSchema> | null;
  undo: UndoBundle | null;
}

export function emptySession(): SessionData {
  return {
    messages: [],
    pendingPlan: null,
    approval: null,
    undo: null,
  };
}

export class SessionStore {
  private area: StorageAreaLike;

  constructor(area: StorageAreaLike) {
    this.area = area;
  }

  async load(): Promise<SessionData> {
    try {
      const stored = await this.area.get(SESSION_KEY);
      const parsed = SessionDataSchema.safeParse(stored[SESSION_KEY]);
      if (!parsed.success) return emptySession();
      return parsed.data as SessionData;
    } catch {
      return emptySession();
    }
  }

  async save(data: SessionData): Promise<void> {
    const safe = SessionDataSchema.safeParse(data);
    if (!safe.success) {
      throw new Error('Session state failed validation');
    }
    await this.area.set({ [SESSION_KEY]: safe.data });
  }
}

