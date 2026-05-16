/**
 * useSettings — lightweight React context that loads /api/settings once
 * on app mount and makes the values available anywhere without prop drilling.
 *
 * Usage:
 *   import { useSettings } from '../hooks/useSettings';
 *   const { settings } = useSettings();
 */
import { createContext, useContext, useState, useEffect } from 'react';

const SettingsContext = createContext({ settings: null, reload: () => {} });

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null);

  async function load() {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;           // not logged in yet
      const res = await fetch('/api/settings/', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSettings(await res.json());
    } catch {
      /* silently ignore — defaults are baked into the component */
    }
  }

  useEffect(() => {
    load();
    // Re-load whenever the user logs in (token appears in storage)
    const onStorage = (e) => { if (e.key === 'token' && e.newValue) load(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, reload: load }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
