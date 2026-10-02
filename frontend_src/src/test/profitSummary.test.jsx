// The profit summary: choose from-to, generate, read it in columns.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import reportsSrc from '../pages/Reports.jsx?raw';
import exportSrc from '../utils/exportUtils.js?raw';

const row = (period, start, end, o = {}) => ({
  period, start, end,
  pos_count: 0, pos_sales: 0, invoice_count: 0, invoice_sales: 0,
  service_count: 0, service_sales: 0, sales_count: 0, sales: 0, cost: 0,
  gross_profit: 0, gross_margin_pct: null, expenses: 0, salaries: 0,
  net_profit: 0, uncollected: 0, cash_profit: 0, purchases_count: 0, purchases: 0, ...o,
});
const SEP = row('2026-09', '2026-09-01', '2026-09-30', {
  pos_count: 12, pos_sales: 1200, invoice_count: 3, invoice_sales: 900,
  service_count: 4, service_sales: 640, sales_count: 19, sales: 2740,
  cost: 800, gross_profit: 1940, gross_margin_pct: 70.8, expenses: 300,
  salaries: 1000, net_profit: 640, uncollected: 150, cash_profit: 490 });
const OCT = row('2026-10', '2026-10-01', '2026-10-31', { expenses: 200, net_profit: -200, cash_profit: -200 });
const MONTHLY = {
  start: '2026-09-01', end: '2026-10-31', group: 'month', branch_scoped: false,
  rows: [SEP, OCT],
  totals: { ...SEP, period: 'Total', expenses: 500, net_profit: 440, cash_profit: 290 },
};

const getReportProfitSummary = vi.fn(p => Promise.resolve(
  p.group === 'total'
    ? { ...MONTHLY, group: 'total', rows: [{ ...MONTHLY.totals, period: 'total' }] }
    : MONTHLY));
vi.mock('../api/client', () => ({
  getReportProfitSummary: (...a) => getReportProfitSummary(...a),
}));
vi.mock('../components/shared', () => ({
  LoadingSpinner: () => <div>loading</div>,
  ErrorAlert: ({ message }) => <div role="alert">{message}</div>,
  fmt: v => Number(v || 0).toFixed(2),
  exportPeriodRange: () => ({ from: '2026-09-01', to: '2026-10-31' }),
}));
const exportProps = [];
vi.mock('../pages/reports/charts', () => ({
  StatCard: ({ label, value }) => <div data-testid="stat">{label}: {value}</div>,
  ExportButtons: (p) => { exportProps.push(p); return <div data-testid="export" />; },
}));

import { ProfitSummaryReport } from '../pages/reports/ProfitSummaryReport';

const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

async function generated(rowsChoice) {
  render(<ProfitSummaryReport t={t} />);
  if (rowsChoice) fireEvent.click(screen.getByText(`reports.psRows_${rowsChoice}`));
  fireEvent.click(screen.getByText('reports.psGenerate'));
  await screen.findByTestId('export');
}

describe('the profit summary', () => {
  beforeEach(() => { getReportProfitSummary.mockClear(); exportProps.length = 0; });

  test('waits for a period and Generate', () => {
    render(<ProfitSummaryReport t={t} />);
    expect(getReportProfitSummary).not.toHaveBeenCalled();
    expect(screen.getByText('reports.psChoosePeriod')).toBeTruthy();
  });

  test('lays the period out in columns, a row per month and a totals line', async () => {
    await generated();
    expect(getReportProfitSummary.mock.calls[0][0])
      .toEqual({ start: '2026-09-01', end: '2026-10-31', group: 'month' });
    // two header rows, two months, one totals line
    expect(screen.getAllByRole('row')).toHaveLength(5);
    for (const h of ['reports.psPos', 'reports.psInvoices', 'reports.psServices',
                     'reports.psCost', 'reports.psGross', 'reports.psExpenses',
                     'reports.psSalaries', 'reports.psNet', 'reports.psCash']) {
      expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    }
    expect(document.body.textContent).toContain('reports.psCount:{"n":4}');   // services count
  });

  test('the whole period can be one row', async () => {
    await generated('total');
    expect(getReportProfitSummary.mock.calls[0][0].group).toBe('total');
    expect(screen.getAllByRole('row')).toHaveLength(3);        // header ×2, one row
  });

  test('the PDF carries every channel, services included, in small type', async () => {
    await generated();
    const p = exportProps.at(-1);
    const labels = p.pdfColumns.map(c => c.label);
    expect(labels).toEqual(expect.arrayContaining(
      ['reports.psPos', 'reports.psInvoices', 'reports.psServices', 'reports.psSales',
       'reports.psCost', 'reports.psGross', 'reports.psExpenses', 'reports.psSalaries',
       'reports.psNet', 'reports.psUncollected', 'reports.psCash']));
    expect(p.pdfDense).toBe(true);
    const services = p.pdfColumns.find(c => c.label === 'reports.psServices');
    expect(services.value(SEP)).toBe(640);
    expect(p.totals.label).toBe('common.total');
  });

  test('refuses a period that ends before it starts', () => {
    render(<ProfitSummaryReport t={t} />);
    fireEvent.change(screen.getByLabelText('common.exportFrom'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('common.exportTo'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByText('reports.psGenerate'));
    expect(getReportProfitSummary).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('common.exportFromAfterTo');
  });
});

describe('around it', () => {
  test('the Reports page keeps the permission gate and its own dates', () => {
    expect(reportsSrc).toMatch(/const canProfit = can\('profit_report'\)/);
    expect(reportsSrc).toMatch(/current === 'profit' && canProfit && <ProfitSummaryReport t=\{t\} \/>/);
    expect(reportsSrc).toMatch(/\{current !== 'profit' && \(/);
  });
  test('the report PDF has a dense mode, on plain paper and on the letterhead', () => {
    expect(exportSrc).toMatch(/dense = false,/);
    expect(exportSrc).toMatch(/\$\{dense \? `table\.rpt-tbl \{ font-size: 7px; \}/);
    expect(exportSrc).toMatch(/\.hj-inner table\.rpt-tbl th, \.hj-inner table\.rpt-tbl td \{\s*font-size: 7px !important;/);
  });
});

describe('the report PDF on a letterhead', () => {
  test('a report about the whole business prints no empty Account line', () => {
    expect(exportSrc).toMatch(/hideAccount: !client,/);
    expect(exportSrc).toMatch(/theme\.header\(\{ C, title, client, rows, statusHtml, hideAccount \}\)/);
  });
  test('dense column titles wrap instead of running into each other', () => {
    expect(exportSrc).toMatch(/\.hj-inner table\.rpt-tbl th \{\s*white-space: normal;/);
  });
});
