// The profit summary tab: one row per period, sales split by channel.
import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import reportsSrc from '../pages/Reports.jsx?raw';

const row = (period, start, end, o = {}) => ({
  period, start, end,
  pos_count: 0, pos_sales: 0, invoice_count: 0, invoice_sales: 0,
  service_count: 0, service_sales: 0, sales_count: 0, sales: 0, cost: 0,
  gross_profit: 0, gross_margin_pct: null, expenses: 0, salaries: 0,
  net_profit: 0, uncollected: 0, cash_profit: 0, purchases_count: 0, purchases: 0, ...o,
});
const DATA = {
  start: '2026-01-01', end: '2026-02-28', group: 'month', branch_scoped: false,
  rows: [
    row('2026-01', '2026-01-01', '2026-01-31', {
      pos_count: 12, pos_sales: 1200, invoice_count: 3, invoice_sales: 900,
      service_count: 4, service_sales: 640, sales_count: 19, sales: 2740,
      cost: 800, gross_profit: 1940, gross_margin_pct: 70.8, expenses: 300,
      salaries: 1000, net_profit: 640, uncollected: 150, cash_profit: 490 }),
    row('2026-02', '2026-02-01', '2026-02-28', { expenses: 200, net_profit: -200, cash_profit: -200 }),
  ],
  totals: row('Total', '2026-01-01', '2026-02-28', {
    pos_count: 12, pos_sales: 1200, invoice_count: 3, invoice_sales: 900,
    service_count: 4, service_sales: 640, sales_count: 19, sales: 2740, cost: 800,
    gross_profit: 1940, gross_margin_pct: 70.8, expenses: 500, salaries: 1000,
    net_profit: 440, uncollected: 150, cash_profit: 290 }),
};

const getReportProfitSummary = vi.fn(() => Promise.resolve(DATA));
vi.mock('../api/client', () => ({
  getReportProfitSummary: (...a) => getReportProfitSummary(...a),
}));
vi.mock('../components/shared', () => ({
  LoadingSpinner: () => <div>loading</div>,
  ErrorAlert: ({ message }) => <div>{message}</div>,
  fmt: v => Number(v || 0).toFixed(2),
}));
vi.mock('../pages/reports/charts', () => ({
  StatCard: ({ label, value }) => <div data-testid="stat">{label}: {value}</div>,
  ExportButtons: () => <div data-testid="export" />,
}));

import { ProfitSummaryReport } from '../pages/reports/ProfitSummaryReport';

const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

describe('the profit summary', () => {
  test('lists every period with its channels and a totals line', async () => {
    render(<ProfitSummaryReport params={{ start: '2026-01-01', end: '2026-02-28' }} t={t} />);
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(3));
    const body = document.body.textContent;
    // A count under each channel, and the quiet month still has its row.
    expect(body).toContain('reports.psCount:{"n":12}');
    expect(body).toContain('reports.psCount:{"n":4}');
    expect(screen.getAllByRole('row')).toHaveLength(2 + 2 + 1);   // 2 header rows, 2 periods, total
    expect(screen.getByTestId('export')).toBeTruthy();
  });

  test('asks the server for the grouping chosen', async () => {
    getReportProfitSummary.mockClear();
    render(<ProfitSummaryReport params={{ start: '2026-01-01', end: '2026-02-28' }} t={t} />);
    await waitFor(() => expect(getReportProfitSummary).toHaveBeenCalled());
    expect(getReportProfitSummary.mock.calls[0][0]).toMatchObject({ group: 'month' });
  });

  test('is the first tab on the Reports page', () => {
    // Only for those holding the permission, and never rendered without it.
    expect(reportsSrc).toMatch(/const canProfit = can\('profit_report'\)/);
    expect(reportsSrc).toMatch(/\.\.\.\(canProfit \? \[\{ key: 'profit'/);
    expect(reportsSrc).toMatch(/current === 'profit' && canProfit && <ProfitSummaryReport/);
  });
});
