import { describe, expect, it } from 'vitest';
import { approvalMatches, createApproval, hashPlan } from '../../src/lib/security/approval';
import { ActionPlanSchema, type ActionPlan } from '../../src/types/plan';

function makePlan(): ActionPlan {
  return ActionPlanSchema.parse({
    taskId: 'task_abcdef123456',
    tabId: 7,
    pageUrl: 'https://example.com/page',
    pageFingerprint: 'b'.repeat(16),
    summary: '修改标题',
    actions: [
      {
        actionId: 'action_001',
        type: 'replace_text',
        target: 'el_001',
        value: '新标题',
        risk: 'medium',
      },
    ],
    riskLevel: 'medium',
    requiresApproval: true,
    createdAt: 1000,
    expiresAt: 100_000,
  });
}

describe('plan authorization', () => {
  it('binds approval to a stable plan hash', async () => {
    const plan = makePlan();
    const hash = await hashPlan(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPlan(plan)).toBe(hash);
    const tampered = { ...plan, summary: '另一个计划' };
    expect(await hashPlan(tampered)).not.toBe(hash);
    const approval = createApproval(plan, hash, 2000);
    expect(approvalMatches(approval, plan, hash, 2000).ok).toBe(true);
    expect(approvalMatches(approval, plan, hash, 200_000).ok).toBe(false);
    expect(approvalMatches({ ...approval, consumed: true }, plan, hash, 2000).ok).toBe(false);
    expect(approvalMatches(approval, plan, 'c'.repeat(64), 2000).ok).toBe(false);
  });

  it('rejects approval after the page fingerprint changes', async () => {
    const plan = makePlan();
    const hash = await hashPlan(plan);
    const approval = { ...createApproval(plan, hash, 2000), pageFingerprint: 'd'.repeat(16) };
    expect(approvalMatches(approval, plan, hash, 2000).ok).toBe(false);
  });
});
