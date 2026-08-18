// The service screens, and the registries a page has to be in to be reachable.
//
// The registry tests exist because the backend equivalent caught two real gaps:
// a module can be fully built and simply never appear, and nothing raises. The
// symptom shows up somewhere other than the cause.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import appSrc from '../App.jsx?raw';
import sidebarSrc from '../components/Sidebar.jsx?raw';
import paletteSrc from '../components/CommandPalette.jsx?raw';
import serviceSrc from '../pages/Service.jsx?raw';
import jobFormSrc from '../pages/service/JobForm.jsx?raw';
import equipmentFormSrc from '../pages/service/EquipmentForm.jsx?raw';
import { buildWorkOrderHTML } from '../utils/workOrder';

// ── Reachability ─────────────────────────────────────────────────────────────

describe('the page is reachable', () => {
  test('App declares the route and lazy-loads the page', () => {
    expect(appSrc).toMatch(/const Service\s*=\s*lazy\(/);
    expect(appSrc).toMatch(/<Route path="\/service"/);
  });

  test('the page title key list includes it', () => {
    // Without this the header renders the fallback 'ERP' instead of a name.
    expect(appSrc).toMatch(/'\/service'/);
    expect(en.pages['/service']).toBeTruthy();
    expect(ar.pages['/service']).toBeTruthy();
  });

  test('the sidebar links to it, gated on the module', () => {
    expect(sidebarSrc).toMatch(/to: '\/service'[^}]*module: 'service'/);
  });

  test('the command palette can jump to it', () => {
    expect(paletteSrc).toMatch(/url: '\/service'[^}]*module: 'service'/);
  });
});

// ── Translation ──────────────────────────────────────────────────────────────

describe('both languages', () => {
  test('the service block has the same keys in each', () => {
    expect(Object.keys(en.service).sort()).toEqual(Object.keys(ar.service).sort());
  });

  test('every Arabic string is actually Arabic', () => {
    // A key that exists with an English value passes a key-parity check and
    // still reads as English on screen — the failure mode parity alone misses.
    const latinOnly = Object.entries(ar.service)
      .filter(([, v]) => /[A-Za-z]{3,}/.test(v) && !/[؀-ۿ]/.test(v))
      .map(([k]) => k);
    expect(latinOnly).toEqual([]);
  });

  test('the page title and nav label exist in both', () => {
    for (const dict of [en, ar]) {
      expect(dict.nav.service).toBeTruthy();
      expect(dict.service.title).toBeTruthy();
    }
  });
});

// ── The screens ──────────────────────────────────────────────────────────────

describe('the page renders from translations, not literals', () => {
  test('no hardcoded English labels in the markup', () => {
    // Every visible string goes through t(). Statuses come from the API and are
    // mapped to `service.status*` keys.
    const strippedComments = serviceSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(strippedComments).not.toMatch(/>\s*(Jobs|Equipment|Complete|Reopen)\s*</);
  });

  test('the status ladder is driven by one endpoint per transition', () => {
    // A single "set status" call would let the UI skip the consumption that
    // completing performs.
    expect(serviceSrc).toMatch(/startServiceJob/);
    expect(serviceSrc).toMatch(/completeServiceJob/);
    expect(serviceSrc).toMatch(/reopenServiceJob/);
    // Anchored to a CALL: `setStatusFilter` is the list filter and is fine.
    expect(serviceSrc).not.toMatch(/setStatus\(|updateStatus\(/);
  });

  test('completing and reopening both ask first', () => {
    // Both move stock and post to the ledger.
    expect(serviceSrc).toMatch(/completeConfirm/);
    expect(serviceSrc).toMatch(/reopenConfirm/);
  });
});

describe('the job form', () => {
  test('parts and charges are added by distinct buttons', () => {
    expect(jobFormSrc).toMatch(/addPart/);
    expect(jobFormSrc).toMatch(/addCharge/);
  });

  test('a part line requires a stock item', () => {
    // The backend rejects a part with no inventory_id; requiring it here means
    // that rejection never reaches the user.
    expect(jobFormSrc).toMatch(/line_type === 'part' \?[\s\S]{0,400}?required/);
  });

  test('a charge line never carries a stock item', () => {
    expect(jobFormSrc).toMatch(/inventory_id: l\.line_type === 'part' \?/);
  });

  test('equipment is filtered to the chosen client', () => {
    // Offering another customer's machines invites the mistake the backend
    // then rejects.
    expect(jobFormSrc).toMatch(/getServiceEquipment\(\{ client_id: form\.client_id \}\)/);
  });
});

// ── Work order ───────────────────────────────────────────────────────────────

const SETTINGS = { company_name: 'Acme Service', default_currency: 'USD' };

const JOB = {
  id: 1, job_number: 'SVC-2026-0001', job_type: 'Repair', priority: 'Normal',
  status: 'Scheduled', client_name: 'Bakery Co', assigned_name: 'Sami',
  scheduled_date: '2026-09-01', reported_fault: 'Fan not spinning',
  equipment: { name: 'Bakery oven', model: 'R-200', serial_number: 'SN-4471' },
  lines: [
    { id: 1, line_type: 'part', name: 'Fan belt', quantity: 2, unit_price: 12 },
    { id: 2, line_type: 'charge', name: 'Labour', quantity: 1, unit_price: 100 },
  ],
  subtotal: 124, tax_total: 0, total: 124,
};

const html = (job = JOB) => buildWorkOrderHTML(job, SETTINGS, null, {});

describe('the work order', () => {
  test('carries what a technician needs on site', () => {
    const out = html();
    expect(out).toContain('SVC-2026-0001');
    expect(out).toContain('Bakery oven');
    expect(out).toContain('SN-4471');          // check against the plate
    expect(out).toContain('Fan not spinning');
  });

  test('leaves ruled space to write the visit up', () => {
    // A blank box invites a scrawl in one corner; the lines are the point.
    expect(html()).toContain('wo-rule');
    expect(html()).toContain('Additional parts used');
  });

  test('hides prices until the job is completed', () => {
    // A technician mid-visit should not be quoting figures nobody has agreed.
    const before = html();
    expect(before).not.toContain('124.00');

    const after = html({ ...JOB, status: 'Completed' });
    expect(after).toContain('124.00');
  });

  test('has somewhere for both signatures', () => {
    const out = html();
    expect(out).toContain('Technician');
    expect(out).toContain('Customer signature');
  });

  test('is a work order, not an invoice', () => {
    expect(html()).toContain('Work Order');
    expect(html()).not.toMatch(/\bInvoice\b/);
  });
});

// ── Interpolation ────────────────────────────────────────────────────────────

describe('no raw placeholders reach the screen', () => {
  test('every t() key the service page uses takes no parameters it is not given', () => {
    // A key like 'Tax ({{rate}}%)' called without its parameter renders the
    // braces literally. This shipped once: the job totals read "Tax ({{rate}}%)"
    // in the browser while every test passed, because nothing asserted on the
    // rendered label.
    const keys = [...serviceSrc.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map(m => m[1]);
    const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

    const leaky = keys.filter((k) => {
      const v = lookup(en, k);
      return typeof v === 'string' && /\{\{/.test(v);
    });

    expect(leaky).toEqual([]);
  });
});

// ── Every key resolves ───────────────────────────────────────────────────────

describe('every translation key the service screens use exists', () => {
  // This is the test that was missing. A key with no entry renders as the key
  // itself — the browser showed "common.clientBeirut Bakery" and
  // "COMMON.UNITPRICE" in a table header, while the whole suite passed: a
  // missing key is not a hardcoded English string, so the literals check above
  // sails straight past it.
  const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

  test.each([
    ['Service page', serviceSrc],
    ['job form', jobFormSrc],
    ['equipment form', equipmentFormSrc],
  ])('%s', (_label, src) => {
    // `\bt\(` and not just `t\(`: `set('client_id')` also ends in "t(".
    const keys = [...src.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'\)/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(5);

    const missingEn = keys.filter(k => typeof lookup(en, k) !== 'string');
    const missingAr = keys.filter(k => typeof lookup(ar, k) !== 'string');

    expect(missingEn).toEqual([]);
    expect(missingAr).toEqual([]);
  });

  test('the dynamically built status keys all exist', () => {
    // Built as `service.status${status.replace(/\s/g,'')}` from an API value,
    // so no literal appears in the source for the checker above to find.
    for (const s of ['Draft', 'Scheduled', 'In Progress', 'Completed', 'Cancelled']) {
      const key = `status${s.replace(/\s/g, '')}`;
      expect(en.service[key], key).toBeTruthy();
      expect(ar.service[key], key).toBeTruthy();
    }
  });

  test('the part/charge line-type keys exist', () => {
    // Built as `service.${l.line_type}` from the row data.
    for (const k of ['part', 'charge']) {
      expect(en.service[k]).toBeTruthy();
      expect(ar.service[k]).toBeTruthy();
    }
  });
});
