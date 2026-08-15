import { useState, useEffect, useMemo, useRef } from 'react';
import { useData } from './useData';

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/**
 * useServerList — the server-side counterpart to useSortPaginate.
 *
 * The big list screens used to fetch every row and then filter, sort and page
 * them in the browser. That is why they were fast: the work was local. It is
 * also why they did not scale — measured on PostgreSQL, the invoice list went
 * from 115 ms / 0.1 MB at 200 rows to 1,984 ms / 19.8 MB at 40,000, on every
 * page open, for every user. `limit=50` stayed flat at ~96 ms across the same
 * range.
 *
 * So paging, sorting and searching all move to the server together. They have
 * to move as a set: sorting one page of fifty rows sorts the wrong thing, and
 * searching one page finds only what is already on screen.
 *
 * The list endpoints keep both response shapes — no `limit` still returns the
 * plain array — so callers that legitimately need everything (exports, finance
 * aggregators) are unaffected by this hook.
 *
 *   const list = useServerList(
 *     (query, signal) => getInvoices(query, signal),
 *     { status: statusFilter, client_id: clientFilter || undefined },
 *   );
 *
 * `filters` may be rebuilt on every render; it is compared by value, so a new
 * object with the same contents does not refetch.
 */
export function useServerList(fetchPage, filters = {}, opts = {}) {
  const {
    pageSize: initialPageSize = DEFAULT_PAGE_SIZE,
    debounceMs = 300,
    // Seeds the box from a persisted value, for screens that remembered the
    // operator's search across sessions before this hook existed.
    initialSearch = '',
  } = opts;

  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [sortKey, setSortKey]   = useState(null);
  const [sortDir, setSortDir]   = useState('asc');
  const [search, setSearch]     = useState(initialSearch);
  // The typed value drives the input; the debounced one drives the request, so
  // a six-character search costs one round trip rather than six.
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), debounceMs);
    return () => clearTimeout(id);
  }, [search, debounceMs]);

  // Compared by value: the caller usually builds this object inline, so
  // comparing by identity would refetch on every keystroke elsewhere.
  const filterKey = JSON.stringify(filters ?? {});

  // Any change to what is being asked for invalidates the page number — page 7
  // of a search with three results is an empty screen.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setPage(1);
  }, [filterKey, debouncedSearch, pageSize, sortKey, sortDir]);

  const query = useMemo(() => {
    const q = {
      limit:  pageSize,
      offset: (page - 1) * pageSize,
      ...JSON.parse(filterKey),
    };
    if (debouncedSearch.trim()) q.search = debouncedSearch.trim();
    if (sortKey) { q.sort = sortKey; q.dir = sortDir; }
    // Drop empty values so the URL carries only real filters.
    Object.keys(q).forEach(k => {
      if (q[k] === '' || q[k] === null || q[k] === undefined) delete q[k];
    });
    return q;
  }, [page, pageSize, filterKey, debouncedSearch, sortKey, sortDir]);

  const queryKey = JSON.stringify(query);
  const { data, loading, error, reload } =
    useData(signal => fetchPage(query, signal), [queryKey]);

  // The endpoints answer with an envelope when `limit` is set, but tolerate a
  // plain array so this hook still works against an endpoint that has not been
  // paginated yet.
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  const total = Array.isArray(data) ? data.length : (data?.total ?? 0);

  function requestSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items, total, loading, error, reload,
    page, setPage, pageSize, setPageSize, totalPages,
    sortKey, sortDir, requestSort,
    search, setSearch,
    // True once the user has narrowed the set — lets a screen say "no matches"
    // rather than "nothing here yet", which are different problems.
    isFiltered: Boolean(debouncedSearch.trim()) ||
                Object.values(filters ?? {}).some(v => v !== '' && v != null),
    PAGE_SIZES,
  };
}
