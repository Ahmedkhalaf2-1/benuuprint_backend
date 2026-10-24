import { CUSTOMER_SAFE_EVENTS } from '../automation/automation-rules.service.js';
import {
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_ESCALATION_RULES,
} from './default-rules.js';
import {
  EVENT_CATEGORY,
  EVENT_TYPES,
  MILESTONES,
  OPTIONAL_CUSTOMER_CATEGORIES,
  milestoneForStage,
  notificationTypeForAlert,
} from './events.js';
import {
  LogEmailProvider,
  LogWhatsAppProvider,
} from './providers/dev-providers.js';
import {
  PermanentProviderError,
  TransientProviderError,
} from './providers/provider.ports.js';
import { addSeconds, backoffSeconds } from './retry-policy.js';
import {
  MILESTONE_LABELS,
  TEMPLATE_CATALOG,
  TEMPLATE_LOCALES,
} from './template-catalog.js';
import {
  TEMPLATE_VARIABLES,
  assertNoSecrets,
  checkTemplate,
  cleanValue,
  escapeHtml,
  render,
  toHtml,
} from './template-renderer.js';

describe('template renderer', () => {
  it('substitutes only whitelisted variables', () => {
    expect(
      render(
        'Hello {{customerName}}, order {{ orderNumber }} is {{milestone}}.',
        { customerName: 'Mona', orderNumber: 'ORD-1', milestone: 'ready' },
      ),
    ).toBe('Hello Mona, order ORD-1 is ready.');
  });
  it('missing values become empty text, never "undefined"', () => {
    expect(render('A{{reason}}B', {})).toBe('AB');
    expect(render('A{{reason}}B', { reason: null })).toBe('AB');
  });
  it('rejects unknown variables and anything that is not a plain variable', () => {
    for (const bad of [
      'Hi {{password}}',
      'Hi {{ constructor }}',
      'Hi {{customerName.toString()}}',
      'Hi {{ 1+1 }}',
      'Hi {{#if x}}',
      'Hi {{{customerName}}}',
      'Hi {% if x %}',
      'Hi ${customerName}',
      'Hi `x`',
      'Hi <script>alert(1)</script>',
      'Hi <a href="javascript:x">',
      'Hi <img onerror=x>',
      'Hi {{customerName',
      'Hi }}',
      '',
    ])
      expect(checkTemplate(bad).ok).toBe(false);
    expect(() => render('{{nope}}', {})).toThrow(/Unknown variable/);
    expect(checkTemplate('{{nope}}').errors[0]).toBe('Unknown variable "nope"');
  });
  it('limits the length and lists the variables used', () => {
    expect(checkTemplate('x'.repeat(5000)).ok).toBe(false);
    expect(
      checkTemplate(
        '{{orderNumber}} {{orderNumber}} {{jobNumber}}',
      ).variables.sort(),
    ).toEqual(['jobNumber', 'orderNumber']);
  });
  it('values are plain text: control characters removed, length capped', () => {
    expect(cleanValue('a\u0000b\u0007c')).toBe('abc');
    expect(cleanValue('x'.repeat(1000))).toHaveLength(300);
    expect(render('{{reason}}', { reason: '{{password}}' })).toBe(
      '{{password}}',
    ); // not re-evaluated
  });
  it('escapes HTML for the email rendition', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
    );
    expect(toHtml('Line1\nLine2\n\nPara <2>')).toBe(
      '<p>Line1<br>Line2</p>\n<p>Para &lt;2&gt;</p>',
    );
  });
  it('refuses to persist secrets', () => {
    expect(() => assertNoSecrets({ orderId: 'x' })).not.toThrow();
    for (const bad of [
      { password: 'x' },
      { nested: { accessToken: 'x' } },
      { authorization: 'Bearer abc' },
      { link: 'https://files/x?X-Amz-Signature=abc' },
      { jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' },
    ])
      expect(() => assertNoSecrets(bad)).toThrow(/must not be persisted/);
  });
});

describe('seeded templates and rules', () => {
  it('every template is valid, uses supported variables and exists in every locale', () => {
    expect(TEMPLATE_LOCALES).toEqual(['en', 'ar']);
    const codes = new Set<string>();
    for (const t of TEMPLATE_CATALOG) {
      expect(codes.has(t.code)).toBe(false);
      codes.add(t.code);
      for (const locale of TEMPLATE_LOCALES) {
        for (const text of [t[locale].title, t[locale].body]) {
          const c = checkTemplate(text);
          expect(c.errors).toEqual([]);
          for (const v of c.variables) expect(TEMPLATE_VARIABLES).toContain(v);
        }
      }
      // both languages use the same placeholders
      const vars = (l: 'en' | 'ar') =>
        new Set([
          ...checkTemplate(t[l].title).variables,
          ...checkTemplate(t[l].body).variables,
        ]);
      expect([...vars('ar')].sort()).toEqual([...vars('en')].sort());
    }
  });
  it('Arabic templates contain Arabic text', () => {
    for (const t of TEMPLATE_CATALOG) {
      const text = (t.ar.title + t.ar.body).replace(/\{\{[^}]*\}\}/g, '');
      // a template made only of placeholders (alert messages carry their own text) has nothing to translate
      if (/^[\s(){}.]*$/.test(text)) continue;
      if (!/[\u0600-\u06ff]/.test(text))
        throw new Error(`No Arabic text in ${t.code}: ${text}`);
    }
  });
  it('every default rule points at a template of the right audience and a supported event', () => {
    for (const r of DEFAULT_AUTOMATION_RULES) {
      expect(EVENT_TYPES).toContain(r.eventType);
      const t = TEMPLATE_CATALOG.find((x) => x.code === r.templateCode);
      expect(t, r.code).toBeDefined();
      expect(t!.audience).toBe(
        r.audience === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF',
      );
      if (r.audience === 'CUSTOMER') {
        expect(CUSTOMER_SAFE_EVENTS as readonly string[]).toContain(
          r.eventType,
        );
        expect(r.channels).not.toContain('IN_APP');
      }
      if (r.audience === 'ROLE' || r.audience === 'PERMISSION')
        expect(r.audienceValue).toBeTruthy();
    }
    expect(new Set(DEFAULT_AUTOMATION_RULES.map((r) => r.code)).size).toBe(
      DEFAULT_AUTOMATION_RULES.length,
    );
  });
  it('customers are never told about operational failures', () => {
    for (const e of [
      'QC_FAILED',
      'REWORK_CREATED',
      'STAGE_BLOCKED',
      'SHIPMENT_FAILED',
      'COMMERCIAL_REAPPROVAL_REQUIRED',
      'ALERT_OPENED',
    ])
      expect(CUSTOMER_SAFE_EVENTS as readonly string[]).not.toContain(e);
  });
  it('every supported event has a category and at least one default rule (alerts are rule-driven)', () => {
    for (const e of EVENT_TYPES) {
      expect(EVENT_CATEGORY[e]).toBeDefined();
      if (e !== 'ALERT_ESCALATED')
        expect(DEFAULT_AUTOMATION_RULES.some((r) => r.eventType === e)).toBe(
          true,
        );
    }
  });
  it('escalation defaults are bounded: unique levels per alert type, 1-5', () => {
    const seen = new Set<string>();
    for (const r of DEFAULT_ESCALATION_RULES) {
      expect(r.level).toBeGreaterThanOrEqual(1);
      expect(r.level).toBeLessThanOrEqual(5);
      const k = `${r.alertType}:${r.level}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(r.channels.every((c) => c === 'IN_APP' || c === 'EMAIL')).toBe(
        true,
      );
    }
    const byType = (t: string) =>
      DEFAULT_ESCALATION_RULES.filter((r) => r.alertType === t).sort(
        (a, b) => a.level - b.level,
      );
    for (const t of new Set(DEFAULT_ESCALATION_RULES.map((r) => r.alertType)))
      byType(t).reduce((prev, r) => {
        expect(r.afterMinutes).toBeGreaterThanOrEqual(prev);
        return r.afterMinutes;
      }, 0);
  });
});

describe('customer-safe milestones', () => {
  it('map internal stages to coarse labels and never expose failures', () => {
    expect(milestoneForStage('FABRIC_PREPARATION')).toBe('PRODUCTION_STARTED');
    expect(milestoneForStage('CUTTING')).toBe('PRODUCTION_IN_PROGRESS');
    expect(milestoneForStage('SEWING')).toBe('PRODUCTION_IN_PROGRESS');
    expect(milestoneForStage('QC_GATE_2')).toBe('QUALITY_CHECK');
    expect(milestoneForStage('PACKAGING')).toBe('PACKAGING');
    expect(milestoneForStage('READY')).toBeNull();
    for (const m of MILESTONES) expect(MILESTONE_LABELS[m]).toBeDefined();
    for (const l of Object.values(MILESTONE_LABELS))
      expect(l.en + l.ar).not.toMatch(/fail|rework|block|reject/i);
  });
  it('only PRODUCTION_MILESTONE is optional for customers', () => {
    expect(OPTIONAL_CUSTOMER_CATEGORIES).toEqual(['PRODUCTION_MILESTONE']);
  });
  it('alert types map to the notification type people see', () => {
    expect(notificationTypeForAlert('DELAYED_STAGE')).toBe('STAGE_DELAYED');
    expect(notificationTypeForAlert('OVERDUE_ORDER')).toBe(
      'ALERT_OVERDUE_ORDER',
    );
  });
});

describe('retry policy', () => {
  it('doubles up to the cap', () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7].map((n) => backoffSeconds(n, 60, 3600)),
    ).toEqual([60, 120, 240, 480, 960, 1920, 3600]);
    expect(backoffSeconds(100, 60, 3600)).toBe(3600);
    expect(backoffSeconds(0, 60, 3600)).toBe(60);
    expect(addSeconds(new Date('2031-01-01T00:00:00Z'), 90).toISOString()).toBe(
      '2031-01-01T00:01:30.000Z',
    );
  });
});

describe('development providers', () => {
  const mail = (key: string) => ({
    to: 'mona@example.com',
    from: 'x@y',
    subject: 's',
    text: 't',
    idempotencyKey: key,
  });
  it('record deliveries and replay an idempotency key without sending twice', async () => {
    const p = new LogEmailProvider();
    const a = await p.send(mail('k1'));
    const b = await p.send(mail('k1'));
    expect(b.providerMessageId).toBe(a.providerMessageId);
    expect(p.sent).toHaveLength(1);
    await p.send(mail('k2'));
    expect(p.sent).toHaveLength(2);
  });
  it('can simulate transient and permanent failures', async () => {
    const p = new LogWhatsAppProvider();
    const msg = {
      to: '+201001112233',
      templateName: 't_en',
      locale: 'en',
      variables: [],
      fallbackText: 'x',
      idempotencyKey: 'w1',
    };
    p.simulate({ transient: 2 });
    await expect(p.send(msg)).rejects.toBeInstanceOf(TransientProviderError);
    await expect(p.send(msg)).rejects.toBeInstanceOf(TransientProviderError);
    await expect(p.send(msg)).resolves.toHaveProperty('providerMessageId');
    p.simulate({ permanent: true });
    await expect(
      p.send({ ...msg, idempotencyKey: 'w2' }),
    ).rejects.toBeInstanceOf(PermanentProviderError);
  });
});
