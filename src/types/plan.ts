import { z } from 'zod';

export const ACTION_TYPES = [
  'replace_text',
  'fill_input',
  'set_checkbox',
  'select_option',
  'click_element',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const ActionTypeSchema = z.enum(ACTION_TYPES);
export const ElementIdSchema = z.string().regex(/^el_\d{3}$/, 'invalid element id');
export const PageFingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/, 'invalid page fingerprint');
export const PlanHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'invalid plan hash');

const ActionValueSchema = z.union([z.string().max(2000), z.boolean()]);

export const ModelActionSchema = z
  .object({
    type: ActionTypeSchema,
    target: ElementIdSchema,
    value: ActionValueSchema.optional(),
    reason: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    switch (action.type) {
      case 'replace_text':
        if (typeof action.value !== 'string' || action.value.trim().length === 0) {
          ctx.addIssue({ code: 'custom', message: 'replace_text requires a non-empty string value' });
        }
        break;
      case 'fill_input':
        if (typeof action.value !== 'string') {
          ctx.addIssue({ code: 'custom', message: 'fill_input requires a string value' });
        }
        break;
      case 'set_checkbox':
        if (typeof action.value !== 'boolean') {
          ctx.addIssue({ code: 'custom', message: 'set_checkbox requires a boolean value' });
        }
        break;
      case 'select_option':
        if (typeof action.value !== 'string' || action.value.length === 0) {
          ctx.addIssue({ code: 'custom', message: 'select_option requires a non-empty string value' });
        }
        break;
      case 'click_element':
        if (action.value !== undefined) {
          ctx.addIssue({ code: 'custom', message: 'click_element must not carry a value' });
        }
        break;
    }
  });

export type ModelAction = z.infer<typeof ModelActionSchema>;

export const ModelPlanSchema = z
  .object({
    summary: z.string().min(1).max(300),
    actions: z.array(ModelActionSchema).min(1).max(8),
  })
  .strict();

export type ModelPlan = z.infer<typeof ModelPlanSchema>;

export const ModelResponseSchema = z
  .object({
    reply: z.string().min(1).max(2000),
    plan: ModelPlanSchema.nullable(),
  })
  .strict();

export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PlanActionSchema = z
  .object({
    actionId: z.string().regex(/^action_\d{3}$/),
    type: ActionTypeSchema,
    target: ElementIdSchema,
    value: ActionValueSchema.optional(),
    risk: RiskLevelSchema,
  })
  .strict();

export type PlanAction = z.infer<typeof PlanActionSchema>;

export const ActionPlanSchema = z
  .object({
    taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
    tabId: z.number().int().positive(),
    pageUrl: z.string().url().max(2048),
    pageFingerprint: PageFingerprintSchema,
    summary: z.string().min(1).max(300),
    actions: z.array(PlanActionSchema).min(1).max(8),
    riskLevel: RiskLevelSchema,
    requiresApproval: z.literal(true),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export type ActionPlan = z.infer<typeof ActionPlanSchema>;

export const PlanApprovalSchema = z
  .object({
    planHash: PlanHashSchema,
    tabId: z.number().int().positive(),
    pageFingerprint: PageFingerprintSchema,
    expiresAt: z.number().int().nonnegative(),
    consumed: z.boolean(),
  })
  .strict();

export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

export const UndoRecordSchema = z
  .object({
    actionId: z.string().regex(/^action_\d{3}$/),
    type: ActionTypeSchema,
    target: ElementIdSchema,
    before: z.union([z.string(), z.boolean()]),
    after: z.union([z.string(), z.boolean()]),
    pageFingerprint: PageFingerprintSchema,
  })
  .strict();

export type UndoRecord = z.infer<typeof UndoRecordSchema>;
