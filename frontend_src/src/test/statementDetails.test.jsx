// The statement of account can show what each invoice was for, on screen and
// in the exported PDF / spreadsheet.
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

const STATEMENT = {
  client: { id: 3, name: 'Nour Stores' }, currency: 'USD', opening_balance: 0,
  total_charged: 220, total_paid: 0, closing_balance: 220,
  movements: [{
    date: '2026-11-01', type: 'invoice', reference: 'INV-2026-000031', invoice_id: 31,
    description: 'Invoice INV-2026-000031', charged: 220, paid: 0, balance: 220,
    lines: [{ name: 'Office chair', quantity: 2, unit: 'pcs', unit_price: 100, discount: 0, net: 200, tax: 0 },
            { name: 'Delivery', quantity: 1, unit: null, unit_price: 20, discount: 0, net: 20, tax: 0 }],
  }],
};
vi.mock('../api/client', () => ({ getClientStatement: () => Promise.resolve(STATEMENT) }));
const exported = [];
vi.mock('../pages/reports/charts', () => ({
  ExportButtons: (p) => { exported.push(p.rows.map(r => p.columns[2].value(r))); return null; },
}));

import StatementTab from '../pages/clients/StatementTab.jsx';

describe('statement of account with invoice details', () => {
  test('a click opens one invoice\'s items; the switch opens them all and exports them', async () => {
    localStorage.setItem('erp_lang', 'en');
    render(<LocaleProvider><StatementTab clientId={3} /></LocaleProvider>);
    await waitFor(() => screen.getByText('INV-2026-000031'));
    expect(screen.queryByText('Office chair')).toBeNull();
    fireEvent.click(screen.getByText('INV-2026-000031'));
    expect(screen.getByText('Office chair')).toBeTruthy();
    fireEvent.click(screen.getByText('INV-2026-000031'));
    expect(screen.queryByText('Office chair')).toBeNull();

    fireEvent.click(screen.getByLabelText(en.clients.showInvoiceDetails));
    expect(screen.getByText('Office chair')).toBeTruthy();
    const last = exported[exported.length - 1];
    expect(last[0]).toBe('Invoice INV-2026-000031');
    expect(last[1]).toContain('Office chair');
    expect(last[1]).toContain('2 pcs');
    expect(last.length).toBe(3);
  });

  test('its strings exist in both languages', () => {
    for (const k of ['showInvoiceDetails', 'clickForItems', 'item', 'qty', 'unitPrice', 'amount']) {
      expect(en.clients[k], k).toBeTruthy();
      expect(ar.clients[k]).not.toBe(en.clients[k]);
    }
  });
});
