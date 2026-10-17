// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActions, undoActions, type DomContext } from '../../src/lib/page/execute';
import { readPage } from '../../src/lib/page/extract';
import type { PlanAction } from '../../src/types/plan';

let clicked = 0;

function setup(): DomContext {
  document.title = 'Executor fixture';
  document.body.innerHTML = `
    <h1>Old title</h1>
    <input aria-label="Search" value="old query">
    <label>Agree <input type="checkbox" aria-label="Agree"></label>
    <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
    <button id="open">Open settings</button>
    <button id="delete">Delete account</button>
    <form><button>Submit order</button></form>
  `;
  clicked = 0;
  document.getElementById('open')?.addEventListener('click', () => {
    clicked += 1;
  });
  const result = readPage(document, 'https://example.com/page');
  return {
    doc: document,
    url: 'https://example.com/page',
    fingerprint: result.fingerprint,
    registry: result.registry,
  };
}

function findId(ctx: DomContext, label: string): string {
  const entry = [...ctx.registry.entries()].find(([, value]) => value.descriptor.label.includes(label));
  if (!entry) throw new Error(`Missing element: ${label}`);
  return entry[0];
}

function action(
  actionId: string,
  type: PlanAction['type'],
  target: string,
  value?: string | boolean,
): PlanAction {
  return {
    actionId,
    type,
    target,
    ...(value === undefined ? {} : { value }),
    risk: 'medium',
  };
}

describe('allow-listed action executor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('executes approved actions, verifies state, and supports undo', () => {
    const ctx = setup();
    const actions = [
      action('action_001', 'replace_text', findId(ctx, 'Old title'), 'New title'),
      action('action_002', 'fill_input', findId(ctx, 'Search'), 'new query'),
      action('action_003', 'set_checkbox', findId(ctx, 'Agree'), true),
      action('action_004', 'select_option', findId(ctx, 'Color'), 'blue'),
      action('action_005', 'click_element', findId(ctx, 'Open settings')),
    ];
    const report = executeActions(ctx, actions);
    expect(report.ok, report.results.map((result) => result.error).join(' | ')).toBe(true);
    expect(report.results.every((result) => result.ok)).toBe(true);
    expect(document.querySelector('h1')?.textContent).toBe('New title');
    expect((document.querySelector('input[aria-label="Search"]') as HTMLInputElement).value).toBe('new query');
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('blue');
    expect(clicked).toBe(1);
    expect(report.undo).toHaveLength(4);
    expect(report.results.find((result) => result.actionId === 'action_005')?.undoable).toBe(false);

    const undo = undoActions(ctx, report.undo);
    expect(undo.ok).toBe(true);
    expect(document.querySelector('h1')?.textContent).toBe('Old title');
    expect((document.querySelector('input[aria-label="Search"]') as HTMLInputElement).value).toBe('old query');
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('red');
  });

  it('rejects unknown or mismatched targets before mutation', () => {
    const ctx = setup();
    const mismatch = executeActions(ctx, [
      action('action_001', 'fill_input', findId(ctx, 'Old title'), 'x'),
    ]);
    expect(mismatch.ok).toBe(false);
    expect(document.querySelector('h1')?.textContent).toBe('Old title');

    const missing = executeActions(ctx, [
      { actionId: 'action_001', type: 'replace_text', target: 'el_999', value: 'x', risk: 'medium' },
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.stale).toBe(true);
  });

  it('stops when the page structure changes and does not overwrite newer user edits', () => {
    const ctx = setup();
    const titleId = findId(ctx, 'Old title');
    const stale = executeActions(ctx, [action('action_001', 'replace_text', titleId, 'New title')]);
    expect(stale.ok).toBe(true);

    document.querySelector('h1')!.textContent = 'User edit';
    const undo = undoActions(ctx, stale.undo);
    expect(undo.ok).toBe(false);
    expect(undo.error).toContain('再次变化');
    expect(document.querySelector('h1')?.textContent).toBe('User edit');

    const fresh = setup();
    document.body.appendChild(document.createElement('div'));
    const changed = executeActions(fresh, [
      action('action_001', 'replace_text', findId(fresh, 'Old title'), 'New title'),
    ]);
    expect(changed.ok).toBe(false);
    expect(changed.stale).toBe(true);
    expect(document.querySelector('h1')?.textContent).toBe('Old title');
  });

  it('refuses high-impact clicks without dispatching them', () => {
    const ctx = setup();
    const deleteId = findId(ctx, 'Delete');
    const deleteButton = document.getElementById('delete');
    const handler = vi.fn();
    deleteButton?.addEventListener('click', handler);
    const report = executeActions(ctx, [action('action_001', 'click_element', deleteId)]);
    expect(report.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    const formCtx = setup();
    const submitId = findId(formCtx, 'Submit order');
    const formReport = executeActions(formCtx, [action('action_001', 'click_element', submitId)]);
    expect(formReport.ok).toBe(false);
  });
});
