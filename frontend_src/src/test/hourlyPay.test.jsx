// Paying someone by the hour, on screen.
//
// The checks here are the ones that caught real, silent breakage before: a
// translation key with no entry renders as the key itself, and an interpolated
// string used without its parameters prints the braces. Both pass every
// behavioural test.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import hrSrc from '../pages/HR.jsx?raw';
import panelSrc from '../pages/hr/PayrollRunPanel.jsx?raw';
import constantsSrc from '../pages/hr/constants.js?raw';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the employee form offers a pay type', () => {
  test('the two pay types are defined in one place', () => {
    expect(constantsSrc).toMatch(/export const PAY_TYPES = \['Salaried', 'Hourly'\]/);
  });

  test('a blank employee starts salaried', () => {
    // Defaulting to Hourly would silently zero every new employee's pay.
    expect(constantsSrc).toMatch(/pay_type: 'Salaried'/);
  });

  test('the form sends the rate', () => {
    expect(hrSrc).toMatch(/hourly_rate:\s*Number\(empForm\.hourly_rate\)/);
  });

  test('the rate field only appears for hourly staff', () => {
    expect(hrSrc).toMatch(/empForm\.pay_type === 'Hourly' &&/);
  });
});

describe('the payroll line', () => {
  test('an hourly line sends hours, never a total', () => {
    // The API refuses base_salary on an hourly line precisely so the payslip
    // figure cannot stop matching the hours printed beside it. Sending it
    // anyway would turn every edit into a 400.
    expect(panelSrc).toMatch(/isHourly \? \{ hours_worked:/);
    expect(panelSrc).toMatch(/: \{ base_salary:/);
  });

  test('it re-syncs the hours after an autosave', () => {
    // The server recomputes the total; without this the row would keep showing
    // the pre-edit figure.
    expect(panelSrc).toMatch(/setHours\(numStr\(line\.hours_worked\)\)/);
    expect(panelSrc).toMatch(/line\.hours_worked\]\)/);
  });

  test('the working is shown, not just a number', () => {
    expect(panelSrc).toMatch(/hr\.hoursAtRate/);
  });
});

describe('both languages', () => {
  const KEYS = ['hr.fldPayType', 'hr.payTypeSalaried', 'hr.payTypeHourly',
                'hr.fldHourlyRate', 'hr.hourlyRateHint', 'hr.colBaseOrHours',
                'hr.hoursAtRate'];

  test('every new key exists in both', () => {
    expect(KEYS.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(KEYS.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the Arabic strings are actually Arabic', () => {
    // A key present with an English value passes a parity check and still
    // reads as English on screen. hoursAtRate is excluded: it is pure
    // punctuation and placeholders.
    const latinOnly = KEYS
      .filter(k => k !== 'hr.hoursAtRate')
      .filter(k => /[A-Za-z]{3,}/.test(lookup(ar, k)) && !/[؀-ۿ]/.test(lookup(ar, k)));
    expect(latinOnly).toEqual([]);
  });

  test('the pay-type options resolve for both values', () => {
    // Built as `hr.payType${x}` from PAY_TYPES, so a mismatch renders the key.
    for (const dict of [en, ar]) {
      for (const x of ['Salaried', 'Hourly']) {
        expect(dict.hr[`payType${x}`], x).toBeTruthy();
      }
    }
  });

  test('hoursAtRate is given exactly the parameters it names', () => {
    // Called without them it renders "× {{rate}} = {{total}}" on the payslip.
    const named = [...en.hr.hoursAtRate.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
    expect(named).toEqual(['rate', 'total']);
    expect(panelSrc).toMatch(/hr\.hoursAtRate', \{ rate:[\s\S]{0,80}?total:/);
    expect([...ar.hr.hoursAtRate.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort())
      .toEqual(named);
  });
});
