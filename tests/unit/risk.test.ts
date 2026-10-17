import { describe, expect, it } from 'vitest';
import { assessClickSafety, textLooksHighRisk } from '../../src/lib/security/risk';

describe('risk classifier', () => {
  it('flags external-impact wording in Chinese and English', () => {
    for (const text of ['Delete account', 'Send message', '立即购买', '提交订单', '发布内容']) {
      expect(textLooksHighRisk(text)).toBe(true);
    }
  });

  it('allows a plain button outside a form', () => {
    expect(
      assessClickSafety({
        text: '展开更多',
        tag: 'button',
        type: 'button',
        disabled: false,
        insideForm: false,
      }).safe,
    ).toBe(true);
  });

  it('rejects form buttons, submit buttons, links, disabled controls and dangerous wording', () => {
    const base = {
      text: 'Open',
      tag: 'button',
      type: 'button',
      disabled: false,
      insideForm: false,
    };
    expect(assessClickSafety({ ...base, insideForm: true }).safe).toBe(false);
    expect(assessClickSafety({ ...base, type: 'submit' }).safe).toBe(false);
    expect(assessClickSafety({ ...base, tag: 'a' }).safe).toBe(false);
    expect(assessClickSafety({ ...base, disabled: true }).safe).toBe(false);
    expect(assessClickSafety({ ...base, text: '确认付款' }).safe).toBe(false);
  });
});
