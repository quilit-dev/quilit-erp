// The reconciliation report renders every issue the server can raise.
//
// A missing entry here does not crash anything — the renderer falls back to the
// server's English `message` — so an untranslated issue type is invisible in
// testing and shows up only as an Arabic report with an English sentence in the
// middle of it. Hence a test per type, driven off the list the server actually
// emits.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import modalsSrc from '../pages/finance/modals.jsx?raw';

// Every `"type": "..."` in routers/finance.py's reconciliation().
const ISSUE_TYPES = [
  'vat_mismatch', 'overpayment', 'orphaned_payment', 'future_expense',
  'unreversed_void', 'unrestocked_void', 'stock_gl_mismatch',
  'deferred_revenue_mismatch', 'gl_unbalanced',
];

// Every source_type the unreversed_void check can report.
const SOURCES = ['invoice_payment', 'invoice', 'pos_cogs'];

const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort();

describe('every reconciliation issue is translated', () => {
  test.each(ISSUE_TYPES)('%s has a chip label in both languages', (type) => {
    expect(en.finance.reconIssue[type], `en ${type}`).toBeTruthy();
    expect(ar.finance.reconIssue[type], `ar ${type}`).toBeTruthy();
  });

  test.each(ISSUE_TYPES)('%s has a message in both languages', (type) => {
    expect(en.finance.reconMsg[type], `en ${type}`).toBeTruthy();
    expect(ar.finance.reconMsg[type], `ar ${type}`).toBeTruthy();
  });

  test.each(ISSUE_TYPES)('%s uses the same placeholders in both', (type) => {
    // A placeholder present in one language and not the other silently drops
    // the number out of half the reports.
    expect(placeholders(ar.finance.reconMsg[type]), type)
      .toEqual(placeholders(en.finance.reconMsg[type]));
  });

  test.each(SOURCES)('the void source "%s" is translated', (src) => {
    expect(en.finance.reconSource[src], `en ${src}`).toBeTruthy();
    expect(ar.finance.reconSource[src], `ar ${src}`).toBeTruthy();
  });
});

describe('the renderer handles the new fields', () => {
  test('`what` is mapped through reconSource, not printed raw', () => {
    // The server sends a source_type key precisely so the sentence stays in
    // one language.
    expect(modalsSrc).toMatch(/finance\.reconSource\.' \+ fp\.what/);
  });

  test('an unmapped source falls back to the whole server message', () => {
    // Better a fully English sentence than an Arabic one with a raw key in it.
    expect(modalsSrc).toMatch(/if \(w === wk\) return issue\.message;/);
  });

  test('the new money fields are currency-formatted', () => {
    for (const f of ['gl', 'physical', 'gap', 'held', 'owed']) {
      expect(modalsSrc, f).toMatch(new RegExp(`'${f}'`));
    }
  });

  test('the money fields list covers every money placeholder used', () => {
    const money = new Set(
      (modalsSrc.match(/_RECON_MONEY_FIELDS = \[([\s\S]*?)\]/) || [, ''])[1]
        .match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) || []);
    // `units` is a count, not money, and must NOT be formatted as currency.
    expect(money.has('units')).toBe(false);
    for (const f of ['physical', 'gl', 'gap', 'held', 'owed']) {
      expect(money.has(f), f).toBe(true);
    }
  });
});
