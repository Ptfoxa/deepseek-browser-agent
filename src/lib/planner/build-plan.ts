import type {
  ActionPreview,
  PageElement,
  PageSnapshot,
} from '../../types/messages';
import type { ActionPlan, ModelPlan, PlanAction } from '../../types/plan';
import { assessActionRisk } from '../security/risk';
import { truncate } from '../page/extract';

export type PlanBuildErrorCode =
  | 'invalid_target'
  | 'unsupported_action'
  | 'high_risk'
  | 'invalid_parameters'
  | 'empty_plan';

export class PlanBuildError extends Error {
  code: PlanBuildErrorCode;
  detail: string;

  constructor(code: PlanBuildErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'PlanBuildError';
    this.code = code;
    this.detail = detail;
  }
}

export interface BuildPlanContext {
  tabId: number;
  snapshot: PageSnapshot;
  fingerprint: string;
  now?: number;
  taskId?: string;
}

export interface BuiltPlan {
  plan: ActionPlan;
  previews: ActionPreview[];
}

const PLAN_TTL_MS = 10 * 60 * 1000;

function expectedKind(type: PlanAction['type']): PageElement['kind'] {
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

function displayValue(element: PageElement): string {
  switch (element.kind) {
    case 'text':
      return element.label;
    case 'text_input':
      return element.value ?? '';
    case 'checkbox':
      return element.checked ? '已勾选' : '未勾选';
    case 'select': {
      const option = element.options?.find((item) => item.value === element.value);
      return option?.label ?? element.value ?? '';
    }
    case 'button':
      return element.label;
  }
}

function nextDisplay(element: PageElement, value: string | boolean | undefined): string {
  if (element.kind === 'checkbox') return value === true ? '已勾选' : '未勾选';
  if (element.kind === 'button') return '触发点击';
  if (element.kind === 'select' && typeof value === 'string') {
    const option = element.options?.find((item) => item.value === value);
    return option?.label ?? value;
  }
  return typeof value === 'string' ? value : '';
}

export function buildPlan(modelPlan: ModelPlan, context: BuildPlanContext): BuiltPlan {
  if (modelPlan.actions.length === 0) {
    throw new PlanBuildError('empty_plan', '计划中没有操作');
  }
  const byId = new Map(context.snapshot.elements.map((element) => [element.id, element]));
  const seenTargets = new Set<string>();
  const actions: PlanAction[] = [];
  const previews: ActionPreview[] = [];

  for (const [index, action] of modelPlan.actions.entries()) {
    const element = byId.get(action.target);
    if (!element) {
      throw new PlanBuildError('invalid_target', `目标元素 ${action.target} 不在当前页面快照中`);
    }
    if (element.kind !== expectedKind(action.type)) {
      throw new PlanBuildError('invalid_target', `元素 ${action.target} 不支持该操作`);
    }
    if (element.disabled) {
      throw new PlanBuildError('invalid_target', `元素 ${action.target} 已禁用`);
    }
    if (seenTargets.has(action.target)) {
      throw new PlanBuildError('invalid_parameters', `同一元素 ${action.target} 在一次计划中出现多次`);
    }
    seenTargets.add(action.target);

    const risk = assessActionRisk(action, element);
    if (risk.risk === 'high') {
      throw new PlanBuildError(
        'high_risk',
        '计划包含可能产生外部影响的高风险操作，MVP 不自动执行',
        risk.reason,
      );
    }

    const actionId = `action_${String(index + 1).padStart(3, '0')}`;
    const expected = truncate(nextDisplay(element, action.value), 300) || '清空内容';
    actions.push({
      actionId,
      type: action.type,
      target: action.target,
      ...(action.value === undefined ? {} : { value: action.value }),
      expected,
      risk: risk.risk,
    });
    previews.push({
      actionId,
      type: action.type,
      target: action.target,
      targetLabel: element.label,
      before: truncate(displayValue(element), 300),
      after: truncate(nextDisplay(element, action.value), 300),
      risk: risk.risk,
      undoable: action.type !== 'click_element',
      note:
        action.type === 'click_element'
          ? '点击可能触发页面自身逻辑，无法自动撤销'
          : '仅修改当前页面 DOM，未保存到网站服务器',
    });
  }

  const now = context.now ?? Date.now();
  const taskId =
    context.taskId ?? `task_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const plan: ActionPlan = {
    taskId,
    tabId: context.tabId,
    pageUrl: context.snapshot.url,
    pageFingerprint: context.fingerprint,
    summary: truncate(modelPlan.summary, 300),
    actions,
    riskLevel: 'medium',
    requiresApproval: true,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
  };
  return { plan, previews };
}
