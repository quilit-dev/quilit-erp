// The terms recorded against a customer have to reach the screens that act on
// them — and the receipt has to exist for the payment the customer made.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import detailSrc from '../pages/ClientDetail.jsx?raw';
import paymentsTabSrc from '../pages/clients/PaymentsTab.jsx?raw';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import planSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import checkoutSrc from '../pages/pos/CheckoutModal.jsx?raw';
import voucherSrc from '../utils/receiptVoucher.js?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the client overview shows what was entered', () => {
  test('the billing fields appear', () => {
    // They were recorded, validated, and displayed nowhere — so an operator
    // filled them in and they vanished.
    for (const field of ['financial_id', 'preferred_currency', 'vat_status',
                         'allow_installments']) {
      expect(detailSrc, field).toContain(`client.${field}`);
    }
  });

  test('the instalment terms read as terms, not as a raw flag', () => {
    expect(detailSrc).toMatch(/clients\.planDefault/);
    expect(detailSrc).toMatch(/clients\.notOnTerms/);
  });
});

describe('preferred currency does something', () => {
  test('a payment from that customer opens in their currency', () => {
    expect(modalSrc).toMatch(/CURRENCIES\.includes\(client\?\.preferred_currency\)/);
  });

  test('the till follows it only where the till can honour it', () => {
    // POS takes USD and LBP. Defaulting a EUR customer into EUR would put the
    // cashier in a currency checkout refuses.
    expect(checkoutSrc).toMatch(/\['USD', 'LBP'\]\.includes\(customer\.preferred_currency\)/);
  });
});

describe('the instalments flag does something', () => {
  test('the invoice screen does not offer a plan to a customer refused one', () => {
    expect(planSrc).toMatch(/plan\.length === 0 && !open && allowed/);
    expect(planSrc).toMatch(/installments\.notApproved/);
  });

  test('an older payload without the field still offers plans', () => {
    // `!== 0` rather than truthiness: undefined must mean allowed, or the
    // option disappears everywhere the field is not sent yet.
    expect(planSrc).toMatch(/invoice\.client_allow_installments !== 0/);
  });

  test('the till refuses the same customer', () => {
    expect(checkoutSrc).toMatch(/customer\.allow_installments === 0/);
    expect(checkoutSrc).toMatch(/notApproved \? t\('installments\.notApproved'\)/);
  });

  test('the customer defaults prefill the plan on both screens', () => {
    expect(planSrc).toMatch(/invoice\.client_installment_count/);
    expect(planSrc).toMatch(/invoice\.client_installment_frequency/);
    expect(checkoutSrc).toMatch(/customer\.default_installment_count/);
    expect(checkoutSrc).toMatch(/customer\.default_installment_frequency/);
  });

  test('what the cashier types over the prefill sticks', () => {
    // Without this the effect keeps resetting the boxes under their hands.
    expect(checkoutSrc).toMatch(/if \(planTouched \|\| !customer\) return;/);
    expect(checkoutSrc).toMatch(/setPlanTouched\(true\); setPlanCount/);
  });
});

describe('the receipt for the payment the customer actually made', () => {
  test('the API calls exist', () => {
    expect(apiSrc).toMatch(/issuePaymentVoucher/);
    expect(apiSrc).toMatch(/listCustomerPayments/);
  });

  test('the voucher names every invoice the money reached', () => {
    expect(voucherSrc).toMatch(/buildPaymentVoucherHTML/);
    expect(voucherSrc).toMatch(/allocated\.map/);
  });

  test('it is bilingual like the per-invoice one', () => {
    // The point of the document is that both languages appear together; a
    // locale lookup would give one or the other.
    const body = voucherSrc.slice(voucherSrc.indexOf('buildPaymentVoucherHTML'));
    expect(body).toMatch(/سند قبض/);
    expect(body).toMatch(/Receipt Voucher/);
  });

  test('it says what was handed over when that was not the company currency', () => {
    // A receipt showing only the USD equivalent is not a receipt for what the
    // customer actually paid.
    expect(voucherSrc).toMatch(/payment\.currency !== C\.currency/);
    expect(voucherSrc).toMatch(/payment\.paid_amount/);
  });

  test('it can be printed the moment the payment is taken', () => {
    expect(modalSrc).toMatch(/issuePaymentVoucher\(result\.payment_id\)/);
    expect(modalSrc).toMatch(/printPaymentVoucher/);
  });

  test('and reprinted later from the customer', () => {
    expect(detailSrc).toMatch(/<PaymentsTab/);
    expect(paymentsTabSrc).toMatch(/issuePaymentVoucher/);
  });

  test('a reprint shows the number it was issued under', () => {
    expect(paymentsTabSrc).toMatch(/voucher_number/);
  });

  test('the payments list groups by payment, not by allocation', () => {
    // One row per invoice is how the ledger stores it and not how anybody
    // remembers paying.
    expect(paymentsTabSrc).toMatch(/\(p\.allocated \|\| \[\]\)\.map/);
  });
});

describe('translation and styling', () => {
  test('every new key resolves in both languages', () => {
    for (const k of ['clients.planDefault', 'clients.notOnTerms',
                     'clients.paymentsReceived', 'clients.noPayments',
                     'clients.appliedTo', 'installments.notApproved',
                     'invoices.printReceipt']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the interpolated key names the parameters it is given', () => {
    const named = [...en.clients.planDefault.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
    expect(named).toEqual(['count', 'frequency']);
    expect([...ar.clients.planDefault.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort())
      .toEqual(['count', 'frequency']);
  });

  test('the Arabic is actually Arabic', () => {
    const latinOnly = [['clients', 'notOnTerms'], ['clients', 'paymentsReceived'],
                       ['clients', 'appliedTo'], ['installments', 'notApproved'],
                       ['invoices', 'printReceipt']]
      .filter(([g, k]) => /[A-Za-z]{3,}/.test(ar[g][k]) && !/[؀-ۿ]/.test(ar[g][k]));
    expect(latinOnly).toEqual([]);
  });

  test('every key the payments tab uses resolves', () => {
    const keys = [...paymentsTabSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(4);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('no invented class names in the payments tab', () => {
    const used = new Set();
    for (const m of paymentsTabSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});
