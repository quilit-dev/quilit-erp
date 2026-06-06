import { useEffect, useState, useCallback } from 'react';
import { getMyWarehouses } from '../api/client';

/**
 * Shared warehouse selector data — used by every form that needs the operator
 * to pick which warehouse a stock-touching operation hits (Purchases, POS
 * session open, Production order create, Stock transfer, etc.).
 *
 * Returns the list of warehouses the current user can transact in plus the
 * resolved default id (so the selector can pre-select sensibly).
 *
 * Cached across renders within a single page mount; pages that genuinely
 * change the warehouse list (rare) can call `reload()` to refetch.
 */
export function useWarehouses() {
  const [warehouses, setWarehouses] = useState([]);
  const [defaultId, setDefaultId]   = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await getMyWarehouses();
      setWarehouses(r.warehouses || []);
      setDefaultId(r.default_id ?? null);
    } catch (e) {
      setError(e.message || 'Failed to load warehouses');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { warehouses, defaultId, loading, error, reload };
}
