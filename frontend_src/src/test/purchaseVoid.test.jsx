// Voiding a purchase, from the screen.
//
// The mirror of voiding an invoice, and the page has to behave like one: the
// row stays in the list so the history reads true, labelled as void, and out of
// every figure. Two things are worth guarding here specifically:
//
//   * the server's refusal is a 409 that says exactly how much of the receipt
//     is left on the shelf. That sentence IS the answer, so it has to reach the
//     user rather than being replaced by a generic failure;
//   * the warning shown before confirming depends on whether goods actually
//     arrived. An order voided before receipt reverses nothing, and telling
//     somebody their stock is about to move when it is not is how a safe action
//     comes to look dangerous.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import pageSrc from '../pages/Purchases.jsx?raw';
import apiSrc from '../api/client.js?raw';

const STRINGS = ['void', 'voiding', 'voidTitle', 'voidedBadge', 'voided',
                 'voidFailed', 'voidReason', 'voidWarning', 'voidWarningStock'];

describe('the request', () => {
  test('it PATCHes the void endpoint with a reason', () => {
    expect(apiSrc).toMatch(
      /voidPurchase\s*=\s*\(id, reason\) =>\s*\n?\s*api\.patch\(`\/api\/purchases\/\$\{id\}\/void`, \{ reason \}\)/);
    expect(pageSrc).toMatch(/await voidPurchase\(voidTarget\.id, voidReason \|\| 'Voided'\)/);
  });

  test("the server's own refusal reaches the user", () => {
    // A 409 naming the shortfall is the whole answer; a generic message would
    // send somebody off to work out why on their own.
    expect(pageSrc).toMatch(/toast\(err\.message \|\| t\('purchases\.voidFailed'\), 'red'\)/);
  });

  test('the list reloads afterwards', () => {
    expect(pageSrc).toMatch(/setVoidTarget\(null\); setVoidReason\(''\);\s*\n\s*load\(\);/);
  });

  test('the button cannot be pressed twice while it works', () => {
    expect(pageSrc).toMatch(/disabled=\{voiding\}/);
    expect(pageSrc).toMatch(/finally \{\s*\n\s*setVoiding\(false\);\s*\n\s*\}/);
  });
});

describe('the warning before confirming', () => {
  test('it depends on whether goods actually arrived', () => {
    // stock_updated is the server's own record of whether the receipt landed.
    expect(pageSrc).toMatch(/voidTarget\.stock_updated\s*\n?\s*\?\s*t\('purchases\.voidWarningStock'/);
    expect(pageSrc).toMatch(/:\s*t\('purchases\.voidWarning'\)/);
  });

  test('the stock warning names the quantity and the item', () => {
    // A purchase has lines now, so these read the document-level roll-up the
    // list serves, falling back to the header for an order saved before that.
    expect(pageSrc).toMatch(/quantity: voidTarget\.total_quantity \?\? voidTarget\.quantity/);
    expect(pageSrc).toMatch(/product: voidTarget\.item_summary \|\| voidTarget\.product_name/);
  });

  test('and the plain one promises no stock movement', () => {
    expect(en.purchases.voidWarning).toMatch(/no stock or ledger entry changes/i);
  });
});

describe('a voided row', () => {
  test('stays in the list, labelled', () => {
    // Out of the figures, not out of the history — as a voided invoice is.
    expect(pageSrc).toMatch(/const isVoided\s+= !!p\.voided_at;/);
    expect(pageSrc).toMatch(/isVoided && <span className="badge badge-red"/);
  });

  test('is dimmed the way an archived one is', () => {
    expect(pageSrc).toMatch(/className=\{isArchived \|\| isVoided \? 'row-archived' : undefined\}/);
  });

  test('shows Void as its status rather than what it was', () => {
    expect(pageSrc).toMatch(/isVoided\s*\n?\s*\?\s*<StatusBadge status="Void" \/>/);
  });

  test('offers no further actions', () => {
    // Receiving or paying a voided purchase is refused by the server; offering
    // the button would only produce an error the user did not need to see.
    expect(pageSrc).toMatch(/\) : isVoided \? \(/);
  });

  test('and the reason it was voided is visible', () => {
    expect(pageSrc).toMatch(/p\.void_reason \|\| t\('purchases\.voidedBadge'\)/);
    expect(pageSrc).toMatch(/title=\{p\.void_reason \|\| undefined\}/);
  });
});

describe('the action', () => {
  test('is offered whatever the status', () => {
    // An order voided before it arrives reverses nothing; one voided after
    // takes the goods back. Both are legitimate, so neither is gated.
    const block = pageSrc.match(
      /\{p\.status === 'Paid' && \([\s\S]*?onClick=\{\(\) => \{ setVoidTarget\(p\); setVoidReason\(''\); \}\}/);
    expect(block, 'the void button is not offered outside a status branch').toBeTruthy();
  });

  test('opens with an empty reason each time', () => {
    // A reason left over from the previous purchase would be recorded against
    // this one, in an audit trail somebody later relies on.
    expect(pageSrc).toMatch(/setVoidTarget\(p\); setVoidReason\(''\);/);
  });
});

describe('both languages', () => {
  test.each(STRINGS)('purchases.%s exists in EN and AR', (key) => {
    expect(en.purchases[key], `en.purchases.${key}`).toBeTruthy();
    expect(ar.purchases[key], `ar.purchases.${key}`).toBeTruthy();
    expect(ar.purchases[key]).not.toBe(en.purchases[key]);
  });

  test('the placeholders survive translation', () => {
    const ph = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort();
    expect(ph(ar.purchases.voidWarningStock))
      .toEqual(ph(en.purchases.voidWarningStock));
    expect(ph(en.purchases.voidWarningStock))
      .toEqual(['{{product}}', '{{quantity}}']);
  });
});
