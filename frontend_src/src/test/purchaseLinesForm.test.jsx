// The purchase form, once a purchase is a document with lines.
//
// The screen has to say the same thing the server does, or the operator types
// a number, sees one total, and gets another. Three things carry that:
//
//   * the document keeps what belongs to the DELIVERY — one supplier, one
//     currency, one freight charge — and everything per-product moves to a
//     line. Freight staying on the document is the whole point: it used to be
//     attachable to only one order, so that product absorbed all of it;
//   * the running total mirrors the server's arithmetic, including that tax is
//     per line on the discounted goods value and freight is outside the
//     taxable base;
//   * the list describes a document rather than an item, because a unit cost
//     is not a property of an order with six different products in it.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import pageSrc from '../pages/Purchases.jsx?raw';
import suppliersSrc from '../pages/Suppliers.jsx?raw';

const STRINGS = ['itemsLabel', 'addLine', 'removeLine', 'selectItem',
                 'linesCol', 'costCurrency', 'shippingSharedHint'];

describe('the form is a line editor', () => {
  test('lines are their own state, seeded from the saved order', () => {
    expect(pageSrc).toMatch(/const \[lines, setLines\] = useState\(\(\) => \{/);
    expect(pageSrc).toMatch(/if \(initial\.items\?\.length\)/);
  });

  test('an order saved before lines existed still opens', () => {
    // Its header is folded back into one line rather than showing an empty
    // editor over a purchase that plainly has something on it.
    expect(pageSrc).toMatch(/if \(initial\.product_name\)/);
  });

  test('lines can be added and removed', () => {
    expect(pageSrc).toMatch(/const addLine\s+= \(\) => setLines/);
    expect(pageSrc).toMatch(/const dropLine = \(i\) => setLines/);
  });

  test('the last line cannot be removed', () => {
    expect(pageSrc).toMatch(/\{lines\.length > 1 && \(/);
  });

  test('it posts items, not the flat single-item shape', () => {
    expect(pageSrc).toMatch(/items: lines\.map\(l => \(\{/);
    for (const field of ['inventory_id', 'product_name', 'category', 'quantity',
                         'unit_cost', 'discount', 'tax_rate_id']) {
      expect(pageSrc, field).toMatch(new RegExp(`${field}:\\s`));
    }
  });

  test('picking a stocked item fills the line', () => {
    expect(pageSrc).toMatch(/function pickInventory\(i, id\)/);
    expect(pageSrc).toMatch(/patch\.product_name = item\.name/);
  });
});

describe('what stays on the document', () => {
  test('supplier, currency, freight, status and notes', () => {
    const form = pageSrc.match(/const \[form, setForm\] = useState\(\{[\s\S]*?\}\);/)[0];
    for (const key of ['supplier', 'cost_currency', 'additional_costs',
                       'status', 'notes', 'warehouse_id']) {
      expect(form, key).toMatch(new RegExp(`${key}:`));
    }
  });

  test('and nothing per-product does', () => {
    // A quantity or a unit cost on the document is the bug this replaces.
    const form = pageSrc.match(/const \[form, setForm\] = useState\(\{[\s\S]*?\}\);/)[0];
    for (const key of ['product_name', 'quantity', 'unit_cost', 'tax_rate_id',
                       'inventory_id', 'category']) {
      expect(form, key).not.toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });

  test('freight says it is shared across the items', () => {
    expect(pageSrc).toMatch(/purchases\.shippingSharedHint/);
    expect(en.purchases.shippingSharedHint).toMatch(/shared across/i);
  });
});

describe('the running total mirrors the server', () => {
  test('a line is its goods value less its own discount, floored at zero', () => {
    expect(pageSrc).toMatch(
      /const lineNet = \(l\) => Math\.max\([\s\S]*?- \(parseFloat\(l\.discount\) \|\| 0\), 0\)/);
  });

  test('tax is per line, on the discounted value', () => {
    expect(pageSrc).toMatch(/const taxAmt\s+= lines\.reduce\(/);
    expect(pageSrc).toMatch(/lineNet\(l\) \* \(Number\(r\.rate\) \|\| 0\) \/ 100/);
  });

  test('freight is added after tax, being outside the taxable base', () => {
    expect(pageSrc).toMatch(
      /const total\s+= goods \+ \(parseFloat\(form\.additional_costs\) \|\| 0\) \+ taxAmt/);
  });
});

describe('the list describes a document', () => {
  test('it names the first item and says how many others', () => {
    expect(pageSrc).toMatch(/p\.item_summary \|\| p\.product_name/);
  });

  test('it shows the line count where a unit cost used to be', () => {
    // A unit cost is not a property of an order holding six products.
    expect(pageSrc).toMatch(/p\.line_count \?\? 1/);
    expect(pageSrc).not.toMatch(/\$\{fmtNum\(p\.unit_cost\)\}/);
  });

  test('quantity is the total across the lines', () => {
    expect(pageSrc).toMatch(/p\.total_quantity \?\? p\.quantity/);
  });

  test('the category filter matches an order on ANY of its lines', () => {
    expect(pageSrc).toMatch(/\(p\.categories \|\| \[\]\)\.includes\(categoryFilter\)/);
  });
});

describe('the export', () => {
  test('emits one row per line', () => {
    // An accountant reconciling a supplier statement works line by line; a row
    // per order hides exactly the detail they opened the export for.
    expect(pageSrc).toMatch(/const exportData = filtered\.flatMap\(p => \{/);
    expect(pageSrc).toMatch(/const rows = \(p\.items \|\| \[\]\)\.length \? p\.items : \[null\]/);
  });

  test('the delivery charge is written once, not on every line', () => {
    // Otherwise summing the column counts the freight once per product.
    expect(pageSrc).toMatch(/'Additional':\s+i === 0 \? p\.additional_costs : ''/);
    expect(pageSrc).toMatch(/'Order Total':\s+i === 0 \? p\.total_cost : ''/);
  });

  test('and each line carries its own numbers', () => {
    // Keys with spaces are quoted; `Discount` is a bare identifier.
    for (const col of ['Line Total', 'VAT Amount']) {
      expect(pageSrc, col).toMatch(new RegExp(`'${col}'`));
    }
    expect(pageSrc).toMatch(/Discount:\s+l \? \(l\.discount \|\| 0\) : 0/);
  });
});

describe('the supplier history', () => {
  test('reads the document total, not quantity x unit cost', () => {
    expect(suppliersSrc).toMatch(/const total = \(p\.subtotal \|\| 0\) \+ \(p\.additional_costs \|\| 0\)/);
  });

  test('and describes the order by its lines', () => {
    expect(suppliersSrc).toMatch(/p\.item_summary \|\| p\.product_name/);
    expect(suppliersSrc).toMatch(/p\.line_count \?\? 1/);
  });
});

describe('both languages', () => {
  test.each(STRINGS)('purchases.%s exists in EN and AR', (key) => {
    expect(en.purchases[key], `en.purchases.${key}`).toBeTruthy();
    expect(ar.purchases[key], `ar.purchases.${key}`).toBeTruthy();
    expect(ar.purchases[key]).not.toBe(en.purchases[key]);
  });
});


describe('correcting a purchase after the goods have landed', () => {
  test('Edit is offered whatever the status', () => {
    // A cost keyed wrong used to be uncorrectable once received. The button no
    // longer sits inside the branch that offers Receive — which is now gated
    // on whether the goods have arrived rather than on the status word, since
    // a prepaid order is still waiting for its delivery.
    const receiveBranch = pageSrc.match(/\{!p\.received_at && \([\s\S]*?\)\}/)[0];
    expect(receiveBranch).not.toMatch(/common\.edit/);
    expect(pageSrc).toMatch(
      /setActivePurchase\(p\); setModal\('edit'\);[\s\S]{0,80}t\('common\.edit'\)/);
  });

  test('the form warns before restating', () => {
    // Saving is a restatement, not a correction on paper, so it says so BEFORE
    // it happens rather than after.
    expect(pageSrc).toMatch(/const landed = !!\(initial\.stock_updated \|\| initial\.expense_recorded\)/);
    expect(pageSrc).toMatch(/\{isEdit && landed && \(/);
    expect(pageSrc).toMatch(/purchases\.restateWarning/);
  });

  test('and the warning says what will actually happen', () => {
    for (const phrase of [/re-value/i, /cost correction/i, /dated today/i, /refused/i]) {
      expect(en.purchases.restateWarning, String(phrase)).toMatch(phrase);
    }
  });

  test('the warning exists in both languages', () => {
    expect(ar.purchases.restateWarning).toBeTruthy();
    expect(ar.purchases.restateWarning).not.toBe(en.purchases.restateWarning);
  });
});
