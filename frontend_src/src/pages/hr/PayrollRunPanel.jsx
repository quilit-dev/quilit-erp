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
        {/* The components the run derived from each person and the month.
            Shown only when any of them is non-zero, so a tenant that has not
            set any of this up keeps the strip it had. */}
        {(run.total_transport_allowance || run.total_attendance_bonus || run.total_late_deduction
          || run.total_insurance_employee || run.total_advance_recovery) ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
            <Field label={t('hr.colTransport')}       value={fmt(run.total_transport_allowance || 0)} />
            <Field label={t('hr.colAttendanceBonus')} value={fmt(run.total_attendance_bonus || 0)} />
            <Field label={t('hr.colLateDeduction')}   value={fmt(run.total_late_deduction || 0)} />
            <Field label={t('hr.colInsuranceEmp')}    value={fmt(run.total_insurance_employee || 0)} />
            <Field label={t('hr.colAdvances')}        value={fmt(run.total_advance_recovery || 0)} />
          </div>
        ) : null}
        {/* Employer-side cost — what payroll actually costs the company. */}
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14 }}>
          {t('hr.employerNssf')}: {fmt(run.total_nssf_employer || 0)} ·
          {' '}{t('hr.totalDeductionsLabel')}: {fmt(run.total_deductions || 0)}
          {run.total_insurance_employer > 0 && (
            <> · {t('hr.employerInsurance')}: {fmt(run.total_insurance_employer)}</>
          )}
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
                {/* Derived from the month and the person. Stacked so the
                    table does not grow a column per figure. */}
                <th style={{ textAlign: 'right', width: 90  }}>{t('hr.colAttendanceShort')}</th>
                <th style={{ textAlign: 'right', width: 100 }}>{t('hr.colAllowancesShort')}</th>
                <th style={{ textAlign: 'right', width: 100 }}>{t('hr.colOtherDedShort')}</th>
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
  // The derived components. Seeded by the run; a manager may correct any of
  // them here, the way bonus and deduction have always been correctable.
  const [attDays, setAttDays] = useState(numStr(line.attended_days));
  const [lateDays, setLateDays] = useState(numStr(line.late_days));
  const [transport, setTransport] = useState(numStr(line.transport_allowance));
  const [attBonus, setAttBonus] = useState(numStr(line.attendance_bonus));
  const [lateDed, setLateDed] = useState(numStr(line.late_deduction));
  const [insEmp, setInsEmp]   = useState(numStr(line.insurance_employee));
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
    setAttDays(numStr(line.attended_days));
    setLateDays(numStr(line.late_days));
    setTransport(numStr(line.transport_allowance));
    setAttBonus(numStr(line.attendance_bonus));
    setLateDed(numStr(line.late_deduction));
    setInsEmp(numStr(line.insurance_employee));
    setDirty(false);
  }, [line.base_salary, line.bonuses, line.deductions, line.overtime_hours,
      line.overtime_amount, line.hours_worked, line.attended_days, line.late_days,
      line.transport_allowance, line.attendance_bonus, line.late_deduction,
      line.insurance_employee]);

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
      attended_days:       Number(attDays) || 0,
      late_days:           Number(lateDays) || 0,
      transport_allowance: Number(transport) || 0,
      attendance_bonus:    Number(attBonus) || 0,
      late_deduction:      Number(lateDed) || 0,
      insurance_employee:  Number(insEmp) || 0,
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
      {/* Attendance: days attended and days late, as the clock (or the
          manager) recorded them. */}
      <td style={{ textAlign: 'right', fontSize: 11 }}>
        {editable ? (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <NumberInput step="1" min="0" className="form-control" title={t('hr.colAttended')}
                   style={{ textAlign: 'right', padding: '4px 6px', width: 40 }}
                   value={attDays} onChange={edit(setAttDays)} onBlur={() => commit()} />
            <NumberInput step="1" min="0" className="form-control" title={t('hr.colLate')}
                   style={{ textAlign: 'right', padding: '4px 6px', width: 40 }}
                   value={lateDays} onChange={edit(setLateDays)} onBlur={() => commit()} />
          </div>
        ) : (
          <div>{line.attended_days || 0}{t('hr.daysSuffix')}
            {line.late_days > 0 && <span style={{ color: 'var(--caution-ink)' }}> · {line.late_days} {t('hr.lateSuffix')}</span>}
          </div>
        )}
      </td>
      {/* Allowances: transport, then the attendance bonus. */}
      <td style={{ textAlign: 'right', fontSize: 11 }}>
        {editable ? (
          <div style={{ display: 'grid', gap: 3 }}>
            <NumberInput step="0.01" min="0" className="form-control" title={t('hr.colTransport')}
                   style={{ textAlign: 'right', padding: '4px 6px' }} placeholder={t('hr.colTransport')}
                   value={transport} onChange={edit(setTransport)} onBlur={() => commit()} />
            <NumberInput step="0.01" min="0" className="form-control" title={t('hr.colAttendanceBonus')}
                   style={{ textAlign: 'right', padding: '4px 6px' }} placeholder={t('hr.colAttendanceBonus')}
                   value={attBonus} onChange={edit(setAttBonus)} onBlur={() => commit()} />
          </div>
        ) : (
          <div>
            <div>{fmt(line.transport_allowance || 0)}</div>
            <div style={{ color: 'var(--text-3)' }}>{fmt(line.attendance_bonus || 0)}</div>
          </div>
        )}
      </td>
      {/* Other deductions: late, insurance, and the advance being recovered.
          The advance is not editable here --- what is recovered is what is
          owed; to change it, void the advance. */}
      <td style={{ textAlign: 'right', fontSize: 11 }}>
        {editable ? (
          <div style={{ display: 'grid', gap: 3 }}>
            <NumberInput step="0.01" min="0" className="form-control" title={t('hr.colLateDeduction')}
                   style={{ textAlign: 'right', padding: '4px 6px' }} placeholder={t('hr.colLateDeduction')}
                   value={lateDed} onChange={edit(setLateDed)} onBlur={() => commit()} />
            <NumberInput step="0.01" min="0" className="form-control" title={t('hr.colInsuranceEmp')}
                   style={{ textAlign: 'right', padding: '4px 6px' }} placeholder={t('hr.colInsuranceEmp')}
                   value={insEmp} onChange={edit(setInsEmp)} onBlur={() => commit()} />
            {line.advance_recovery > 0 && (
              <div style={{ color: 'var(--text-3)' }} title={t('hr.colAdvances')}>
                {t('hr.advanceShort')} {fmt(line.advance_recovery)}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div>{fmt(line.late_deduction || 0)}</div>
            <div style={{ color: 'var(--text-3)' }}>{fmt(line.insurance_employee || 0)}</div>
            {line.advance_recovery > 0 && <div style={{ color: 'var(--text-3)' }}>{t('hr.advanceShort')} {fmt(line.advance_recovery)}</div>}
          </div>
        )}
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
