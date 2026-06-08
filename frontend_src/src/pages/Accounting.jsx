// Accounting — double-entry general ledger.
//
// Eight tabs, each with the controls operators expect from a real accounting
// suite:
//
//   • Overview         — KPIs + balance-sheet check, with a date-range
//                        selector (presets + custom) so the cards adapt to
//                        whichever window the operator is reviewing.
//   • Accounts         — Chart of Accounts with type filter, active/inactive
//                        toggle, free-text search, sortable columns and
//                        client-side pagination.
//   • Journal          — Server-paged with date range, status filter,
//                        source-type filter, text search and sortable
//                        columns. Pagination uses the backend's
//                        total/limit/offset contract.
//   • Ledger           — Account + range, sortable transactions and a
//                        client-side page navigator for high-volume accounts.
//   • Trial Balance    — Type filter + free-text search + sortable columns;
//                        the footer total stays in sync with the filter.
//   • Income Statement — Range only (small table, no pagination needed).
//   • Balance Sheet    — As-of date (small table).
//   • Closing          — YearEnd (small) + MonthlyPeriods with year + status
//                        filter so an operator looking at "2026, still open"
//                        gets one click to the rows that matter.

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  getAccounts, createAccount, updateAccount, deleteAccount,
  getJournalEntries, getJournalEntry, createJournalEntry, reverseJournalEntry,
  getGeneralLedger, getTrialBalance, getBalanceSheet, getIncomeStatement, getCashFlow,
  getAccountingSummary, getFiscalYears, closeFiscalYear, reopenFiscalYear,
  getFinancePeriods, lockPeriod, unlockPeriod,
} from '../api/client';
import {
  LoadingSpinner, Modal, ConfirmModal, toast, ExportButton,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => todayISO().slice(0, 7) + '-01';
const yearStartISO  = () => todayISO().slice(0, 4) + '-01-01';

// Last calendar month's first and last day. Used by the date-range preset
// chips so "Last month" doesn't require the operator to count days.
function lastMonthRange() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  const start = d.toISOString().slice(0, 10);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    .toISOString().slice(0, 10);
  return [start, lastDay];
}

// ── Reusable bits ────────────────────────────────────────────────────────────

// Page-size dropdown values — common spreadsheet defaults.
const PAGE_SIZES = [25, 50, 100, 200];

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
  function applyPreset(kind) {
    if (kind === 'thisMonth')   { onStart(monthStartISO()); onEnd(todayISO()); }
    else if (kind === 'lastMonth') {
      const [s, e] = lastMonthRange(); onStart(s); onEnd(e);
    } else if (kind === 'ytd')   { onStart(yearStartISO());  onEnd(todayISO()); }
    else if (kind === 'last30')  {
      const d = new Date(); d.setDate(d.getDate() - 29);
      onStart(d.toISOString().slice(0, 10)); onEnd(todayISO());
    } else if (kind === 'last90') {
      const d = new Date(); d.setDate(d.getDate() - 89);
      onStart(d.toISOString().slice(0, 10)); onEnd(todayISO());
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="date" className="form-control" style={{ width: 150 }}
        value={start} onChange={e => onStart(e.target.value)} />
      <span style={{ color: 'var(--text-3)' }}>→</span>
      <input type="date" className="form-control" style={{ width: 150 }}
        value={end} onChange={e => onEnd(e.target.value)} />
      {presets && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={() => applyPreset('thisMonth')}>{t('accounting.thisMonth')}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => applyPreset('lastMonth')}>{t('accounting.lastMonth')}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => applyPreset('last30')}>{t('accounting.last30Days')}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => applyPreset('last90')}>{t('accounting.last90Days')}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => applyPreset('ytd')}>{t('accounting.ytd')}</button>
        </div>
      )}
    </div>
  );
}


export default function Accounting() {
  const { t, fmt, fmtDate } = useLocale();
  const { can } = usePermissions();
  const canEdit = can('accounting', 'edit');
  const canCreate = can('accounting', 'create');
  const [tab, setTab] = useState('overview');

  const TABS = [
    ['overview', t('accounting.overview')],
    ['accounts', t('accounting.accounts')],
    ['journal', t('accounting.journal')],
    ['ledger', t('accounting.ledger')],
    ['trialBalance', t('accounting.trialBalance')],
    ['incomeStatement', t('accounting.incomeStatement')],
    ['balanceSheet', t('accounting.balanceSheet')],
    ['cashFlow', t('accounting.cashFlow')],
    ['closing', t('accounting.closing')],
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('accounting.title')}</h1>
          <p className="page-subtitle">{t('accounting.subtitle')}</p>
        </div>
      </div>

      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {TABS.map(([key, label]) => (
          <button key={key} className={`tab-btn${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview t={t} fmt={fmt} fmtDate={fmtDate} />}
      {tab === 'accounts' && <Accounts t={t} canCreate={canCreate} canEdit={canEdit} can={can} />}
      {tab === 'journal' && <Journal t={t} fmt={fmt} fmtDate={fmtDate} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'ledger' && <Ledger t={t} fmt={fmt} fmtDate={fmtDate} />}
      {tab === 'trialBalance' && <TrialBalance t={t} fmt={fmt} />}
      {tab === 'incomeStatement' && <IncomeStatement t={t} fmt={fmt} />}
      {tab === 'balanceSheet' && <BalanceSheet t={t} fmt={fmt} />}
      {tab === 'cashFlow' && <CashFlow t={t} fmt={fmt} />}
      {tab === 'closing' && <>
        <YearEnd t={t} fmt={fmt} can={can} />
        <MonthlyPeriods t={t} fmt={fmt} can={can} />
      </>}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
//
// KPIs that follow the operator's date selection — defaults to month-to-date
// for continuity with the previous behaviour but accepts any window. The
// "Total Assets" + balance-sheet ✓ are pinned to the END of the window since
// they are point-in-time figures (a B/S "as of 2026-03-31" is meaningful;
// over a range is not).
function Overview({ t, fmt, fmtDate }) {
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [s,     setS]     = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!start || !end || start > end) return;
    setLoading(true);
    getAccountingSummary({ start, end })
      .then(setS)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end]);

  const cards = s ? [
    [t('accounting.totalIncome'),  fmt(s.month_income),  'green'],
    [t('accounting.totalExpense'), fmt(s.month_expense), 'red'],
    [t('accounting.netIncome'),    fmt(s.month_net),     s.month_net >= 0 ? 'green' : 'red'],
    [t('accounting.totalAssets'),  fmt(s.total_assets),  'blue'],
  ] : [];

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header" style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <span className="card-title">{t('accounting.overview')}</span>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {fmtDate(start)} → {fmtDate(end)}
            </div>
          </div>
          <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
        </div>
      </div>

      {loading || !s ? <LoadingSpinner /> : (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            {cards.map(([label, value, color]) => (
              <div className="stat-card" key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value" style={{ color: `var(--${color})` }}>{value}</div>
              </div>
            ))}
          </div>
          <div className="card"><div className="card-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <span>{t('accounting.accounts')}: <strong>{s.accounts}</strong></span>
            <span>{t('accounting.posted')}: <strong>{s.posted_entries}</strong></span>
            <span>{t('accounting.balanceSheet')}:{' '}
              <strong style={{ color: s.balanced ? 'var(--green)' : 'var(--red)' }}>
                {s.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
              </strong>
              <span style={{ marginInlineStart: 6, color: 'var(--text-3)', fontSize: 12 }}>
                ({t('accounting.asOf')} {fmtDate(end)})
              </span>
            </span>
          </div></div>
        </>
      )}
    </>
  );
}

// ── Chart of Accounts ────────────────────────────────────────────────────────
//
// Filter + sort + search + client-side pagination. The Chart of Accounts is
// small (~30 system + customer-added rows) but operators with mature charts
// pin 100+ — pagination caps the visible rows so the table never feels
// unwieldy.
function Accounts({ t, canCreate, canEdit, can }) {
  const [rows,    setRows]    = useState(null);
  const [modal,   setModal]   = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  // Filters
  const [typeFilter,   setTypeFilter]   = useState('');
  const [activeFilter, setActiveFilter] = useState('active');   // active | inactive | all
  const [search,       setSearch]       = useState('');

  // Sorting (default: code ascending — natural CoA reading order)
  const [sort, setSort] = useState('code');
  const [dir,  setDir]  = useState('asc');

  // Pagination
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(() => getAccounts().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [typeFilter, activeFilter, search, pageSize]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!typeFilter || r.type === typeFilter) &&
      (activeFilter === 'all'
        || (activeFilter === 'active'   && r.is_active)
        || (activeFilter === 'inactive' && !r.is_active)) &&
      (!q
        || (r.code || '').toLowerCase().includes(q)
        || (r.name || '').toLowerCase().includes(q)
        || (r.subtype || '').toLowerCase().includes(q)),
    );
  }, [rows, typeFilter, activeFilter, search]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const av = a[sort] ?? '';
      const bv = b[sort] ?? '';
      // Numeric-ish strings (codes like "1000", "6920") sort naturally with
      // localeCompare's numeric option — no need for a per-column comparator.
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [filtered, sort, dir]);

  const paged = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('asc'); }
  }

  if (!rows) return <LoadingSpinner />;

  async function save() {
    try {
      if (modal.id) await updateAccount(modal.id, { name: modal.name, subtype: modal.subtype, description: modal.description, is_active: modal.is_active });
      else await createAccount({ code: modal.code, name: modal.name, type: modal.type, subtype: modal.subtype, description: modal.description });
      toast(`${modal.code || ''} ${modal.name}`.trim()); setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function toggle(a) {
    try { await updateAccount(a.id, { is_active: !a.is_active }); load(); }
    catch (e) { toast(e.message, 'red'); }
  }
  async function doDelete(a) {
    setConfirmDel(null);
    try { await deleteAccount(a.id); toast('Deleted'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('accounting.accounts')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-control" style={{ width: 200 }} placeholder={t('common.search') + '…'}
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className="form-control" style={{ width: 150 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">{t('accounting.allTypes')}</option>
            {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <select className="form-control" style={{ width: 140 }} value={activeFilter} onChange={e => setActiveFilter(e.target.value)}>
            <option value="active">{t('accounting.activeOnly')}</option>
            <option value="inactive">{t('accounting.inactiveOnly')}</option>
            <option value="all">{t('accounting.allStatuses')}</option>
          </select>
          {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setModal({ code: '', name: '', type: 'Expense', subtype: '', description: '' })}>＋ {t('accounting.newAccount')}</button>}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <SortableTh label={t('accounting.code')}    sortKey="code"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.name')}    sortKey="name"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.type')}    sortKey="type"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.subtype')} sortKey="subtype" sort={sort} dir={dir} onSort={onSort} />
            <th></th><th></th>
          </tr></thead>
          <tbody>
            {paged.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>
                {t('accounting.noAccountsMatch')}
              </td></tr>
            ) : paged.map(a => (
              <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                <td className="text-mono">{a.code}</td>
                <td className="td-primary">{a.name}{a.is_system ? <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('accounting.systemAccount')}</span> : null}</td>
                <td>{a.type}</td>
                <td style={{ color: 'var(--text-3)' }}>{a.subtype || '—'}{a.is_active ? '' : ` · ${t('accounting.inactive')}`}</td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setModal({ ...a })}>{t('common.edit')}</button>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && !a.is_system && (
                    <button className="btn btn-sm btn-secondary" onClick={() => toggle(a)}>
                      {a.is_active ? t('accounting.deactivate') : t('accounting.activate')}
                    </button>
                  )}
                  {can('accounting', 'delete') && !a.is_system && (
                    <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }} onClick={() => setConfirmDel(a)}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager page={page} pageSize={pageSize} total={sorted.length}
        onPage={setPage} onSize={setPageSize} t={t} />

      {modal && (
        <Modal title={modal.id ? t('common.edit') : t('accounting.newAccount')} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('accounting.code')}</label>
                <input className="form-control" value={modal.code} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, code: e.target.value }))} placeholder="6950" />
              </div>
              <div className="form-group">
                <label className="form-label">{t('accounting.type')}</label>
                <select className="form-control" value={modal.type} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, type: e.target.value }))}>
                  {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.name')}</label>
                <input className="form-control" value={modal.name}
                  onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.subtype')}</label>
                <input className="form-control" value={modal.subtype || ''}
                  onChange={e => setModal(m => ({ ...m, subtype: e.target.value }))} placeholder="Operating Expense" />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={!modal.name || (!modal.id && !modal.code)}>{t('common.save')}</button>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmModal title={t('common.delete')} confirmClass="btn-danger" confirmLabel={t('common.delete')}
          message={`${confirmDel.code} — ${confirmDel.name}`}
          onConfirm={() => doDelete(confirmDel)} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────
//
// Server-paged (the backend now returns {rows, total, source_types}). Every
// filter change resets the cursor to page 1 so the operator isn't stranded
// past the end of a freshly-filtered result set.
function Journal({ t, fmt, fmtDate, canCreate, canEdit }) {
  const [start, setStart]               = useState(monthStartISO());
  const [end,   setEnd]                 = useState(todayISO());
  const [sourceType, setSourceType]     = useState('');
  const [status,     setStatus]         = useState('');
  const [search,     setSearch]         = useState('');
  const [sort, setSort] = useState('entry_date');
  const [dir,  setDir]  = useState('desc');
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [detail,   setDetail]   = useState(null);
  const [adding,   setAdding]   = useState(false);
  const [confirmRev, setConfirmRev] = useState(null);

  // Reset to page 1 when any filter/sort/page-size changes — otherwise the
  // operator could be looking at page 3 of a 1-page filtered result.
  useEffect(() => { setPage(1); }, [start, end, sourceType, status, search, sort, dir, pageSize]);

  const load = useCallback(() => {
    setLoading(true);
    getJournalEntries({
      start, end, source_type: sourceType, status, q_text: search,
      sort, direction: dir,
      limit: pageSize, offset: (page - 1) * pageSize,
    })
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end, sourceType, status, search, sort, dir, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('desc'); }
  }

  async function openDetail(id) {
    try { setDetail(await getJournalEntry(id)); } catch (e) { toast(e.message, 'red'); }
  }
  async function doReverse(id) {
    setConfirmRev(null);
    try { await reverseJournalEntry(id); toast(t('accounting.reversed')); setDetail(null); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  const rows         = data?.rows || [];
  const total        = data?.total || 0;
  const sourceTypes  = data?.source_types || [];

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('accounting.journal')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>＋ {t('accounting.newEntry')}</button>}
        </div>
      </div>

      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)',
                    display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
        <span style={{ color: 'var(--text-3)' }}>→</span>
        <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
        <select className="form-control" style={{ width: 160 }} value={sourceType} onChange={e => setSourceType(e.target.value)}>
          <option value="">{t('accounting.allSources')}</option>
          {sourceTypes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="form-control" style={{ width: 140 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t('accounting.allStatuses')}</option>
          <option value="posted">{t('accounting.statusPosted')}</option>
          <option value="reversed">{t('accounting.statusReversed')}</option>
        </select>
        <input className="form-control" style={{ minWidth: 180, flex: 1 }}
          placeholder={t('accounting.searchEntries') + '…'}
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {loading && !data ? <LoadingSpinner /> : rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('accounting.noEntries')}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <SortableTh label="#"                          sortKey="entry_number" sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('common.date')}           sortKey="entry_date"   sort={sort} dir={dir} onSort={onSort} />
              <th>{t('accounting.memo')}</th>
              <SortableTh label={t('accounting.source')}     sortKey="source_type"  sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('accounting.debit')}      sortKey="total_debit"  sort={sort} dir={dir} onSort={onSort} align="right" />
              <SortableTh label={t('accounting.credit')}     sortKey="total_credit" sort={sort} dir={dir} onSort={onSort} align="right" />
              <SortableTh label={t('common.status')}         sortKey="status"       sort={sort} dir={dir} onSort={onSort} />
            </tr></thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(e.id)}>
                  <td className="text-mono">{e.entry_number}</td>
                  <td>{fmtDate(e.entry_date)}</td>
                  <td className="td-primary">{e.memo}</td>
                  <td><span className="badge badge-gray">{e.source_type || 'manual'}</span></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(e.total_debit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(e.total_credit)}</td>
                  <td>
                    <span className={`badge badge-${e.status === 'posted' ? 'green' : e.status === 'reversed' ? 'red' : 'gray'}`}>
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pageSize={pageSize} total={total}
        onPage={setPage} onSize={setPageSize} t={t} />

      {detail && (
        <EntryDetail entry={detail} t={t} fmt={fmt} fmtDate={fmtDate} canEdit={canEdit}
          onClose={() => setDetail(null)} onReverse={() => setConfirmRev(detail.id)} />
      )}
      {adding && (
        <NewEntryModal t={t} fmt={fmt} onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }} />
      )}
      {confirmRev != null && (
        <ConfirmModal title={t('accounting.reverse')} message={t('accounting.confirmReverse')}
          confirmLabel={t('accounting.reverse')} confirmClass="btn-danger"
          onConfirm={() => doReverse(confirmRev)} onCancel={() => setConfirmRev(null)} />
      )}
    </div>
  );
}

function EntryDetail({ entry, t, fmt, fmtDate, canEdit, onClose, onReverse }) {
  const reversible = entry.status === 'posted' && !entry.reversed_by;
  return (
    <Modal title={`${entry.entry_number} · ${fmtDate(entry.entry_date)}`} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 0 }}>{entry.memo}</p>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('accounting.account')}</th><th>{t('accounting.memo')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.debit')}</th>
              <th style={{ textAlign: 'right' }}>{t('accounting.credit')}</th>
            </tr></thead>
            <tbody>
              {entry.lines.map(l => (
                <tr key={l.id}>
                  <td><span className="text-mono">{l.account_code}</span> {l.account_name}</td>
                  <td style={{ color: 'var(--text-3)' }}>{l.memo || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{l.debit ? fmt(l.debit) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{l.credit ? fmt(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td colSpan={2} style={{ textAlign: 'right' }}>Σ</td>
              <td style={{ textAlign: 'right' }}>{fmt(entry.total_debit)}</td>
              <td style={{ textAlign: 'right' }}>{fmt(entry.total_credit)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        {canEdit && reversible && <button className="btn btn-danger" onClick={onReverse}>{t('accounting.reverse')}</button>}
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

function NewEntryModal({ t, fmt, onClose, onSaved }) {
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getAccounts({ active: true }).then(setAccounts).catch(() => {}); }, []);

  const totalD = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalC = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const balanced = Math.abs(totalD - totalC) < 0.005 && totalD > 0;

  function setLine(i, patch) { setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l)); }

  async function save() {
    setSaving(true);
    try {
      await createJournalEntry({
        entry_date: date, memo,
        lines: lines
          .filter(l => l.account_id && ((parseFloat(l.debit) || 0) > 0 || (parseFloat(l.credit) || 0) > 0))
          .map(l => ({ account_id: Number(l.account_id), debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0 })),
      });
      toast(t('accounting.posted')); onSaved();
    } catch (e) { toast(e.message, 'red'); } finally { setSaving(false); }
  }

  return (
    <Modal title={t('accounting.newEntry')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <div className="form-group">
            <label className="form-label">{t('accounting.entryDate')}</label>
            <input type="date" className="form-control" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('accounting.memo')}</label>
            <input className="form-control" value={memo} onChange={e => setMemo(e.target.value)} />
          </div>
        </div>
        <table style={{ width: '100%' }}>
          <thead><tr style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <th style={{ textAlign: 'left' }}>{t('accounting.account')}</th>
            <th style={{ width: 120, textAlign: 'right' }}>{t('accounting.debit')}</th>
            <th style={{ width: 120, textAlign: 'right' }}>{t('accounting.credit')}</th>
            <th style={{ width: 30 }}></th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="form-control" value={l.account_id} onChange={e => setLine(i, { account_id: e.target.value })}>
                    <option value="">{t('accounting.selectAccount')}</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select>
                </td>
                <td><input type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                  value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td><input type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                  value={l.credit} onChange={e => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td>{lines.length > 2 && <button className="btn btn-sm btn-secondary" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }}
          onClick={() => setLines(ls => [...ls, { account_id: '', debit: '', credit: '' }])}>＋ {t('accounting.addLine')}</button>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 12, fontWeight: 600 }}>
          <span>{t('accounting.totalDebit')}: {fmt(totalD)}</span>
          <span>{t('accounting.totalCredit')}: {fmt(totalC)}</span>
          <span style={{ color: balanced ? 'var(--green)' : 'var(--red)' }}>
            {balanced ? `✓ ${t('accounting.balanced')}` : t('accounting.notBalanced')}
          </span>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={!balanced || saving}
          title={!balanced ? t('accounting.mustBalance') : ''}>{saving ? t('common.saving') : t('accounting.posted')}</button>
      </div>
    </Modal>
  );
}

// ── General Ledger ───────────────────────────────────────────────────────────
//
// Account-scoped transactions with sortable columns and client-side pagination.
// The opening + closing balance rows are kept anchored outside the page slice
// so the operator always sees the period's brackets regardless of the page.
function Ledger({ t, fmt, fmtDate }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [data,  setData]  = useState(null);

  const [sort, setSort] = useState('date');
  const [dir,  setDir]  = useState('asc');
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => { getAccounts({ active: true }).then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    if (!accountId) { setData(null); return; }
    getGeneralLedger({ account_id: accountId, start, end }).then(setData).catch(e => toast(e.message, 'red'));
  }, [accountId, start, end]);
  useEffect(() => { setPage(1); }, [accountId, start, end, sort, dir, pageSize]);

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir(key === 'date' ? 'asc' : 'desc'); }
  }

  const sorted = useMemo(() => {
    const txs = data?.transactions || [];
    const out = [...txs];
    out.sort((a, b) => {
      const av = a[sort] ?? '';
      const bv = b[sort] ?? '';
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [data, sort, dir]);
  const paged = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-control" style={{ maxWidth: 280 }} value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">{t('accounting.selectAccount')}</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
        </select>
        <input type="date" className="form-control" style={{ width: 150 }} value={start} onChange={e => setStart(e.target.value)} />
        <span style={{ color: 'var(--text-3)' }}>→</span>
        <input type="date" className="form-control" style={{ width: 150 }} value={end} onChange={e => setEnd(e.target.value)} />
      </div>
      {!accountId ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('accounting.selectAccount')}</div>
      ) : !data ? <LoadingSpinner /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <SortableTh label={t('common.date')}      sortKey="date"    sort={sort} dir={dir} onSort={onSort} />
                <th>{t('accounting.memo')}</th>
                <SortableTh label={t('accounting.debit')}  sortKey="debit"   sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortableTh label={t('accounting.credit')} sortKey="credit"  sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortableTh label={t('accounting.balance')} sortKey="balance" sort={sort} dir={dir} onSort={onSort} align="right" />
              </tr></thead>
              <tbody>
                <tr style={{ color: 'var(--text-3)' }}>
                  <td colSpan={4}>{t('accounting.openingBalance')}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(data.opening_balance)}</td>
                </tr>
                {paged.map((x, i) => (
                  <tr key={i}>
                    <td>{fmtDate(x.date)}</td>
                    <td>{x.memo}</td>
                    <td style={{ textAlign: 'right' }}>{x.debit ? fmt(x.debit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{x.credit ? fmt(x.credit) : ''}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(x.balance)}</td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>{t('accounting.noTransactions')}</td></tr>
                )}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td colSpan={4}>{t('accounting.closingBalance')}</td>
                <td style={{ textAlign: 'right' }}>{fmt(data.closing_balance)}</td>
              </tr></tfoot>
            </table>
          </div>
          {sorted.length > pageSize && (
            <Pager page={page} pageSize={pageSize} total={sorted.length}
              onPage={setPage} onSize={setPageSize} t={t} />
          )}
        </>
      )}
    </div>
  );
}

// ── Trial Balance ────────────────────────────────────────────────────────────
//
// Type filter + search + sortable columns. Totals row recomputes against the
// CURRENT filter so the operator sees the totals for what they're looking at,
// not the whole sheet — matches Excel/Google Sheets behaviour.
function TrialBalance({ t, fmt }) {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);

  const [typeFilter, setTypeFilter] = useState('');
  const [search,     setSearch]     = useState('');
  const [sort, setSort] = useState('code');
  const [dir,  setDir]  = useState('asc');

  useEffect(() => { getTrialBalance({ as_of: asOf }).then(setData).catch(e => toast(e.message, 'red')); }, [asOf]);

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('asc'); }
  }

  const filtered = useMemo(() => {
    const rows = data?.rows || [];
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!typeFilter || r.type === typeFilter) &&
      (!q
        || (r.code || '').toLowerCase().includes(q)
        || (r.name || '').toLowerCase().includes(q)),
    );
  }, [data, typeFilter, search]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const av = a[sort] ?? '';
      const bv = b[sort] ?? '';
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [filtered, sort, dir]);

  // Totals computed against the FILTERED rows so the footer stays meaningful.
  const totalD = sorted.reduce((s, r) => s + (r.debit  || 0), 0);
  const totalC = sorted.reduce((s, r) => s + (r.credit || 0), 0);
  const balanced = Math.abs(totalD - totalC) < 0.005;

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.trialBalance')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-control" style={{ width: 180 }}
            placeholder={t('common.search') + '…'}
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className="form-control" style={{ width: 150 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">{t('accounting.allTypes')}</option>
            {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.asOf')}</span>
          <input type="date" className="form-control" style={{ width: 150 }} value={asOf} onChange={e => setAsOf(e.target.value)} />
          {data && <ExportButton data={sorted} filename={`trial-balance-${asOf}`} sheetName="TrialBalance" />}
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <SortableTh label={t('accounting.code')}  sortKey="code" sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('accounting.name')}  sortKey="name" sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('accounting.type')}  sortKey="type" sort={sort} dir={dir} onSort={onSort} />
              <SortableTh label={t('accounting.debit')} sortKey="debit"  sort={sort} dir={dir} onSort={onSort} align="right" />
              <SortableTh label={t('accounting.credit')} sortKey="credit" sort={sort} dir={dir} onSort={onSort} align="right" />
            </tr></thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>
                  {t('accounting.noAccountsMatch')}
                </td></tr>
              ) : sorted.map(r => (
                <tr key={r.code}>
                  <td className="text-mono">{r.code}</td><td>{r.name}</td><td style={{ color: 'var(--text-3)' }}>{r.type}</td>
                  <td style={{ textAlign: 'right' }}>{r.debit ? fmt(r.debit) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.credit ? fmt(r.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td colSpan={3} style={{ textAlign: 'right', color: balanced ? 'var(--green)' : 'var(--red)' }}>
                {balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
              </td>
              <td style={{ textAlign: 'right' }}>{fmt(totalD)}</td>
              <td style={{ textAlign: 'right' }}>{fmt(totalC)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Income Statement ─────────────────────────────────────────────────────────
function StatementSection({ title, rows, fmt, color }) {
  return (
    <>
      <tr style={{ background: 'var(--surface-2, #f9fafb)' }}>
        <td colSpan={2} style={{ fontWeight: 700, color: color ? `var(--${color})` : undefined }}>{title}</td>
      </tr>
      {rows.map(r => (
        <tr key={r.code}>
          <td style={{ paddingInlineStart: 24 }}><span className="text-mono" style={{ color: 'var(--text-3)' }}>{r.code}</span> {r.name}</td>
          <td style={{ textAlign: 'right' }}>{fmt(r.balance)}</td>
        </tr>
      ))}
      {rows.length === 0 && <tr><td style={{ paddingInlineStart: 24, color: 'var(--text-3)' }}>—</td><td style={{ textAlign: 'right' }}>{fmt(0)}</td></tr>}
    </>
  );
}

function IncomeStatement({ t, fmt }) {
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getIncomeStatement({ start, end }).then(setData).catch(e => toast(e.message, 'red')); }, [start, end]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.incomeStatement')}</span>
        <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection title={t('accounting.income')} rows={data.income} fmt={fmt} color="green" />
            <tr style={{ fontWeight: 600 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalIncome')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_income)}</td></tr>
            <StatementSection title={t('accounting.expense')} rows={data.expense} fmt={fmt} color="red" />
            <tr style={{ fontWeight: 600 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalExpense')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_expense)}</td></tr>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)', fontSize: 15 }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.netIncome')}</td>
              <td style={{ textAlign: 'right', color: data.net_income >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(data.net_income)}</td>
            </tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}

// ── Balance Sheet ────────────────────────────────────────────────────────────
function BalanceSheet({ t, fmt }) {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getBalanceSheet({ as_of: asOf }).then(setData).catch(e => toast(e.message, 'red')); }, [asOf]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.balanceSheet')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.asOf')}</span>
          <input type="date" className="form-control" style={{ width: 150 }} value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection title={t('accounting.assets')} rows={data.assets} fmt={fmt} color="blue" />
            <tr style={{ fontWeight: 700 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalAssets')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_assets)}</td></tr>
            <StatementSection title={t('accounting.liabilities')} rows={data.liabilities} fmt={fmt} />
            <StatementSection title={t('accounting.equity')} rows={data.equity} fmt={fmt} />
            <tr><td style={{ paddingInlineStart: 24 }}>{t('accounting.currentEarnings')}</td><td style={{ textAlign: 'right' }}>{fmt(data.net_income)}</td></tr>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.liabilitiesAndEquity')}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.total_liabilities_equity)}</td>
            </tr>
            <tr><td colSpan={2} style={{ textAlign: 'right', color: data.balanced ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
              {data.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
            </td></tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}


// ── Cash Flow Statement ──────────────────────────────────────────────────────
function CashFlowSection({ title, rows, total, totalLabel, fmt }) {
  return (
    <>
      <tr style={{ background: 'var(--surface-2, #f9fafb)' }}>
        <td colSpan={2} style={{ fontWeight: 700 }}>{title}</td>
      </tr>
      {rows.map(r => (
        <tr key={r.code}>
          <td style={{ paddingInlineStart: 24 }}>
            <span className="text-mono" style={{ color: 'var(--text-3)' }}>{r.code}</span> {r.name}
          </td>
          <td style={{ textAlign: 'right', color: r.amount < 0 ? 'var(--red)' : undefined }}>{fmt(r.amount)}</td>
        </tr>
      ))}
      {rows.length === 0 && (
        <tr><td style={{ paddingInlineStart: 24, color: 'var(--text-3)' }}>—</td><td style={{ textAlign: 'right' }}>{fmt(0)}</td></tr>
      )}
      <tr style={{ fontWeight: 600 }}>
        <td style={{ textAlign: 'right' }}>{totalLabel}</td>
        <td style={{ textAlign: 'right', color: total < 0 ? 'var(--red)' : undefined }}>{fmt(total)}</td>
      </tr>
    </>
  );
}

function CashFlow({ t, fmt }) {
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    getCashFlow({ start, end }).then(setData).catch(e => toast(e.message, 'red'));
  }, [start, end]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.cashFlow')}</span>
        <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <CashFlowSection title={t('accounting.cfOperating')} rows={data.operating}
              total={data.total_operating} totalLabel={t('accounting.cfNetOperating')} fmt={fmt} />
            <CashFlowSection title={t('accounting.cfInvesting')} rows={data.investing}
              total={data.total_investing} totalLabel={t('accounting.cfNetInvesting')} fmt={fmt} />
            <CashFlowSection title={t('accounting.cfFinancing')} rows={data.financing}
              total={data.total_financing} totalLabel={t('accounting.cfNetFinancing')} fmt={fmt} />
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)', fontSize: 15 }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.cfNetChange')}</td>
              <td style={{ textAlign: 'right', color: data.net_change < 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(data.net_change)}</td>
            </tr>
            <tr>
              <td style={{ textAlign: 'right', color: 'var(--text-3)' }}>{t('accounting.cfOpeningCash')}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.opening_cash)}</td>
            </tr>
            <tr style={{ fontWeight: 600 }}>
              <td style={{ textAlign: 'right' }}>{t('accounting.cfClosingCash')}</td>
              <td style={{ textAlign: 'right' }}>{fmt(data.closing_cash)}</td>
            </tr>
            <tr><td colSpan={2} style={{ textAlign: 'right', color: data.balanced ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
              {data.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
            </td></tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}


// ── Financial-year closing ───────────────────────────────────────────────────
function YearEnd({ t, fmt, can }) {
  const canClose  = can('accounting', 'edit');
  const canReopen = can('accounting', 'delete');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(() => getFiscalYears().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);

  async function act() {
    const { year, action } = confirm;
    setConfirm(null); setBusy(true);
    try {
      if (action === 'close') await closeFiscalYear(year);
      else                    await reopenFiscalYear(year);
      toast(t(action === 'close' ? 'accounting.yearClosed' : 'accounting.yearReopened', { year }));
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  if (!rows) return <LoadingSpinner />;
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">{t('accounting.yearEnd')}</span></div>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '0 16px', margin: '0 0 8px' }}>
        {t('accounting.yearEndHint')}
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{t('accounting.year')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.income')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.expenses')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.netIncome')}</th>
            <th>{t('common.status')}</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.year}>
                <td className="td-primary">{r.year}</td>
                <td style={{ textAlign: 'end' }}>{fmt(r.total_income)}</td>
                <td style={{ textAlign: 'end' }}>{fmt(r.total_expense)}</td>
                <td style={{ textAlign: 'end', fontWeight: 600, color: r.net_income < 0 ? 'var(--red)' : undefined }}>
                  {fmt(r.net_income)}</td>
                <td><span className={`badge badge-${r.status === 'closed' ? 'gray' : 'green'}`}>
                  {t(r.status === 'closed' ? 'accounting.closed' : 'accounting.open')}</span></td>
                <td style={{ textAlign: 'end' }}>
                  {r.status === 'open' && canClose && (
                    <button className="btn btn-sm btn-primary" disabled={busy}
                      onClick={() => setConfirm({ year: r.year, action: 'close' })}>
                      {t('accounting.closeYear')}</button>
                  )}
                  {r.status === 'closed' && canReopen && (
                    <button className="btn btn-sm btn-secondary" disabled={busy}
                      onClick={() => setConfirm({ year: r.year, action: 'reopen' })}>
                      {t('accounting.reopenYear')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmModal
          title={confirm.action === 'close' ? t('accounting.closeYear') : t('accounting.reopenYear')}
          message={t(confirm.action === 'close' ? 'accounting.closeYearConfirm' : 'accounting.reopenYearConfirm',
                     { year: confirm.year })}
          confirmLabel={confirm.action === 'close' ? t('accounting.closeYear') : t('accounting.reopenYear')}
          confirmClass={confirm.action === 'close' ? 'btn-danger' : 'btn-primary'}
          onConfirm={act} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}


// ── Monthly period locking (soft close) ──────────────────────────────────────
//
// Year filter + status filter so a chart with 5+ years of monthly periods
// (60+ rows) doesn't drown the operator in completed history.
function MonthlyPeriods({ t, fmt, can }) {
  const canLock = can('accounting', 'edit');
  const [periods, setPeriods] = useState(null);
  const [working, setWorking] = useState(null);

  const [yearFilter,   setYearFilter]   = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(() => getFinancePeriods().then(setPeriods).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);

  const years = useMemo(() => {
    if (!periods) return [];
    return [...new Set(periods.map(p => p.year))].sort((a, b) => b - a);
  }, [periods]);

  const filtered = useMemo(() => {
    if (!periods) return [];
    return periods.filter(p =>
      (!yearFilter   || String(p.year) === String(yearFilter)) &&
      (!statusFilter
        || (statusFilter === 'locked' && p.locked)
        || (statusFilter === 'open'   && !p.locked)),
    );
  }, [periods, yearFilter, statusFilter]);

  async function toggle(p) {
    const key = `${p.year}-${p.month}`;
    setWorking(key);
    try {
      if (p.locked) await unlockPeriod(p.year, p.month);
      else          await lockPeriod(p.year, p.month);
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setWorking(null); }
  }

  if (!periods) return <LoadingSpinner />;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('accounting.monthlyPeriods')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="form-control" style={{ width: 120 }} value={yearFilter} onChange={e => setYearFilter(e.target.value)}>
            <option value="">{t('accounting.allYears')}</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="form-control" style={{ width: 140 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">{t('accounting.allStatuses')}</option>
            <option value="open">{t('accounting.open')}</option>
            <option value="locked">{t('accounting.locked')}</option>
          </select>
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '0 16px', margin: '0 0 8px' }}>
        {t('accounting.monthlyPeriodsHint')}
      </p>
      <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table>
          <thead><tr>
            <th>{t('accounting.month')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.income')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.expenses')}</th>
            <th style={{ textAlign: 'end' }}>{t('accounting.netIncome')}</th>
            <th>{t('common.status')}</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>
                {t('accounting.noPeriodsMatch')}
              </td></tr>
            ) : filtered.map(p => {
              const key = `${p.year}-${p.month}`;
              const snap = p.snapshot;
              return (
                <tr key={key}>
                  <td className="td-primary">{MONTH_NAMES[p.month - 1]} {p.year}</td>
                  <td style={{ textAlign: 'end' }}>{snap ? fmt(snap.income) : '—'}</td>
                  <td style={{ textAlign: 'end' }}>{snap ? fmt(snap.expenses) : '—'}</td>
                  <td style={{ textAlign: 'end', fontWeight: 600 }}>{snap ? fmt(snap.profit) : '—'}</td>
                  <td><span className={`badge badge-${p.locked ? 'gray' : 'green'}`}>
                    {t(p.locked ? 'accounting.locked' : 'accounting.open')}</span></td>
                  <td style={{ textAlign: 'end' }}>
                    {canLock && (
                      <button className={`btn btn-sm ${p.locked ? 'btn-secondary' : 'btn-primary'}`}
                        disabled={working === key} onClick={() => toggle(p)}>
                        {working === key ? '…' : t(p.locked ? 'accounting.unlock' : 'accounting.lock')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
