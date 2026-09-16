// The statement of account prints on the tenant's letterhead.
//
// hajosign's invoices and quotations print on a letterhead the app draws; the
// statement of account went through the generic report builder and came out
// on a plain blue-ruled sheet. A customer receiving both saw two companies.
// The report builder now hands a themed tenant's report to the same shell the
// invoice uses, so the frame, the header and the print geometry are one and
// the same --- and a tenant on the generic template gets byte-for-byte what it
// always got.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportReportPDF } from '../utils/exportUtils';
import statementSrc from '../pages/clients/StatementTab.jsx?raw';
import chartsSrc from '../pages/reports/charts.jsx?raw';

const BASE = { company_name: 'Demo Company', document_template: 'default' };
const HAJO = { ...BASE, document_template: 'hajosign' };

// Captures what printHTML writes into its hidden iframe, and stops the print
// dialog. jsdom has no print(); the iframe's window still needs the method.
function captureNextPrint() {
  return new Promise((resolve) => {
    const orig = document.body.appendChild.bind(document.body);
    document.body.appendChild = (node) => {
      const out = orig(node);
      if (node.tagName === 'IFRAME') {
        node.contentWindow.print = () => {};
        node.contentWindow.focus = () => {};
        queueMicrotask(() => resolve(node.contentDocument.documentElement.outerHTML));
      }
      return out;
    };
  });
}

const COLUMNS = [
  { label: 'Date', value: r => r.date, align: 'left' },
  { label: 'Charged', value: r => r.charged, align: 'right' },
];
const ROWS = [{ date: 'Aug 6, 2025', charged: 100 }];

async function render(settings, extra = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).startsWith('/api/settings/logo')) return { ok: false, headers: new Headers() };
    return { ok: true, json: async () => settings };
  });
  const captured = captureNextPrint();
  await exportReportPDF({
    title: 'Statement of account', filename: 'statement.pdf',
    columns: COLUMNS, rows: ROWS, ...extra,
  });
  return captured;
}

let savedAppend;
beforeEach(() => { savedAppend = document.body.appendChild; });
afterEach(() => { document.body.appendChild = savedAppend; vi.restoreAllMocks(); });

describe('a themed tenant', () => {
  test('gets its letterhead on the statement, with the account named', async () => {
    const html = await render(HAJO, {
      client: { name: 'Client Alpha' },
      subtitle: 'Aug 1, 2025 – Aug 31, 2025',
      meta: { 'Opening balance': '$0', 'Closing balance': '$810.53' },
      totals: { label: 'Total', columns: [null, 100] },
    });
    // The very same shell the invoice prints through.
    expect(html).toContain('class="hj-sheet"');
    expect(html).toContain('class="hj-masthead"');
    expect(html).toContain('<div class="hj-inner">');
    // The header names the account and carries the period and the balances.
    expect(html).toMatch(/hj-account">Client Alpha/);
    expect(html).toMatch(/hj-meta-key">Period<\/span>\s*<span class="hj-meta-val">Aug 1, 2025 – Aug 31, 2025/);
    expect(html).toMatch(/hj-meta-key">Closing balance<\/span>\s*<span class="hj-meta-val">\$810\.53/);
    // The table is the theme's, not the generic builder's brand-blue one.
    expect(html).not.toContain('rpt-hdr');
    expect(html).not.toContain('class="rpt-th');
    expect(html).toMatch(/<th class="r">Charged<\/th>/);
    expect(html).toMatch(/rpt-totals/);
  });

  test('a long statement may break across sheets; the letterhead repeats', async () => {
    const html = await render(HAJO);
    expect(html).toMatch(/\.hj-inner table\.rpt-tbl \{ page-break-inside: auto; \}/);
  });
});

describe('every other tenant', () => {
  test('prints the generic report exactly as before', async () => {
    const html = await render(BASE, { client: { name: 'Client Alpha' } });
    expect(html).toContain('class="rpt-hdr"');
    expect(html).toContain('class="rpt-th rpt-left"');
    expect(html).not.toContain('hj-sheet');
    // The generic header has no account line; the client is only for
    // letterheads that carry one.
    expect(html).not.toContain('Client Alpha');
  });
});

describe('the statement tab hands the letterhead what it needs', () => {
  test('the customer, the period, and both balances', () => {
    expect(statementSrc).toMatch(/pdfClient=\{data\.client\}/);
    expect(statementSrc).toMatch(/\[t\('clients\.openingBalance'\)\]: fmt\(data\.opening_balance/);
    expect(statementSrc).toMatch(/\[t\('clients\.closingBalance'\)\]: fmt\(data\.closing_balance/);
    expect(statementSrc).toMatch(/totals=\{\{/);
    expect(chartsSrc).toMatch(/client: pdfClient \|\| null/);
  });
});
