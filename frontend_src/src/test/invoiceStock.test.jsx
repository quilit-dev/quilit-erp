// An invoice can take its stock lines out of stock: a checkbox on the form,
// and an action in the row menu to take out or put back afterwards.
import { describe, test, expect } from 'vitest';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import menuSrc from '../pages/invoices/ActionMenu.jsx?raw';
import clientSrc from '../api/client.js?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

describe('taking an invoice\'s goods out of stock', () => {
  test('the form sends the choice, off by default, and loads it back on edit', () => {
    expect(invoicesSrc).toContain('deduct_stock: false');
    expect(invoicesSrc).toContain('deduct_stock:   !!form.deduct_stock');
    expect(invoicesSrc).toContain('deduct_stock:   !!full.stock_deducted_at');
  });

  test('the checkbox only appears when a line names a stock item', () => {
    expect(invoicesSrc).toMatch(/\(form\.items \|\| \[\]\)\.some\(i => i\.inventory_id\) && \(/);
  });

  test('the row menu offers take out / put back, never on a till sale or service job', () => {
    expect(menuSrc).toContain("inv.source_type !== 'pos' && !inv.service_job_id");
    expect(menuSrc).toContain("inv.stock_deducted_at ? t('invoices.stockPutBackAction') : t('invoices.stockTakeOutAction')");
    expect(clientSrc).toContain('api.post(`/api/invoices/${id}/stock`)');
    expect(clientSrc).toContain('api.delete(`/api/invoices/${id}/stock`)');
  });

  test('every string exists in both languages', () => {
    for (const k of ['deductStock', 'deductStockHint', 'stockTakeOutAction', 'stockPutBackAction',
                     'stockTakenOut', 'stockPutBack']) {
      expect(en.invoices[k], k).toBeTruthy();
      expect(ar.invoices[k], k).toBeTruthy();
      expect(ar.invoices[k]).not.toBe(en.invoices[k]);
    }
  });
});
