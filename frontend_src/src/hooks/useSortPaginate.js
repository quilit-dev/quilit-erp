import { useState, useMemo } from 'react';

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/**
 * useSortPaginate(rows)
 * Returns sorted + paginated rows plus controls.
 *
 * Usage:
 *   const { sorted, page, pageSize, totalPages, setPage, setPageSize,
 *           sortKey, sortDir, requestSort, SortableTh, Pagination } = useSortPaginate(filtered);
 */
export function useSortPaginate(rows = []) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page,    setPage]    = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  function requestSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  }

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage   = Math.min(page, totalPages);
  const paged      = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  function handlePageSize(n) {
    setPageSize(n);
    setPage(1);
  }

  return {
    sorted: paged,
    allSorted: sorted,
    page: safePage,
    pageSize,
    totalPages,
    setPage,
    setPageSize: handlePageSize,
    sortKey,
    sortDir,
    requestSort,
    PAGE_SIZES,
  };
}
