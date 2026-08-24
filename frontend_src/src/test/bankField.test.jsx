// Choosing which bank a payment went through.
//
// The accounts, their ledger codes and the whole API have existed since bank
// accounts were added. What was missing was any screen: nothing in the app
// called /api/banks, so none could be created and no payment could name one.
// Every transfer went to the general bank line — or, on most paths, to cash.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import BankField, { settlesThroughBank } from '../components/BankField.jsx';
import fieldSrc from '../components/BankField.jsx?raw';
import sectionSrc from '../pages/settings/BankAccountsSection.jsx?raw';
import settingsSrc from '../pages/Settings.jsx?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import expensesSrc from '../pages/Expenses.jsx?raw';
import posSrc from '../pages/pos/CheckoutModal.jsx?raw';
import clientPaySrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import apiSrc from '../api/client.js?raw';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const ACCOUNTS = [
  { id: 1, name: 'Byblos current', bank_name: 'Byblos', currency: 'USD', is_active: 1 },
  { id: 2, name: 'Audi USD', bank_name: 'Audi', currency: 'USD', is_active: 1 },
];

async function mount(props) {
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><MemoryRouter>
        <BankField accounts={ACCOUNTS} value="" onChange={() => {}} {...props} />
      </MemoryRouter></LocaleProvider></ThemeProvider>));
  });
  return container;
}

describe('it asks only when there is something to ask', () => {
  test('a method that settles through a bank gets the picker', async () => {
    for (const m of ['Bank Transfer', 'Cheque', 'Card', 'bank transfer']) {
      const c = await mount({ method: m });
      expect(c.querySelector('select'), m).toBeTruthy();
    }
  });

  test('cash does not', async () => {
    // Notes belong to a drawer. Offering a bank beside them invites an answer
    // to a question with none, and posts cash into a balance that has to
    // reconcile against a statement.
    const c = await mount({ method: 'Cash' });

    expect(c.querySelector('select')).toBeFalsy();
  });

  test('and neither does a business with no accounts on file', async () => {
    const c = await mount({ method: 'Bank Transfer', accounts: [] });

    expect(c.querySelector('select')).toBeFalsy();
  });

  test('an archived account is not offered', async () => {
    const c = await mount({
      method: 'Bank Transfer',
      accounts: [{ ...ACCOUNTS[0], archived_at: '2026-01-01' }],
    });

    expect(c.querySelector('select')).toBeFalsy();
  });

  test('leaving it blank is allowed', async () => {
    // The money still reaches the bank, just the general account rather than a
    // named one. A refinement must never block taking a payment.
    const c = await mount({ method: 'Bank Transfer' });

    expect(c.textContent).toContain(en.banks.unspecified);
  });

  test('the rule about which methods use a bank lives in one place', () => {
    expect(settlesThroughBank('Bank Transfer')).toBe(true);
    expect(settlesThroughBank('Cash')).toBe(false);
    expect(settlesThroughBank('')).toBe(false);
    expect(settlesThroughBank(null)).toBe(false);
  });
});

describe('every path that takes a payment offers it', () => {
  const PATHS = [
    ['the invoice payment form', invoicesSrc],
    ['the account payment modal', clientPaySrc],
    ['the till', posSrc],
    ['expenses', expensesSrc],
  ];

  test.each(PATHS)('%s renders the picker', (_name, src) => {
    expect(src).toMatch(/<BankField/);
  });

  test.each(PATHS)('%s sends the chosen account', (_name, src) => {
    expect(src).toMatch(/bank_account_id:/);
  });
});

describe('paying money OUT asks how it left', () => {
  test('a supplier marked paid is asked, and receiving is not', async () => {
    const src = (await import('../pages/Purchases.jsx?raw')).default;

    // Receiving goods is a stock event and asks nothing.
    expect(src).toMatch(/setPayingFor\(p\)/);
    expect(src).toMatch(/handleStatus\(p, 'Received'\)/);
    expect(src).toMatch(/<PayoutModal/);
  });

  test('a payroll run is asked before it posts', async () => {
    const src = (await import('../pages/hr/PayrollRunPanel.jsx?raw')).default;

    expect(src).toMatch(/setPaying\(true\)/);
    expect(src).toMatch(/<PayoutModal/);
    expect(src).toMatch(/doAction\('pay', payout\)/);
  });

  test('both send it through to the server', async () => {
    const src = (await import('../api/client.js?raw')).default;

    expect(src).toMatch(/updatePurchaseStatus = \(id, status, payout = null\)/);
    expect(src).toMatch(/markPayrollRunPaid  = \(id, payout = null\)/);
  });

  test('the dialog asks two things and no more', async () => {
    const src = (await import('../components/PayoutModal.jsx?raw')).default;

    expect(src).toMatch(/expenses\.paymentMethodLabel/);
    expect(src).toMatch(/<BankField/);
    // Optional in the API, so pressing straight through is allowed rather
    // than blocking somebody who does not know which account it came from.
    expect(src).not.toMatch(/required/);
  });
});

describe('the accounts can be created at all', () => {
  test('Settings carries a section for them', () => {
    expect(settingsSrc).toMatch(/<BankAccountsSection/);
  });

  test('which is not the same thing as the bank details above it', () => {
    // Those are four lines printed on an invoice. These are ledger accounts.
    expect(sectionSrc).toContain('text fields printed on an invoice');
    expect(en.banks.desc).toMatch(/printed on invoices/i);
  });

  test('the ledger code each one posts to is shown', () => {
    // So an accountant can find the account in the chart without guessing.
    expect(sectionSrc).toMatch(/banks\.glCode/);
  });

  test('and they are archived, never deleted', () => {
    expect(sectionSrc).toMatch(/archiveBankAccount/);
    expect(sectionSrc).not.toMatch(/deleteBankAccount/);
    expect(en.banks.archiveConfirm).toMatch(/keep\s+pointing at it/);
  });

  test('the API calls exist', () => {
    for (const fn of ['getBankAccounts', 'createBankAccount',
                      'updateBankAccount', 'archiveBankAccount']) {
      expect(apiSrc, fn).toContain(fn);
    }
  });
});

describe('it reads in both languages', () => {
  test('every string exists in each, with the same placeholders', () => {
    const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
      .map(m => m[1]).sort().join(',');

    for (const [k, v] of Object.entries(en.banks)) {
      expect(ar.banks[k], `ar.banks.${k}`).toBeTruthy();
      expect(named(ar.banks[k]), k).toBe(named(v));
    }
  });

  test('the Arabic is Arabic where it is prose', () => {
    for (const k of ['title', 'desc', 'empty', 'add', 'field', 'unspecified']) {
      expect(/[؀-ۿ]/.test(ar.banks[k]), k).toBe(true);
    }
  });

  test('the picker asks in the reader’s language', () => {
    expect(fieldSrc).toMatch(/t\('banks\.field'\)/);
    expect(fieldSrc).toMatch(/t\('banks\.unspecified'\)/);
  });
});
