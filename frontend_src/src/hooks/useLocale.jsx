import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import en from '../locales/en';
import ar from '../locales/ar';

const LOCALES = { en, ar };
const STORAGE_KEY = 'erp_lang';

const LocaleContext = createContext(null);

export function LocaleProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem(STORAGE_KEY) || 'en');

  const setLang = useCallback((l) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  }, []);

  const isRTL = lang === 'ar';
  const locale = LOCALES[lang] || en;

  useEffect(() => {
    document.documentElement.setAttribute('dir', isRTL ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', lang);
  }, [lang, isRTL]);

  // t('nav.clients') — dot-path lookup with optional {{var}} interpolation
  const t = useCallback((key, vars) => {
    // Walk the dot-path, descending only into own properties (never the
    // prototype chain) so a crafted key cannot reach __proto__ / constructor.
    const val = key.split('.').reduce(
      (node, p) => (node != null && Object.prototype.hasOwnProperty.call(node, p))
        ? node[p]
        : undefined,
      locale,
    );
    if (typeof val !== 'string') return key;
    if (!vars) return val;
    return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : `{{${k}}}`));
  }, [locale]);

  // Translate a status string from the DB (stored in English)
  const tStatus = useCallback((status) => {
    return locale.status?.[status] ?? status;
  }, [locale]);

  // Translate a category value. Preset categories (Materials, Equipment…) are
  // stored canonically in English; user-typed custom categories aren't in the
  // dict and fall back to their original text unchanged.
  const tCategory = useCallback((category) => {
    if (!category) return category;
    return locale.categories?.[category] ?? category;
  }, [locale]);

  // Translate a value from a fixed option list defined in code — account types,
  // employment and leave types, contract types, payment methods, units. These
  // rendered raw in their dropdowns, so an Arabic screen still offered "Asset",
  // "Full-time" and "Bank Transfer". The value is also what gets STORED, so the
  // same call translates it back wherever it is displayed later.
  //
  // Anything absent from the dictionary passes through unchanged, which keeps
  // user-defined values (custom units, custom categories) as the user typed them.
  const tEnumValue = useCallback((value) => {
    if (!value) return value;
    return locale.enumValues?.[value] ?? value;
  }, [locale]);

  // Translate a chart-of-accounts name. The 26 seeded accounts are written to
  // the DATABASE in English, so the language toggle never reached them — the
  // General Ledger's account picker stayed English in an otherwise Arabic UI.
  //
  // Keyed by account CODE, which is stable, rather than by name. And translated
  // ONLY while the stored name still matches the seeded English: `en` is the
  // canonical seed text, so a mismatch means the owner renamed the account and
  // their wording must win over ours. Accounts they created themselves are not
  // in the dictionary at all and fall through unchanged.
  //
  // Accepts a row ({code, name} or {account_code, account_name}) or a bare code.
  const tAccount = useCallback((account, fallbackName) => {
    if (!account) return fallbackName ?? '';
    const isRow = typeof account === 'object';
    const code  = isRow ? (account.code ?? account.account_code) : account;
    const name  = isRow ? (account.name ?? account.account_name ?? '')
                        : (fallbackName ?? '');
    // A chart that ships its own Arabic wins outright. Lebanon's plan is
    // published in Arabic and the names are stored beside the English ones, so
    // the dictionary below — which only knows the default chart's codes — has
    // nothing useful to say about them.
    if (isRTL && isRow) {
      const own = account.name_ar ?? account.account_name_ar;
      if (own) return own;
    }
    if (code == null) return name;
    const key = String(code);
    if (!isRow && fallbackName == null) return locale.accountNames?.[key] ?? key;
    if (en.accountNames?.[key] !== name) return name;   // renamed by the owner
    return locale.accountNames?.[key] ?? name;
  }, [locale, isRTL]);

  // Translate a seeded role name (also stored in the database in English).
  // Roles the owner created are absent from the dictionary and pass through.
  const tRole = useCallback((role) => {
    if (!role) return role;
    return locale.roleNames?.[role] ?? role;
  }, [locale]);

  // Locale-aware currency formatter — uses settings currency if available
  const fmt = useCallback((val, currency) => {
    const cur = currency || localStorage.getItem('erp_currency') || 'USD';
    const fmtLocale = isRTL ? 'ar-SA-u-nu-latn' : 'en-US';
    return new Intl.NumberFormat(fmtLocale, {
      style: 'currency', currency: cur, minimumFractionDigits: 0,
    }).format(val || 0);
  }, [isRTL]);

  // Locale-aware date formatter
  const fmtDate = useCallback((d) => {
    if (!d) return '—';
    const fmtLocale = isRTL ? 'ar-SA-u-nu-latn' : 'en-US';
    return new Date(d).toLocaleDateString(fmtLocale, { year: 'numeric', month: 'short', day: 'numeric' });
  }, [isRTL]);

  return (
    <LocaleContext.Provider value={{ lang, setLang, isRTL, t, tStatus, tCategory, tAccount, tRole, tEnumValue, fmt, fmtDate }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>');
  return ctx;
}
