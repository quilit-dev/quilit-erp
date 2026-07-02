import { useState, useEffect, useMemo } from 'react';
import { getAccounts, getGeneralLedger } from '../../api/client';
import { LoadingSpinner, toast } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { SortableTh, Pager } from './ui';

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

export { Ledger };
