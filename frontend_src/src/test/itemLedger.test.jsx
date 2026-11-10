// Item ledger: a Reports tab that shows one item's sales, buyers, purchases,
// returns and movements, reachable from each inventory row.
import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import reportsSrc from '../pages/Reports.jsx?raw';
import inventorySrc from '../pages/Inventory.jsx?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

const LEDGER = {
  start: '2026-01-01', end: '2026-11-10', show_cost: false,
  item: { id: 4, name: 'Office chair', unit: 'pcs', on_hand: 12, sale_price: 100, category: null },
  summary: { net_quantity: 5, quantity_returned: 0, net_sales: 500, average_price: 100, customers: 2,
             invoices: 3, quantity_purchased: 10, quantity_returned_to_suppliers: 0, last_sale: '2026-11-01' },
  sales: [{ date: '2026-11-01', invoice_number: 'INV-2026-000031', source: 'invoice', client_name: 'Nour Stores',
            quantity: 2, unit: 'pcs', unit_price: 100, discount: 0, net: 200, payment_status: 'Paid' }],
  customers: [{ client_id: 1, client_name: 'Nour Stores', quantity: 2, returned: 0, net_sales: 200,
                invoices: 1, last_date: '2026-11-01' }],
  monthly: [{ month: '2026-11', quantity: 5, net_sales: 500 }],
  purchases: [], returns_in: [], returns_out: [], movements: [],
};
vi.mock('../api/client', () => ({
  getInventory: () => Promise.resolve([{ id: 4, name: 'Office chair' }]),
  getReportItemLedger: () => Promise.resolve(LEDGER),
}));
vi.mock('../pages/reports/charts', () => ({
  StatCard: ({ label, value }) => <div>{label}: {value}</div>,
  VBarChart: () => <div>chart</div>,
  ExportButtons: () => <span>export</span>,
}));
import { ItemLedgerReport } from '../pages/reports/ItemLedgerReport';

describe('item ledger', () => {
  test('shows the item, its sales and who bought it; no cost without permission', async () => {
    localStorage.setItem('erp_lang', 'en');
    render(<LocaleProvider><ItemLedgerReport params={{}} t={(k) => k.split('.').reduce((o, p) => (o || {})[p], en) || k} initialItem={4} /></LocaleProvider>);
    await waitFor(() => screen.getByText('INV-2026-000031'));
    expect(screen.getAllByText('Nour Stores').length).toBe(2);
    expect(screen.queryByText(en.reports.ledgerUnitCost)).toBeNull();
  });

  test('is a Reports tab, and each inventory row links to it', () => {
    expect(reportsSrc).toContain("{ key: 'itemLedger',");
    expect(reportsSrc).toContain("initialItem={linkedItem}");
    expect(inventorySrc).toContain('navigate(`/reports?report=itemLedger&item=${item.id}`)');
  });

  test('its strings exist in both languages', () => {
    for (const k of ['itemLedger', 'walkIn', 'ledgerSales', 'ledgerByCustomer', 'ledgerPurchases',
                     'ledgerMovements', 'ledgerPickItemHint']) {
      expect(en.reports[k], k).toBeTruthy();
      expect(ar.reports[k]).not.toBe(en.reports[k]);
    }
    expect(ar.inventory.itemLedger).toBeTruthy();
  });
});
