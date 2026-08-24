// The insight engine, read as what it claims to be: an analysis of the whole
// business rather than a summary of the income statement.
//
// It used to see only what the Finance page had fetched, so every observation
// it could make was about income, expenses or the ledger. The things a
// business actually comes unstuck on live elsewhere — stock nobody has moved,
// a repair nobody invoiced, one customer who is most of the revenue — and the
// panel was silent on all of them.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import { generateInsights } from '../pages/finance/insights';
import insightsSrc from '../pages/finance/insights.jsx?raw';
import financeSrc from '../pages/Finance.jsx?raw';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

// The real translator, so a missing key or an unfilled placeholder shows up
// here rather than as "{{amt}}" on somebody's screen.
const translate = (dict) => (key, params = {}) => {
  const v = lookup(dict, key);
  if (typeof v !== 'string') return key;
  return v.replace(/\{\{(\w+)\}\}/g, (_, p) =>
    (params[p] === undefined || params[p] === null ? `{{${p}}}` : params[p]));
};

const t = translate(en);
const fmtK = (v) => `$${Math.round(Number(v) || 0)}`;

const SUMMARY = { income: 100000, expenses: 60000, profit: 40000, margin: 40,
                  by_category: [], prev: null };
const MONTHLY = [
  { month: '2026-06', income: 30000, expenses: 20000, profit: 10000 },
  { month: '2026-07', income: 35000, expenses: 20000, profit: 15000 },
  { month: '2026-08', income: 35000, expenses: 20000, profit: 15000 },
];

const run = (ctx, tr = t) => generateInsights(SUMMARY, MONTHLY, ctx, fmtK, tr);
const byId = (list, id) => list.find(i => i.id === id);

describe('it looks at every module, not just the ledger', () => {
  const CASES = [
    ['stock-dead',             { inventory: { dead_value: 9000, dead_share: 40, dead_count: 12 } }],
    ['stock-out',              { inventory: { stockout_selling: 2, stockout_top: 'Fan belt' } }],
    ['stock-reorder',          { inventory: { below_reorder: 4, below_reorder_top: 'Filter' } }],
    ['price-under-cost',       { inventory: { under_cost: 1, under_cost_top: 'Loss leader' } }],
    ['client-concentration',   { sales: { revenue: 100000, top_client: 'Big Co', top_client_share: 62 } }],
    ['discount-leak',          { sales: { revenue: 100000, discount: 14000, discount_share: 14 } }],
    ['quote-winrate',          { quotations: { quoted: 20, accepted: 3, win_rate: 15 } }],
    ['po-stuck',               { purchases: { stuck_orders: 3, stuck_value: 4200, stuck_days: 30 } }],
    ['service-uninvoiced',     { service: { uninvoiced: 4, uninvoiced_value: 3100 } }],
    ['project-over-budget',    { projects: { over_budget: 2, over_budget_top: 'Villa', over_budget_by: 5000 } }],
    ['project-unbilled',       { projects: { unbilled: 1, unbilled_value: 8000 } }],
    ['pipeline-stale',         { crm: { stale: 6, stale_days: 45 } }],
    ['payroll-heavy',          { hr: { payroll: 55000, headcount: 9 } }],
    ['wip-stalled',            { manufacturing: { stalled: 2, stalled_value: 1200, stalled_days: 14 } }],
    ['dso-slow',               { receivables: { dso: 78, outstanding: 21000, past_due: 0 } }],
    ['period-not-locked',      { controls: { unlocked_periods: 3, unlocked_latest: '2026-05' } }],
  ];

  test.each(CASES)('%s is raised from the scan', (id, ctx) => {
    expect(byId(run(ctx), id)).toBeTruthy();
  });

  test('a module the viewer cannot see says nothing at all', () => {
    // The server omits the block rather than sending zeroes, and a zero would
    // otherwise render as "0 items below reorder point" — a claim about the
    // business made on behalf of a reader who cannot see it.
    const quiet = run({});

    for (const id of CASES.map(c => c[0])) {
      expect(byId(quiet, id), id).toBeFalsy();
    }
  });
});

describe('an observation is worth the space it takes', () => {
  test('every one names a figure, not just a category', () => {
    const all = run({
      inventory: { dead_value: 9000, dead_share: 40, dead_count: 12,
                   stockout_selling: 2, stockout_top: 'Fan belt' },
      service: { uninvoiced: 4, uninvoiced_value: 3100 },
      hr: { payroll: 55000, headcount: 9 },
    });

    for (const ins of all) {
      expect(ins.title, ins.id).not.toMatch(/\{\{/);
      expect(ins.detail || '', ins.id).not.toMatch(/\{\{/);
      expect(ins.action || '', ins.id).not.toMatch(/\{\{/);
    }
  });

  test('the ones worth acting on carry the action', () => {
    const all = run({ service: { uninvoiced: 4, uninvoiced_value: 3100 } });

    expect(byId(all, 'service-uninvoiced').action).toBeTruthy();
  });

  test('a stat that cannot be computed is never invented', () => {
    // DSO on a period that billed nothing is infinity, and the server sends
    // null rather than a number somebody might act on.
    const all = run({ receivables: { dso: null, outstanding: 5000, past_due: 0 } });

    expect(byId(all, 'dso-slow')).toBeFalsy();
  });
});

describe('one noisy module cannot fill the panel', () => {
  test('at most two observations from any one area', () => {
    // A warehouse with four stock problems used to push an unbilled repair and
    // an unlocked month off the bottom, and the reader saw a stock report
    // rather than a picture of the business.
    const all = run({
      inventory: { dead_value: 9000, dead_share: 40, dead_count: 12,
                   stockout_selling: 2, stockout_top: 'A',
                   below_reorder: 5, below_reorder_top: 'B',
                   under_cost: 2, under_cost_top: 'C' },
      service: { uninvoiced: 4, uninvoiced_value: 3100 },
      controls: { unlocked_periods: 2, unlocked_latest: '2026-05' },
    });

    const head = all.slice(0, 6);
    const inventory = head.filter(i => i.category === 'Inventory');
    expect(inventory.length).toBeLessThanOrEqual(2);
    expect(byId(head, 'service-uninvoiced')).toBeTruthy();
    expect(byId(head, 'period-not-locked')).toBeTruthy();
  });

  test('the panel stays readable', () => {
    const all = run({
      inventory: { dead_value: 9000, dead_share: 40, dead_count: 12,
                   stockout_selling: 2, stockout_top: 'A', below_reorder: 5,
                   below_reorder_top: 'B', under_cost: 2, under_cost_top: 'C',
                   reserved_share: 55 },
      sales: { revenue: 100000, top_client: 'Big Co', top_client_share: 62,
               discount: 14000, discount_share: 14, top_item: 'Widget',
               top_item_share: 40 },
      service: { uninvoiced: 4, uninvoiced_value: 3100, past_due: 3 },
      projects: { over_budget: 2, over_budget_top: 'Villa', over_budget_by: 5000,
                  unbilled: 1, unbilled_value: 8000 },
      crm: { stale: 6, stale_days: 45, open_value: 1000 },
      hr: { payroll: 55000, headcount: 9 },
      manufacturing: { stalled: 2, stalled_value: 1200, stalled_days: 14 },
      quotations: { quoted: 20, accepted: 3, win_rate: 15, pending: 5, pending_value: 9000 },
      purchases: { stuck_orders: 3, stuck_value: 4200, stuck_days: 30, spend: 50000,
                   top_supplier: 'Acme', top_supplier_share: 70 },
      receivables: { dso: 78, outstanding: 21000, past_due: 5, past_due_value: 9000,
                     oldest_due: '2026-03-01' },
      controls: { unlocked_periods: 3, unlocked_latest: '2026-05' },
    });

    expect(all.length).toBeLessThanOrEqual(10);
    // …and covers a spread of the business rather than one corner of it.
    expect(new Set(all.map(i => i.category)).size).toBeGreaterThanOrEqual(5);
  });
});

describe('it reads in Arabic', () => {
  const ARABIC = /[؀-ۿ]/;
  const CTX = {
    inventory: { dead_value: 9000, dead_share: 40, dead_count: 12,
                 stockout_selling: 2, stockout_top: 'Fan belt' },
    service: { uninvoiced: 4, uninvoiced_value: 3100 },
    hr: { payroll: 55000, headcount: 9 },
    projects: { unbilled: 1, unbilled_value: 8000 },
    crm: { stale: 6, stale_days: 45 },
    receivables: { dso: 78, outstanding: 21000, past_due: 0 },
  };

  test('every observation is translated, not just the finance ones', () => {
    for (const ins of run(CTX, translate(ar))) {
      expect(ARABIC.test(ins.title), ins.id).toBe(true);
      if (ins.detail) expect(ARABIC.test(ins.detail), ins.id).toBe(true);
      if (ins.action) expect(ARABIC.test(ins.action), ins.id).toBe(true);
    }
  });

  test('the Arabic fills the same figures in', () => {
    for (const ins of run(CTX, translate(ar))) {
      expect(ins.title, ins.id).not.toMatch(/\{\{/);
      expect(ins.detail || '', ins.id).not.toMatch(/\{\{/);
      expect(ins.action || '', ins.id).not.toMatch(/\{\{/);
    }
  });

  test('both languages define every message the engine asks for', () => {
    const keys = [...insightsSrc.matchAll(/t\('(finance\.ins[A-Za-z]*\.[\w.]+)'/g)]
      .map(m => m[1]);

    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      expect(typeof lookup(en, k), `en ${k}`).toBe('string');
      expect(typeof lookup(ar, k), `ar ${k}`).toBe('string');
    }
  });

  test('a message and its translation take the same parameters', () => {
    // The commonest way a translated string breaks: the Arabic drops a
    // placeholder, so the sentence renders without the number that made it
    // worth reading.
    const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
      .map(m => m[1]).sort().join(',');

    for (const [key, enMsg] of Object.entries(en.finance.ins)) {
      const arMsg = ar.finance.ins[key];
      expect(arMsg, `ar.finance.ins.${key}`).toBeTruthy();
      for (const part of ['t', 'd', 'a']) {
        if (typeof enMsg[part] !== 'string') continue;
        expect(typeof arMsg[part], `${key}.${part}`).toBe('string');
        expect(named(arMsg[part]), `${key}.${part}`).toBe(named(enMsg[part]));
      }
    }
  });

  test('every category chip has a label in both languages', () => {
    const cats = [...insightsSrc.matchAll(/category: '([\w ]+)'/g)]
      .map(m => m[1].toLowerCase().replace(/\s+/g, ''));

    for (const c of new Set(cats)) {
      expect(typeof en.finance.insCat[c], `en ${c}`).toBe('string');
      expect(typeof ar.finance.insCat[c], `ar ${c}`).toBe('string');
    }
  });
});

describe('the scan is one request, and says what it read', () => {
  test('the page asks the server rather than assembling it itself', () => {
    expect(financeSrc).toMatch(/getBusinessSignals/);
    expect(financeSrc).not.toMatch(/getCashReconciliations/);
    expect(financeSrc).not.toMatch(/getFiscalYears/);
  });

  test('it re-scans when the reporting window moves', () => {
    // Half the signals are period-relative — what was billed, what was quoted,
    // what payroll cost against it.
    expect(financeSrc).toMatch(/\[range\.start, range\.end\]/);
  });

  test('the header states the size of the scan', () => {
    expect(insightsSrc).toMatch(/finance\.insightsScanned/);
    expect(en.finance.insightsScanned).toMatch(/\{\{records\}\}/);
    expect(ar.finance.insightsScanned).toMatch(/\{\{records\}\}/);
  });

  test('and falls back to the plain subtitle when it read nothing', () => {
    // A count of zero records dressed up as analysis is worse than no claim.
    expect(insightsSrc).toMatch(/scanned\?\.records/);
    expect(insightsSrc).toMatch(/finance\.insightsSubtitle/);
  });
});
