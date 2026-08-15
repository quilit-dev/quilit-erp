import { useState, useEffect } from 'react';
import { getCashFlow } from '../../api/client';
import { LoadingSpinner, toast } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { DateRange } from './ui';
import { StatementExport } from './StatementExport';

// ── Cash Flow Statement ──────────────────────────────────────────────────────
function CashFlowSection({ title, rows, total, totalLabel, fmt, tAccount }) {
  return (
    <>
      <tr style={{ background: 'var(--surface-2, #f9fafb)' }}>
        <td colSpan={2} style={{ fontWeight: 700 }}>{title}</td>
      </tr>
      {rows.map(r => (
        <tr key={r.code}>
          <td style={{ paddingInlineStart: 24 }}>
            <span className="text-mono" style={{ color: 'var(--text-3)' }}>{r.code}</span> {tAccount ? tAccount(r) : r.name}
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

function CashFlow({ t, tAccount, fmt }) {
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
          <StatementExport kind="cashflow" data={data} t={t} />
        </div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="table-wrap"><table>
          <tbody>
            <CashFlowSection tAccount={tAccount} title={t('accounting.cfOperating')} rows={data.operating}
              total={data.total_operating} totalLabel={t('accounting.cfNetOperating')} fmt={fmt} />
            <CashFlowSection tAccount={tAccount} title={t('accounting.cfInvesting')} rows={data.investing}
              total={data.total_investing} totalLabel={t('accounting.cfNetInvesting')} fmt={fmt} />
            <CashFlowSection tAccount={tAccount} title={t('accounting.cfFinancing')} rows={data.financing}
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

export { CashFlow };
