// Sales by address: the places, biggest first, each opening onto its
// customers; the gap (no address, walk-in) shown at the bottom, not hidden.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const client = (id, name, sales, address) => ({ id, name, company: null, address, invoices: 1,
  sales, gross: sales, collected: 0, outstanding: sales });
const DATA = {
  start: '2026-01-01', end: '2026-12-31',
  summary: { locations: 2, customers: 4, invoices: 5, sales: 1000, gross: 1100, collected: 600,
             outstanding: 500, unlocated_sales: 100 },
  locations: [
    { key: 'hamra, beirut', kind: 'address', address: 'Hamra, Beirut', customers: 2, invoices: 2,
      sales: 600, gross: 660, collected: 400, outstanding: 260, share: 60,
      clients: [client(1, 'Aya', 400, 'Hamra, Beirut'), client(2, 'Bilal', 200, 'hamra,  beirut.')] },
    { key: 'tyre', kind: 'address', address: 'Tyre', customers: 1, invoices: 1, sales: 300, gross: 330,
      collected: 200, outstanding: 130, share: 30, clients: [client(3, 'Chadi', 300, 'Tyre')] },
    { key: 'no_address', kind: 'no_address', address: null, customers: 1, invoices: 2, sales: 100,
      gross: 110, collected: 0, outstanding: 110, share: 10, clients: [client(4, 'Dana', 100, null)] },
  ],
};
vi.mock('../api/client', () => ({ getReportSalesByAddress: vi.fn(() => Promise.resolve(DATA)) }));
vi.mock('../pages/reports/charts', () => ({
  StatCard: ({ label, value }) => <div data-testid="stat">{label}: {value}</div>,
  HBarChart: ({ data }) => <div data-testid="chart">{data.map(d => d.place).join('|')}</div>,
  ExportButtons: () => <div data-testid="export" />,
}));
vi.mock('../components/shared', () => ({
  LoadingSpinner: () => <div>loading</div>,
  ErrorAlert: ({ message }) => <div role="alert">{message}</div>,
  fmt: v => Number(v || 0).toFixed(2),
}));

import { SalesByAddressReport } from '../pages/reports/SalesByAddressReport';

const t = (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k);
async function mount() {
  let utils;
  await act(async () => {
    utils = render(<MemoryRouter>
      <SalesByAddressReport params={{ start: '2026-01-01', end: '2026-12-31' }} t={t} />
    </MemoryRouter>);
  });
  return utils;
}
const places = c => [...c.querySelectorAll('tr.sba-place')].map(r => r.children[1].textContent);
const customers = c => [...c.querySelectorAll('tr.sba-client')].map(r => r.children[1].textContent);

beforeEach(() => { vi.clearAllMocks(); });

describe('Sales by address', () => {
  test('asks for the period and lists the places, the gap last', async () => {
    const api = await import('../api/client');
    const { container, getByTestId } = await mount();
    expect(api.getReportSalesByAddress).toHaveBeenCalledWith({ start: '2026-01-01', end: '2026-12-31' });
    expect(places(container)).toEqual(['Hamra, Beirut', 'Tyre', 'reports.sba.no_address']);
    expect(getByTestId('chart').textContent).toBe('Hamra, Beirut|Tyre');
    expect(container.textContent).toContain('reports.sba.unlocated {"amount":"100.00"}');
  });

  test('a place opens onto its customers, with the address as each typed it', async () => {
    const { container } = await mount();
    expect(customers(container)).toEqual([]);
    await act(async () => { fireEvent.click(container.querySelector('tr.sba-place')); });
    expect(customers(container)).toEqual(['Aya', expect.stringContaining('Bilal')]);
    expect(customers(container)[1]).toContain('hamra,  beirut.');
  });

  test('searching a customer finds their place and opens it', async () => {
    const { container, getByLabelText } = await mount();
    await act(async () => {
      fireEvent.change(getByLabelText('reports.sba.search'), { target: { value: 'chadi' } });
    });
    expect(places(container)).toEqual(['Tyre']);
    expect(customers(container)).toEqual(['Chadi']);
    expect(container.querySelector('tfoot'), 'totals are for the whole period, not the search').toBeNull();
  });
});
