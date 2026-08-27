// Closing tab — YearEnd (hard close) + MonthlyPeriods (soft period locks).
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  getFiscalYears, closeFiscalYear, reopenFiscalYear,
  getFinancePeriods, lockPeriod, unlockPeriod,
} from '../../api/client';
import { LoadingSpinner, ConfirmModal, toast } from '../../components/shared';
import { MONTH_NAMES } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

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
          <SearchSelect
            className="form-control"
            style={{ width: 120 }}
            value={yearFilter}
            onChange={v => setYearFilter(v)}
            placeholder={t('accounting.allYears')}
            options={(years).map(y => ({ value: y, label: y }))} />
          <SearchSelect
            className="form-control"
            style={{ width: 140 }}
            value={statusFilter}
            onChange={v => setStatusFilter(v)}
            placeholder={t('accounting.allStatuses')}
            options={[{ value: 'open', label: t('accounting.open') }, { value: 'locked', label: t('accounting.locked') }]} />
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

export { YearEnd, MonthlyPeriods };
