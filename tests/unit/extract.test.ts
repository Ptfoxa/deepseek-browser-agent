// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readPage } from '../../src/lib/page/extract';

function fixture() {
  document.title = 'Fixture page';
  document.body.innerHTML = `
    <h1>Old title</h1>
    <p>Contact user@example.com or 13812345678. Card 4111 1111 1111 1111.</p>
    <form>
      <input aria-label="Username" value="alice">
      <input type="password" aria-label="Password" value="P@ssw0rd!">
      <input type="email" aria-label="Email" value="user@example.com">
      <label>Agree <input type="checkbox" aria-label="Agree"></label>
      <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <button>Submit order</button>
    </form>
    <button>Open settings</button>
    <button>Delete account</button>
    <a href="https://example.com/private?token=SECRET#frag">Private link</a>
    <script>window.secret = "should-not-appear"</script>
    <style>.hidden { display: none }</style>
  `;
}

describe('page extraction', () => {
  it('collects bounded page context and never includes sensitive values', () => {
    fixture();
    const { snapshot } = readPage(document, 'https://example.com/page');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('P@ssw0rd!');
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toContain('13812345678');
    expect(serialized).not.toContain('should-not-appear');
    expect(snapshot.sensitiveFieldCount).toBe(2);
    expect(snapshot.forms).toHaveLength(1);
    expect(snapshot.forms[0]?.fieldCount).toBeGreaterThanOrEqual(4);
    expect(snapshot.elements.find((element) => element.label === 'Username')?.formIndex).toBe(0);
    expect(snapshot.links[0]?.href).toBe('https://example.com/private');
    expect(snapshot.links[0]?.href).not.toContain('token');
    expect(snapshot.text).toContain('[邮箱已隐藏]');
    expect(snapshot.text).toContain('[手机号已隐藏]');
  });

  it('marks dangerous and form-bound buttons as unsafe but keeps plain controls', () => {
    fixture();
    const { snapshot } = readPage(document, 'https://example.com/page');
    const submit = snapshot.elements.find((element) => element.label.includes('Submit order'));
    const settings = snapshot.elements.find((element) => element.label.includes('Open settings'));
    const remove = snapshot.elements.find((element) => element.label.includes('Delete'));
    expect(submit?.safeToClick).toBe(false);
    expect(remove?.safeToClick).toBe(false);
    expect(settings?.safeToClick).toBe(true);
  });

  it('assigns unique ids and truncates long page text', () => {
    document.title = 'Long';
    document.body.innerHTML = `<p>${'内容'.repeat(4000)}</p>`;
    const { snapshot, fingerprint } = readPage(document, 'https://example.com/long');
    expect(snapshot.text.length).toBeLessThanOrEqual(6000);
    expect(snapshot.truncated).toBe(true);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const ids = snapshot.elements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
