// Invoice Aging used to ignore every filter: the period at the top of Reports
// was never sent, so changing it changed nothing. It now asks for the chosen
// period, asks again when it changes, and the table can be searched.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const DATA = {
  summary: { current: { count: 2, total: 300 }, '1_30': { count: 0, total: 0 },
             '31_60': { count: 0, total: 0 }, '61_90': { count: 0, total: 0 },
             over_90: { count: 0, total: 0 } },
  invoices: [
    { id: 1, invoice_number: 'INV-1', client_name: 'Nour Stores', amount: 100, paid_amount: 0, remaining: 100, days_overdue: 0 },
    { id: 2, invoice_number: 'INV-2', client_name: 'Cedar Trading', amount: 200, paid_amount: 0, remaining: 200, days_overdue: 0 },
  ],
};

vi.mock('../api/client', () => ({
  getReportInvoiceAging: vi.fn(() => Promise.resolve(DATA)),
}));

const t = (k) => k;

async function mount(params) {
  const { AgingReport } = await import('../pages/reports/AgingReport.jsx');
  const view = (p) => (
    <ThemeProvider><LocaleProvider><MemoryRouter>
      <AgingReport params={p} t={t} />
    </MemoryRouter></LocaleProvider></ThemeProvider>);
  let utils;
  await act(async () => { utils = render(view(params)); });
  return { ...utils, rerenderWith: async (p) => { await act(async () => utils.rerender(view(p))); } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Invoice Aging filters', () => {
  test('asks the server for the chosen period, and again when it changes', async () => {
    const api = await import('../api/client');
    const { rerenderWith } = await mount({ start: '2026-11-01', end: '2026-11-30' });
    expect(api.getReportInvoiceAging).toHaveBeenLastCalledWith({ start: '2026-11-01', end: '2026-11-30' });

    await rerenderWith({ start: '2026-01-01', end: '2026-12-31' });
    expect(api.getReportInvoiceAging).toHaveBeenLastCalledWith({ start: '2026-01-01', end: '2026-12-31' });
    expect(api.getReportInvoiceAging).toHaveBeenCalledTimes(2);
  });

  test('the search narrows the table by client or invoice number', async () => {
    const { container, getByLabelText } = await mount({ start: '2026-01-01', end: '2026-12-31' });
    const rows = () => [...container.querySelectorAll('tbody tr')].map(r => r.textContent);
    expect(rows()).toHaveLength(2);

    await act(async () => { fireEvent.change(getByLabelText('reports.agingSearch'), { target: { value: 'cedar' } }); });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('INV-2');

    await act(async () => { fireEvent.change(getByLabelText('reports.agingSearch'), { target: { value: 'inv-1' } }); });
    expect(rows()[0]).toContain('Nour Stores');
  });
});
