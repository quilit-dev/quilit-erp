// The Payment Plans report: the book's state up top, a status filter that asks
// the server again, a search, and each plan opening onto its own schedule.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const line = (seq, due, amount, paid, status) => ({ seq, due_date: due, amount, paid, remaining: amount - paid, status });
const DATA = {
  as_of: '2026-11-22', start: '2026-01-01', end: '2026-12-31', status: 'open',
  summary: { plans: 2, on_track: 1, late: 1, completed: 0, cancelled: 0, scheduled: 2000, collected: 450,
             outstanding: 1550, overdue: 150, overdue_installments: 1, due_in_period: 900,
             scheduled_in_period: 1200, collection_rate: 75 },
  aging: { current: { count: 2, total: 600 }, '1_30': { count: 1, total: 150 }, '31_60': { count: 0, total: 0 },
           '61_90': { count: 0, total: 0 }, over_90: { count: 0, total: 0 } },
  forecast: [{ month: '2026-12', due: 300, count: 1 }],
  plans: [
    { key: 'invoice-7', kind: 'invoice', client_id: 3, client_name: 'Behind Co', reference: 'INV-7', invoice_id: 7,
      status: 'late', count: 4, paid_count: 1, total: 1200, paid: 450, remaining: 750, progress: 37.5,
      overdue: 150, overdue_count: 1, days_late: 15, next_due_date: '2026-12-08', next_due_amount: 300,
      first_due: '2026-10-08', last_due: '2027-01-08', frequency: 'monthly', due_in_period: 450,
      installments: [line(1, '2026-10-08', 300, 300, 'Paid'), line(2, '2026-11-08', 300, 150, 'Overdue'),
                     line(3, '2026-12-08', 300, 0, 'Due'), line(4, '2027-01-08', 300, 0, 'Due')] },
    { key: 'account-2', kind: 'account', client_id: 4, client_name: 'Fine Co', reference: 'Account plan #2',
      invoice_id: null, status: 'on_track', count: 4, paid_count: 0, total: 800, paid: 0, remaining: 800,
      progress: 0, overdue: 0, overdue_count: 0, days_late: 0, next_due_date: '2026-12-01', next_due_amount: 200,
      first_due: '2026-12-01', last_due: '2027-03-01', frequency: 'monthly', due_in_period: 200,
      installments: [line(1, '2026-12-01', 200, 0, 'Due')] },
  ],
};

vi.mock('../api/client', () => ({ getReportPaymentPlans: vi.fn(() => Promise.resolve(DATA)) }));

const t = (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k);

async function mount() {
  const { PaymentPlansReport } = await import('../pages/reports/PaymentPlansReport.jsx');
  let utils;
  await act(async () => {
    utils = render(<ThemeProvider><LocaleProvider><MemoryRouter>
      <PaymentPlansReport params={{ start: '2026-01-01', end: '2026-12-31' }} t={t} />
    </MemoryRouter></LocaleProvider></ThemeProvider>);
  });
  return utils;
}

const planRows = c => [...c.querySelectorAll('tbody tr[aria-expanded]')];

beforeEach(() => { vi.clearAllMocks(); });

describe('Payment Plans report', () => {
  test('shows the state of the book and every plan', async () => {
    const { container } = await mount();
    expect(container.textContent).toContain('75%');
    expect(planRows(container).map(r => r.textContent)).toEqual([
      expect.stringContaining('Behind Co'), expect.stringContaining('Fine Co')]);
    expect(container.textContent).toContain('reports.pp.status.late');
  });

  test('the status filter asks the server again', async () => {
    const api = await import('../api/client');
    const { getByText } = await mount();
    expect(api.getReportPaymentPlans).toHaveBeenLastCalledWith({ start: '2026-01-01', end: '2026-12-31', status: 'open' });
    await act(async () => { fireEvent.click(getByText('reports.pp.filter.completed')); });
    expect(api.getReportPaymentPlans).toHaveBeenLastCalledWith({ start: '2026-01-01', end: '2026-12-31', status: 'completed' });
  });

  test('a plan opens onto its schedule', async () => {
    const { container } = await mount();
    expect(container.querySelector('.plan-schedule')).toBeNull();
    await act(async () => { fireEvent.click(planRows(container)[0]); });
    const schedule = container.querySelector('.plan-schedule');
    expect(schedule.querySelectorAll(':scope table > tbody > tr')).toHaveLength(4);
    expect(schedule.textContent).toContain('reports.pp.line.Overdue');
  });

  test('the search narrows the list', async () => {
    const { container, getByLabelText } = await mount();
    await act(async () => { fireEvent.change(getByLabelText('reports.pp.search'), { target: { value: 'fine' } }); });
    expect(planRows(container)).toHaveLength(1);
    expect(planRows(container)[0].textContent).toContain('Fine Co');
  });
});
