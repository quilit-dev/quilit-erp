import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, Modal, ConfirmModal, toast, NumberInput } from '../../components/shared';
import {
  getCashReconciliation, addCashMovement, deleteCashMovement,
  reopenCashReconciliation,
} from '../../api/client';
import { money, VarianceTag, CATS } from './ui';
import { CloseDayModal } from './modals';

// ── Reconciliation detail modal ─────────────────────────────────────────────
function ReconDetailModal({ reconId, canCreate, canEdit, canDelete, onClose, onChanged }) {
  const { t, fmtDate, tEnumValue } = useLocale();
  const [rec, setRec] = useState(null);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [dir, setDir] = useState('in');
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Float');
  const [desc, setDesc] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getCashReconciliation(reconId).then(setRec).catch(e => setError(e.message));
  }, [reconId]);
  useEffect(() => { load(); }, [load]);

  async function addMv() {
    if (amount === '' || Number(amount) <= 0) { toast(t('cash.amount'), 'red'); return; }
    setAdding(true);
    try {
      await addCashMovement(reconId, {
        direction: dir, currency, amount: Number(amount),
        category, description: desc.trim() || null,
      });
      toast(t('cash.movementAdded'), 'green');
      setAmount(''); setDesc('');
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setAdding(false); }
  }

  async function removeMv(mid) {
    try { await deleteCashMovement(reconId, mid); toast(t('cash.movementRemoved'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  async function reopen() {
    try {
      await reopenCashReconciliation(reconId);
      toast(t('cash.reconReopened'), 'green');
      setConfirmReopen(false); load(); onChanged();
    } catch (e) { toast(e.message, 'red'); setConfirmReopen(false); }
  }

  const isOpen = rec?.status === 'open';
  const fu = rec?.figures?.usd || {};
  const fl = rec?.figures?.lbp || {};

  // label | USD value | LBP value
  const Row = ({ label, u, l, bold, signed }) => (
    <tr>
      <td style={bold ? { fontWeight: 700 } : undefined}>{label}</td>
      <td style={{ textAlign: 'end', ...(bold ? { fontWeight: 700 } : {}) }}>
        {signed ? (signed === '+' ? '+' : '−') : ''}{money(u, 'USD')}
      </td>
      <td style={{ textAlign: 'end', ...(bold ? { fontWeight: 700 } : {}) }}>
        {signed ? (signed === '+' ? '+' : '−') : ''}{money(l, 'LBP')}
      </td>
    </tr>
  );

  return (
    <Modal title={rec ? `${rec.drawer_name} · ${rec.business_date}` : t('cash.title')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!rec && !error && <LoadingSpinner />}
        {rec && (
          <>
            <div style={{ marginBottom: 10 }}>
              <span className={`badge badge-${isOpen ? 'green' : 'gray'}`}>
                {isOpen ? t('cash.statusOpen') : t('cash.statusClosed')}
              </span>
              {rec.auto_capture && (
                <span className="badge badge-blue" style={{ marginInlineStart: 6 }}>{t('cash.autoCapture')}</span>
              )}
            </div>

            {/* Two separate balances — never summed */}
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr><th></th><th style={{ textAlign: 'end' }}>USD</th><th style={{ textAlign: 'end' }}>LBP</th></tr>
              </thead>
              <tbody>
                <Row label={t('cash.openingBalance')} u={fu.opening}    l={fl.opening} />
                <Row label={t('cash.autoIn')}         u={fu.auto_in}    l={fl.auto_in}  signed="+" />
                <Row label={t('cash.autoOut')}        u={fu.auto_out}   l={fl.auto_out} signed="-" />
                <Row label={t('cash.manualIn')}       u={fu.manual_in}  l={fl.manual_in}  signed="+" />
                <Row label={t('cash.manualOut')}      u={fu.manual_out} l={fl.manual_out} signed="-" />
                <Row label={t('cash.expectedCash')}   u={rec.expected_cash} l={rec.expected_cash_lbp} bold />
                {rec.status === 'closed' && (
                  <>
                    <Row label={t('cash.countedCash')} u={rec.counted_cash} l={rec.counted_cash_lbp} />
                    <tr>
                      <td style={{ fontWeight: 700 }}>{t('cash.variance')}</td>
                      <td style={{ textAlign: 'end' }}><VarianceTag value={rec.variance} currency="USD" /></td>
                      <td style={{ textAlign: 'end' }}><VarianceTag value={rec.variance_lbp} currency="LBP" /></td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>

            {/* Movements */}
            <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('cash.movements')}</h4>
            {(rec.movements || []).length === 0 && (
              <p style={{ color: 'var(--text-3)', fontSize: 13 }}>—</p>
            )}
            {(rec.movements || []).length > 0 && (
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr><th>{t('cash.direction')}</th><th>{t('cash.currency')}</th><th>{t('cash.category')}</th>
                      <th>{t('cash.description')}</th><th style={{ textAlign: 'end' }}>{t('cash.amount')}</th><th></th></tr>
                </thead>
                <tbody>
                  {rec.movements.map(m => (
                    <tr key={m.id}>
                      <td>
                        <span className={`badge badge-${m.direction === 'in' ? 'green' : 'red'}`}>
                          {m.direction === 'in' ? t('cash.cashIn') : t('cash.cashOut')}
                        </span>
                      </td>
                      <td>{m.currency || 'USD'}</td>
                      <td>{m.category || '—'}</td>
                      <td>{m.description || '—'}</td>
                      <td style={{ textAlign: 'end' }}>{money(m.amount, m.currency)}</td>
                      <td>
                        {isOpen && canEdit && (
                          <button className="icon-btn" title={t('common.delete')} onClick={() => removeMv(m.id)}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Add movement */}
            {isOpen && canCreate && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end',
                            marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.direction')}</label>
                  <select className="form-control" style={{ height: 32 }} value={dir}
                    onChange={e => { setDir(e.target.value); setCategory(CATS[e.target.value][0]); }}>
                    <option value="in">{t('cash.cashIn')}</option>
                    <option value="out">{t('cash.cashOut')}</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.currency')}</label>
                  <select className="form-control" style={{ height: 32 }} value={currency}
                    onChange={e => setCurrency(e.target.value)}>
                    <option value="USD">USD</option>
                    <option value="LBP">LBP</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.category')}</label>
                  <select className="form-control" style={{ height: 32 }} value={category}
                    onChange={e => setCategory(e.target.value)}>
                    {CATS[dir].map(cat => <option key={cat} value={cat}>{tEnumValue(cat)}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 110 }}>
                  <label className="form-label">{t('cash.description')}</label>
                  <input className="form-control" style={{ height: 32 }} value={desc}
                    onChange={e => setDesc(e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0, width: 110 }}>
                  <label className="form-label">{t('cash.amount')}</label>
                  <NumberInput step="any" min="0" className="form-control" style={{ height: 32 }}
                    value={amount} onChange={e => setAmount(e.target.value)} />
                </div>
                <button className="btn btn-secondary btn-sm" disabled={adding} onClick={addMv}>
                  {t('cash.addMovement')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {rec && isOpen && canEdit && (
          <button className="btn btn-primary" onClick={() => setClosing(true)}>{t('cash.closeDay')}</button>
        )}
        {rec && !isOpen && canDelete && (
          <button className="btn btn-secondary" onClick={() => setConfirmReopen(true)}>{t('cash.reopen')}</button>
        )}
      </div>
      {closing && rec && (
        <CloseDayModal recon={rec} onClose={() => setClosing(false)}
          onClosed={() => { setClosing(false); load(); onChanged(); }} />
      )}
      {confirmReopen && (
        <ConfirmModal title={t('cash.reopen')} message={t('cash.reopenConfirm')}
          confirmLabel={t('cash.reopen')}
          onCancel={() => setConfirmReopen(false)} onConfirm={reopen} />
      )}
    </Modal>
  );
}

export { ReconDetailModal };
