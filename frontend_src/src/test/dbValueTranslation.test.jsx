// Translating values that live in the DATABASE in English.
//
// Most UI text is a t('…') key, so the language toggle reaches it. Seeded
// reference data is different: the 26 chart-of-accounts rows and the 18 role
// names are WRITTEN to the database in English at install time, so no amount of
// switching to Arabic touches them. That is why the General Ledger's account
// picker stayed English in an otherwise Arabic screen.
//
// `tStatus` and `tCategory` already solved this for statuses and categories.
// `tAccount` and `tRole` extend the same idea, with one rule that matters: a
// name the OWNER changed is theirs, and must not be overwritten by our
// translation of the name it used to have.
import { describe, test, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { LocaleProvider, useLocale } from '../hooks/useLocale.jsx';
import en from '../locales/en';
import ar from '../locales/ar';

const wrapper = ({ children }) => <LocaleProvider>{children}</LocaleProvider>;

function localeHook(lang) {
  localStorage.setItem('erp_lang', lang);
  const { result } = renderHook(() => useLocale(), { wrapper });
  return result;
}

describe('the locale dictionaries cover the seeded data', () => {
  test('every seeded account and role has an Arabic entry', () => {
    // A missing key is invisible at runtime — it silently falls back to
    // English, which is exactly the bug being fixed.
    const missingAccounts = Object.keys(en.accountNames).filter(k => !ar.accountNames[k]);
    const missingRoles    = Object.keys(en.roleNames).filter(k => !ar.roleNames[k]);
    expect(missingAccounts).toEqual([]);
    expect(missingRoles).toEqual([]);
    // 31 since migration 144f added 4100 Service Revenue. The count is a
    // tripwire: it fails when the chart of accounts changes, which is the
    // moment somebody has to decide whether the new account needs a name in
    // both languages.
    expect(Object.keys(en.accountNames)).toHaveLength(31);
    expect(Object.keys(en.roleNames)).toHaveLength(18);
    expect(Object.keys(en.enumValues).filter(k => !ar.enumValues[k])).toEqual([]);
  });

  test('covers accounts seeded by later migrations too', () => {
    // The four multi-currency accounts (migration 120) live in a SECOND seed
    // list, which is how they were missed the first time and shipped English.
    for (const code of ['1010', '4910', '6910', '6920', '4100']) {
      expect(en.accountNames[code], `${code} missing from en`).toBeTruthy();
      expect(ar.accountNames[code], `${code} missing from ar`).toBeTruthy();
      expect(ar.accountNames[code]).not.toBe(en.accountNames[code]);
    }
  });

  test('no Arabic entry was left as its English source', () => {
    const untranslated = Object.entries(ar.accountNames)
      .filter(([k, v]) => v === en.accountNames[k]);
    expect(untranslated).toEqual([]);
  });
});

describe('tAccount', () => {
  test('translates a seeded account in Arabic', () => {
    const r = localeHook('ar');
    expect(r.current.tAccount({ code: '1100', name: 'Accounts Receivable' }))
      .toBe(ar.accountNames['1100']);
  });

  test('leaves it in English when the language is English', () => {
    const r = localeHook('en');
    expect(r.current.tAccount({ code: '1100', name: 'Accounts Receivable' }))
      .toBe('Accounts Receivable');
  });

  test("does NOT overwrite an account the owner renamed", () => {
    // They renamed 6100 "Rent" to "Office Rent". Showing the Arabic for "Rent"
    // would quietly discard their wording.
    const r = localeHook('ar');
    expect(r.current.tAccount({ code: '6100', name: 'Office Rent' })).toBe('Office Rent');
  });

  test('passes through an account the owner created', () => {
    const r = localeHook('ar');
    expect(r.current.tAccount({ code: '7777', name: 'Site Fuel' })).toBe('Site Fuel');
  });

  test('reads the journal-line shape too', () => {
    // Journal rows carry account_code/account_name rather than code/name.
    const r = localeHook('ar');
    expect(r.current.tAccount({ account_code: '4000', account_name: 'Sales Revenue' }))
      .toBe(ar.accountNames['4000']);
  });

  test('never throws on a missing or partial row', () => {
    const r = localeHook('ar');
    expect(r.current.tAccount(null)).toBe('');
    expect(r.current.tAccount({ name: 'No code here' })).toBe('No code here');
  });
});

describe('tEnumValue', () => {
  test('translates the option lists that rendered raw English', () => {
    // These are the dropdowns the audit found: account types, employment and
    // leave types, contract types, payment methods, units.
    const r = localeHook('ar');
    for (const v of ['Asset', 'Full-time', 'Annual', 'Permanent', 'Bank Transfer', 'pcs']) {
      expect(r.current.tEnumValue(v), `${v} should be translated`).toBe(ar.enumValues[v]);
      expect(r.current.tEnumValue(v)).not.toBe(v);
    }
  });

  test('passes through a value the user defined', () => {
    const r = localeHook('ar');
    expect(r.current.tEnumValue('drum')).toBe('drum');
  });

  test('leaves values in English when the language is English', () => {
    const r = localeHook('en');
    expect(r.current.tEnumValue('Bank Transfer')).toBe('Bank Transfer');
  });

  test('never throws on empty', () => {
    const r = localeHook('ar');
    expect(r.current.tEnumValue('')).toBe('');
    expect(r.current.tEnumValue(null)).toBe(null);
  });
});

describe('tRole', () => {
  test('translates a seeded role in Arabic', () => {
    const r = localeHook('ar');
    expect(r.current.tRole('Business Owner')).toBe(ar.roleNames['Business Owner']);
    expect(r.current.tRole('Accountant')).toBe(ar.roleNames['Accountant']);
  });

  test('passes through a role the owner created', () => {
    const r = localeHook('ar');
    expect(r.current.tRole('Night Shift Lead')).toBe('Night Shift Lead');
  });

  test('leaves roles in English when the language is English', () => {
    const r = localeHook('en');
    expect(r.current.tRole('Business Owner')).toBe('Business Owner');
  });

  test('never throws on an empty value', () => {
    const r = localeHook('ar');
    expect(r.current.tRole('')).toBe('');
    expect(r.current.tRole(undefined)).toBe(undefined);
  });
});
