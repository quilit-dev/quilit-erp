// Taking one payment against a customer, and showing where an invoice came from.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import detailSrc from '../pages/ClientDetail.jsx?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import apiSrc from '../api/client.js?raw';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the payment reaches the server', () => {
  test('the API call exists', () => {
    expect(apiSrc).toMatch(/recordCustomerPayment/);
    expect(apiSrc).toMatch(/\/api\/clients\/\$\{id\}\/payments/);
  });

  test('it is reachable from the customer, gated on permission', () => {
    expect(detailSrc).toMatch(/<CustomerPaymentModal/);
    expect(detailSrc).toMatch(/can\('invoices', 'create'\) && \(/);
  });

  test('it reloads the customer afterwards', () => {
    // Balances on the page are stale the moment the payment lands — and so is
    // the agreed schedule, which is why both are refreshed.
    expect(detailSrc).toMatch(/onDone=\{\(\) => \{ setPlanKey\(k => k \+ 1\);/);
    expect(detailSrc).toMatch(/getClient\(id\)\.then\(setClient\)/);
  });

  test('a duplicate submission carries an idempotency key', () => {
    // Without one, a double-click takes the money twice.
    expect(modalSrc).toMatch(/idempotency_key:/);
  });
});

describe('the preview is honest about being a preview', () => {
  test('it uses the same oldest-first rule the server uses', () => {
    expect(modalSrc).toMatch(/due_date \|\| a\.created_at/);
    expect(modalSrc).toMatch(/clients\.oldestFirst/);
  });

  test('drafts and voided invoices are excluded, as the server excludes them', () => {
    // Showing an operator that money will land on a draft, when the server
    // will refuse it, is worse than showing nothing.
    expect(modalSrc).toMatch(/!i\.voided_at/);
    expect(modalSrc).toMatch(/Pending Approval/);
  });

  test('the result replaces the preview once it has happened', () => {
    expect(modalSrc).toMatch(/if \(result\) \{/);
    expect(modalSrc).toMatch(/result\.allocated/);
  });

  test('overpayment is blocked before it is submitted', () => {
    // The server refuses it; catching it here explains why rather than
    // returning a bare 400.
    expect(modalSrc).toMatch(/const over =/);
    expect(modalSrc).toMatch(/disabled=\{saving \|\| over \|\| !amount\}/);
    expect(modalSrc).toMatch(/clients\.overpaymentWarning/);
  });
});

describe('an invoice says where it came from', () => {
  test('the list shows the source as a caption', () => {
    // One number series now, so origin is a caption rather than a prefix.
    expect(invoicesSrc).toMatch(/inv\.source_type && inv\.source_type !== 'sales'/);
    expect(invoicesSrc).toMatch(/inv\.source_reference/);
  });

  test('every source the backend can emit has a label', () => {
    // Built as `clients.source${Type}` from the row, so a missing one renders
    // the key itself.
    for (const src of ['Pos', 'Service', 'Quotation', 'Project', 'Sales']) {
      expect(en.clients[`source${src}`], src).toBeTruthy();
      expect(ar.clients[`source${src}`], src).toBeTruthy();
    }
  });
});

describe('styling and translation', () => {
  test('no invented class names', () => {
    const used = new Set();
    for (const m of modalSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    expect(css.length).toBeGreaterThan(1000);
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });

  test('every key the modal uses resolves in both languages', () => {
    const keys = [...modalSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('interpolated keys are given the parameters they name', () => {
    for (const [key, args] of [
      ['clients.owesTotal', ['name', 'amount']],
      ['clients.stillOutstanding', ['amount']],
      ['clients.overpaymentWarning', ['amount']],
    ]) {
      const named = [...lookup(en, key).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
      expect(named, key).toEqual([...args].sort());
      expect([...lookup(ar, key).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort(), key)
        .toEqual([...args].sort());
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['paymentRecorded', 'willSettle', 'oldestFirst', 'applied',
                  'settled', 'sourcePos', 'sourceService'];
    const latinOnly = KEYS.filter(k => {
      const v = ar.clients[k];
      return /[A-Za-z]{3,}/.test(v) && !/[؀-ۿ]/.test(v);
    });
    expect(latinOnly).toEqual([]);
  });
});
