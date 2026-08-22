// Period-end FX revaluation — marking foreign cash to the closing rate.
//
// Cash held in a currency that is not the company's is worth whatever it is
// worth today, not what it was worth when it came in. IAS 21 says the
// difference belongs in the profit and loss, and until now this could only be
// done by calling the API by hand — so in practice it was never done, and a
// foreign balance drifted further from reality every month.
//
// The operator counts the notes. The system knows what the books say those
// notes were worth, and posts the difference.
import { useState, useEffect, useCallback } from 'react';
import { getAccounts, postFxRevaluation } from '../../api/client';
import { LoadingSpinner, ConfirmModal, NumberInput, toast } from '../../components/shared';
import { todayISO } from './constants';

// The currencies with a cash account of their own. USD is the functional
// currency and is never revalued against itself.
const FOREIGN = [
  { code: 'LBP', field: 'counted_lbp', account: '1010' },
  { code: 'EUR', field: 'counted_eur', account: '1020' },
];

function Revaluation({ t, fmt, can }) {
  const canPost = can('accounting', 'create');
  const [counts, setCounts] = useState({ LBP: '', EUR: '' });
  const [asOf, setAsOf] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState(null);
  const [accounts, setAccounts] = useState([]);

  const load = useCallback(
    () => getAccounts({ active: true }).then(setAccounts).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  // Only offer a currency the chart actually has an account for. A tenant on a
  // chart without one would otherwise be invited to revalue into nothing.
  const available = FOREIGN.filter(f => accounts.some(a => a.code === f.account));
  const supplied = available.filter(f => counts[f.code] !== '');

  async function post() {
    setConfirm(false);
    setBusy(true);
    try {
      const body = { as_of: asOf, note: note.trim() || null };
      for (const f of supplied) body[f.field] = Number(counts[f.code]);
      const res = await postFxRevaluation(body);
      setResult(res);
      toast(res.message);
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  if (!accounts.length) return <LoadingSpinner />;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{t('accounting.fxRevaluation')}</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '0 16px', margin: '0 0 8px' }}>
        {t('accounting.fxRevaluationHint')}
      </p>

      <div className="card-body">
        <div className="form-grid">
          {available.map(f => (
            <div className="form-group" key={f.code}>
              <label className="form-label">
                {t('accounting.countedIn', { currency: f.code })}
              </label>
              <NumberInput className="form-control" min="0" step="any"
                value={counts[f.code]}
                onChange={e => setCounts(c => ({ ...c, [f.code]: e.target.value }))} />
            </div>
          ))}
          <div className="form-group">
            <label className="form-label">{t('accounting.asOf')}</label>
            <input type="date" className="form-control" value={asOf}
              onChange={e => setAsOf(e.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('invoices.noteOptional')}</label>
            <input className="form-control" value={note}
              onChange={e => setNote(e.target.value)} />
          </div>
        </div>

        {/* What the notes are worth today against what the books say. Shown
            afterwards, because the server's arithmetic is the one that counts. */}
        {result && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('invoices.paymentCurrency')}</th>
                  <th style={{ textAlign: 'right' }}>{t('accounting.rate')}</th>
                  <th style={{ textAlign: 'right' }}>{t('accounting.onTheBooks')}</th>
                  <th style={{ textAlign: 'right' }}>{t('accounting.worthToday')}</th>
                  <th style={{ textAlign: 'right' }}>{t('accounting.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {(result.results || []).map(r => (
                  <tr key={r.currency}>
                    <td>{r.currency}</td>
                    <td style={{ textAlign: 'right' }} className="text-mono">{r.rate}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.book_usd)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.counted_usd)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600,
                                 color: r.delta > 0 ? 'var(--green)'
                                   : r.delta < 0 ? 'var(--red)' : 'var(--text-3)' }}>
                      {r.delta === 0 ? '—' : fmt(r.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="modal-footer" style={{ borderTop: '1px solid var(--border)' }}>
        <button className="btn btn-primary" disabled={busy || !canPost || !supplied.length}
          onClick={() => setConfirm(true)}
          title={!canPost ? t('accounting.needPermission') : ''}>
          {busy ? t('common.saving') : t('accounting.postRevaluation')}
        </button>
      </div>

      {confirm && (
        <ConfirmModal
          title={t('accounting.fxRevaluation')}
          message={t('accounting.confirmRevaluation')}
          confirmLabel={t('accounting.postRevaluation')}
          onConfirm={post} onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
}

export { Revaluation };
