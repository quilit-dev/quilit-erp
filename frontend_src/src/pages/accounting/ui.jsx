// Reusable table controls shared by the Accounting tabs. The sort header
// and pager are thin adapters over the app-wide kit in components/shared —
// one rendering implementation, accounting's prop names preserved so the
// tab files don't change.
import {
  SortableTh as SharedSortableTh,
  Pagination,
} from '../../components/shared';
import { PAGE_SIZES, todayISO, monthStartISO, yearStartISO, lastMonthRange } from './constants';

// Click-to-sort header: shows the active arrow and toggles direction.
function SortableTh({ label, sortKey, sort, dir, onSort, align = 'start' }) {
  return (
    <SharedSortableTh
      label={label} sortKey={sortKey}
      currentKey={sort} currentDir={dir} onSort={onSort}
      style={{ textAlign: align }}
    />
  );
}

// Page navigator — works for both client- and server-paged tables.
// (`t` is accepted for call-site compatibility; Pagination translates itself.)
function Pager({ page, pageSize, total, onPage, onSize, t, sizes = PAGE_SIZES }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage   = Math.min(page, totalPages);
  return (
    <Pagination
      page={safePage} totalPages={totalPages}
      pageSize={pageSize} pageSizes={sizes} totalRows={total}
      setPage={(v) => onPage(typeof v === 'function' ? v(safePage) : v)}
      setPageSize={(n) => onSize && onSize(n)}
    />
  );
}

// Date-range row used by Overview + Income Statement. Preset chips collapse
// the most common ranges into a single click; the inputs accept any custom
// window.
function DateRange({ start, end, onStart, onEnd, t, presets = true }) {
  const daysAgoISO = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  // Each preset resolves to its [start, end]. Comparing the live range against
  // them also tells us which preset (if any) is active, so the segmented
  // control can highlight the current selection (and show "custom" = none).
  const PRESETS = [
    ['thisMonth', t('accounting.thisMonth'),  () => [monthStartISO(), todayISO()]],
    ['lastMonth', t('accounting.lastMonth'),  () => lastMonthRange()],
    ['last30',    t('accounting.last30Days'), () => [daysAgoISO(29), todayISO()]],
    ['last90',    t('accounting.last90Days'), () => [daysAgoISO(89), todayISO()]],
    ['ytd',       t('accounting.ytd'),        () => [yearStartISO(), todayISO()]],
  ];
  const apply = (range) => { const [s, e] = range(); onStart(s); onEnd(e); };
  const activeKey = PRESETS.find(([, , range]) => {
    const [s, e] = range(); return s === start && e === end;
  })?.[0];

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="date" className="form-control" style={{ width: 150 }}
        value={start} onChange={e => onStart(e.target.value)} />
      <span style={{ color: 'var(--text-3)' }}>→</span>
      <input type="date" className="form-control" style={{ width: 150 }}
        value={end} onChange={e => onEnd(e.target.value)} />
      {/* Period presets render as a segmented selector — visually distinct
          from the Export / PDF action buttons that sit alongside them. */}
      {presets && (
        <div className="seg" role="group">
          {PRESETS.map(([key, label, range]) => (
            <button key={key} type="button"
              className={`seg-item${activeKey === key ? ' active' : ''}`}
              aria-pressed={activeKey === key}
              onClick={() => apply(range)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { SortableTh, Pager, DateRange };
