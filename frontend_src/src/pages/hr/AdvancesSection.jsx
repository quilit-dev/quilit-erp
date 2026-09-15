// Salary advances (سلفة) on the employee's own page: what they have been
// handed ahead of payday, what is still owed, and the run that recovered
// the rest.
//
// An advance is an asset --- the person owes it --- not an expense, and the
// next payroll run deducts the open total from their net. So the figure that
// matters here is the outstanding one at the top; the rows are its history.
// Voiding is offered only on an open advance that no draft run has claimed:
// a recovered one is part of a paid run, and unwinding that is a payroll
// correction, not a click.
import { useState, useCallback, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal, ConfirmModal, fmt, fmtDate, toast, NumberInput } from '../../components/shared';
import { getAdvances, createAdvance, voidAdvance } from '../../api/client';
import BankField, { useBankAccounts } from '../../components/BankField.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';
import { Section } from './primitives';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque'];
const BADGE = { open: 'yellow', recovered: 'green', voided: 'gray' };

export function AdvancesSection({ empId, canEdit }) {
  const { t, tEnumValue } = useLocale();
  const accounts = useBankAccounts();
  const [data,     setData]     = useState({ rows: [], outstanding: 0 });
  const [loading,  setLoading]  = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [voiding,  setVoiding]  = useState(null);
  const [busy,     setBusy]     = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [bankId, setBankId] = useState('');
  const [note,   setNote]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await getAdvances({ employee_id: empId })); }
    catch (err) { toast(err.message, 'red'); }
    finally { setLoading(false); }
  }, [empId]);
  useEffect(() => { load(); }, [load]);

  async function record(e) {
    e.preventDefault();
    const value = Number(amount);
    if (!(value > 0)) { toast(t('hr.advanceAmountRequired'), 'red'); return; }
    setBusy(true);
    try {
      await createAdvance({
        employee_id: empId, amount: value, payment_method: method,
        bank_account_id: bankId ? Number(bankId) : null,
        note: note.trim() || null,
      });
      toast(t('hr.advanceRecorded'));
      setFormOpen(false); setAmount(''); setNote('');
      await load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function doVoid() {
    setBusy(true);
    try {
      await voidAdvance(voiding.id, {});
      toast(t('hr.advanceVoided'));
      setVoiding(null);
      await load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Section
      title={t('hr.advancesTitle')}
      right={canEdit && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setFormOpen(true)}>
          + {t('hr.recordAdvance')}
        </button>
      )}>
      {/* The number that matters: what the next run will take back. */}
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        {t('hr.advanceOutstanding')}: <strong>{fmt(data.outstanding || 0)}</strong>
        {data.outstanding > 0 && (
          <span style={{ color: 'var(--text-3)' }}> · {t('hr.advanceOutstandingHint')}</span>
        )}
      </div>

      {loading ? <LoadingSpinner /> : data.rows.length === 0 ? (
        <EmptyState message={t('hr.noAdvances')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                <th>{t('common.status')}</th>
                <th>{t('hr.advanceRecoveredIn')}</th>
                <th>{t('hr.fldNotes')}</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {data.rows.map(a => (
                <tr key={a.id} className={a.status === 'voided' ? 'row-archived' : undefined}>
                  <td>{fmtDate(a.paid_at)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(a.amount)} {a.currency !== 'USD' ? a.currency : ''}</td>
                  <td><span className={`badge badge-${BADGE[a.status] || 'gray'}`}>{t(`hr.advanceStatus_${a.status}`)}</span></td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>
                    {a.recovered_period_start
                      ? `${fmtDate(a.recovered_period_start)} – ${fmtDate(a.recovered_period_end)}`
                        + (a.status === 'open' ? ` (${t('hr.advanceClaimedByDraft')})` : '')
                      : '—'}
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{a.note || a.void_reason || ''}</td>
                  {canEdit && (
                    <td>
                      {a.status === 'open' && !a.recovered_in_run_id && (
                        <button type="button" className="btn btn-sm btn-danger"
                          onClick={() => setVoiding(a)}>{t('common.void')}</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <Modal title={t('hr.recordAdvance')} onClose={() => setFormOpen(false)}>
          <form onSubmit={record}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group form-full">
                  <label className="form-label">{t('common.amount')}</label>
                  <NumberInput className="form-control" min="0.01" step="0.01" autoFocus
                    value={amount} onChange={e => setAmount(e.target.value)} />
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{t('hr.advanceAmountHint')}</div>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.paymentMethod')}</label>
                  <SearchSelect className="form-control" value={method} allowBlank={false}
                    onChange={v => { setMethod(v); if (v === 'Cash') setBankId(''); }}
                    options={METHODS.map(m => ({ value: m, label: tEnumValue(m) }))} />
                </div>
                <div className="form-group">
                  <BankField method={method} value={bankId} onChange={setBankId} accounts={accounts} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('hr.fldNotes')}</label>
                  <input className="form-control" value={note} onChange={e => setNote(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t('common.saving') : t('hr.recordAdvance')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {voiding && (
        <ConfirmModal
          title={t('hr.voidAdvanceTitle')}
          message={t('hr.voidAdvanceMessage', { amount: fmt(voiding.amount) })}
          onConfirm={doVoid} onCancel={() => setVoiding(null)} />
      )}
    </Section>
  );
}
