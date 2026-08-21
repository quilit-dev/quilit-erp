// From a posting to the document behind it, and back again — plus the search
// that has to land somewhere useful.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import journalSrc from '../pages/accounting/Journal.jsx?raw';
import ledgerSrc from '../pages/accounting/Ledger.jsx?raw';
import accountingSrc from '../pages/Accounting.jsx?raw';
import postingsSrc from '../components/DocumentPostings.jsx?raw';
import clientsReportSrc from '../pages/reports/ClientsReport.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('a posting names the document behind it', () => {
  test('the entry detail links to it', () => {
    expect(journalSrc).toMatch(/entry\.source\.route \? \(/);
    expect(journalSrc).toMatch(/<Link to=\{entry\.source\.route\}/);
  });

  test('a document that is gone is said to be gone, not linked', () => {
    // A link that 404s is worse than a sentence explaining why there is none.
    expect(journalSrc).toMatch(/entry\.source\.exists === false/);
    expect(journalSrc).toMatch(/accounting\.documentGone/);
  });

  test('the list shows the document number under the source type', () => {
    expect(journalSrc).toMatch(/e\.source\?\.label/);
  });

  test('the source type is translated rather than printed raw', () => {
    expect(journalSrc).toMatch(/tEnumValue\(e\.source_type \|\| 'manual'\)/);
  });
});

describe('a document reports what it did to the books', () => {
  test('the API call exists', () => {
    expect(apiSrc).toMatch(/getDocumentPostings/);
    expect(apiSrc).toMatch(/\/api\/accounting\/for\//);
  });

  test('it is gated on permission to read the ledger', () => {
    // Raising an invoice does not make someone an accountant.
    expect(postingsSrc).toMatch(/!can\('accounting', 'view'\)/);
  });

  test('nothing is fetched until it is opened', () => {
    expect(postingsSrc).toMatch(/if \(!next \|\| data \|\| loading\) return;/);
  });

  test('it links back into the journal entry', () => {
    expect(postingsSrc).toMatch(/\/accounting\?tab=journal&focus=/);
  });

  test('it reaches the documents that actually produce postings', () => {
    for (const [file, doc] of [['Invoices.jsx', 'invoice'],
                               ['Expenses.jsx', 'expense'],
                               ['Purchases.jsx', 'purchase']]) {
      const src = fs.readFileSync(path.resolve(here, '../pages', file), 'utf8');
      expect(src, file).toMatch(new RegExp('<DocumentPostings document="' + doc + '"'));
      expect(src, file).toMatch(/import DocumentPostings from/);
    }
  });
});

describe('searching the accounting lands somewhere', () => {
  test('the page opens the tab the URL names', () => {
    // Both results used to land on the Overview tab, the one place the thing
    // you searched for does not appear.
    expect(accountingSrc).toMatch(/useSearchParams/);
    expect(accountingSrc).toMatch(/params\.get\('tab'\)/);
  });

  test('changing tab by hand drops the deep link', () => {
    // Otherwise a refresh reopens a record the operator already closed.
    expect(accountingSrc).toMatch(/setParams\(\{\}, \{ replace: true \}\)/);
  });

  test('the journal opens the entry that was searched for', () => {
    expect(journalSrc).toMatch(/useFocusId/);
    expect(journalSrc).toMatch(/getJournalEntry\(focusId\)/);
  });

  test('the ledger opens the account that was searched for', () => {
    expect(ledgerSrc).toMatch(/useFocusId/);
    expect(ledgerSrc).toMatch(/setAccountId\(String\(focusId\)\)/);
  });

  test('the journal can be searched by account and by amount', () => {
    for (const p of ['account_id', 'min_amount', 'max_amount']) {
      expect(journalSrc, p).toContain(p);
    }
    expect(journalSrc).toMatch(/accounting\.allAccounts/);
  });

  test('the filters can be cleared', () => {
    expect(journalSrc).toMatch(/setAccountId\(''\); setMinAmount\(''\);/);
  });
});

describe('client revenue says where the revenue came from', () => {
  test('the breakdown reaches both the table and the export', () => {
    expect(clientsReportSrc).toMatch(/revenue_by_source/);
    expect(clientsReportSrc).toMatch(/reports\.revenueBySource/);
  });

  test('the export headers are translated, not hardcoded English', () => {
    // An Arabic screen was producing an English-headed workbook.
    expect(clientsReportSrc).not.toMatch(/label: 'Total Invoiced'/);
    expect(clientsReportSrc).not.toMatch(/label: 'Client'/);
    expect(clientsReportSrc).not.toMatch(/label="Active Clients"/);
  });

  test('a client with no revenue shows nothing rather than an empty box', () => {
    expect(clientsReportSrc).toMatch(/sourceSummary\(c, tEnumValue, fmt\)\.length === 0/);
  });
});

describe('translation', () => {
  test('the new keys resolve in both languages', () => {
    for (const k of ['accounting.allAccounts', 'accounting.minAmount',
                     'accounting.maxAmount', 'accounting.fromDocument',
                     'accounting.documentGone', 'accounting.viewPostings',
                     'accounting.postingsFor', 'accounting.noPostings',
                     'reports.revenueBySource', 'reports.activeClients']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = [['accounting', 'allAccounts'], ['accounting', 'viewPostings'],
                  ['accounting', 'documentGone'], ['reports', 'revenueBySource'],
                  ['reports', 'activeClients']];
    const latinOnly = KEYS.filter(([g, k]) =>
      /[A-Za-z]{3,}/.test(ar[g][k]) && !/[؀-ۿ]/.test(ar[g][k]));
    expect(latinOnly).toEqual([]);
  });

  test('every source type the ledger can show has a label', () => {
    // Otherwise the badge prints `pos_cogs`, which is a code, and prints it
    // in Latin script in the middle of an Arabic screen.
    const TYPES = ['invoice', 'invoice_payment', 'expense', 'purchase',
                   'payroll', 'depreciation', 'pos_cogs', 'service_cogs',
                   'prepaid_payment', 'manual', 'closing', 'reversal',
                   'fx_revaluation', 'sales', 'pos'];
    expect(TYPES.filter(k => !en.enumValues?.[k])).toEqual([]);
    expect(TYPES.filter(k => !ar.enumValues?.[k])).toEqual([]);
  });

  test('every key the postings panel uses resolves', () => {
    const keys = [...postingsSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(4);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('no invented class names in the postings panel', () => {
    const used = new Set();
    for (const m of postingsSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});
