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
    expect(html()).toContain('Work carried out');
    expect(html()).toContain('Parts used');
  });

  // While the job is open the sheet is a FORM: the office fills in the fault,
  // the technician writes the rest on site, and the office types it back onto
  // the job afterwards. A section that arrives already filled in is a section
  // nobody writes on, so the sheet would come back saying what the office
  // guessed rather than what happened.
  test('the writing space is empty even when the office typed something', () => {
    const out = html({ ...JOB, work_done: 'Office guess: replaced belt' });

    expect(out).not.toContain('Office guess');
    expect((out.match(/wo-rule/g) || []).length).toBeGreaterThan(4);
  });

  test('parts used is a grid the technician fills in, not a list', () => {
    // A part is a name and a quantity. Asking for both on one ruled line
    // reliably gets one of them.
    const out = html();

    expect(out).toContain('Part / description');
    expect(out).toContain('wo-blank');
  });

  test('the lines the office issued are still on it, without prices', () => {
    const out = html();

    expect(out).toContain('Parts issued from stores');
    expect(out).toContain('Fan belt');
  });

  test('it says what to do with the sheet afterwards', () => {
    expect(html()).toContain('Return this sheet to the office');
  });

  test('once completed it prints the record instead of blank lines', () => {
    const out = html({ ...JOB, status: 'Completed',
                       work_done: 'Replaced fan belt and tensioner' });

    expect(out).toContain('Replaced fan belt and tensioner');
    expect(out).not.toContain('Part / description');
    expect(out).not.toContain('Return this sheet to the office');
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

  // Bilingual for the same reason the receipt voucher is: the sheet is filled
  // in by a technician on site and signed by a customer, and those are not
  // reliably the same reader. A locale-driven lookup gives one language or the
  // other, which is a different document.
  test('every label on it is in both languages', () => {
    const out = html();

    for (const [en, ar] of [
      ['Work Order', 'أمر عمل'],
      ['Job No.', 'رقم المهمة'],
      ['Technician', 'الفني'],
      ['Equipment', 'المعدّة'],
      ['Reported fault', 'العطل'],
      ['Work carried out', 'العمل المنفَّذ'],
      ['Parts used', 'القطع المستعملة'],
      ['Customer signature', 'توقيع العميل'],
    ]) {
      expect(out, en).toContain(en);
      expect(out, ar).toContain(ar);
    }
  });

  test('the two languages are set apart, not run together', () => {
    // Adjacent spans render as "رقمNo." with nothing telling a reader where
    // one stops. The voucher solves it with a lighter-weight <i> and a gap.
    expect(html()).toMatch(/Job No\. <i>/);
    expect(html()).toContain('wo-ar-sub');
  });

  test('the note about bringing it back is in both too', () => {
    const out = html();

    expect(out).toContain('Return this sheet to the office');
    expect(out).toContain('أعد هذه الورقة');
    expect(out).toContain('dir="rtl"');
  });

  test('the priced copy is bilingual as well', () => {
    const out = html({ ...JOB, status: 'Completed', work_done: 'Done' });

    expect(out).toContain('الإجمالي');   // Total
    expect(out).toContain('سعر الوحدة');   // Unit
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
    // __dirname is not defined in one.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cssSrc = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    expect(cssSrc.length).toBeGreaterThan(1000);

    const defined = new Set(
      [...cssSrc.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    const missing = [...used].filter(c => !defined.has(c)).sort();

    expect(missing).toEqual([]);
  });
});

// ── Styling that has now regressed twice ─────────────────────────────────────

describe('fields are actually styled', () => {
  test.each([
    ['Service page', () => serviceSrc],
    ['job form',     () => jobFormSrc],
    ['equipment form', () => equipmentFormSrc],
  ])('%s classes every label', (_label, get) => {
    // An unclassed label has no CSS rule at all, so it renders as plain body
    // text. On the detail panels the wrapper stacked nothing either, gluing
    // each label to its value: "ClientAli", "StatusIn Progress". In the forms
    // the wrapper is a form-group, so they stacked but rendered in the wrong
    // face — every other form in the app is small-caps.
    const src = get();
    expect(src).not.toContain('<div><label>');
    expect(src).not.toMatch(/<label>\s*\{?t\(/);
  });

  test('every input in the job form carries a className', () => {
    // NumberInput spreads props onto a bare <input> and adds no class of its
    // own, so quantity and unit price rendered unstyled beside the styled name
    // field next to them. Also shipped twice.
    //
    // Split on the tag name rather than matching the whole tag with a regex:
    // JSX attributes contain arrow functions, so any [^>] class stops at the
    // '>' of '=>' and never reaches the closing '/>'.
    const tagsFor = (name) => jobFormSrc.split(`<${name}`).slice(1)
      .map(chunk => chunk.slice(0, chunk.indexOf('/>')))
      .filter(tag => tag.length > 0);

    const tags = [...tagsFor('NumberInput'), ...tagsFor('input')];
    expect(tags.length).toBeGreaterThan(2);

    const unstyled = tags.filter(tag => !tag.includes('className='));
    expect(unstyled, 'input(s) rendering with no class').toEqual([]);
  });
});

// ── Finding a job ────────────────────────────────────────────────────────────

describe('the filter row is laid out like the other modules', () => {
  // .form-control is width:100%. Dropped into a flex row without an explicit
  // width, every control expands to fill the line and each one ends up on a
  // row of its own — which is exactly how this shipped: a search box, two date
  // pickers and two buttons each spanning the full page width.
  // Both bars on the page: the jobs one and the equipment one.
  const bars = serviceSrc.split('className="search-bar"').slice(1)
    .map(chunk => chunk.slice(0, chunk.indexOf('</div>', chunk.indexOf('common.clear'))));
  const searchBar = bars[0];

  test('the search bar is the shared pattern, not a bespoke row', () => {
    expect(searchBar).toBeTruthy();
    expect(serviceSrc).toContain('className="search-input-wrap"');
    expect(serviceSrc).toContain('className="form-control search-input"');
    // .filter-group was used by this page alone and constrains nothing.
    expect(serviceSrc).not.toContain('filter-group');
  });

  test('both bars exist \u2014 jobs and equipment', () => {
    // The equipment list used to be a bare table with no card and no search,
    // the only list screen in the app that was.
    expect(bars.length).toBe(2);
  });

  test('every control in them has a width, or is the one that flexes', () => {
    // Split on the tag name: JSX attributes contain arrow functions, so a
    // [^>] character class stops at the '>' of '=>' and never reaches '/>'.
    const tagsFor = (bar, name) => bar.split(`<${name}`).slice(1)
      .map(chunk => chunk.slice(0, chunk.search(/\/>|>/)));

    const controls = bars.flatMap(
      bar => [...tagsFor(bar, 'select'), ...tagsFor(bar, 'input')]
    ).filter(tag => tag.includes('form-control'));
    expect(controls.length).toBeGreaterThan(3);

    const unsized = controls.filter(
      tag => !/style=\{\{\s*width:/.test(tag) && !tag.includes('search-input'));
    expect(unsized, 'control(s) that will span the whole row').toEqual([]);
  });

  test('the flexible one is the search box', () => {
    // It should take the leftover space rather than a fixed width, the same
    // way the invoice and client lists do it.
    expect(searchBar).toMatch(/flex: '1 1 200px'/);
  });
});

describe('the jobs list can be searched and sorted', () => {
  test('the search box is debounced', () => {
    // Without it every keystroke fires a request while typing a client name.
    expect(serviceSrc).toMatch(/setTimeout\(\(\) => setSearchTerm/);
  });

  test('search, dates and sort all reach the query', () => {
    for (const key of ['search:', 'date_from:', 'date_to:', 'sort,']) {
      expect(serviceSrc, key).toContain(key);
    }
  });

  test('the sort toggle flips between the two directions', () => {
    expect(serviceSrc).toMatch(/v === 'desc' \? 'asc' : 'desc'/);
  });

  test('the filter labels exist in both languages', () => {
    for (const dict of [en, ar]) {
      for (const k of ['searchPlaceholder', 'dateFrom', 'dateTo',
                       'sortNewest', 'sortOldest']) {
        expect(dict.service[k], k).toBeTruthy();
      }
    }
  });
});
