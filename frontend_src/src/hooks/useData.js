import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * useData — race-condition-safe data fetching hook.
 *
 * Key design decisions:
 *  1. Uses AbortController so in-flight requests are cancelled when the
 *     component unmounts or deps change — prevents stale state updates.
 *  2. Does NOT use mountedRef pattern (which is fragile in StrictMode).
 *     Instead, each fetch gets a fresh abort controller; if the controller
 *     is already aborted by the time the fetch resolves, we discard the result.
 *  3. Tracks a `fetchId` counter so only the LATEST fetch updates state —
 *     eliminates out-of-order response problems.
 *  4. Visible error messages: AbortError is silently ignored (not an error),
 *     all other errors surface their real message.
 *  5. Re-fetches when the browser tab regains visibility, so navigating
 *     away and back always shows fresh data.
 */
export function useData(fetchFn, deps = []) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Tracks the AbortController for the current in-flight request
  const controllerRef = useRef(null);
  // Monotonically-increasing counter — lets us discard stale responses
  const fetchIdRef    = useRef(0);

  const load = useCallback(async () => {
    // Cancel any previous in-flight request
    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    // Claim a fetch slot
    const myId = ++fetchIdRef.current;

    setLoading(true);
    setError(null);

    try {
      // Pass the signal so the API layer can cancel the fetch
      const result = await fetchFn(controller.signal);

      // Discard if a newer fetch has already started, or if we were aborted
      if (myId !== fetchIdRef.current || controller.signal.aborted) return;

      setData(result);
    } catch (err) {
      // AbortError = intentional cancellation, not a user-visible error
      if (err.name === 'AbortError') return;

      if (myId !== fetchIdRef.current) return;

      setError(err.message || 'An unexpected error occurred.');
    } finally {
      if (myId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Run on mount and whenever deps change
  useEffect(() => {
    load();
    return () => {
      // Abort in-flight request on unmount / dep change
      if (controllerRef.current) {
        controllerRef.current.abort();
      }
    };
  }, [load]);

  // Refetch when the user returns to this tab (e.g. after creating a record elsewhere)
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        load();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load]);

  return { data, loading, error, reload: load };
}

/**
 * useMultiData — fetches several endpoints in parallel and tracks
 * their combined loading/error state. Used by pages that need multiple
 * datasets before they can render (e.g. Quotations needs clients + projects).
 *
 * Returns { results: [...], loading, errors: [...], reload }
 * results[i] is null until fetch i resolves.
 */
export function useMultiData(fetchFns) {
  const count = fetchFns.length;
  const [results,  setResults]  = useState(() => Array(count).fill(null));
  const [loadings, setLoadings] = useState(() => Array(count).fill(true));
  const [errors,   setErrors]   = useState(() => Array(count).fill(null));
  const fetchIdRef = useRef(0);

  const load = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    setLoadings(Array(count).fill(true));
    setErrors(Array(count).fill(null));

    const controllers = fetchFns.map(() => new AbortController());

    const promises = fetchFns.map((fn, i) =>
      fn(controllers[i].signal)
        .then(result => ({ i, result, error: null }))
        .catch(err  => ({ i, result: null, error: err.name === 'AbortError' ? null : (err.message || 'Error') }))
    );

    const settled = await Promise.all(promises);
    if (myId !== fetchIdRef.current) return;

    const newResults  = [...results];
    const newErrors   = Array(count).fill(null);
    const newLoadings = Array(count).fill(false);

    settled.forEach(({ i, result, error }) => {
      newResults[i] = result;
      newErrors[i]  = error;
    });

    setResults(newResults);
    setErrors(newErrors);
    setLoadings(newLoadings);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function onVisible() { if (document.visibilityState === 'visible') load(); }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const loading = loadings.some(Boolean);
  const error   = errors.find(Boolean) || null;

  return { results, loading, error, reload: load };
}
