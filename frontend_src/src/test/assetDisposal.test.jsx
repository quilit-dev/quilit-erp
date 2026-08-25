// Buying and selling an asset, from the screen.
//
// The gain used to be shown only AFTERWARDS, in a toast, and was never in the
// books at all — the disposal posted nothing. So the two things worth pinning
// here are that the operator is told what the entry will be BEFORE they
// commit, and that the figure they are shown is arrived at the same way the
// server arrives at it.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import src from '../pages/FixedAssets.jsx?raw';

describe('how it was bought is asked at registration', () => {
  test('an asset the business already owned posts nothing', () => {
    expect(src).toMatch(/is_opening_balance: !!form\.is_opening_balance/);
    expect(src).toMatch(/assets\.alreadyOwned/);
    expect(en.assets.alreadyOwnedHint).toMatch(/without booking a purchase/i);
  });

  test('bought on credit owes the supplier rather than moving money', () => {
    expect(src).toMatch(/on_credit: *!!form\.on_credit/);
  });

  test('paid for, it asks the method and the account', () => {
    expect(src).toMatch(/<BankField method=\{form\.payment_method\}/);
  });

  test('and asks none of it while editing', () => {
    // An asset's financial basis is frozen once it has depreciated, and the
    // entry that bought it is already posted.
    expect(src).toMatch(/\{!editId && \(/);
  });
});

describe('the sale states its entry before it is made', () => {
  test('every line of it is named', () => {
    for (const k of ['willPost', 'postCostOut', 'postDepCleared',
                     'postProceeds', 'postGain', 'postLoss']) {
      expect(src, k).toMatch(new RegExp(`assets\\.${k}`));
    }
  });

  test('the preview works the gain out the way the server does', () => {
    // net of VAT, against book value — not gross proceeds, which would
    // overstate the gain by the tax collected for the state.
    expect(src).toMatch(/const net = gross - vat;/);
    expect(src).toMatch(/const gainLoss = Math\.round\(\(net - book\) \* 100\) \/ 100;/);
  });

  test('a loss is shown as a loss, in red', () => {
    expect(src).toMatch(/gainLoss < 0/);
    expect(src).toMatch(/var\(--red\)/);
  });

  test('VAT is asked for, because selling an asset is a taxable supply', () => {
    expect(src).toMatch(/assets\.fldVat/);
    expect(src).toMatch(/vat_amount: Number\(disposeForm\.vat_amount \|\| 0\)/);
  });

  test('the money is sent to the account it was received into', () => {
    expect(src).toMatch(/<BankField method=\{disposeForm\.payment_method\}/);
    expect(src).toMatch(/bank_account_id: disposeForm\.bank_account_id/);
  });

  test('it says depreciation is brought up to date first', () => {
    expect(src).toMatch(/assets\.postCatchUpHint/);
    expect(en.assets.postCatchUpHint).toMatch(/up to the\s+disposal date first/);
  });
});

describe('a fully depreciated asset can still be sold', () => {
  test('the button is offered on it', () => {
    // Which is exactly when a truck goes for scrap. The button used to vanish
    // at the moment it was most needed.
    expect(src).toMatch(/\['Active', 'Fully Depreciated'\]\.includes\(detail\.status\)/);
  });
});

describe('it reads in both languages', () => {
  test('every new string exists in each, with the same placeholders', () => {
    const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
      .map(m => m[1]).sort().join(',');

    for (const k of ['alreadyOwned', 'alreadyOwnedHint', 'onCredit', 'fldVat',
                     'willPost', 'postCostOut', 'postDepCleared',
                     'postProceeds', 'postVat', 'postGain', 'postLoss',
                     'postCatchUpHint']) {
      expect(typeof en.assets[k], `en ${k}`).toBe('string');
      expect(typeof ar.assets[k], `ar ${k}`).toBe('string');
      expect(/[؀-ۿ]/.test(ar.assets[k]), k).toBe(true);
      expect(named(ar.assets[k]), k).toBe(named(en.assets[k]));
    }
  });
});
