import type { ActionPlan, PlanApproval } from '../../types/plan';

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

export function canonicalPlan(plan: ActionPlan): string {
  return JSON.stringify({
    taskId: plan.taskId,
    tabId: plan.tabId,
    pageUrl: plan.pageUrl,
    pageFingerprint: plan.pageFingerprint,
    summary: plan.summary,
    actions: plan.actions.map((action) => ({
      actionId: action.actionId,
      type: action.type,
      target: action.target,
      value: action.value ?? null,
      expected: action.expected,
      risk: action.risk,
    })),
    riskLevel: plan.riskLevel,
    requiresApproval: plan.requiresApproval,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  });
}

export async function hashPlan(plan: ActionPlan): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPlan(plan));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createApproval(
  plan: ActionPlan,
  planHash: string,
  now = Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
): PlanApproval {
  return {
    planHash,
    tabId: plan.tabId,
    pageFingerprint: plan.pageFingerprint,
    expiresAt: Math.min(plan.expiresAt, now + ttlMs),
    consumed: false,
  };
}

export function approvalMatches(
  approval: PlanApproval | null | undefined,
  plan: ActionPlan,
  planHash: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!approval) return { ok: false, reason: '没有有效的用户授权' };
  if (approval.consumed) return { ok: false, reason: '该授权已经使用过' };
  if (approval.planHash !== planHash) return { ok: false, reason: '授权与当前计划不匹配' };
  if (approval.tabId !== plan.tabId) return { ok: false, reason: '目标标签页已改变' };
  if (approval.pageFingerprint !== plan.pageFingerprint) {
    return { ok: false, reason: '页面状态已改变' };
  }
  if (approval.expiresAt <= now || plan.expiresAt <= now) {
    return { ok: false, reason: '授权已过期，请重新生成计划' };
  }
  return { ok: true };
}
