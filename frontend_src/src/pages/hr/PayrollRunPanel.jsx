import { useState, useCallback, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import PayoutModal from '../../components/PayoutModal.jsx';
import { LoadingSpinner, ErrorAlert, Modal, fmt, fmtDate, toast, NumberInput } from '../../components/shared';
import { getPayrollRun, createPayrollRun, updatePayrollLine,
         approvePayrollRun, markPayrollRunPaid, cancelPayrollRun } from '../../api/client';
import { PAYROLL_BADGE, payrollStatusLabel } from './constants';
import { Field } from './primitives';

// ════════════════════════════════════════════════════════════════════════════
// PayrollRunPanel — create OR view+edit a payroll run
// ════════════════════════════════════════════════════════════════════════════
function PayrollRunPanel({ runId, canEdit, canApprove, canDelete, onClose, onChanged }) {
  const { t } = useLocale();
  const isNew = runId === 'new';
  const [run,     setRun]     = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [error,   setError]   = useState(null);
  const [busy,    setBusy]    = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd,   setPeriodEnd]   = useState('');
  const [notes,       setNotes]       = useState('');

  const load = useCallback(async (silent = false) => {
    if (isNew) return;
    if (!silent) setLoading(true);
    setError(null);
    try { setRun(await getPayrollRun(runId)); }
    catch (err) { setError(err.message); }
    finally { if (!silent) setLoading(false); }
  }, [runId, isNew]);
  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!periodStart || !periodEnd) { toast(t('hr.bothDatesRequired'), 'error'); return; }
    setBusy(true);
    try {
      const res = await createPayrollRun({ period_start: periodStart, period_end: periodEnd, notes: notes || null });
      toast(t('hr.payrollRunCreated', { count: res.lines }));
      onChanged();
      onClose();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function patchLine(line, patch) {
    try {
      await updatePayrollLine(line.id, patch);
      await load(true); onChanged();   // silent refresh — no spinner flash while editing
    } catch (err) { toast(err.message, 'error'); }
  }
  // Salaries usually leave by transfer. Asking once, here, is what stops
  // the whole payroll being credited to the till.
  const [paying, setPaying] = useState(false);

  async function doAction(action, payout = null) {
    setBusy(true);
    try {
      if (action === 'approve') { await approvePayrollRun(run.id); toast(t('hr.runApproved')); }
      else if (action === 'pay') {
        const r = await markPayrollRunPaid(run.id, payout);
        toast(t('hr.paidAndPosted', { id: r.expense_id }));
        setPaying(false);
      }
      else if (action === 'cancel') { await cancelPayrollRun(run.id); toast(t('hr.runCancelled')); }
      await load(); onChanged();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  if (isNew) {
    return (
      <Modal title={t('hr.newPayrollRun')} onClose={onClose}>
        <form onSubmit={handleCreate}>
          <div className="modal-body">
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 14 }}>
              {t('hr.runInstructions')}
            </p>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('hr.periodStart')} *</label>
                <input type="date" required className="form-control"
                  value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('hr.periodEnd')} *</label>
                <input type="date" required className="form-control"
                  value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">{t('hr.notesField')}</label>
                <input className="form-control" placeholder={t('hr.notesPh')}
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t('hr.creating') : t('hr.createRun')}
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  if (loading) return <Modal title={t('hr.payrollRun')} onClose={onClose}><div className="modal-body"><LoadingSpinner /></div></Modal>;
  if (error || !run) return <Modal title={t('hr.payrollRun')} onClose={onClose}><div className="modal-body"><ErrorAlert message={error || t('hr.notFound')} onRetry={load} /></div></Modal>;

  const editable = run.status === 'Draft' && canEdit;
  return (
    <Modal
      title={`${t('hr.payrollHeader')} · ${fmtDate(run.period_start)} → ${fmtDate(run.period_end)}`}
      onClose={onClose} size="modal-lg">
      <div className="modal-body">

        {/* Header — status + totals */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <span className={`badge badge-${PAYROLL_BADGE[run.status] || 'gray'}`} style={{ fontSize: 13, padding: '4px 10px' }}>{payrollStatusLabel(run.status, t)}</span>
          {run.approved_by_name && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('hr.approvedBy')} {run.approved_by_name}</span>}
          {run.paid_at && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('hr.paidLabel')} {fmtDate(run.paid_at)}</span>}
          <div style={{ marginInlineStart: 'auto', fontSize: 18, fontWeight: 700 }}>{fmt(run.total_net || 0)}</div>
        </div>

        {/* Totals strip — full breakdown (gross / bonus / overtime / tax / NSSF / net) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 14 }}>
          <Field label={t('hr.colGross2')}      value={fmt(run.total_gross || 0)} />
          <Field label={t('hr.colBonuses2')}    value={fmt(run.total_bonuses || 0)} />
          <Field label={t('hr.colOvertime')}    value={fmt(run.total_overtime || 0)} />
          <Field label={t('hr.colTaxWithheld')} value={fmt(run.total_tax || 0)} />
          <Field label={t('hr.colNssfEmp')}     value={fmt(run.total_nssf_employee || 0)} />
          <Field label={t('hr.colNetToPay')}    value={<strong>{fmt(run.total_net || 0)}</strong>} />
        </div>
        {/* Employer-side cost — what payroll actually costs the company. */}
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14 }}>
          {t('hr.employerNssf')}: {fmt(run.total_nssf_employer || 0)} ·
          {' '}{t('hr.totalDeductionsLabel')}: {fmt(run.total_deductions || 0)}
        </div>

        {/* Per-employee lines */}
        <div className="table-wrap" style={{ marginBottom: 16, fontSize: 12 }}>
          <table>
            <thead>
              <tr>
                <th>{t('hr.colEmployee2')}</th>
                <th style={{ textAlign: 'right', width: 110 }}>{t('hr.colBaseOrHours')}</th>
                <th style={{ textAlign: 'right', width: 90  }}>{t('hr.colBonus')}</th>
                <th style={{ textAlign: 'right', width: 110 }}>{t('hr.colOtShort')}</th>
                <th style={{ textAlign: 'right', width: 90  }}>{t('hr.colDeductShort')}</th>
                <th style={{ textAlign: 'right', width: 80, color: 'var(--text-3)'  }}>{t('hr.colTaxShort')}</th>
                <th style={{ textAlign: 'right', width: 80, color: 'var(--text-3)'  }}>{t('hr.colNssfShort')}</th>
                <th style={{ textAlign: 'right', width: 110 }}>{t('hr.colNetShort')}</th>
              </tr>
            </thead>
            <tbody>
              {(run.lines || []).map(l => (
                <PayrollLineRow key={l.id} line={l} editable={editable}
                  onPatch={(patch) => patchLine(l, patch)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="modal-footer" style={{ gap: 8 }}>
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {run.status === 'Draft' && canApprove && (
          <button className="btn btn-primary" disabled={busy} onClick={() => doAction('approve')}>{t('hr.approveBtn')}</button>
        )}
        {run.status === 'Approved' && canApprove && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setPaying(true)}>{t('hr.markPaidAndPost')}</button>
        )}
        {run.status !== 'Paid' && run.status !== 'Cancelled' && canDelete && (
          <button className="btn btn-danger" disabled={busy} onClick={() => doAction('cancel')}>{t('hr.cancelRun')}</button>
        )}
      </div>

      {paying && (
        <PayoutModal
          title={t('hr.markPaidAndPost')}
          summary={t('hr.payoutSummary', { total: fmt(run.total_net) })}
          confirmLabel={t('hr.markPaidAndPost')}
          busy={busy}
          onConfirm={payout => doAction('pay', payout)}
          onClose={() => setPaying(false)} />
      )}
    </Modal>
  );
}

function PayrollLineRow({ line, editable, onPatch }) {
  const { t } = useLocale();
  // Zero → empty string so the field reads as a "0" placeholder, not a literal 0
  // the cashier has to clear before typing.
  const numStr = (v) => (v ? String(v) : '');
  const [base,    setBase]    = useState(numStr(line.base_salary));
  const [bonus,   setBonus]   = useState(numStr(line.bonuses));
  const [deduct,  setDeduct]  = useState(numStr(line.deductions));
  const [otHours, setOtHours] = useState(numStr(line.overtime_hours));
  const [otAmt,   setOtAmt]   = useState(numStr(line.overtime_amount));
  const [hours,   setHours]   = useState(numStr(line.hours_worked));
  const [dirty,   setDirty]   = useState(false);

  // An hourly employee's total is hours x rate, so the hours are what you edit
  // and the total is shown as the result. Sending base_salary for one of these
  // is refused by the API, precisely so the figure on the payslip can never
  // stop matching the hours printed beside it.
  const rate = Number(line.hourly_rate || 0);
  const isHourly = rate > 0 || Number(line.hours_worked || 0) > 0;

  // Re-sync from the server after an autosave (the panel refetches silently) —
  // e.g. overtime amount the API computed from hours. Runs only when the stored
  // values actually change, so it never interrupts typing.
  useEffect(() => {
    setBase(numStr(line.base_salary));
    setBonus(numStr(line.bonuses));
    setDeduct(numStr(line.deductions));
    setOtHours(numStr(line.overtime_hours));
    setOtAmt(numStr(line.overtime_amount));
    setHours(numStr(line.hours_worked));
    setDirty(false);
  }, [line.base_salary, line.bonuses, line.deductions, line.overtime_hours,
      line.overtime_amount, line.hours_worked]);

  const edit = (setter) => (e) => { setter(e.target.value); setDirty(true); };

  // Autosave-on-blur — but only when a field actually changed, so tabbing or
  // clicking through the row never triggers a needless recompute + refetch.
  function commit(patch = {}) {
    if (!dirty) return;
    onPatch({
      // base_salary is deliberately absent for an hourly line — the API
      // recomputes it from the hours and refuses an explicit total.
      ...(isHourly ? { hours_worked: Number(hours) || 0 }
                   : { base_salary:  Number(base)  || 0 }),
      bonuses:         Number(bonus)  || 0,
      deductions:      Number(deduct) || 0,
      overtime_hours:  Number(otHours) || 0,
      overtime_amount: Number(otAmt) || 0,
      ...patch,
    });
    setDirty(false);
  }
  return (
    <tr>
      <td className="td-primary" style={{ fontWeight: 600 }}>
        {line.employee_name}
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{line.job_title}{line.department_name ? ` · ${line.department_name}` : ''}</div>
      </td>
      <td>
        {isHourly ? (
          <>
            {editable
              ? <NumberInput step="0.25" min="0" placeholder="0" className="form-control"
                       style={{ textAlign: 'right', padding: '4px 6px' }}
                       value={hours} onChange={edit(setHours)} onBlur={() => commit()} />
              : <div style={{ textAlign: 'right' }}>{Number(line.hours_worked || 0)}h</div>}
            {/* The working, so the figure is never a bare number nobody can check. */}
            <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'right', marginTop: 2 }}>
              {t('hr.hoursAtRate', { rate: fmt(rate), total: fmt(line.base_salary || 0) })}
            </div>
          </>
        ) : (
          editable
            ? <NumberInput step="0.01" min="0" placeholder="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                     value={base} onChange={edit(setBase)} onBlur={() => commit()} />
            : <div style={{ textAlign: 'right' }}>{fmt(line.base_salary || 0)}</div>
        )}
      </td>
      <td>
        {editable
          ? <NumberInput step="0.01" min="0" placeholder="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                   value={bonus} onChange={edit(setBonus)} onBlur={() => commit()} />
          : <div style={{ textAlign: 'right' }}>{fmt(line.bonuses || 0)}</div>}
      </td>
      <td>
        {editable ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <NumberInput step="0.01" min="0" className="form-control"
                   style={{ textAlign: 'right', padding: '4px 6px', width: 50 }}
                   placeholder={t('hr.hoursPh')} value={otHours}
                   onChange={edit(setOtHours)} onBlur={() => commit({ overtime_amount: null })} />
            <NumberInput step="0.01" min="0" className="form-control"
                   style={{ textAlign: 'right', padding: '4px 6px', width: 60 }}
                   placeholder={t('hr.amountPh')} value={otAmt}
                   onChange={edit(setOtAmt)} onBlur={() => commit()} />
          </div>
        ) : (
          <div style={{ textAlign: 'right' }}>
            {fmt(line.overtime_amount || 0)}
            {line.overtime_hours > 0 && <span style={{ color: 'var(--text-3)', fontSize: 10 }}> ({line.overtime_hours}h)</span>}
          </div>
        )}
      </td>
      <td>
        {editable
          ? <NumberInput step="0.01" min="0" placeholder="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                   value={deduct} onChange={edit(setDeduct)} onBlur={() => commit()} />
          : <div style={{ textAlign: 'right' }}>{fmt(line.deductions || 0)}</div>}
      </td>
      <td style={{ textAlign: 'right', color: 'var(--text-3)' }}>{fmt(line.tax_amount || 0)}</td>
      <td style={{ textAlign: 'right', color: 'var(--text-3)' }}>{fmt(line.nssf_employee || 0)}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(line.net_amount || 0)}</td>
    </tr>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// CONTRACTS — embedded panel within EmployeeDetail
// ════════════════════════════════════════════════════════════════════════════
const CONTRACT_BADGE = { Draft: 'gray', Active: 'green', Expired: 'yellow', Terminated: 'red' };

export { PayrollRunPanel };
