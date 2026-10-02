// The profit summary: choose from-to, generate, read one statement.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import reportsSrc from '../pages/Reports.jsx?raw';

const TOT = {
  period: 'total', start: '2026-09-01', end: '2026-09-30',
  pos_count: 12, pos_sales: 1200, invoice_count: 3, invoice_sales: 900,
  service_count: 4, service_sales: 640, sales_count: 19, sales: 2740,
  cost: 800, gross_profit: 1940, gross_margin_pct: 70.8, expenses: 300,
  salaries: 1000, net_profit: 640, uncollected: 150, cash_profit: 490,
  purchases_count: 2, purchases: 500,
};
const getReportProfitSummary = vi.fn(() => Promise.resolve({
  start: '2026-09-01', end: '2026-09-30', group: 'total', branch_scoped: false,
  rows: [TOT], totals: TOT,
}));
vi.mock('../api/client', () => ({
  getReportProfitSummary: (...a) => getReportProfitSummary(...a),
}));
vi.mock('../components/shared', () => ({
  LoadingSpinner: () => <div>loading</div>,
  ErrorAlert: ({ message }) => <div role="alert">{message}</div>,
  fmt: v => Number(v || 0).toFixed(2),
  exportPeriodRange: () => ({ from: '2026-09-01', to: '2026-09-30' }),
}));
vi.mock('../pages/reports/charts', () => ({
  StatCard: ({ label, value }) => <div data-testid="stat">{label}: {value}</div>,
  ExportButtons: ({ rows }) => <div data-testid="export" data-rows={rows.length} />,
}));

import { ProfitSummaryReport, statementLines } from '../pages/reports/ProfitSummaryReport';

const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

describe('the profit summary', () => {
  beforeEach(() => getReportProfitSummary.mockClear());

  test('waits for a period and Generate instead of loading on its own', () => {
    render(<ProfitSummaryReport t={t} />);
    expect(getReportProfitSummary).not.toHaveBeenCalled();
    expect(screen.getByText('reports.psChoosePeriod')).toBeTruthy();
  });

  test('generates one statement for exactly the dates chosen', async () => {
    render(<ProfitSummaryReport t={t} />);
    fireEvent.change(screen.getByLabelText('common.exportFrom'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('common.exportTo'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByText('reports.psGenerate'));
    await waitFor(() => expect(getReportProfitSummary).toHaveBeenCalled());
    expect(getReportProfitSummary.mock.calls[0][0])
      .toEqual({ start: '2026-09-01', end: '2026-09-30', group: 'total' });
    await screen.findByText('reports.psTotalSales', { selector: 'td' });
    const body = document.body.textContent;
    expect(body).toContain('2740.00');
    expect(body).toContain('-800.00');            // cost shown as a deduction
    expect(body).toContain('640.00');
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

describe('the statement lines', () => {
  const lines = statementLines(TOT, k => k);
  const by = k => lines.find(l => l.key === k);

  test('sales by channel add up to total sales, with their counts', () => {
    expect(by('pos').amount + by('invoices').amount + by('services').amount).toBe(by('sales').amount);
    expect([by('pos').count, by('invoices').count, by('services').count]).toEqual([12, 3, 4]);
  });
  test('each step down the statement follows from the one above', () => {
    expect(by('sales').amount + by('cost').amount).toBe(by('gross').amount);
    expect(by('gross').amount + by('expenses').amount + by('salaries').amount).toBe(by('net').amount);
    expect(by('net').amount + by('uncollected').amount).toBe(by('cash').amount);
  });
  test('purchases are shown for reference, outside the profit', () => {
    expect(by('purchases').amount).toBe(500);
    expect(lines.indexOf(by('purchases'))).toBeGreaterThan(lines.indexOf(by('cash')));
  });
  test('a branch-scoped report has no purchases line', () => {
    const scoped = statementLines({ ...TOT, purchases: null, purchases_count: null }, k => k);
    expect(scoped.find(l => l.key === 'purchases')).toBeUndefined();
  });
});

describe('the Reports page', () => {
  test('the profit summary keeps its permission gate and its own dates', () => {
    expect(reportsSrc).toMatch(/const canProfit = can\('profit_report'\)/);
    expect(reportsSrc).toMatch(/current === 'profit' && canProfit && <ProfitSummaryReport t=\{t\} \/>/);
    expect(reportsSrc).toMatch(/\{current !== 'profit' && \(/);
  });
});
