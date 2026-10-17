import { describe, expect, it } from 'vitest';
import { ActionPlanSchema, ModelResponseSchema } from '../../src/types/plan';
import { ModelOutputError, parseModelOutput } from '../../src/lib/planner/parse';

const validResponse = {
  reply: '可以修改标题',
  plan: {
    summary: '修改标题',
    actions: [{ type: 'replace_text', target: 'el_001', value: '新标题' }],
  },
};

describe('structured plan protocol', () => {
  it('accepts a valid model response', () => {
    expect(ModelResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects arbitrary selectors and unknown extra fields', () => {
    const injected = {
      reply: '执行',
      plan: {
        summary: '注入',
        actions: [
          {
            type: 'click_element',
            target: 'el_001',
            selector: '#danger',
          },
        ],
      },
    };
    expect(ModelResponseSchema.safeParse(injected).success).toBe(false);
    expect(() => parseModelOutput(JSON.stringify(injected))).toThrow(ModelOutputError);
  });

  it('rejects unknown action types and malformed values', () => {
    const unknown = {
      reply: '执行',
      plan: { summary: '执行 JS', actions: [{ type: 'run_js', target: 'el_001', value: 'alert(1)' }] },
    };
    expect(ModelResponseSchema.safeParse(unknown).success).toBe(false);
    expect(
      ModelResponseSchema.safeParse({
        reply: '勾选',
        plan: { summary: '勾选', actions: [{ type: 'set_checkbox', target: 'el_001', value: 'yes' }] },
      }).success,
    ).toBe(false);
    expect(
      ModelResponseSchema.safeParse({
        reply: '点击',
        plan: { summary: '点击', actions: [{ type: 'click_element', target: 'el_001', value: true }] },
      }).success,
    ).toBe(false);
  });

  it('caps action count and target ids', () => {
    const tooMany = {
      reply: '很多操作',
      plan: {
        summary: '批量',
        actions: Array.from({ length: 9 }, () => ({
          type: 'replace_text',
          target: 'el_001',
          value: 'x',
        })),
      },
    };
    expect(ModelResponseSchema.safeParse(tooMany).success).toBe(false);
    expect(
      ModelResponseSchema.safeParse({
        reply: 'x',
        plan: {
          summary: 'x',
          actions: [{ type: 'replace_text', target: 'body > h1', value: 'x' }],
        },
      }).success,
    ).toBe(false);
  });

  it('requires all stored plan fields and an approval flag', () => {
    const plan = {
      taskId: 'task_abcdef123456',
      tabId: 1,
      pageUrl: 'https://example.com/',
      pageFingerprint: 'a'.repeat(16),
      summary: 'x',
      actions: [
        {
          actionId: 'action_001',
          type: 'replace_text',
          target: 'el_001',
          value: 'y',
          risk: 'medium',
        },
      ],
      riskLevel: 'medium',
      requiresApproval: false,
      createdAt: 1,
      expiresAt: 2,
    };
    expect(ActionPlanSchema.safeParse(plan).success).toBe(false);
    expect(ActionPlanSchema.safeParse({ ...plan, requiresApproval: true }).success).toBe(true);
  });

  it('parses JSON wrapped in surrounding prose but never executes it', () => {
    const parsed = parseModelOutput(`模型说明：\n\`\`\`json\n${JSON.stringify(validResponse)}\n\`\`\``);
    expect(parsed.plan?.actions[0]?.type).toBe('replace_text');
    expect(() => parseModelOutput('alert(document.cookie)')).toThrow(ModelOutputError);
  });
});
