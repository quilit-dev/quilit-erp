/**
 * usePersistedState — drop-in replacement for useState that persists
 * the value in sessionStorage so it survives in-session navigation
 * (page switches) but resets on a new browser tab / session.
 *
 * Usage:
 *   const [search, setSearch] = usePersistedState('clients.search', '');
 *   const [preset, setPreset] = usePersistedState('finance.preset', 'month');
 */
import { useState, useEffect } from 'react';

export function usePersistedState(key, defaultValue) {
  const [state, setState] = useState(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored === null) return defaultValue;
      return JSON.parse(stored);
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // sessionStorage full or unavailable — fail silently
    }
  }, [key, state]);

  return [state, setState];
}
