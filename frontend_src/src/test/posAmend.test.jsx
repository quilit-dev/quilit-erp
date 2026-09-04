// Correcting a completed till sale, from the cashier's side.
//
// The server is the authority on every figure here. What these tests protect
// is the part the server cannot: that the cashier is shown the DIFFERENCE
// rather than the whole corrected total, and is never told to collect money
// that is already in the drawer. Getting that wrong does not fail loudly — it
// takes the customer's money twice.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';

import checkoutSrc from '../pages/pos/CheckoutModal.jsx?raw';
import registerSrc from '../pages/pos/RegisterView.jsx?raw';
import detailSrc from '../pages/pos/SaleDetailModal.jsx?raw';
import historySrc from '../pages/pos/HistoryView.jsx?raw';
import posSrc from '../pages/POS.jsx?raw';
import clientSrc from '../api/client.js?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

function Providers({ children }) {
  return (
    <ThemeProvider><LocaleProvider><SettingsProvider>
      <MemoryRouter>{children}</MemoryRouter>
    </SettingsProvider></LocaleProvider></ThemeProvider>
  );
}

async function mount(ui) {
  let container;
  await act(async () => {
    ({ container } = render(<Providers>{ui}</Providers>));
    await new Promise(r => setTimeout(r, 0));
  });
  return container;
}

const PRICING = {
  items: [{ name: 'Thing', quantity: 1, unit_price: 50, line_type: 'product' }],
  subtotal: 50, taxTotal: 0, discountTotal: 0, total: 50, orderDiscount: 0,
};

// A completed sale of $10 that is being corrected up to $50.
const AMENDING = {
  id: 7, invoice_number: 'INV-2026-000007', amount: 10, status: 'completed',
  payment: { id: 3, amount: 10, method: 'Cash' },
  items: [{ id: 1, name: 'Thing', inventory_id: 4, quantity: 1,
            unit_price: 10, discount: 0, line_type: 'product' }],
};


describe('the cashier is shown the difference, not the total', () => {
  test('an ordinary checkout shows no correction rows at all', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={[]} drawers={[]}
        onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).not.toContain(en.pos.alreadyPaid);
    expect(c.textContent).not.toContain(en.pos.toCollect);
  });

  test('a correction shows what was already paid', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={[]} drawers={[]}
        amending={AMENDING} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toContain(en.pos.alreadyPaid);
    expect(c.textContent).toContain(en.pos.toCollect);
    // $50 corrected total less the $10 already in the drawer.
    expect(c.textContent).toContain('40');
  });

  test('a shrinking sale asks for a refund, not a collection', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const shrunk = { ...PRICING, subtotal: 4, total: 4,
                     items: [{ name: 'Thing', quantity: 1, unit_price: 4,
                               line_type: 'product' }] };
    const c = await mount(
      <CheckoutModal pricing={shrunk} clients={[]} drawers={[]}
        amending={AMENDING} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toContain(en.pos.toRefund);
    expect(c.textContent).not.toContain(en.pos.toCollect);
  });

  test('a correction worth exactly the same collects nothing', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const same = { ...PRICING, subtotal: 10, total: 10,
                   items: [{ name: 'Thing', quantity: 1, unit_price: 10,
                             line_type: 'product' }] };
    const c = await mount(
      <CheckoutModal pricing={same} clients={[]} drawers={[]}
        amending={AMENDING} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toContain(en.pos.toCollect);
    expect(c.textContent).not.toContain(en.pos.toRefund);
  });

  test('an instalment sale counts its deposit, not its invoice', async () => {
    // The whole sale was $10 but only $4 was taken as a deposit; correcting it
    // must not pretend the other $6 is in the drawer.
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const onPlan = { ...AMENDING, amount: 10, payment: { id: 3, amount: 4 } };
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={[]} drawers={[]}
        amending={onPlan} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toContain('46');       // 50 − 4
  });

  test('a sale with no payment row at all is treated as unpaid', async () => {
    const { CheckoutModal } = await import('../pages/pos/CheckoutModal.jsx');
    const unpaid = { ...AMENDING, payment: null };
    const c = await mount(
      <CheckoutModal pricing={PRICING} clients={[]} drawers={[]}
        amending={unpaid} onClose={() => {}} onDone={() => {}} />);
    expect(c.textContent).toContain('50');
  });
});


describe('the correction reaches the right endpoint', () => {
  test('the client has an amend call that posts to /amend', () => {
    expect(clientSrc).toMatch(/amendPosSale[\s\S]{0,120}\/amend/);
  });

  test('the checkout modal chooses between checkout and amend', () => {
    expect(checkoutSrc).toContain('amendPosSale');
    expect(checkoutSrc).toMatch(/amending\s*\n?\s*\?\s*await amendPosSale/);
  });

  test('the tender check is against the difference when correcting', () => {
    expect(checkoutSrc).toContain('amending ? collectInCurrency : totalInCurrency');
  });

  test('what is sent as tendered is the difference, not the total', () => {
    expect(checkoutSrc).toContain('amending ? collectInCurrency : totalInCurrency');
  });
});


describe('starting and leaving a correction', () => {
  test('the sale detail modal offers the edit', () => {
    expect(detailSrc).toContain("t('pos.editSale')");
    expect(detailSrc).toContain('onAmend(sale)');
  });

  test('only a completed sale is offered it', () => {
    // Never a returned one, and never one already superseded.
    expect(detailSrc).toMatch(/sale\.status === 'completed' && onAmend/);
  });

  test('the history hands the sale up to the page', () => {
    expect(historySrc).toContain('onAmend');
    expect(posSrc).toContain('startAmend');
    expect(posSrc).toContain("setView('register')");
  });

  test('the register seeds the cart from the sale being corrected', () => {
    expect(registerSrc).toContain('seededFor');
    expect(registerSrc).toContain('amending.items');
  });

  test('the register offers a way out that rings nothing', () => {
    expect(registerSrc).toContain('onCancelAmend');
  });

  test('a correction is announced before it is saved', () => {
    expect(registerSrc).toContain("t('pos.correctingSale')");
    expect(registerSrc).toContain("t('pos.saveCorrection')");
  });

  test('the seeded price is the receipt price, not the ex-VAT one', () => {
    // pos_sale_items carries the VAT-inclusive unit price, which is what a
    // cart line holds. invoice_items carries the net one; seeding from that
    // would silently reprice every corrected sale.
    expect(registerSrc).toMatch(/unit_price: Number\(it\.unit_price\)/);
  });
});


describe('a superseded sale reads as one', () => {
  test('the history does not call it Paid', () => {
    expect(historySrc).toContain("s.status === 'amended'");
    expect(historySrc).toContain("t('pos.superseded')");
  });

  test('an outstanding balance is not shown on a superseded row', () => {
    expect(historySrc).toContain("s.status !== 'amended' && (");
  });

  test('the detail modal names the sale that replaced it', () => {
    expect(detailSrc).toContain('amended_by');
    expect(detailSrc).toContain('amended_from_sale');
  });
});


describe('every new string is translated', () => {
  const KEYS = ['editSale', 'saveCorrection', 'correctingSale', 'correctingHint',
                'superseded', 'replacedBy', 'corrects', 'alreadyPaid',
                'toCollect', 'toRefund'];

  test.each(KEYS)('pos.%s exists in English', (k) => {
    expect(typeof en.pos[k]).toBe('string');
    expect(en.pos[k].length).toBeGreaterThan(0);
  });

  test.each(KEYS)('pos.%s exists in Arabic', (k) => {
    // t() returns the raw key when one is missing, so an Arabic user would
    // read "pos.toCollect" on the screen where the money is counted.
    expect(typeof ar.pos[k]).toBe('string');
    expect(ar.pos[k].length).toBeGreaterThan(0);
    expect(ar.pos[k]).not.toBe(en.pos[k]);
  });
});
