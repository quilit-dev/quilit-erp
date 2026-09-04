// Void cancels a document; archiving files the cancelled one away.
//
// The same shape on every section that can void — invoices, quotations,
// purchases and expenses — because a control that behaves differently
// depending on which screen you opened is worse than no control.
//
// Two properties:
//
//   * Archive is offered only on a row that has already been VOIDED. The
//     server refuses it otherwise, and offering a button that always fails is
//     how a screen teaches somebody to distrust it.
//   * Ticking "Archived only" SWAPS the list for the archive rather than
//     widening it. That is why every caller now names which of the three views
//     it wants, and why one screen still asks for `all`.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import apiSrc from '../api/client.js?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import invoiceMenuSrc from '../pages/invoices/ActionMenu.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';
import expensesSrc from '../pages/Expenses.jsx?raw';
import purchasesSrc from '../pages/Purchases.jsx?raw';
import warehousesSrc from '../pages/warehouses/WarehousesTab.jsx?raw';

const PAGES = {
  Invoices: invoicesSrc,
  Quotations: quotationsSrc,
  Expenses: expensesSrc,
  Purchases: purchasesSrc,
};

describe('every void section offers the archive', () => {
  test.each(Object.keys(PAGES))('%s has the "archived only" toggle', (name) => {
    expect(PAGES[name]).toMatch(/checked=\{showArchived\}/);
    expect(PAGES[name]).toMatch(/common\.showArchived/);
  });

  test.each(['Invoices', 'Quotations', 'Expenses'])(
    '%s asks the server for the archive, not for everything', (name) => {
      expect(PAGES[name]).toMatch(/archived:\s*showArchived \? 'only' : /);
    });

  test('Purchases asks the same way', () => {
    expect(purchasesSrc).toMatch(/showArchived\s+\? \{ archived: 'only' \}/);
  });
});

describe('the archive action is gated on the void', () => {
  test('the invoice menu offers it only once voided', () => {
    // `isVoided && (...)` — not an unconditional entry that would 400.
    expect(invoiceMenuSrc).toMatch(/\) : isVoided && \(/);
    expect(invoiceMenuSrc).toMatch(/onClick=\{\(\) => \{ setOpen\(false\); onArchive\(\); \}\}/);
  });

  test('the quotation menu does the same', () => {
    expect(quotationsSrc).toMatch(/\) : isVoided && \(/);
  });

  test('an expense row shows Archive only on a voided row', () => {
    // archived -> Restore; live -> Edit/Void; voided -> Archive.
    expect(expensesSrc).toMatch(/\{exp\.archived_at \? \(/);
    expect(expensesSrc).toMatch(/\) : !exp\.voided_at \? \(/);
  });

  test('an archived row offers Restore instead', () => {
    for (const [name, src] of Object.entries({
      'invoice menu': invoiceMenuSrc, Quotations: quotationsSrc, Expenses: expensesSrc,
    })) {
      expect(src, name).toMatch(/common\.restore/);
    }
  });

  test("the server's refusal is shown, not replaced", () => {
    // It says exactly what to do; a generic message would send somebody off to
    // work out why on their own.
    for (const [name, src] of Object.entries(PAGES)) {
      expect(src, name).toMatch(/catch \(err\) \{ toast\(err\.message/);
    }
  });
});

describe('the three-state filter', () => {
  test('no caller uses the old boolean any more', () => {
    // It was renamed rather than reinterpreted: a stale `include_archived=1`
    // is ignored and falls back to the working list, which is the safe view.
    for (const [name, src] of Object.entries(PAGES)) {
      expect(src, name).not.toMatch(/include_archived/);
    }
    expect(apiSrc).not.toMatch(/include_archived/);
  });

  test('the one screen that renders both asks for both', () => {
    // Active and archived warehouses are two separate tables on that page, and
    // it is the whole reason this is not a boolean.
    expect(warehousesSrc).toMatch(/getWarehouses\(\{ archived: 'all' \}\)/);
    expect(warehousesSrc).toMatch(/rows\.filter\(r => !r\.archived_at\)/);
    expect(warehousesSrc).toMatch(/rows\.filter\(r =>\s+r\.archived_at\)/);
  });

  test('expenses can reach their archive at all now', () => {
    // The list used to hard-code "not archived", so an archived expense was
    // unreachable from the screen.
    expect(apiSrc).toMatch(/getExpenses\s+= \(params = \{\}, s\) =>/);
  });
});

describe('the label says what the control does', () => {
  test('it is "archived only", not "show archived"', () => {
    // It swaps the list now. "Show archived" read as "show these as well",
    // which is what it used to do.
    expect(en.common.showArchived).toMatch(/only/i);
    expect(en.common.showArchived).not.toMatch(/^show /i);
  });

  test('both languages have the archive strings', () => {
    for (const key of ['showArchived', 'archive', 'archived', 'restore', 'restored']) {
      expect(en.common[key], `en.common.${key}`).toBeTruthy();
      expect(ar.common[key], `ar.common.${key}`).toBeTruthy();
    }
  });
});
