// The payment plan panel, and the plan on the customer's own copy.
//
// The checks here are the ones that caught real, silent breakage on the service
// module: a translation key with no entry renders as the key itself, an invented
// class name renders unstyled, and an interpolated string used without its
// parameter prints the braces. All three pass every behavioural test.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import planSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import exportSrc from '../utils/exportUtils.js?raw';
import sharedSrc from '../components/shared.jsx?raw';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

// ── Reachability ─────────────────────────────────────────────────────────────

describe('the panel is reachable', () => {
  test('the invoice payments modal renders it', () => {
    // Built and never mounted is the failure mode that raises nothing.
    expect(invoicesSrc).toMatch(/import PaymentPlan from '\.\/invoices\/PaymentPlan\.jsx'/);
    expect(invoicesSrc).toMatch(/<PaymentPlan/);
  });

  test('it reloads the invoice after a change', () => {
    // Settlement is derived server-side, so the panel cannot recompute a plan
    // locally — it has to re-read the invoice or the table goes stale.
    expect(invoicesSrc).toMatch(/onChange=\{async \(\) => \{ setPayModal\(await getInvoice/);
  });

  test('a voided invoice offers no plan', () => {
    expect(invoicesSrc).toMatch(/!payModal\.voided_at && \(\s*<PaymentPlan/);
  });
});

// ── Translation ──────────────────────────────────────────────────────────────

describe('both languages', () => {
  test('the installments block has the same keys in each', () => {
    expect(Object.keys(en.installments).sort())
      .toEqual(Object.keys(ar.installments).sort());
  });

  test('every Arabic string is actually Arabic', () => {
    // A key present with an English value passes a parity check and still reads
    // as English on screen.
    const latinOnly = Object.entries(ar.installments)
      .filter(([, v]) => /[A-Za-z]{3,}/.test(v) && !/[؀-ۿ]/.test(v))
      .map(([k]) => k);
    expect(latinOnly).toEqual([]);
  });

  test('every key the panel uses exists in both', () => {
    // `\bt\(` and not `t\(`: `useState(` also ends in "t(".
    const keys = [...planSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'\)/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(10);

    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('no interpolated key is used without its parameters', () => {
    // 'Tax ({{rate}}%)' called bare renders the braces literally. That shipped
    // once, and every test passed.
    const bare = [...planSrc.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)]
      .map(m => m[1])
      .filter(k => {
        const v = lookup(en, k);
        return typeof v === 'string' && /\{\{/.test(v);
      });
    expect(bare).toEqual([]);
  });

  test('the interpolated keys are given exactly the parameters they name', () => {
    // The other direction: passing `{amount}` to a string that says
    // `{{total}}` leaves the placeholder on screen.
    for (const [key, args] of [
      ['installments.nextDue',    ['date', 'amount']],
      ['installments.splitHint',  ['total']],
    ]) {
      const value = lookup(en, key);
      const named = [...value.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
      expect(named, key).toEqual([...args].sort());
      expect(planSrc, key).toContain(`t('${key}'`);
      for (const a of args) {
        expect(planSrc.includes(`${a}:`), `${key} passes ${a}`).toBe(true);
      }
    }
  });
});

// ── Status rendering ─────────────────────────────────────────────────────────

describe('instalment statuses render', () => {
  test('every status the server can return is translatable', () => {
    // installments.py returns exactly these four. A status with no entry falls
    // back to the raw English string, so Arabic silently shows "Overdue".
    for (const s of ['Due', 'Overdue', 'Partial', 'Paid']) {
      expect(en.status[s], s).toBeTruthy();
      expect(ar.status[s], s).toBeTruthy();
      expect(/[؀-ۿ]/.test(ar.status[s]), `${s} in Arabic`).toBe(true);
    }
  });

  test('every status has a colour', () => {
    // Badge falls back to grey for anything unlisted — and Overdue is the one
    // status that most needs not to be grey.
    const colors = sharedSrc.match(/const statusColors = \{[\s\S]*?\};/)[0];
    for (const s of ['Due', 'Overdue', 'Partial', 'Paid']) {
      expect(colors, s).toMatch(new RegExp(`${s}: '`));
    }
    expect(colors).toMatch(/Overdue: 'red'/);
  });

  test('the panel uses the shared Badge contract', () => {
    // Badge takes {status} and translates it itself; it accepts no colour prop
    // and no children, so `<Badge color=...>text</Badge>` renders nothing.
    expect(planSrc).toMatch(/<Badge status=\{row\.status\} \/>/);
    expect(planSrc).not.toMatch(/<Badge color=/);
  });

  test('toasts pass a colour, not a severity word', () => {
    // toast(msg, type='green') takes a COLOUR. 'error' is not one, and lands
    // as an unstyled toast.
    expect(planSrc).not.toMatch(/toast\([^)]*'(error|success|warning)'\)/);
  });
});

// ── Styling ──────────────────────────────────────────────────────────────────

describe('every class the panel uses is a real class', () => {
  test('no invented class names', () => {
    const used = new Set();
    for (const m of planSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);

    // From disk, not `?raw`: vite.config sets css:false for tests, so the
    // bundler route would compare against an empty stylesheet and always pass.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cssSrc = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    expect(cssSrc.length).toBeGreaterThan(1000);

    const defined = new Set(
      [...cssSrc.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});

// ── The customer's copy ──────────────────────────────────────────────────────

describe('the plan reaches the customer', () => {
  test('the shared invoice template renders the schedule', () => {
    // Shared, so the same block appears on the printed PDF and on the share
    // link. A schedule the customer cannot see when they print it is half a
    // feature.
    expect(exportSrc).toMatch(/const plan = invoice\.installments \|\| \[\]/);
    expect(exportSrc).toMatch(/Payment Plan/);
  });

  test('the single due-date band is suppressed under a plan', () => {
    // Otherwise the document says "$12,000 due by December" directly above a
    // schedule of twelve monthly payments -- the invoice's own due_date IS the
    // final instalment.
    expect(exportSrc).toMatch(/: plan\.length/);
  });

  test('arrears are called out, not just listed', () => {
    expect(exportSrc).toMatch(/overdueRows/);
  });
});
