// Changing a stock item's price at the till. The server holds everyone
// without `pos_price_override` to the list price, so the register must not
// offer a box the sale would then refuse --- and once a price leaves list,
// the list price has to stay in view on the line, the sale and the receipt.
import { describe, test, expect } from 'vitest';
import registerSrc from '../pages/pos/RegisterView.jsx?raw';
import detailSrc from '../pages/pos/SaleDetailModal.jsx?raw';
import receiptSrc from '../pages/pos/ReceiptModal.jsx?raw';
import historySrc from '../pages/pos/HistoryView.jsx?raw';
import rolesSrc from '../pages/RoleManagement.jsx?raw';

describe('the price box on a stock line', () => {
  test('is offered only to someone holding the permission', () => {
    expect(registerSrc).toMatch(/const canOverride = can\('pos_price_override'\)/);
    // The stock-line box is rendered only for a `priced` line, which needs the
    // permission; the custom-line box (inventory_id null) stays unconditional.
    expect(registerSrc).toMatch(/const priced = canOverride && l\.inventory_id != null/);
    expect(registerSrc).toMatch(/\{priced && \(\s*<div className="pos-cart-line-price">[^]*?unit_price: e\.target\.value/);
  });

  test('the list price rides along on the cart line and to the receipt', () => {
    expect(registerSrc).toMatch(/list_price: productUsdUnitPrice\(p, fxRate\)/);
    expect(registerSrc).toMatch(/list_price: l\.list_price != null \? Number\(l\.list_price\) : null/);
  });

  test('an overridden line shows its list price struck through', () => {
    expect(registerSrc).toMatch(/\{t\('pos\.listPrice'\)\} <s>\{posMoney\(l\.list_price\)\}<\/s>/);
    // On its own full-width row: the body beside the controls is ~60px wide.
    expect(registerSrc).toMatch(/pos-cart-line--priced/);
  });

  test('no promotion stacks on an overridden price, as on the server', () => {
    expect(registerSrc).toMatch(/if \(isOverridden\(l\)\) return null;/);
  });

  test('"overridden" is a comparison with the server\'s 1% tolerance, not a flag', () => {
    for (const src of [registerSrc, detailSrc, receiptSrc]) {
      expect(src).toMatch(/Math\.max\(0\.01, Number\([a-z]+\.list_price\) \* 0\.01\)/);
    }
  });
});

describe('where a changed price can be seen afterwards', () => {
  test('the sale detail strikes the list price beside the charged one', () => {
    expect(detailSrc).toMatch(/<s>\{fmt\(it\.list_price\)\}<\/s>/);
  });
  test('the receipt shows the quoted price in brackets', () => {
    expect(receiptSrc).toMatch(/<s>\{Number\(it\.list_price\)\.toFixed\(2\)\}<\/s>/);
  });
  test('the history can be narrowed to sales with a changed price', () => {
    expect(historySrc).toMatch(/rows\.filter\(s => s\.has_override\)/);
    expect(historySrc).toMatch(/t\('pos\.overriddenOnly'\)/);
  });
});

describe('the role editor', () => {
  test('offers the key so an owner can hand it to a role', () => {
    expect(rolesSrc).toMatch(/'pos_price_override',/);
    expect(rolesSrc).toMatch(/pos_price_override: t\('roles\.modulePosPriceOverride'\)/);
  });
});
