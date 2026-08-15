// useServerList — paging, searching and sorting on the server.
//
// The list screens used to download every row and filter, sort and page in the
// browser: 1,984 ms and 19.8 MB for 40,000 invoices, on every open. Moving one
// of the three server-side without the others is worse than moving none —
// sorting a page of fifty sorts the wrong rows, and searching a page finds only
// what is already on screen. These pin that they travel together, and that the
// request is shaped the way the endpoints expect.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useServerList } from '../hooks/useServerList';

const page = (items, total) => ({ items, total, limit: 25, offset: 0 });
let fetchPage;

beforeEach(() => {
  vi.clearAllMocks();
  fetchPage = vi.fn(async () => page([{ id: 1 }, { id: 2 }], 57));
});

const lastQuery = () => fetchPage.mock.calls[fetchPage.mock.calls.length - 1][0];

describe('useServerList', () => {
  test('asks for one page, not the whole table', async () => {
    const { result } = renderHook(() => useServerList(fetchPage));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    expect(lastQuery()).toMatchObject({ limit: 25, offset: 0 });
    expect(result.current.items).toHaveLength(2);
    // total is the server's count of the WHOLE filtered set, not the page —
    // it is what "showing 25 of 57" and the page count are built from.
    expect(result.current.total).toBe(57);
    expect(result.current.totalPages).toBe(3);
  });

  test('offset follows the page', async () => {
    const { result } = renderHook(() => useServerList(fetchPage));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    await act(async () => { result.current.setPage(3); });
    await waitFor(() => expect(lastQuery().offset).toBe(50));
  });

  test('search is debounced into a single request', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useServerList(fetchPage, {}, { debounceMs: 300 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const before = fetchPage.mock.calls.length;

      // Six keystrokes must not be six round trips.
      for (const ch of ['a', 'ac', 'acm', 'acme', 'acme ', 'acme c']) {
        act(() => { result.current.setSearch(ch); });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      expect(fetchPage.mock.calls.length - before).toBe(1);
      expect(lastQuery().search).toBe('acme c');
    } finally {
      vi.useRealTimers();
    }
  });

  test('sorting goes to the server, with a direction', async () => {
    const { result } = renderHook(() => useServerList(fetchPage));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    await act(async () => { result.current.requestSort('amount'); });
    await waitFor(() => expect(lastQuery()).toMatchObject({ sort: 'amount', dir: 'asc' }));

    // Clicking the same column again flips it.
    await act(async () => { result.current.requestSort('amount'); });
    await waitFor(() => expect(lastQuery().dir).toBe('desc'));
  });

  test('narrowing the set returns to page 1', async () => {
    // Otherwise a search from page 7 lands on an empty screen and looks broken.
    const { result } = renderHook(() => useServerList(fetchPage));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    await act(async () => { result.current.setPage(3); });
    await waitFor(() => expect(lastQuery().offset).toBe(50));

    await act(async () => { result.current.setSearch('acme'); });
    await waitFor(() => expect(lastQuery().offset).toBe(0));
    expect(result.current.page).toBe(1);
  });

  test('filters are compared by value, so an inline object does not thrash', async () => {
    // Every page builds its filters inline; comparing by identity would refetch
    // on every unrelated render.
    const { rerender } = renderHook(
      ({ status }) => useServerList(fetchPage, { status }),
      { initialProps: { status: 'Unpaid' } },
    );
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    const calls = fetchPage.mock.calls.length;

    rerender({ status: 'Unpaid' });          // same value, new object
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchPage.mock.calls.length).toBe(calls);

    rerender({ status: 'Paid' });            // a real change
    await waitFor(() => expect(lastQuery().status).toBe('Paid'));
  });

  test('empty filters are dropped rather than sent blank', async () => {
    renderHook(() => useServerList(fetchPage, { status: '', client_id: undefined }));
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    expect(lastQuery()).not.toHaveProperty('status');
    expect(lastQuery()).not.toHaveProperty('client_id');
  });

  test('tolerates an endpoint that still returns a plain array', async () => {
    // So the hook can be adopted one screen at a time.
    const plain = vi.fn(async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { result } = renderHook(() => useServerList(plain));
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.total).toBe(3);
  });
});
