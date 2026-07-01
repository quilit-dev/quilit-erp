import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, fmt, fmtDate, toast } from '../../components/shared';
import { getEmployee, uploadEmployeeFile, deleteEmployeeFile, employeeFileURL } from '../../api/client';
import { EMP_STATUS_BADGE, LEAVE_STATUS_BADGE, PAYROLL_BADGE, CHANGE_BADGE,
         changeLabel, empStatusLabel, leaveStatusLabel, payrollStatusLabel } from './constants';
import { ContractsSection } from './ContractsSection';

function EmployeeDetail({ empId, canEdit, onClose, onEdit, onChanged }) {
  const { t } = useLocale();
  const [emp,     setEmp]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [uploading, setUploading] = useState(null);   // 'cv' | 'contract' | 'other' | null
  const cvInputRef       = useRef(null);
  const contractInputRef = useRef(null);
  const otherInputRef    = useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setEmp(await getEmployee(empId)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [empId]);
  useEffect(() => { load(); }, [load]);

  async function handleUpload(kind, file) {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      toast(t('hr.onlyPdfAccepted'), 'error'); return;
    }
    setUploading(kind);
    try {
      await uploadEmployeeFile(empId, kind, file);
      toast(
        kind === 'cv'       ? t('hr.cvUploaded') :
        kind === 'contract' ? t('hr.contractUploaded') :
                              t('hr.fileUploaded'),
      );
      await load();
    } catch (err) {
      toast(err.message || t('hr.uploadFailed'), 'error');
    } finally {
      setUploading(null);
    }
  }

  async function handleDeleteFile(fileId) {
    try { await deleteEmployeeFile(fileId); toast(t('hr.fileDeleted')); await load(); }
    catch (err) { toast(err.message || t('hr.couldNotDelete'), 'error'); }
  }

  if (loading) {
    return <Modal title={t('hr.employeeDetails')} onClose={onClose} size="modal-lg"><div className="modal-body"><LoadingSpinner /></div></Modal>;
  }
  if (error || !emp) {
    return <Modal title={t('hr.employeeDetails')} onClose={onClose} size="modal-lg"><div className="modal-body"><ErrorAlert message={error || t('hr.notFound')} onRetry={load} /></div></Modal>;
  }

  const cv       = (emp.files || []).find(f => f.kind === 'cv');
  const contract = (emp.files || []).find(f => f.kind === 'contract');
  const others   = (emp.files || []).filter(f => f.kind === 'other');

  return (
    <Modal title={`${emp.full_name} — ${emp.employee_code || ''}`} onClose={onClose} size="modal-lg">
      <div className="modal-body">

        {/* ── Profile summary ───────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
          <Field label={t('hr.fldJobTitleShort')}    value={emp.job_title || '—'} />
          <Field label={t('hr.fldDepartment')}       value={emp.department_name || '—'} />
          <Field label={t('hr.fldManager')}          value={emp.manager_name || '—'} />
          <Field label={t('hr.fldStatus')}           value={<span className={`badge badge-${EMP_STATUS_BADGE[emp.status] || 'gray'}`}>{empStatusLabel(emp.status, t)}</span>} />
          <Field label={t('hr.fldType')}             value={emp.employment_type} />
          <Field label={t('hr.fldCurrentSalary')}    value={fmt(emp.salary || 0)} />
          <Field label={t('hr.fldHireDateShort')}    value={emp.hire_date ? fmtDate(emp.hire_date) : '—'} />
          <Field label={t('hr.fldEmail')}            value={emp.email || '—'} />
          <Field label={t('hr.fldPhone')}            value={emp.phone || '—'} />
        </div>

        {/* ── Files (CV / Contract / Other) ─────────────────────────────── */}
        <Section title={t('hr.documents')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FileSlot
              label={t('hr.cvResume')} file={cv} canEdit={canEdit} uploading={uploading === 'cv'}
              onPick={() => cvInputRef.current?.click()}
              onDelete={() => handleDeleteFile(cv.id)} />
            <FileSlot
              label={t('hr.employmentContract')} file={contract} canEdit={canEdit} uploading={uploading === 'contract'}
              onPick={() => contractInputRef.current?.click()}
              onDelete={() => handleDeleteFile(contract.id)} />
          </div>
          {canEdit && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-sm btn-secondary"
                onClick={() => otherInputRef.current?.click()}
                disabled={uploading === 'other'}>
                {t('hr.uploadOtherDoc')}
              </button>
            </div>
          )}
          {others.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {others.map(f => (
                <div key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{f.filename}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {(f.size_bytes / 1024).toFixed(0)} KB · {fmtDate(f.created_at)}
                  </span>
                  <a className="btn btn-sm btn-secondary" href={employeeFileURL(f.id)} target="_blank" rel="noopener noreferrer">{t('hr.view')}</a>
                  {canEdit && <button className="btn btn-sm btn-danger" onClick={() => handleDeleteFile(f.id)}>{t('hr.delete')}</button>}
                </div>
              ))}
            </div>
          )}
          {/* Hidden file inputs — PDFs only */}
          <input ref={cvInputRef}       type="file" accept="application/pdf" style={{ display: 'none' }}
                 onChange={e => { handleUpload('cv',       e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={contractInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
                 onChange={e => { handleUpload('contract', e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={otherInputRef}    type="file" accept="application/pdf" style={{ display: 'none' }}
                 onChange={e => { handleUpload('other',    e.target.files?.[0]); e.target.value = ''; }} />
        </Section>

        {/* ── Salary / role timeline ───────────────────────────────────── */}
        <Section title={t('hr.employmentHistory')}>
          {(emp.history || []).length === 0 ? (
            <EmptyState message={t('hr.noHistory')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {emp.history.map(h => (
                <div key={h.id} style={{
                  display: 'flex', gap: 12, padding: '10px 12px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  borderInlineStart: `3px solid var(--${CHANGE_BADGE[h.change_type] || 'border'})`,
                  background: 'var(--surface)',
                }}>
                  <div style={{ minWidth: 96, fontSize: 12, color: 'var(--text-3)' }}>{fmtDate(h.effective_date)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ marginBottom: 4 }}>
                      <span className={`badge badge-${CHANGE_BADGE[h.change_type] || 'gray'}`}>{changeLabel(h.change_type, t)}</span>
                      {h.reason && <span style={{ marginInlineStart: 8, fontSize: 12, color: 'var(--text-2)' }}>{h.reason}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                      {(h.old_salary != null || h.new_salary != null) &&
                        (Number(h.old_salary || 0) !== Number(h.new_salary || 0)) && (
                          <span>{t('hr.historySalary')}: <strong>{fmt(h.old_salary || 0)} → {fmt(h.new_salary || 0)}</strong></span>
                        )}
                      {h.new_title !== h.old_title && (
                        <span>{t('hr.historyTitle')}: <strong>{h.old_title || '—'} → {h.new_title || '—'}</strong></span>
                      )}
                      {h.new_department_id !== h.old_department_id && (
                        <span>{t('hr.historyDepartment')}: <strong>{h.old_department_name || '—'} → {h.new_department_name || '—'}</strong></span>
                      )}
                      {h.new_manager_id !== h.old_manager_id && (
                        <span>{t('hr.historyManager')}: <strong>{h.old_manager_name || '—'} → {h.new_manager_name || '—'}</strong></span>
                      )}
                    </div>
                  </div>
                  {h.created_by_name && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('hr.historyBy')} {h.created_by_name}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Contracts ────────────────────────────────────────────────── */}
        <ContractsSection empId={empId} canEdit={canEdit} />

        {/* ── Payroll history ──────────────────────────────────────────── */}
        <Section title={t('hr.payrollHistory')}>
          {(emp.payroll_history || []).length === 0 ? (
            <EmptyState message={t('hr.noPayrollLines')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('hr.colPeriod')}</th>
                    <th>{t('common.status')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colBase')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colBonus')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colDeductions')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colNet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {emp.payroll_history.map(p => (
                    <tr key={p.id}>
                      <td>{fmtDate(p.period_start)} → {fmtDate(p.period_end)}</td>
                      <td><span className={`badge badge-${PAYROLL_BADGE[p.status] || 'gray'}`}>{payrollStatusLabel(p.status, t)}</span></td>
                      <td style={{ textAlign: 'right' }}>{fmt(p.base_salary)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(p.bonuses)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(p.deductions)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(p.net_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ── Leave history ────────────────────────────────────────────── */}
        <Section title={t('hr.leaveHistory')}>
          {(emp.leave_history || []).length === 0 ? (
            <EmptyState message={t('hr.noLeaveOnRecord')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('hr.colType')}</th><th>{t('hr.colPeriod')}</th><th>{t('hr.colDays')}</th><th>{t('common.status')}</th><th>{t('hr.fldReason')}</th></tr></thead>
                <tbody>
                  {emp.leave_history.map(l => (
                    <tr key={l.id}>
                      <td>{l.leave_type}</td>
                      <td>{fmtDate(l.start_date)} → {fmtDate(l.end_date)}</td>
                      <td>{l.days}</td>
                      <td><span className={`badge badge-${LEAVE_STATUS_BADGE[l.status] || 'gray'}`}>{leaveStatusLabel(l.status, t)}</span></td>
                      <td style={{ color: 'var(--text-3)' }}>{l.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => onEdit(emp)}>{t('hr.editProfile')}</button>
        )}
      </div>
    </Modal>
  );
}

// ── Small layout primitives used by EmployeeDetail ──────────────────────────
function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}
function Section({ title, right, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 10 }}>
        <h4 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px',
                     color: 'var(--text-3)', margin: 0 }}>{title}</h4>
        {right}
      </div>
      {children}
    </div>
  );
}
function FileSlot({ label, file, canEdit, uploading, onPick, onDelete }) {
  const { t } = useLocale();
  return (
    <div style={{
      padding: '12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
      background: file ? 'var(--surface)' : 'transparent',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{label}</div>
      {file ? (
        <>
          <div style={{ fontSize: 13, marginBottom: 4 }}>{file.filename}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
            {(file.size_bytes / 1024).toFixed(0)} KB · {fmtDate(file.created_at)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <a className="btn btn-sm btn-primary" href={employeeFileURL(file.id)} target="_blank" rel="noopener noreferrer">{t('hr.view')}</a>
            {canEdit && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={onPick} disabled={uploading}>{t('hr.replace')}</button>
                <button className="btn btn-sm btn-danger" onClick={onDelete}>{t('hr.delete')}</button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>{t('hr.noFileUploaded')}</div>
          {canEdit && (
            <button className="btn btn-sm btn-primary" onClick={onPick} disabled={uploading}>
              {uploading ? t('hr.uploading') : t('hr.uploadPdf')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export { EmployeeDetail };
