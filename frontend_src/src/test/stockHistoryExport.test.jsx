// An item's stock history can be exported, and the invoice list no longer
// carries a due-date column (overdue still shows in the status badge).
import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import invoicesSrc from '../pages/Invoices.jsx?raw';

const MOVES = [{ id: 1, created_at: '2026-11-01 10:15:00', type: 'sale', delta: -2, qty_before: 10,
                 qty_after: 8, reference: 'INV-2026-000031', note: 'Invoice' }];
vi.mock('../api/client', () => ({ getStockMovements: () => Promise.resolve(MOVES) }));
const exported = [];
vi.mock('../pages/reports/charts', () => ({
  ExportButtons: (p) => { exported.push(p); return <span>export-buttons</span>; },
}));
import { MovementsModal } from '../pages/inventory/MovementsModal';

describe('stock history export', () => {
  test('the history window offers Excel and PDF of every movement', async () => {
    localStorage.setItem('erp_lang', 'en');
    render(<LocaleProvider><MovementsModal item={{ id: 4, name: 'Office chair' }} onClose={() => {}} /></LocaleProvider>);
    await waitFor(() => screen.getByText('export-buttons'));
    const p = exported[exported.length - 1];
    expect(p.rows).toHaveLength(1);
    expect(p.baseName).toBe('stock_history_Office_chair');
    const ref = p.columns.find(c => c.label === 'Reference');
    expect(ref.value(MOVES[0])).toBe('INV-2026-000031');
  });
});

describe('invoice list', () => {
  test('has no due-date column, but still flags overdue in the status', () => {
    expect(invoicesSrc).not.toContain('sortKey="due_date"');
    expect(invoicesSrc).toContain("<Badge status={inv.is_overdue ? 'Overdue' : inv.payment_status} />");
  });
});
