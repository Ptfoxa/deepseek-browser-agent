import type { ExecuteActionResult, ExecuteReport, UndoReport } from '../../types/messages';
import type { PlanAction, UndoRecord } from '../../types/plan';
import { textLooksHighRisk } from '../security/risk';
import type { RegistryEntry } from './extract';
import { normalizeText } from './extract';
import { fingerprintDocument } from './fingerprint';

export interface DomContext {
  doc: Document;
  url: string;
  fingerprint: string;
  registry: Map<string, RegistryEntry>;
}

class ActionFailure extends Error {
  kind: 'invalid' | 'stale' | 'conflict';

  constructor(message: string, kind: 'invalid' | 'stale' | 'conflict' = 'invalid') {
    super(message);
    this.kind = kind;
  }
}

function buttonText(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) return normalizeText(element.value);
  const inner = typeof element.innerText === 'string' ? element.innerText : '';
  return normalizeText(
    element.getAttribute('aria-label') ?? (inner || element.textContent) ?? element.getAttribute('title') ?? '',
  );
}

function liveBaseline(entry: RegistryEntry): string | boolean {
  switch (entry.kind) {
    case 'text':
      return entry.element.textContent ?? '';
    case 'text_input':
      return (entry.element as HTMLInputElement | HTMLTextAreaElement).value;
    case 'checkbox':
      return (entry.element as HTMLInputElement).checked;
    case 'select':
      return (entry.element as HTMLSelectElement).value;
    case 'button':
      return buttonText(entry.element);
  }
}

function ensureCurrent(ctx: DomContext): void {
  const current = fingerprintDocument(ctx.doc, ctx.url);
  if (current !== ctx.fingerprint) {
    throw new ActionFailure('页面结构已发生变化，请重新分析网页并生成计划', 'stale');
  }
}

function requireEntry(ctx: DomContext, action: PlanAction): RegistryEntry {
  const entry = ctx.registry.get(action.target);
  if (!entry) throw new ActionFailure(`目标元素 ${action.target} 不存在或已失效`, 'stale');
  if (!entry.element.isConnected) throw new ActionFailure('目标元素已从页面移除', 'stale');
  if (entry.descriptor.kind !== expectedKind(action.type)) {
    throw new ActionFailure('操作类型与目标元素不匹配');
  }
  if (liveBaseline(entry) !== entry.baseline) {
    throw new ActionFailure('目标元素内容已发生变化，拒绝覆盖', 'stale');
  }
  if (entry.descriptor.disabled) throw new ActionFailure('目标元素已禁用');
  if (entry.descriptor.readOnly && action.type === 'fill_input') {
    throw new ActionFailure('目标输入框为只读');
  }
  return entry;
}

function expectedKind(type: PlanAction['type']): RegistryEntry['kind'] {
  switch (type) {
    case 'replace_text':
      return 'text';
    case 'fill_input':
      return 'text_input';
    case 'set_checkbox':
      return 'checkbox';
    case 'select_option':
      return 'select';
    case 'click_element':
      return 'button';
  }
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function performAction(
  ctx: DomContext,
  action: PlanAction,
): { undo?: UndoRecord; note?: string } {
  const entry = requireEntry(ctx, action);
  const before = liveBaseline(entry);
  let after: string | boolean = before;

  switch (action.type) {
    case 'replace_text': {
      if (typeof action.value !== 'string') throw new ActionFailure('替换文本缺少 value');
      entry.element.textContent = action.value;
      const achieved = entry.element.textContent ?? '';
      if (normalizeText(achieved) !== normalizeText(action.value)) {
        throw new ActionFailure('文本替换后校验失败');
      }
      after = achieved;
      entry.descriptor.label = action.value.slice(0, 300);
      break;
    }
    case 'fill_input': {
      if (typeof action.value !== 'string') throw new ActionFailure('填写输入框缺少 value');
      const element = entry.element as HTMLInputElement | HTMLTextAreaElement;
      if (element instanceof HTMLInputElement && element.type === 'number') {
        if (action.value.trim() !== '' && Number.isNaN(Number(action.value))) {
          throw new ActionFailure('数字输入框的 value 不是有效数字');
        }
      }
      setNativeValue(element, action.value);
      dispatchInputEvents(element);
      if (element.value !== action.value) throw new ActionFailure('输入框写入后校验失败');
      after = element.value;
      entry.descriptor.value = action.value.slice(0, 200);
      break;
    }
    case 'set_checkbox': {
      if (typeof action.value !== 'boolean') throw new ActionFailure('复选框缺少布尔值');
      const element = entry.element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (setter) setter.call(element, action.value);
      else element.checked = action.value;
      dispatchInputEvents(element);
      if (element.checked !== action.value) throw new ActionFailure('复选框状态校验失败');
      after = element.checked;
      entry.descriptor.checked = element.checked;
      break;
    }
    case 'select_option': {
      if (typeof action.value !== 'string') throw new ActionFailure('下拉选择缺少 value');
      const element = entry.element as HTMLSelectElement;
      const option = [...element.options].find((item) => item.value === action.value);
      if (!option) throw new ActionFailure('目标下拉选项不存在');
      element.value = action.value;
      dispatchInputEvents(element);
      if (element.value !== action.value) throw new ActionFailure('下拉选择校验失败');
      after = element.value;
      entry.descriptor.value = action.value.slice(0, 200);
      break;
    }
    case 'click_element': {
      if (!entry.descriptor.safeToClick) {
        throw new ActionFailure(entry.descriptor.riskReason ?? '该控件不在安全点击范围内');
      }
      if (entry.insideForm) throw new ActionFailure('控件位于表单内，已拒绝点击');
      if (textLooksHighRisk(buttonText(entry.element))) {
        throw new ActionFailure('控件语义可能产生外部影响，已拒绝点击');
      }
      entry.element.click();
      if (!entry.element.isConnected) {
        return { note: '点击已触发，页面结构随之变化；外部效果无法自动撤销' };
      }
      return { note: '点击已触发；该操作不可撤销' };
    }
  }

  entry.baseline = after;
  return {
    undo: {
      actionId: action.actionId,
      type: action.type,
      target: action.target,
      before,
      after,
      pageFingerprint: ctx.fingerprint,
    },
  };
}

export function executeActions(ctx: DomContext, actions: PlanAction[]): ExecuteReport {
  const results: ExecuteActionResult[] = [];
  const undo: UndoRecord[] = [];

  try {
    ensureCurrent(ctx);
  } catch (error) {
    return {
      ok: false,
      stale: true,
      results,
      undo,
      error: error instanceof Error ? error.message : '页面已发生变化',
    };
  }

  for (const action of actions) {
    try {
      ensureCurrent(ctx);
      const outcome = performAction(ctx, action);
      if (outcome.undo) undo.push(outcome.undo);
      results.push({
        actionId: action.actionId,
        ok: true,
        undoable: Boolean(outcome.undo),
        note: outcome.note,
      });
    } catch (error) {
      const failure = error instanceof ActionFailure ? error : null;
      results.push({
        actionId: action.actionId,
        ok: false,
        error: error instanceof Error ? error.message : '操作失败',
        undoable: false,
      });
      return {
        ok: false,
        stale: failure?.kind === 'stale',
        results,
        undo,
        error: error instanceof Error ? error.message : '操作失败',
      };
    }
  }

  return { ok: true, stale: false, results, undo };
}

function restoreEntry(entry: RegistryEntry, record: UndoRecord): void {
  switch (record.type) {
    case 'replace_text': {
      if (typeof record.before !== 'string') throw new ActionFailure('撤销记录不完整');
      entry.element.textContent = record.before;
      if ((entry.element.textContent ?? '') !== record.before) {
        throw new ActionFailure('文本恢复后校验失败');
      }
      break;
    }
    case 'fill_input': {
      if (typeof record.before !== 'string') throw new ActionFailure('撤销记录不完整');
      const element = entry.element as HTMLInputElement | HTMLTextAreaElement;
      setNativeValue(element, record.before);
      dispatchInputEvents(element);
      if (element.value !== record.before) throw new ActionFailure('输入框恢复后校验失败');
      break;
    }
    case 'set_checkbox': {
      if (typeof record.before !== 'boolean') throw new ActionFailure('撤销记录不完整');
      const element = entry.element as HTMLInputElement;
      element.checked = record.before;
      dispatchInputEvents(element);
      if (element.checked !== record.before) throw new ActionFailure('复选框恢复后校验失败');
      break;
    }
    case 'select_option': {
      if (typeof record.before !== 'string') throw new ActionFailure('撤销记录不完整');
      const element = entry.element as HTMLSelectElement;
      const option = [...element.options].find((item) => item.value === record.before);
      if (!option) throw new ActionFailure('原下拉选项已不存在，无法安全撤销');
      element.value = record.before;
      dispatchInputEvents(element);
      if (element.value !== record.before) throw new ActionFailure('下拉选择恢复后校验失败');
      break;
    }
    case 'click_element':
      throw new ActionFailure('点击操作不可撤销');
  }
  entry.baseline = record.before;
}

export function undoActions(ctx: DomContext, records: UndoRecord[]): UndoReport {
  const results: Array<{ actionId: string; ok: boolean; error?: string }> = [];
  try {
    ensureCurrent(ctx);
  } catch (error) {
    return {
      ok: false,
      results,
      error: error instanceof Error ? error.message : '页面已发生变化',
    };
  }

  for (const record of [...records].reverse()) {
    try {
      const entry = ctx.registry.get(record.target);
      if (!entry || !entry.element.isConnected) {
        throw new ActionFailure('目标元素不存在，无法撤销', 'stale');
      }
      if (liveBaseline(entry) !== record.after) {
        throw new ActionFailure('页面内容在修改后已再次变化，拒绝覆盖', 'conflict');
      }
      restoreEntry(entry, record);
      results.push({ actionId: record.actionId, ok: true });
    } catch (error) {
      results.push({
        actionId: record.actionId,
        ok: false,
        error: error instanceof Error ? error.message : '撤销失败',
      });
      return {
        ok: false,
        results,
        error: error instanceof Error ? error.message : '撤销失败',
      };
    }
  }
  return { ok: true, results };
}
