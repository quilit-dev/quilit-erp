/**
 * useSettings — React context that loads /api/settings and the current manual
 * exchange rate, and makes them available app-wide without prop drilling.
 *
 *   const { settings, exchangeRate } = useSettings();
 *
 * `exchangeRate` is `{ rate, base, secondary }` once an admin has set a rate,
 * otherwise `null`.
 *
 * `displayCurrency` ('USD' | 'LBP') is a per-browser view preference that flips
 * which currency `<DualMoney>` shows as the primary figure. It is purely
 * presentational — stored amounts are always in the base currency (USD).
 *
 * Auth is carried by the HttpOnly `session` cookie (credentials: include) — the
 * app no longer keeps a token in localStorage.
 */
import { createContext, useContext, useState, useEffect } from 'react';

const SettingsContext = createContext({
  settings: null, exchangeRate: null, taxRates: [], reload: () => {},
  displayCurrency: 'USD', setDisplayCurrency: () => {},
});

export function SettingsProvider({ children }) {
  const [settings, setSettings]         = useState(null);
  const [exchangeRate, setExchangeRate] = useState(null);
  const [taxRates, setTaxRates]         = useState([]);
  const [displayCurrency, _setDisplayCurrency] = useState(
    () => localStorage.getItem('erp_display_currency') || 'USD',
  );

  function setDisplayCurrency(c) {
    const next = c === 'LBP' ? 'LBP' : 'USD';
    localStorage.setItem('erp_display_currency', next);
    _setDisplayCurrency(next);
  }

  async function load() {
    // Both requests fail quietly with 401 until the user is logged in.
    try {
      const res = await fetch('/api/settings/', { credentials: 'include' });
      if (res.ok) setSettings(await res.json());
    } catch {
      /* ignore — component defaults apply */
    }
    try {
      const res = await fetch('/api/settings/exchange-rate', { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setExchangeRate(d.current ? {
          rate:      Number(d.current.rate),
          base:      d.base_currency,
          secondary: d.secondary_currency,
        } : null);
      }
    } catch {
      /* ignore — pages show single-currency until a rate is set */
    }
    try {
      const res = await fetch('/api/tax-rates/', { credentials: 'include' });
      if (res.ok) setTaxRates(await res.json());
    } catch {
      /* ignore — document forms fall back to no tax options */
    }
  }

  useEffect(() => {
    load();
    // Re-load right after login (Login.jsx dispatches 'user-updated') and when
    // the signed-in user changes in another tab.
    const onAuthChange = () => load();
    const onStorage = (e) => { if (e.key === 'user') load(); };
    window.addEventListener('user-updated', onAuthChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('user-updated', onAuthChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return (
    <SettingsContext.Provider value={{
      settings, exchangeRate, taxRates, reload: load,
      displayCurrency, setDisplayCurrency,
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
