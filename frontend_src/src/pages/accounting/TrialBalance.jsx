import { useState, useEffect, useMemo } from 'react';
import { getTrialBalance } from '../../api/client';
import { LoadingSpinner, ExportButton, toast } from '../../components/shared';
import { ACCOUNT_TYPES, todayISO } from './constants';
import { SortableTh } from './ui';

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

export { TrialBalance };
