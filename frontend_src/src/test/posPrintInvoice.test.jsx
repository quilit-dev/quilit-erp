// POS can print the A4 invoice as well as the till roll.
//
// They are different documents for different purposes: the roll is what the
// customer walks out with, the A4 is what a business customer files or claims
// VAT against. The point of this test is that the second one reuses the ordinary
// invoice exporter rather than re-laying the sale out — one design, one set of
// company details, one tax presentation.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import receiptSrc from '../pages/pos/ReceiptModal.jsx?raw';

describe('the POS receipt offers an invoice too', () => {
  test('it reuses the shared invoice exporter', () => {
    // Not a second layout: a POS invoice and an Invoices-screen invoice must be
    // the same document, or a customer who gets both sees two designs.
    expect(receiptSrc).toMatch(/import \{ exportInvoicePDF \} from '\.\.\/\.\.\/utils\/exportUtils'/);
    expect(receiptSrc).toMatch(/exportInvoicePDF\(billed/);
  });

  test('it fetches the real invoice record rather than printing the sale', () => {
    // Every POS sale already has an invoice behind it; printing the in-memory
    // sale would miss anything the server computed.
    expect(receiptSrc).toMatch(/getInvoice\(sale\.invoice_id\)/);
  });

  test('the till roll is still the primary action', () => {
    expect(receiptSrc).toMatch(/printReceipt/);
  });

  test('the button is hidden when the sale has no invoice', () => {
    // A returned or legacy row may not have one, and a button that errors is
    // worse than one that is absent.
    expect(receiptSrc).toMatch(/sale\.invoice_id && \(/);
  });

  test('the display currency follows the rest of the app', () => {
    expect(receiptSrc).toMatch(/displayCurrency, exchangeRate/);
  });

  test('the label exists in both languages', () => {
    expect(en.pos.printInvoice).toBeTruthy();
    expect(ar.pos.printInvoice).toBeTruthy();
    expect(ar.pos.printInvoice).toMatch(/[؀-ۿ]/);
  });
});

describe('a till sale has no customer record', () => {
  test('the printed invoice names them rather than reading like an error', () => {
    // The exporter's generic fallback is "No client specified", which looks
    // like a defect on a document handed to the person who just paid.
    expect(receiptSrc).toMatch(/t\('pos\.walkIn'\)/);
    expect(en.pos.walkIn).toBeTruthy();
    expect(ar.pos.walkIn).toMatch(/[؀-ۿ]/);
  });
});
