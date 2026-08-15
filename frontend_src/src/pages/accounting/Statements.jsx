// Income Statement + Balance Sheet (they share the StatementSection rows).
import { useState, useEffect } from 'react';
import { getIncomeStatement, getBalanceSheet } from '../../api/client';
import { LoadingSpinner, toast } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { DateRange } from './ui';
import { StatementExport } from './StatementExport';

// ── Income Statement ─────────────────────────────────────────────────────────
function StatementSection({ title, rows, fmt, color, tAccount }) {
  return (
    <>
      <tr style={{ background: 'var(--surface-2, #f9fafb)' }}>
        <td colSpan={2} style={{ fontWeight: 700, color: color ? `var(--${color})` : undefined }}>{title}</td>
      </tr>
      {rows.map(r => (
        <tr key={r.code}>
          <td style={{ paddingInlineStart: 24 }}><span className="text-mono" style={{ color: 'var(--text-3)' }}>{r.code}</span> {tAccount ? tAccount(r) : r.name}</td>
          <td style={{ textAlign: 'right' }}>{fmt(r.balance)}</td>
        </tr>
      ))}
      {rows.length === 0 && <tr><td style={{ paddingInlineStart: 24, color: 'var(--text-3)' }}>—</td><td style={{ textAlign: 'right' }}>{fmt(0)}</td></tr>}
    </>
  );
}

function IncomeStatement({ t, tAccount, fmt }) {
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getIncomeStatement({ start, end }).then(setData).catch(e => toast(e.message, 'red')); }, [start, end]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.incomeStatement')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
          <StatementExport kind="income" data={data} t={t} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection tAccount={tAccount} title={t('accounting.income')} rows={data.income} fmt={fmt} color="green" />
            <tr style={{ fontWeight: 600 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalIncome')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_income)}</td></tr>
            <StatementSection tAccount={tAccount} title={t('accounting.expense')} rows={data.expense} fmt={fmt} color="red" />
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
function BalanceSheet({ t, tAccount, fmt }) {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  useEffect(() => { getBalanceSheet({ as_of: asOf }).then(setData).catch(e => toast(e.message, 'red')); }, [asOf]);
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="card-title">{t('accounting.balanceSheet')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('accounting.asOf')}</span>
          <input type="date" className="form-control" style={{ width: 150 }} value={asOf} onChange={e => setAsOf(e.target.value)} />
          <StatementExport kind="balance" data={data} t={t} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <StatementSection tAccount={tAccount} title={t('accounting.assets')} rows={data.assets} fmt={fmt} color="blue" />
            <tr style={{ fontWeight: 700 }}><td style={{ textAlign: 'right' }}>{t('accounting.totalAssets')}</td><td style={{ textAlign: 'right' }}>{fmt(data.total_assets)}</td></tr>
            <StatementSection tAccount={tAccount} title={t('accounting.liabilities')} rows={data.liabilities} fmt={fmt} />
            <StatementSection tAccount={tAccount} title={t('accounting.equity')} rows={data.equity} fmt={fmt} />
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

export { IncomeStatement, BalanceSheet };
