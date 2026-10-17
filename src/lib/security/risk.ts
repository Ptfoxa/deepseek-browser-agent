import type { PageElement } from '../../types/messages';
import type { ModelAction, RiskLevel } from '../../types/plan';

const HIGH_RISK_PATTERNS: RegExp[] = [
  /\b(submit|send|publish|post|delete|remove|buy|purchase|pay|checkout|order|transfer|confirm|approve|unsubscribe|sign\s*out|log\s*out|login|register|book|reserve|donate|withdraw|reset|upgrade|subscribe)\b/i,
  /(提交|发送|发布|删除|移除|购买|支付|付款|下单|转账|确认|注销|登录|注册|退出|预约|订阅|清空|重置|升级|授权)/,
];

const HIGH_RISK_ATTRIBUTES = ['submit', 'reset', 'image'];

export function textLooksHighRisk(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface ClickSafetyInput {
  text: string;
  tag: string;
  type: string;
  disabled: boolean;
  insideForm: boolean;
}

export function assessClickSafety(input: ClickSafetyInput): {
  safe: boolean;
  reason?: string;
} {
  if (input.disabled) return { safe: false, reason: '控件已禁用' };
  if (input.insideForm) return { safe: false, reason: '控件位于表单内，可能提交数据' };
  if (HIGH_RISK_ATTRIBUTES.includes(input.type)) {
    return { safe: false, reason: '按钮可能提交或重置表单' };
  }
  if (input.tag === 'a') {
    return { safe: false, reason: 'MVP 不允许自动点击链接' };
  }
  if (textLooksHighRisk(input.text)) {
    return { safe: false, reason: '按钮文字包含高风险语义' };
  }
  return { safe: true };
}

export function assessActionRisk(action: ModelAction, element: PageElement): {
  risk: RiskLevel;
  reason?: string;
} {
  if (action.type !== 'click_element') {
    return { risk: 'medium' };
  }
  if (!element.safeToClick) {
    return { risk: 'high', reason: element.riskReason ?? '该控件不属于安全点击范围' };
  }
  return { risk: 'medium' };
}
