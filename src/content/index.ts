import { z } from 'zod';
import type { ContentError, UndoReport } from '../types/messages';
import { ActionPlanSchema, UndoRecordSchema } from '../types/plan';
import { executeActions, undoActions, type DomContext } from '../lib/page/execute';
import { readPage } from '../lib/page/extract';

let current: DomContext | null = null;

function fail(code: ContentError['code'], message: string): { ok: false; error: ContentError } {
  return { ok: false, error: { code, message } };
}

const ExecuteMessageSchema = z
  .object({
    channel: z.literal('DBA'),
    type: z.literal('EXECUTE_PLAN'),
    plan: ActionPlanSchema,
  })
  .strict();

const UndoMessageSchema = z
  .object({
    channel: z.literal('DBA'),
    type: z.literal('UNDO'),
    records: z.array(UndoRecordSchema).min(1).max(8),
  })
  .strict();

async function handle(message: unknown): Promise<unknown> {
  if (!message || typeof message !== 'object') return fail('invalid_message', '消息格式无效');
  const type = (message as { type?: unknown }).type;
  if ((message as { channel?: unknown }).channel !== 'DBA') {
    return fail('invalid_message', '消息通道无效');
  }

  if (type === 'PING') {
    return { ok: true, version: '0.2.0' };
  }

  if (type === 'READ_PAGE') {
    try {
      const result = readPage(document, location.href);
      current = {
        doc: document,
        url: location.href,
        fingerprint: result.fingerprint,
        registry: result.registry,
      };
      return { ok: true, snapshot: result.snapshot, fingerprint: result.fingerprint };
    } catch {
      return fail('execution_failed', '读取当前网页失败');
    }
  }

  if (type === 'EXECUTE_PLAN') {
    const parsed = ExecuteMessageSchema.safeParse(message);
    if (!parsed.success) return fail('invalid_action', '操作计划未通过 Schema 校验');
    const plan = parsed.data.plan;
    if (!current) return fail('context_missing', '页面上下文已失效，请重新分析当前网页');
    if (plan.pageUrl !== location.href || plan.pageFingerprint !== current.fingerprint) {
      return fail('stale_page', '页面地址或结构已变化，请重新分析当前网页');
    }
    return executeActions(current, plan.actions);
  }

  if (type === 'UNDO') {
    const parsed = UndoMessageSchema.safeParse(message);
    if (!parsed.success) return fail('invalid_action', '撤销记录未通过 Schema 校验');
    if (!current) return fail('context_missing', '页面上下文已失效，无法撤销');
    const report: UndoReport = undoActions(current, parsed.data.records);
    return report;
  }

  return fail('invalid_message', '未知消息类型');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handle(message)
    .then((response) => sendResponse(response))
    .catch((error: unknown) =>
      sendResponse(
        fail('execution_failed', error instanceof Error ? error.message : '页面脚本执行失败'),
      ),
    );
  return true;
});
