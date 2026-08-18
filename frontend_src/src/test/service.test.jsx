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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  test('the removed lifecycle leaves nothing behind', () => {
    // Recording a service consumes, costs and invoices in one call. A leftover
    // Start or Complete button would call an endpoint that no longer exists.
    for (const gone of ['startServiceJob', 'completeServiceJob',
                        'reopenServiceJob', 'scheduleServiceJob',
                        'updateServiceJob', 'printWorkOrder']) {
      expect(serviceSrc, gone).not.toContain(gone);
    }
  });

  test('cancelling asks first', () => {
    // It returns stock, reverses the cost and voids the invoice.
    expect(serviceSrc).toMatch(/cancelConfirm/);
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

  test('the two remaining status keys exist', () => {
    // A service either happened or was recorded by mistake.
    for (const key of ['statusCompleted', 'statusCancelled']) {
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

// ── Styling ──────────────────────────────────────────────────────────────────

describe('every class the page uses is a real class', () => {
  test('no invented class names', () => {
    // This shipped: the toggle used `className="tab"`, and the stylesheet
    // defines `.tab-btn`. The buttons rendered as unstyled bordered text and
    // every test passed, because nothing checked that a class exists.
    const used = new Set();
    for (const m of serviceSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      const raw = (m[1] || m[2] || '')
        .replace(/\$\{[^}]*\}/g, ' ')   // drop the interpolated halves
        .split(/\s+/);
      raw.filter(Boolean).forEach(c => used.add(c));
    }
    // Tokens ending in '-' are the static half of an interpolated name
    // (`badge-${color}`) and cannot be checked from the source alone. Skipping
    // them narrows what this catches to WHOLLY invented names — which is the
    // bug it exists for: `tab`, `muted`, `r`, `page-head` were all complete
    // class names that simply did not exist.
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);

    // Read from disk, not via `?raw`: vite.config sets `css: false` for tests,
    // which stubs CSS imports to an empty string — so the bundler route would
    // make this test silently pass on an empty stylesheet.
    // `import.meta.url`, not __dirname: this file is an ES module and
    // __dirname is not defined in one (eslint catches it; vitest happened to
    // tolerate it via its CJS interop).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cssSrc = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    expect(cssSrc.length).toBeGreaterThan(1000);

    const defined = new Set(
      [...cssSrc.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    const missing = [...used].filter(c => !defined.has(c)).sort();

    expect(missing).toEqual([]);
  });
});
