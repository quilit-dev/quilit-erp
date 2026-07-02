// Reusable table controls shared by the Accounting tabs: click-to-sort
// headers, the client/server page navigator, and the preset date-range row.
import { PAGE_SIZES, todayISO, monthStartISO, yearStartISO, lastMonthRange } from './constants';

// Click-to-sort header: shows the active arrow and toggles direction.
function SortableTh({ label, sortKey, sort, dir, onSort, align = 'start' }) {
  const active = sort === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align, whiteSpace: 'nowrap' }}
      title="Click to sort"
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <span style={{ opacity: active ? 0.9 : 0.25, fontSize: 10 }}>
          {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  );
}

// Page navigator — works for both client- and server-paged tables.
function Pager({ page, pageSize, total, onPage, onSize, t, sizes = PAGE_SIZES }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage   = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to   = Math.min(safePage * pageSize, total);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '10px 14px', borderTop: '1px solid var(--border)',
      fontSize: 12, color: 'var(--text-3)', flexWrap: 'wrap',
    }}>
      <div>
        {t('common.showing') /* fallback handled below */ || 'Showing'} <strong style={{ color: 'var(--text)' }}>{from}</strong>–<strong style={{ color: 'var(--text)' }}>{to}</strong>
        {' '}{t('common.of') || 'of'} <strong style={{ color: 'var(--text)' }}>{total.toLocaleString()}</strong>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {onSize && (
          <>
            <span>{t('common.perPage') || 'Per page'}</span>
            <select className="form-control" style={{ width: 70, padding: '2px 6px', fontSize: 12 }}
              value={pageSize} onChange={e => onSize(Number(e.target.value))}>
              {sizes.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <span style={{ margin: '0 8px', color: 'var(--border)' }}>|</span>
          </>
        )}
        <button className="btn btn-sm btn-secondary" disabled={safePage <= 1}
          onClick={() => onPage(1)}>«</button>
        <button className="btn btn-sm btn-secondary" disabled={safePage <= 1}
          onClick={() => onPage(safePage - 1)}>‹</button>
        <span style={{ minWidth: 70, textAlign: 'center' }}>
          {safePage} / {totalPages}
        </span>
        <button className="btn btn-sm btn-secondary" disabled={safePage >= totalPages}
          onClick={() => onPage(safePage + 1)}>›</button>
        <button className="btn btn-sm btn-secondary" disabled={safePage >= totalPages}
          onClick={() => onPage(totalPages)}>»</button>
      </div>
    </div>
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
