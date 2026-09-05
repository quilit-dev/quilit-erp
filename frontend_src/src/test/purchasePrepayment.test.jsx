// Paying for a purchase before the goods arrive.
//
// The page offered exactly two buttons, and they were wired to a single ladder:
// "Receive" while the status was Ordered, "Mark Paid" while it was Received. So
// a pre-ordered delivery — paid up front, shipped weeks later — could only be
// entered by pressing Receive first, which booked stock that was still at the
// supplier and made every count and valuation wrong until it turned up.
//
// The two buttons are now driven by the two independent facts. Receiving is
// about the GOODS and is offered until they arrive, paid or not. Paying is
// about the MONEY and is offered while anything is outstanding, before delivery
// as readily as after.
import { describe, test, expect, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import PayoutModal from '../components/PayoutModal.jsx';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import purchasesSrc from '../pages/Purchases.jsx?raw';
import apiSrc from '../api/client.js?raw';

async function mount(props) {
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><MemoryRouter>
        <PayoutModal title="Pay" confirmLabel="Record payment"
          onConfirm={() => {}} onClose={() => {}} {...props} />
      </MemoryRouter></LocaleProvider></ThemeProvider>));
  });
  return container;
}

const amountBox = (c) => c.querySelector('#payout-amount');
const confirmBtn = (c) => [...c.querySelectorAll('button')]
  .find(b => b.className.includes('btn-primary'));


describe('the payout dialog only asks how much when there is a choice', () => {
  test('without maxAmount it is the dialog it always was', async () => {
    // Payroll and every other caller pass no amount. Growing a required field
    // under them would have been a silent regression on three other screens.
    const c = await mount({});
    expect(amountBox(c)).toBeNull();
  });

  test('with maxAmount it asks, and defaults to settling in full', async () => {
    const c = await mount({ maxAmount: 250 });
    expect(amountBox(c)).toBeTruthy();
    expect(amountBox(c).value).toBe('250');
  });
});

describe('it refuses an amount that cannot be right', () => {
  const cases = [['0', 'nothing'], ['-5', 'a negative'], ['400', 'more than is owed']];

  test.each(cases)('%s (%s) blocks the button', async (value) => {
    const c = await mount({ maxAmount: 250 });
    await act(async () => {
      fireEvent.change(amountBox(c), { target: { value } });
    });
    expect(confirmBtn(c).disabled, `${value} should not be payable`).toBe(true);
  });

  test('a part payment inside the balance is allowed', async () => {
    // The deposit case — the whole reason the field exists.
    const c = await mount({ maxAmount: 250 });
    await act(async () => {
      fireEvent.change(amountBox(c), { target: { value: '100' } });
    });
    expect(confirmBtn(c).disabled).toBe(false);
  });

  test('the amount reaches the caller', async () => {
    const onConfirm = vi.fn();
    const c = await mount({ maxAmount: 250, onConfirm });
    await act(async () => {
      fireEvent.change(amountBox(c), { target: { value: '100' } });
      fireEvent.click(confirmBtn(c));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].amount).toBe(100);
  });
});


describe('the two buttons follow the two facts, not one ladder', () => {
  test('receiving is offered until the goods arrive, whatever has been paid', () => {
    // `p.status === 'Ordered'` was the bug: a prepaid order has status
    // 'Prepaid', so the Receive button vanished the moment it was paid for —
    // leaving no way at all to book the delivery.
    expect(purchasesSrc).toMatch(/\{!p\.received_at && \(/);
    expect(purchasesSrc).not.toMatch(/p\.status === 'Ordered' && \(\s*\n\s*<button[^>]*\n[^\n]*handleStatus\(p, 'Received'\)/);
  });

  test('paying is offered while anything is outstanding', () => {
    expect(purchasesSrc).toMatch(/\{p\.outstanding > 0\.005 && \(/);
    expect(purchasesSrc).not.toMatch(/p\.status === 'Received' && \(\s*\n\s*<button[^>]*\n[^\n]*setPayingFor/);
  });

  test('a payment goes to the payments endpoint, not to a status change', () => {
    // Marking a status is what put stock on the shelf. Money must not.
    expect(apiSrc).toMatch(/payPurchase\s*=\s*\(id, d\) => api\.post\(`\/api\/purchases\/\$\{id\}\/payments`/);
    expect(purchasesSrc).toContain('payPurchase(purchase.id');
  });

  test('the dialog is told the outstanding balance', () => {
    expect(purchasesSrc).toMatch(/maxAmount=\{Number\(payingFor\.outstanding \|\| 0\)\}/);
  });
});


describe('the new states are nameable in both languages', () => {
  test.each(['Prepaid', 'Deposit Paid'])('%s has a status label', (status) => {
    expect(en.status[status], `${status} missing from en`).toBeTruthy();
    expect(ar.status[status], `${status} missing from ar`).toBeTruthy();
    expect(ar.status[status]).not.toBe(en.status[status]);
  });

  test.each(['payNow', 'recordPayment', 'amountToPay', 'prepaySummary',
             'paymentRecorded', 'payAmountRange', 'statsPrepaid', 'statsAdvances',
             'paidLabel', 'outstandingLabel', 'paymentsTitle', 'noPayments'])(
    'purchases.%s is translated', (key) => {
      expect(en.purchases[key], `${key} missing from en`).toBeTruthy();
      expect(ar.purchases[key], `${key} missing from ar`).toBeTruthy();
      expect(ar.purchases[key]).not.toBe(en.purchases[key]);
    });

  test('a prepaid order does not wear the colour of a delivered one', () => {
    // Green means the goods are here. Money out with nothing on the shelf is
    // the confusion this whole feature exists to remove, so it must not
    // borrow that signal.
    const map = purchasesSrc.slice(purchasesSrc.indexOf('const map = {'),
                                   purchasesSrc.indexOf('return <span className={`badge'));
    expect(map).toMatch(/Prepaid: 'purple'/);
    expect(map).toMatch(/'Deposit Paid': 'purple'/);
    expect(map).toMatch(/Received: 'green'/);
  });

  test('the status a user CHOOSES on the form stays the three real ones', () => {
    // 'Prepaid' and 'Deposit Paid' are computed from the payments. Offering
    // them on the create form would invite asserting a payment that was never
    // recorded — the row would say paid and the ledger would say nothing.
    const form = purchasesSrc.slice(0, purchasesSrc.indexOf('function StatusBadge'));
    expect(form).not.toContain("value: 'Prepaid'");
    expect(form).not.toContain("value: 'Deposit Paid'");
  });
});
