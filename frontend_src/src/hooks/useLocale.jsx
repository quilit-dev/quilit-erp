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
    <LocaleContext.Provider value={{ lang, setLang, isRTL, t, tStatus, tCategory, fmt, fmtDate }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>');
  return ctx;
}
