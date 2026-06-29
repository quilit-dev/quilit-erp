import { useState, useEffect, useCallback } from 'react';
import { getCategories } from '../api/client';

// Owner-defined category registry, fetched per domain and cached at module
// level so the many dropdowns across modules don't each refetch. The Settings
// manager calls invalidateCategories() after edits so every open dropdown
// refreshes. Returns a plain string[] of active category names for the domain.

const _cache = new Map();        // domain -> string[]
const _subs  = new Set();        // re-render callbacks

export function invalidateCategories() {
  _cache.clear();
  _subs.forEach(fn => fn());
}

export function useCategories(domain) {
  const [names, setNames] = useState(() => _cache.get(domain) || []);

  const load = useCallback(() => {
    if (!domain) return;
    if (_cache.has(domain)) { setNames(_cache.get(domain)); return; }
    getCategories(domain)
      .then(rows => {
        const list = (Array.isArray(rows) ? rows : []).map(r => r.name);
        _cache.set(domain, list);
        setNames(list);
      })
      .catch(() => setNames([]));
  }, [domain]);

  useEffect(() => {
    load();
    // Re-pull from cache/server when another component invalidates.
    const onInvalidate = () => load();
    _subs.add(onInvalidate);
    return () => _subs.delete(onInvalidate);
  }, [load]);

  return names;
}
