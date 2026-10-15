// Returns: the credit and debit notes, and the screens that raise them.
import { describe, test, expect } from 'vitest';
import { buildReturnNoteHTML } from '../utils/returnNote';
import modalsSrc from '../components/ReturnModals.jsx?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import actionMenuSrc from '../pages/invoices/ActionMenu.jsx?raw';
import purchasesSrc from '../pages/Purchases.jsx?raw';
import sidebarSrc from '../components/Sidebar.jsx?raw';
import appSrc from '../App.jsx?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

const SETTINGS = { company_name: 'Test Co', default_currency: 'USD' };

const creditNote = {
  id: 4, return_number: 'CN-2026-00004', return_date: '2026-10-15',
  invoice_number: 'INV-2026-000012', client_name: 'Nour Stores', reason: 'Wrong size',
  subtotal: 200, tax_total: 22, total: 222,
  applied_to_invoice: 100, refunded: 0, credited: 122, refund_method: null,
  items: [
    { name: 'Chair', quantity: 2, unit: 'pcs', unit_net: 100, net: 200, tax_amount: 22,
      condition: 'restock' },
  ],
};

const debitNote = {
  id: 2, return_number: 'DN-2026-00002', return_date: '2026-10-15',
  po_number: 'PO-0007', supplier: 'Acme Trading',
  subtotal: 50, tax_total: 0, total: 50,
  applied_to_purchase: 0, refunded: 50, credited: 0, refund_method: 'Bank Transfer',
  items: [{ name: 'Cable', quantity: 5, unit_price: 10, net: 50, tax_amount: 0 }],
};

describe('the credit note', () => {
  test('names the invoice, the customer, the lines and how it was settled', () => {
    const html = buildReturnNoteHTML(creditNote, 'sales', SETTINGS);
    expect(html).toContain('Credit Note');
    expect(html).toContain('إشعار دائن');
    expect(html).toContain('CN-2026-00004');
    expect(html).toContain('INV-2026-000012');
    expect(html).toContain('Nour Stores');
    expect(html).toContain('Back in stock');
    expect(html).toContain('222.00 USD');
    expect(html).toContain('Taken off the invoice balance');
    expect(html).toContain('Held as customer credit');
    expect(html).not.toContain('Refunded —');
  });

  test('a voided note says so on the paper', () => {
    const html = buildReturnNoteHTML({ ...creditNote, voided_at: '2026-10-16', void_reason: 'typo' },
                                     'sales', SETTINGS);
    expect(html).toContain('VOID');
  });
});

describe('the debit note', () => {
  test('names the purchase, the supplier and the refund', () => {
    const html = buildReturnNoteHTML(debitNote, 'purchases', SETTINGS);
    expect(html).toContain('Debit Note');
    expect(html).toContain('إشعار مدين');
    expect(html).toContain('PO-0007');
    expect(html).toContain('Acme Trading');
    expect(html).toContain('Refunded — Bank Transfer');
    expect(html).toContain('Supplier Signature');
  });
});

describe('the screens', () => {
  test('returns are reachable from the sidebar and the router', () => {
    expect(sidebarSrc).toMatch(/to: '\/returns'.*module: 'returns'/);
    expect(appSrc).toContain('path="/returns/:kind"');
  });

  test('an invoice row offers a return only to those allowed to raise one', () => {
    expect(invoicesSrc).toContain("onReturn={can('returns', 'create')");
    expect(actionMenuSrc).toContain("t('returns.returnItems')");
  });

  test('a credit note applied to an invoice is not deletable as a payment', () => {
    expect(invoicesSrc).toContain("p.method !== 'Credit note'");
  });

  test('customer and supplier credit are offered as ways to pay', () => {
    expect(invoicesSrc).toContain("value: 'Customer credit'");
    expect(purchasesSrc).toContain("value: 'Supplier credit'");
  });

  test('a purchase can only be returned once its goods have arrived', () => {
    expect(purchasesSrc).toMatch(/p\.received_at && can\('returns', 'create'\)/);
  });

  test('the dialog asks refund or credit only for money already paid', () => {
    expect(modalsSrc).toContain('if (rest <= 0.005) return null;');
  });

  test('every returns string exists in both languages', () => {
    const enKeys = Object.keys(en.returns).sort();
    const arKeys = Object.keys(ar.returns).sort();
    expect(arKeys).toEqual(enKeys);
    for (const k of ['returnItems', 'returnToSupplier', 'creditNoteRaised']) {
      expect(en.returns[k]).toBeTruthy();
    }
    expect(en.nav.returns).toBe('Returns');
    expect(ar.nav.returns).toBe('المرتجعات');
  });
});
