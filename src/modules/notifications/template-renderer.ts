/**
 * Safe, explicit message templates: `{{variable}}` placeholders from a fixed whitelist and nothing else.
 * No expressions, no helpers, no partials, no code evaluation. Unknown variables and any other `{{ … }}`,
 * `{% … %}`, `${ … }` or script-like construct are rejected when a template is published, and values are
 * only ever substituted as plain text (HTML is escaped by `toHtml`).
 */

export const TEMPLATE_VARIABLES = [
  'customerName',
  'brandName',
  'sampleNumber',
  'orderNumber',
  'jobNumber',
  'shipmentNumber',
  'quotationNumber',
  'currentStage',
  'stageName',
  'targetDate',
  'trackingLink',
  'milestone',
  'reason',
  'recipientName',
  'alertTitle',
  'alertReason',
  'severity',
  'escalationLevel',
  'productName',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
const ALLOWED = new Set<string>(TEMPLATE_VARIABLES);

export const MAX_SUBJECT = 200;
export const MAX_BODY = 4000;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FORBIDDEN: [RegExp, string][] = [
  [/\{%|%\}/, 'template tags ({% … %})'],
  [/\$\{/, 'template literals (${ … })'],
  [/`/, 'backticks'],
  [/<\s*script/i, 'script elements'],
  [/javascript:/i, 'javascript: URLs'],
  [/\bon\w+\s*=/i, 'inline event handlers'],
  [/\{\{\{|\}\}\}/, 'triple braces'],
];

export interface TemplateCheck {
  ok: boolean;
  errors: string[];
  variables: string[];
}

export function checkTemplate(text: string, max = MAX_BODY): TemplateCheck {
  const errors: string[] = [];
  const used = new Set<string>();
  if (text.length === 0) errors.push('The template is empty');
  if (text.length > max)
    errors.push(`The template is longer than ${max} characters`);
  for (const [re, label] of FORBIDDEN)
    if (re.test(text)) errors.push(`Not allowed: ${label}`);
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1]!.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name))
      errors.push(
        `Unsupported placeholder "{{${m[1]}}}": only plain variable names are allowed`,
      );
    else if (!ALLOWED.has(name)) errors.push(`Unknown variable "${name}"`);
    else used.add(name);
  }
  // a stray brace pair that did not form a placeholder
  const stripped = text.replace(PLACEHOLDER, '');
  if (/\{\{|\}\}/.test(stripped)) errors.push('Unbalanced "{{" or "}}"');
  return { ok: errors.length === 0, errors, variables: [...used] };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

type Scalar = string | number | boolean | null | undefined;

/** Control characters are removed from values; length is capped. */
export function cleanValue(value: Scalar): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(CONTROL_CHARS, '').slice(0, 300);
}

export function render(
  template: string,
  vars: Partial<Record<string, Scalar>>,
): string {
  const check = checkTemplate(template, Number.MAX_SAFE_INTEGER);
  if (!check.ok)
    throw new Error(`Invalid template: ${check.errors.join('; ')}`);
  return template.replace(PLACEHOLDER, (_, raw: string) =>
    cleanValue(vars[raw.trim()]),
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text → minimal, safe HTML (escaped, paragraphs and line breaks). */
export function toHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Redacts bearer-like secrets before anything is stored or logged. */
export function assertNoSecrets(value: unknown, path = 'payload'): void {
  const SECRET_KEY =
    /(password|passwd|secret|token|authorization|signedurl|signed_url|apikey|api_key|cardnumber|cvv|iban)/i;
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k))
      throw new Error(
        `${path}.${k} looks like a secret and must not be persisted`,
      );
    if (
      typeof v === 'string' &&
      /^(Bearer\s+\S+|eyJ[A-Za-z0-9_-]{20,}\.)/.test(v)
    )
      throw new Error(
        `${path}.${k} looks like a credential and must not be persisted`,
      );
    if (
      typeof v === 'string' &&
      /[?&](signature|sig|X-Amz-Signature|expires)=/i.test(v)
    )
      throw new Error(
        `${path}.${k} looks like a signed URL and must not be persisted`,
      );
    assertNoSecrets(v, `${path}.${k}`);
  }
}
