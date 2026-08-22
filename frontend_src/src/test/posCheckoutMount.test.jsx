// The checkout modal, actually mounted.
//
// It crashed in production with "Cannot access 'R' before initialization" — a
// const read by a useEffect dependency array 25 lines before it was declared.
// Nothing caught it: eslint does not track temporal dead zones across a
// component body, the page smoke test only globs pages/*.jsx, and mounting the
// POS page does not render a modal that is closed.
//
// So this mounts every POS modal directly. A component that is only reachable
// through a click is exactly the one no test was rendering.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';

function Providers({ children }) {
  return (
    <ThemeProvider><LocaleProvider><SettingsProvider>
      <MemoryRouter>{children}</MemoryRouter>
    </SettingsProvider></LocaleProvider></ThemeProvider>
  );
}

const PRICING = {
  items: [{ name: 'Thing', quantity: 1, unit_price: 10, line_type: 'product' }],
  subtotal: 10, taxTotal: 0, discountTotal: 0, total: 10, orderDiscount: 0,
};

const CLIENTS = [
  { id: 1, name: 'Walk-up Co', allow_installments: 1,
    default_installment_count: 6, default_installment_frequency: 'monthly',
    preferred_currency: 'USD' },
  // A customer with none of the newer fields — an older payload.
  { id: 2, name: 'Legacy Co' },
];

async function mount(ui) {
  let container;
  await act(async () => {
    ({ container } = render(<Providers>{ui}</Providers>));
    await new Promise(r => setTimeout(r, 0));
  });
  return container;
}

describe('the checkout modal mounts', () => {
  test('with no customer chosen', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={CLIENTS} drawers={[]}
        onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });

  test('with drawers present', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={CLIENTS}
        drawers={[{ id: 3, name: 'Front', auto_capture: 1 }]}
        onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });

  test('defaulting to the register\'s currency', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={CLIENTS} drawers={[]}
        defaultCurrency="LBP" onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });

  test('with an empty cart and no clients', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={{ ...PRICING, items: [], total: 0 }} clients={[]}
        drawers={[]} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });
});

describe('the other POS modals mount', () => {
  test('the receipt', async () => {
    const { ReceiptModal } = await import('../pages/pos/ReceiptModal.jsx');
    const c = await mount(
      <ReceiptModal sale={{
        invoice_number: 'POS-1', subtotal: 10, tax_total: 0, discount_total: 0,
        total: 10, items: [], payment_method: 'Cash', amount_tendered: 10,
        change_given: 0,
      }} onClose={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });

  test('the receipt for an instalment sale', async () => {
    const { ReceiptModal } = await import('../pages/pos/ReceiptModal.jsx');
    const c = await mount(
      <ReceiptModal sale={{
        invoice_number: 'POS-2', subtotal: 300, tax_total: 0, discount_total: 0,
        total: 300, items: [], payment_method: 'Cash', amount_tendered: 100,
        change_given: 0, paid_now: 100, balance: 200,
        installments: [{ seq: 1, due_date: '2026-01-01', amount: 100 },
                       { seq: 2, due_date: '2026-02-01', amount: 200 }],
      }} onClose={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });

  test('closing the register', async () => {
    const { CloseRegisterModal } = await import('../pages/pos/CloseRegisterModal.jsx');
    const c = await mount(
      <CloseRegisterModal session={{ id: 1, opening_float: 0 }}
        onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });
});

describe('opening the register mounts', () => {
  test('with no drawers configured', async () => {
    const { OpenRegisterPanel } = await import('../pages/pos/OpenRegisterPanel.jsx');
    const c = await mount(
      <OpenRegisterPanel drawers={[]} onOpened={() => {}} />);
    expect(c.textContent).toBeTruthy();
  });
});
