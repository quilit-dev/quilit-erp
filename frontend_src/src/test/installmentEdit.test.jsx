// Editing a payment plan that is already running.
//
// A plan could be rebuilt from a count and a frequency, or removed — but only
// while no money had arrived. That is the wrong shape for the thing people
// actually ask for, which is to move the instalments still to come. Rebuilding
// cannot answer it: settlement is derived from cumulative paid against
// cumulative scheduled, so regenerating five rows where there were twelve
// re-reads what the customer has already settled.
//
// The editor states the rows instead. Two things are worth guarding here, and
// both are about not lying to the person on the screen:
//
//   * rows money has reached are read-only, because the server refuses to
//     change them — a box you can type into but not save is worse than no box;
//   * Save is disabled until the draft adds up, on the SAME tolerance the
//     server uses, so the button is never enabled for a request that would be
//     rejected.
//
// Nothing here recomputes an allocation. The panel renders what the server
// returned and posts back what was typed.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import panelSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import { nextMonth } from '../pages/invoices/PaymentPlan.jsx';
import apiSrc from '../api/client.js?raw';

const STRINGS = ['edit', 'editHint', 'editSaved', 'editFailed', 'addRow',
                 'removeRow', 'settledRow', 'scheduled', 'shortBy', 'overBy',
                 'matches'];

describe('the request', () => {
  test('it PATCHes rather than rebuilding through POST', () => {
    // POST regenerates the schedule and is refused once money has arrived.
    expect(apiSrc).toMatch(
      /editPaymentPlan\s*=\s*\(id, d\) => api\.patch\(`\/api\/invoices\/\$\{id\}\/plan`, d\)/);
    expect(panelSrc).toMatch(/await editPaymentPlan\(invoice\.id, \{/);
  });

  test('it sends the rows, not a count and a frequency', () => {
    expect(panelSrc).toMatch(/installments: draft\.map\(/);
    expect(panelSrc).toMatch(/due_date: r\.due_date/);
    expect(panelSrc).toMatch(/amount:\s+Number\(r\.amount\)/);
  });

  test('a failure is shown, not swallowed', () => {
    expect(panelSrc).toMatch(/toast\(err\.message \|\| t\('installments\.editFailed'\), 'red'\)/);
  });

  test('the panel reloads from the server afterwards', () => {
    // The new allocation is the server's answer, never recomputed here.
    expect(panelSrc).toMatch(/setDraft\(null\);\s*\n\s*onChange\?\.\(\)/);
  });
});

describe('what money has already reached', () => {
  test('a row that has been paid against is marked settled', () => {
    expect(panelSrc).toMatch(/settled:\s+Number\(r\.paid\) > CENT/);
  });

  test('its date and amount are read-only', () => {
    const disabled = panelSrc.match(/disabled=\{row\.settled\}/g) || [];
    expect(disabled.length).toBe(2);        // the date box and the amount box
  });

  test('it cannot be removed', () => {
    expect(panelSrc).toMatch(/\{!row\.settled && draft\.length > 1 && \(/);
  });

  test('the row says why it is fixed', () => {
    expect(panelSrc).toMatch(/t\('installments\.settledRow'\)/);
  });
});

describe('the plan still has to add up', () => {
  test('Save is disabled until it does', () => {
    expect(panelSrc).toMatch(/disabled=\{busy \|\| Math\.abs\(gap\) > CENT\}/);
  });

  test('on the same tolerance the server applies', () => {
    // 0.005 — a cent of rounding is not a mismatch, a dollar is. A stricter
    // browser check would block edits the server accepts; a looser one would
    // enable a button that fails.
    expect(panelSrc).toMatch(/const CENT = 0\.005;/);
  });

  test('the gap is measured against the invoice total', () => {
    expect(panelSrc).toMatch(/const gap\s+= total - drafted;/);
    expect(panelSrc).toMatch(/const total = Number\(invoice\.amount\) \|\| 0;/);
  });

  test('and is reported as short, over, or matching', () => {
    for (const key of ['matches', 'shortBy', 'overBy']) {
      expect(panelSrc, key).toMatch(new RegExp(`installments\\.${key}`));
    }
  });
});

describe('the editor itself', () => {
  test('rows can be added and dropped', () => {
    expect(panelSrc).toMatch(/const addRow\s+= \(\) => setDraft/);
    expect(panelSrc).toMatch(/const dropRow = \(i\) => setDraft/);
  });

  test('the last row cannot be dropped', () => {
    expect(panelSrc).toMatch(/draft\.length > 1/);
  });

  test('a new row is suggested a month after the last', () => {
    expect(panelSrc).toMatch(/due_date: nextMonth\(/);
  });

  test('the read-only table and the editor are never both shown', () => {
    expect(panelSrc).toMatch(/\{plan\.length > 0 && !draft && \(\s*\n\s*<table>/);
  });

  test('cancelling drops the draft without saving', () => {
    expect(panelSrc).toMatch(/onClick=\{\(\) => setDraft\(null\)\}/);
  });

  test('the button is offered even once payments have arrived', () => {
    // The whole point. `locked` gates the REBUILD; it must not gate the edit.
    const edit = panelSrc.match(
      /\{canEdit && plan\.length > 0 && !open && !draft && \([\s\S]{0,200}?installments\.edit'\)\}/);
    expect(edit, 'the edit button is gated on `locked`').toBeTruthy();
    expect(edit[0]).not.toMatch(/locked/);
  });

  test('the rebuild button is still gated on it', () => {
    expect(panelSrc).toMatch(/\{canEdit && plan\.length > 0 && !locked && !open && !draft && \(/);
  });
});

describe('the date suggested for a new row', () => {
  test('it steps one month on', () => {
    expect(nextMonth('2026-04-15')).toBe('2026-05-15');
  });

  test('it does not slip a day', () => {
    // It used to run the date through a Date and back out via toISOString,
    // which converts local midnight to UTC — east of Greenwich that lands on
    // the day BEFORE, so stepping from the 15th suggested the 14th. A date
    // input holds a plain calendar day; it has no timezone to convert.
    expect(nextMonth('2026-01-01')).toBe('2026-02-01');
    expect(nextMonth('2026-06-15')).toBe('2026-07-15');
    expect(nextMonth('2026-07-31')).toBe('2026-08-31');
    expect(nextMonth('2026-11-30')).toBe('2026-12-30');
  });

  test('it clamps rather than skipping a short month', () => {
    expect(nextMonth('2026-01-31')).toBe('2026-02-28');
    expect(nextMonth('2028-01-31')).toBe('2028-02-29');   // a leap year
  });

  test('it rolls over the year', () => {
    expect(nextMonth('2026-12-15')).toBe('2027-01-15');
  });

  test('anything that is not a date falls back to today', () => {
    expect(nextMonth('')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextMonth(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('nothing about money', () => {
  test('the panel computes no allocation of its own', () => {
    // `paid`, `remaining` and `status` are the server's; a second
    // implementation here is how a screen comes to disagree with the ledger.
    expect(panelSrc).not.toMatch(/status\s*=\s*['"]Paid['"]/);
    expect(panelSrc).not.toMatch(/remaining:\s/);
  });

  test('the draft carries only dates, amounts and notes', () => {
    const body = panelSrc.match(/installments: draft\.map\(r => \(\{[\s\S]*?\}\)\)/)[0];
    expect(body).not.toMatch(/paid|status|seq|id/);
  });
});

describe('both languages', () => {
  test.each(STRINGS)('installments.%s exists in EN and AR', (key) => {
    expect(en.installments[key], `en.installments.${key}`).toBeTruthy();
    expect(ar.installments[key], `ar.installments.${key}`).toBeTruthy();
    expect(ar.installments[key]).not.toBe(en.installments[key]);
  });

  test('the placeholders survive translation', () => {
    const ph = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort();
    for (const key of ['editHint', 'shortBy', 'overBy']) {
      expect(ph(ar.installments[key]), key).toEqual(ph(en.installments[key]));
    }
    expect(ph(en.installments.editHint)).toContain('{{total}}');
    expect(ph(en.installments.shortBy)).toContain('{{amount}}');
  });

  test('the locked hint now points at the edit rather than refusing', () => {
    // It used to say the plan "can no longer be changed", which stopped being
    // true the moment the editor shipped.
    expect(en.installments.lockedHint).not.toMatch(/no longer be changed/);
    expect(en.installments.lockedHint).toMatch(/Edit schedule/);
  });
});
