// The debtors list, and the sheet you take to the phone with you.
//
// Chasing money starts with one question — who owes, and how much — and the
// clients list could not answer it. It now filters to accounts that owe,
// biggest first, and prints the same set as a report.
//
// The property worth guarding is that the figure is ONE number wherever it
// appears. The list, the customer's own page and this report all read
// `_OWED_SQL` on the server; nothing recomputes a balance in the browser,
// because a second implementation is how a screen comes to disagree with the
// page behind it.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import clientsSrc from '../pages/Clients.jsx?raw';

const STRINGS = ['owingOnly', 'owingPdf', 'owingTitle', 'owingSubtitle',
                 'owingTotal', 'owingNone'];

describe('the owing filter', () => {
  test('asks the server, rather than filtering in the browser', () => {
    // The list is paged server-side, so filtering here would only ever hide
    // rows from the current page and report a wrong total.
    expect(clientsSrc).toMatch(/owingOnly \? \{ owing: 1 \} : \{\}/);
  });

  test('the choice is remembered', () => {
    expect(clientsSrc).toMatch(/usePersistedState\('clients\.owingOnly', false\)/);
  });

  test('outstanding is a sortable column', () => {
    expect(clientsSrc).toMatch(/sortKey="outstanding"/);
  });

  test('the figure is read from the row, never recomputed', () => {
    // c.outstanding comes from the server. Any arithmetic over invoices here
    // would be a second definition of what a debt is.
    expect(clientsSrc).toMatch(/c\.outstanding/);
    expect(clientsSrc).not.toMatch(/reduce\([^)]*invoice/i);
  });
});

describe('the outstanding report', () => {
  test('always prints the owing set, whatever the screen is filtered to', () => {
    // The button says outstanding, so it prints outstanding — it does not
    // silently print an unfiltered list because a checkbox was left off.
    expect(clientsSrc).toMatch(/getClients\(\{ owing: 1, sort: 'outstanding', dir: 'desc' \}\)/);
  });

  test('it is not truncated to the page on screen', () => {
    // No `limit` in that call: a chase-up sheet missing half the debtors is
    // worse than no sheet.
    const call = clientsSrc.match(/getClients\(\{ owing: 1[^)]*\)/)[0];
    expect(call).not.toMatch(/limit/);
  });

  test('it carries the two figures the balance is made of', () => {
    for (const field of ['total_invoiced', 'total_paid', 'outstanding']) {
      expect(clientsSrc, field).toMatch(new RegExp(`r\\.${field}`));
    }
  });

  test('money is currency-formatted, not left as a bare number', () => {
    // The report builder adds separators but no currency symbol, and this
    // sheet goes to a person who should not have to assume the currency.
    expect(clientsSrc).toMatch(/value: r => fmt\(r\.outstanding\)/);
    expect(clientsSrc).toMatch(/columns: \[null, null, null, null, null, fmt\(owed\)\]/);
  });

  test('it totals what is owed', () => {
    expect(clientsSrc).toMatch(/rows\.reduce\(\(a, r\) => a \+ Number\(r\.outstanding \|\| 0\), 0\)/);
  });

  test('an empty list says so instead of printing a blank page', () => {
    expect(clientsSrc).toMatch(/if \(!rows\.length\).*owingNone/s);
  });

  test('the button cannot be pressed twice while it works', () => {
    expect(clientsSrc).toMatch(/disabled=\{pdfBusy\}/);
    expect(clientsSrc).toMatch(/finally \{ setPdfBusy\(false\); \}/);
  });

  test('a failure is reported rather than swallowed', () => {
    expect(clientsSrc).toMatch(/catch \(err\) \{ toast\(err\.message, 'red'\); \}/);
  });
});

describe('both languages', () => {
  test.each(STRINGS)('clients.%s exists in EN and AR', (key) => {
    expect(en.clients[key], `en.clients.${key}`).toBeTruthy();
    expect(ar.clients[key], `ar.clients.${key}`).toBeTruthy();
    expect(ar.clients[key]).not.toBe(en.clients[key]);
  });

  test('the placeholder survives translation', () => {
    const ph = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort();
    expect(ph(ar.clients.owingSubtitle)).toEqual(ph(en.clients.owingSubtitle));
    expect(ph(en.clients.owingSubtitle)).toContain('{{count}}');
  });

  test('the column headings it reuses already exist', () => {
    for (const key of ['name', 'company', 'phone', 'totalInvoiced',
                       'totalPaid', 'outstanding']) {
      expect(en.clients[key], `en.clients.${key}`).toBeTruthy();
      expect(ar.clients[key], `ar.clients.${key}`).toBeTruthy();
    }
  });
});
