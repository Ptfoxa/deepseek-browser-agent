import type { ElementKind, PageElement, PageSnapshot } from '../../types/messages';
import { redactPii } from '../security/sanitize';
import { assessClickSafety } from '../security/risk';
import { fingerprintDocument } from './fingerprint';

export const PAGE_LIMITS = {
  text: 6000,
  headings: 40,
  links: 40,
  elements: 120,
  label: 120,
  value: 200,
  options: 30,
  optionLabel: 80,
} as const;

const ELEMENT_SELECTOR =
  'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,input,textarea,select,button,[role="button"]';

const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'TD', 'TH']);
const FILLABLE_TYPES = new Set(['text', 'search', 'url', 'number']);
const SENSITIVE_TYPES = new Set(['password', 'hidden', 'file', 'email', 'tel']);
const SENSITIVE_HINTS = [
  'password',
  'passwd',
  'passcode',
  'secret',
  'token',
  '密码',
  '口令',
  '验证码',
  '卡号',
  'cvv',
  'cvc',
  'ssn',
  '身份证',
  'social security',
  'one-time',
  'otp',
  '邮箱',
  '手机',
  '电话',
  'email',
  'phone',
];

export interface RegistryEntry {
  element: HTMLElement;
  kind: ElementKind;
  descriptor: PageElement;
  baseline: string | boolean;
  insideForm: boolean;
}

export interface ReadPageResult {
  snapshot: PageSnapshot;
  fingerprint: string;
  registry: Map<string, RegistryEntry>;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function elementText(element: Element): string {
  const withInnerText = element as HTMLElement & { innerText?: string };
  const raw = typeof withInnerText.innerText === 'string' ? withInnerText.innerText : element.textContent ?? '';
  return normalizeText(raw);
}

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function fieldHints(element: HTMLElement): string {
  return [
    element.getAttribute('name'),
    element.id,
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element.getAttribute('autocomplete'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isSensitiveField(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && SENSITIVE_TYPES.has(element.type)) return true;
  if (element instanceof HTMLInputElement && element.type === 'checkbox') return false;
  const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
  if (
    autocomplete.startsWith('cc-') ||
    autocomplete.includes('one-time-code') ||
    autocomplete.includes('current-password') ||
    autocomplete.includes('new-password')
  ) {
    return true;
  }
  const hints = fieldHints(element);
  return SENSITIVE_HINTS.some((hint) => hints.includes(hint));
}

function labelForField(element: HTMLElement, fallback: string): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return truncate(redactPii(normalizeText(aria)), PAGE_LIMITS.label);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = element.labels ? [...element.labels] : [];
    const labelText = labels.map((label) => elementText(label)).filter(Boolean).join(' ');
    if (labelText) return truncate(redactPii(labelText), PAGE_LIMITS.label);
  }
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) return truncate(redactPii(normalizeText(placeholder)), PAGE_LIMITS.label);
  const name = element.getAttribute('name') ?? element.id;
  if (name) return truncate(redactPii(normalizeText(name)), PAGE_LIMITS.label);
  return truncate(redactPii(fallback), PAGE_LIMITS.label);
}

function safeHref(raw: string, baseUrl: string): string {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return truncate(`${url.origin}${url.pathname}`, 300);
  } catch {
    return '';
  }
}

function extractVisibleText(doc: Document): { text: string; truncated: boolean } {
  const body = doc.body;
  if (!body) return { text: '', truncated: false };
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script,style,noscript,template,svg,iframe,canvas').forEach((node) => node.remove());
  const inner = normalizeText((body as HTMLElement & { innerText?: string }).innerText ?? '');
  const fallback = normalizeText(clone.textContent ?? '');
  const combined = inner.length >= fallback.length * 0.5 ? inner : fallback;
  const redacted = redactPii(combined);
  return {
    text: redacted.slice(0, PAGE_LIMITS.text),
    truncated: redacted.length > PAGE_LIMITS.text,
  };
}

function buildTextDescriptor(element: HTMLElement): PageElement | null {
  const text = elementText(element);
  if (text.length < 2 || text.length > 500) return null;
  if (element.querySelector('a,button,input,textarea,select,img,svg,video,iframe')) return null;
  if (element.closest('a,button,[role="button"]')) return null;
  if (!isVisible(element)) return null;
  return {
    id: '',
    kind: 'text',
    tag: element.tagName.toLowerCase(),
    label: truncate(redactPii(text), 300),
    disabled: false,
    readOnly: false,
  };
}

function buildFieldDescriptor(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): { descriptor: PageElement; baseline: string | boolean } | null {
  if (!isVisible(element)) return null;
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') {
      const baseline = element.checked;
      return {
        baseline,
        descriptor: {
          id: '',
          kind: 'checkbox',
          tag: 'input',
          label: labelForField(element, '复选框'),
          checked: baseline,
          disabled: element.disabled,
          readOnly: element.readOnly,
        },
      };
    }
    if (!FILLABLE_TYPES.has(element.type)) return null;
    if (element.disabled) return null;
    const baseline = element.value;
    return {
      baseline,
      descriptor: {
        id: '',
        kind: 'text_input',
        tag: 'input',
        label: labelForField(element, `输入框 (${element.type})`),
        value: truncate(redactPii(baseline), PAGE_LIMITS.value),
        disabled: element.disabled,
        readOnly: element.readOnly,
      },
    };
  }
  if (element instanceof HTMLTextAreaElement) {
    if (element.disabled) return null;
    const baseline = element.value;
    return {
      baseline,
      descriptor: {
        id: '',
        kind: 'text_input',
        tag: 'textarea',
        label: labelForField(element, '多行输入框'),
        value: truncate(redactPii(baseline), PAGE_LIMITS.value),
        disabled: element.disabled,
        readOnly: element.readOnly,
      },
    };
  }
  if (element instanceof HTMLSelectElement) {
    const options = [...element.options]
      .slice(0, PAGE_LIMITS.options)
      .map((option) => ({
        value: truncate(redactPii(option.value), PAGE_LIMITS.value),
        label: truncate(redactPii(normalizeText(option.text)), PAGE_LIMITS.optionLabel),
      }));
    return {
      baseline: element.value,
      descriptor: {
        id: '',
        kind: 'select',
        tag: 'select',
        label: labelForField(element, '下拉选择框'),
        value: truncate(redactPii(element.value), PAGE_LIMITS.value),
        options,
        disabled: element.disabled,
        readOnly: false,
      },
    };
  }
  return null;
}

function buildButtonDescriptor(element: HTMLElement): PageElement | null {
  if (!isVisible(element)) return null;
  const text =
    element.getAttribute('aria-label') ??
    (element instanceof HTMLInputElement ? element.value : elementText(element)) ??
    element.getAttribute('title') ??
    '';
  const normalized = normalizeText(text);
  const inputType = element instanceof HTMLInputElement ? element.type : 'button';
  const disabled = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.disabled : false;
  const safety = assessClickSafety({
    text: normalized,
    tag: element.tagName.toLowerCase(),
    type: inputType,
    disabled,
    insideForm: Boolean(element.closest('form')),
  });
  return {
    id: '',
    kind: 'button',
    tag: element.tagName.toLowerCase(),
    label: truncate(redactPii(normalized || '未命名按钮'), PAGE_LIMITS.label),
    disabled,
    readOnly: false,
    safeToClick: safety.safe,
    riskReason: safety.reason,
  };
}

export function readPage(doc: Document, url: string): ReadPageResult {
  const registry = new Map<string, RegistryEntry>();
  const elements: PageElement[] = [];
  const candidates = [...doc.querySelectorAll(ELEMENT_SELECTOR)];
  let sensitiveFieldCount = 0;

  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    if (elements.length >= PAGE_LIMITS.elements) break;

    let built: { descriptor: PageElement; baseline: string | boolean } | null = null;
    if (TEXT_TAGS.has(element.tagName)) {
      const descriptor = buildTextDescriptor(element);
      if (descriptor) built = { descriptor, baseline: element.textContent ?? '' };
    } else if (element instanceof HTMLInputElement) {
      if (element.type !== 'checkbox' && isSensitiveField(element)) {
        sensitiveFieldCount += 1;
        continue;
      }
      built = buildFieldDescriptor(element);
    } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (isSensitiveField(element)) {
        sensitiveFieldCount += 1;
        continue;
      }
      built = buildFieldDescriptor(element);
    } else {
      const descriptor = buildButtonDescriptor(element);
      if (descriptor) {
        built = {
          descriptor,
          baseline:
            element instanceof HTMLInputElement
              ? normalizeText(element.value)
              : normalizeText(
                  element.getAttribute('aria-label') ?? elementText(element) ?? element.getAttribute('title') ?? '',
                ),
        };
      }
    }
    if (!built) continue;

    const id = `el_${String(elements.length + 1).padStart(3, '0')}`;
    const descriptor = { ...built.descriptor, id };
    elements.push(descriptor);
    registry.set(id, {
      element,
      kind: descriptor.kind,
      descriptor,
      baseline: built.baseline,
      insideForm: Boolean(element.closest('form')),
    });
  }

  for (const field of doc.querySelectorAll('input,textarea,select')) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (isSensitiveField(field) && field.type !== 'checkbox') {
        if (!elements.some((entry) => registry.get(entry.id)?.element === field)) {
          sensitiveFieldCount += 1;
        }
      }
    }
  }

  const headings = [...doc.querySelectorAll('h1,h2,h3')]
    .map((heading) => truncate(redactPii(elementText(heading)), 160))
    .filter(Boolean)
    .slice(0, PAGE_LIMITS.headings);

  const links = [...doc.querySelectorAll('a[href]')]
    .map((anchor) => ({
      text: truncate(redactPii(elementText(anchor)), 120),
      href: safeHref(anchor.getAttribute('href') ?? '', url),
    }))
    .filter((link) => link.href.length > 0)
    .slice(0, PAGE_LIMITS.links);

  const { text, truncated } = extractVisibleText(doc);
  const snapshot: PageSnapshot = {
    title: truncate(redactPii(normalizeText(doc.title)), 200),
    url,
    text,
    headings,
    links,
    elements,
    formCount: doc.querySelectorAll('form').length,
    sensitiveFieldCount,
    truncated,
    capturedAt: Date.now(),
  };

  return {
    snapshot,
    fingerprint: fingerprintDocument(doc, url),
    registry,
  };
}
