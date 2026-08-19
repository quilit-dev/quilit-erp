import { useState, useCallback, useEffect, useRef } from 'react';
import { useData } from '../hooks/useData';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, NumberInput, BranchField} from '../components/shared';
import {
  getHRSummary,
  getDepartments, createDepartment, updateDepartment, archiveDepartment, unarchiveDepartment,
  getEmployees, getEmployee, createEmployee, updateEmployee, archiveEmployee, unarchiveEmployee,
  getLeaveRequests, createLeaveRequest, approveLeave, rejectLeave, deleteLeaveRequest,
  uploadEmployeeFile, deleteEmployeeFile, employeeFileURL,
  getPayrollRuns, getPayrollRun, createPayrollRun, updatePayrollLine,
  approvePayrollRun, markPayrollRunPaid, cancelPayrollRun,
  getContracts, createContract, updateContract, setContractStatus,
  archiveContract, getContractPrintData,
  getAttendance, saveAttendanceBulk, getAttendanceSummary,
} from '../api/client';
import ImportWizard from '../components/ImportWizard';

// Section & modal components extracted into ./hr/ — HR.jsx is the orchestrator
// (tabs + shared state); each logical section lives in its own file.
import { EmployeeDetail } from './hr/EmployeeDetail';
import { PayrollRunPanel } from './hr/PayrollRunPanel';
import { AttendanceTab } from './hr/AttendanceTab';
import {
  EMPLOYMENT_TYPES, EMPLOYEE_STATUS, LEAVE_TYPES,
  EMP_STATUS_BADGE, LEAVE_STATUS_BADGE, PAYROLL_BADGE, CHANGE_BADGE, CHANGE_TYPES,
  EMPTY_EMPLOYEE, EMPTY_DEPT, EMPTY_LEAVE, PAY_TYPES,
  changeLabel, empStatusLabel, leaveStatusLabel, payrollStatusLabel,
} from './hr/constants';
// ── KPI card — matches the canonical pattern used across the rest of the
//    app (Manufacturing, Fixed Assets, Recurring Expenses, ...): default
//    `stat-card` surface, muted label, value coloured by the accent. The
//    older tinted-background variant has been retired so every module
//    presents KPIs with the same visual weight. ───────────────────────────
function Kpi({ label, value, color = 'var(--text)' }) {
  return (
    <div className="stat-card" style={{ padding: '14px 18px' }}>
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function HR() {
  const { t, tEnumValue } = useLocale();
  const { can } = usePermissions();

  const [tab, setTab] = useState('employees');
  const [showArchived, setShowArchived] = useState(false);

  const { data: summary,     reload: reloadSummary }                   = useData(getHRSummary);
  const { data: departments, reload: reloadDepts }                     = useData(
    useCallback(() => getDepartments(showArchived ? { include_archived: 1 } : {}), [showArchived]), [showArchived]);
  const { data: employees, loading, error, reload: reloadEmps }        = useData(
    useCallback(() => getEmployees(showArchived ? { include_archived: 1 } : {}), [showArchived]), [showArchived]);
  const { data: leave,       reload: reloadLeave }                     = useData(useCallback(() => getLeaveRequests(), []));
  const { data: payrollRuns, reload: reloadPayroll }                   = useData(useCallback(() => getPayrollRuns(), []));

  const reloadAll = useCallback(() => {
    reloadSummary(); reloadDepts(); reloadEmps(); reloadLeave(); reloadPayroll();
  }, [reloadSummary, reloadDepts, reloadEmps, reloadLeave, reloadPayroll]);

  const depts   = Array.isArray(departments) ? departments : [];
  const emps    = Array.isArray(employees)   ? employees   : [];
  const leaves  = Array.isArray(leave)       ? leave       : [];
  const runs    = Array.isArray(payrollRuns) ? payrollRuns : [];

  // Detail panel — clicking an employee opens a full-profile view with the
  // salary timeline, files (CV/contract), payroll history and leave history.
  const [detailId, setDetailId] = useState(null);

  // Payroll run drill-down: ID of the run being inspected (or null).
  const [runId, setRunId] = useState(null);

  // ── Modals state ──────────────────────────────────────────────────────────
  const [importing,  setImporting]  = useState(false);
  const [empModal,   setEmpModal]   = useState(false);
  const [empForm,    setEmpForm]    = useState(EMPTY_EMPLOYEE);
  const [empEditId,  setEmpEditId]  = useState(null);
  const [deptModal,  setDeptModal]  = useState(false);
  const [deptForm,   setDeptForm]   = useState(EMPTY_DEPT);
  const [deptEditId, setDeptEditId] = useState(null);
  const [leaveModal, setLeaveModal] = useState(false);
  const [leaveForm,  setLeaveForm]  = useState(EMPTY_LEAVE);
  const [saving,     setSaving]     = useState(false);
  const [confirm,    setConfirm]    = useState(null);   // { kind, id, label }

  const canCreate  = can('hr', 'create');
  const canEdit    = can('hr', 'edit');
  const canDelete  = can('hr', 'delete');
  const canApprove = can('hr', 'approve');

  // ── Employee actions ──────────────────────────────────────────────────────
  function openEmpCreate() { setEmpForm(EMPTY_EMPLOYEE); setEmpEditId(null); setEmpModal(true); }
  function openEmpEdit(e) {
    setEmpForm({
      ...EMPTY_EMPLOYEE, ...e,
      department_id: e.department_id ?? '',
      manager_id:    e.manager_id ?? '',
      hire_date:     e.hire_date || '',
      end_date:      e.end_date || '',
      salary:        e.salary ?? 0,
      pay_type:      e.pay_type || 'Salaried',
      hourly_rate:   e.hourly_rate ?? 0,
    });
    setEmpEditId(e.id);
    setEmpModal(true);
  }
  async function saveEmployee(ev) {
    ev.preventDefault();
    if (!empForm.full_name.trim()) { toast('Employee name is required', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...empForm,
        full_name:     empForm.full_name.trim(),
        department_id: empForm.department_id ? Number(empForm.department_id) : null,
        manager_id:    empForm.manager_id ? Number(empForm.manager_id) : null,
        salary:        Number(empForm.salary) || 0,
        hourly_rate:   Number(empForm.hourly_rate) || 0,
        hire_date:     empForm.hire_date || null,
        end_date:      empForm.end_date || null,
        branch_id:     empForm.branch_id || null,
        // Only send the change_type when the user picked one explicitly —
        // empty / unknown is treated by the backend as "auto-detect".
        change_type:   empForm.change_type || null,
        change_reason: (empForm.change_reason || '').trim() || null,
      };
      if (empEditId) { await updateEmployee(empEditId, payload); toast('Employee updated'); }
      else           { await createEmployee(payload);           toast('Employee added'); }
      setEmpModal(false); reloadAll();
    } catch (err) { toast(err.message || 'Could not save employee', 'error'); }
    finally { setSaving(false); }
  }

  // ── Department actions ────────────────────────────────────────────────────
  function openDeptCreate() { setDeptForm(EMPTY_DEPT); setDeptEditId(null); setDeptModal(true); }
  function openDeptEdit(d)  { setDeptForm({ name: d.name, description: d.description || '' }); setDeptEditId(d.id); setDeptModal(true); }
  async function saveDepartment(ev) {
    ev.preventDefault();
    if (!deptForm.name.trim()) { toast('Department name is required', 'error'); return; }
    setSaving(true);
    try {
      const payload = { name: deptForm.name.trim(), description: deptForm.description?.trim() || null };
      if (deptEditId) { await updateDepartment(deptEditId, payload); toast('Department updated'); }
      else            { await createDepartment(payload);            toast('Department created'); }
      setDeptModal(false); reloadDepts(); reloadSummary();
    } catch (err) { toast(err.message || 'Could not save department', 'error'); }
    finally { setSaving(false); }
  }

  // ── Leave actions ─────────────────────────────────────────────────────────
  function openLeaveCreate() { setLeaveForm(EMPTY_LEAVE); setLeaveModal(true); }
  async function saveLeave(ev) {
    ev.preventDefault();
    if (!leaveForm.employee_id) { toast('Select an employee', 'error'); return; }
    if (!leaveForm.start_date || !leaveForm.end_date) { toast('Start and end dates are required', 'error'); return; }
    setSaving(true);
    try {
      await createLeaveRequest({ ...leaveForm, employee_id: Number(leaveForm.employee_id) });
      toast('Leave request submitted');
      setLeaveModal(false); reloadLeave(); reloadSummary();
    } catch (err) { toast(err.message || 'Could not submit leave request', 'error'); }
    finally { setSaving(false); }
  }
  async function reviewLeave(id, decision) {
    try {
      if (decision === 'approve') await approveLeave(id);
      else                        await rejectLeave(id);
      toast(decision === 'approve' ? 'Leave approved' : 'Leave rejected');
      reloadLeave(); reloadSummary(); reloadEmps();
    } catch (err) { toast(err.message || 'Action failed', 'error'); }
  }

  // ── Confirm (archive / delete) ────────────────────────────────────────────
  async function runConfirm() {
    if (!confirm) return;
    try {
      if (confirm.kind === 'employee')   { await archiveEmployee(confirm.id);   toast(t('hr.employeeArchived')); }
      if (confirm.kind === 'department') { await archiveDepartment(confirm.id); toast(t('hr.departmentArchived')); }
      if (confirm.kind === 'restore-employee')   { await unarchiveEmployee(confirm.id);   toast(t('hr.employeeRestored')); }
      if (confirm.kind === 'restore-department') { await unarchiveDepartment(confirm.id); toast(t('hr.departmentRestored')); }
      if (confirm.kind === 'leave')      { await deleteLeaveRequest(confirm.id); toast('Leave request removed'); }
      setConfirm(null); reloadAll();
    } catch (err) { toast(err.message || 'Action failed', 'error'); setConfirm(null); }
  }

  const s = summary || {};
  const TABS = [
    { key: 'employees',   label: t('hr.tabEmployees'),   count: emps.length },
    { key: 'payroll',     label: t('hr.tabPayroll'),     count: runs.length },
    { key: 'departments', label: t('hr.tabDepartments'), count: depts.length },
    { key: 'leave',       label: t('hr.tabLeave'),       count: leaves.length },
    { key: 'attendance',  label: t('hr.tabAttendance'),  count: emps.length },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('hr.title')}</h1>
          <p className="page-subtitle">{t('hr.subtitle')}</p>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 20 }}>
        <Kpi label={t('hr.kpiTotal')}   value={s.total_employees ?? 0} />
        <Kpi label={t('hr.kpiActive')}  value={s.active ?? 0}          color="var(--green)" />
        <Kpi label={t('hr.kpiOnLeave')} value={s.on_leave ?? 0}        color="var(--yellow)" />
        <Kpi label={t('hr.kpiDepts')}   value={s.departments ?? 0}     color="var(--accent)" />
        <Kpi label={t('hr.kpiPending')} value={s.pending_leave ?? 0}
             color={s.pending_leave > 0 ? 'var(--red)' : 'var(--text-3)'} />
        <Kpi label={t('hr.kpiYtdPayroll')} value={fmt(s.ytd_payroll || 0)} color="var(--accent)" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {TABS.map(tb => (
            <button key={tb.key}
              className={`tab-btn${tab === tb.key ? ' active' : ''}`}
              onClick={() => setTab(tb.key)}>
              {tb.label} <span style={{ opacity: 0.6 }}>({tb.count})</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {/* Export is contextual to the active tab — each list dumps to its own sheet */}
          {tab === 'employees' && emps.length > 0 && (
            <ExportButton
              data={emps.map(e => ({
                Code: e.employee_code || '', Name: e.full_name, Job_Title: e.job_title || '',
                Department: e.department_name || '', Manager: e.manager_name || '',
                Employment_Type: e.employment_type || '', Status: e.status || '',
                Salary: e.salary ?? 0,
                Email: e.email || '', Phone: e.phone || '',
                Hired: e.hire_date || '', End_Date: e.end_date || '',
              }))}
              filename="Employees" sheetName="Employees" />
          )}
          {tab === 'leave' && leaves.length > 0 && (
            <ExportButton
              data={leaves.map(l => ({
                Employee: l.employee_name, Type: l.leave_type || '',
                From: l.start_date, To: l.end_date,
                Days: l.days || '', Status: l.status,
                Reason: l.reason || '',
                Requested: fmtDate(l.created_at),
              }))}
              filename="Leave_Requests" sheetName="Leave" />
          )}
          {(tab === 'employees' || tab === 'departments') && (
            <label className="archived-toggle">
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} />
              {t('common.showArchived')}
            </label>
          )}
          {tab === 'employees' && canCreate && (
            <button className="btn btn-secondary" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>
          )}
          {tab === 'employees' && canCreate && (
            <button className="btn btn-primary" onClick={openEmpCreate}>{t('hr.addEmployee')}</button>
          )}
          {tab === 'departments' && canCreate && (
            <button className="btn btn-primary" onClick={openDeptCreate}>{t('hr.addDepartment')}</button>
          )}
          {tab === 'leave' && canCreate && (
            <button className="btn btn-primary" onClick={openLeaveCreate}>{t('hr.requestLeave')}</button>
          )}
          {tab === 'payroll' && canCreate && (
            <button className="btn btn-primary" onClick={() => setRunId('new')}>{t('hr.newPayrollRun')}</button>
          )}
        </div>
      </div>

      {/* ── Employees tab ──────────────────────────────────────────────────── */}
      {tab === 'employees' && (
        <div className="card" style={{ padding: 0 }}>
          {loading ? <LoadingSpinner /> : error ? <ErrorAlert message={error} onRetry={reloadEmps} /> :
           emps.length === 0 ? <EmptyState message={t('hr.noEmployees')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('hr.colCode')}</th>
                    <th>{t('common.name')}</th>
                    <th>{t('hr.colJobTitle')}</th>
                    <th>{t('hr.colDepartment')}</th>
                    <th>{t('hr.colType')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {emps.map(e => {
                    const isArchived = !!e.archived_at;
                    return (
                    <tr key={e.id} className={isArchived ? 'row-archived' : undefined} style={{ cursor: 'pointer' }} onClick={() => setDetailId(e.id)}>
                      <td className="text-mono">{e.employee_code || '—'}</td>
                      <td className="td-primary" style={{ fontWeight: 600 }}>
                        <span style={{ color: 'var(--accent)' }}>{e.full_name}</span>
                        {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                      </td>
                      <td>{e.job_title || '—'}</td>
                      <td>{e.department_name || '—'}</td>
                      <td>{e.employment_type}</td>
                      <td><span className={`badge badge-${EMP_STATUS_BADGE[e.status] || 'gray'}`}>{empStatusLabel(e.status, t)}</span></td>
                      <td onClick={ev => ev.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {isArchived ? (
                            canEdit && <button className="btn btn-sm btn-secondary" style={{ color: '#166534', whiteSpace: 'nowrap' }}
                              onClick={() => setConfirm({ kind: 'restore-employee', id: e.id, label: e.full_name })}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                          ) : (
                            <>
                              {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => openEmpEdit(e)}>{t('common.edit')}</button>}
                              {canDelete && <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ kind: 'employee', id: e.id, label: e.full_name })}>{t('common.archive')}</button>}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Departments tab ────────────────────────────────────────────────── */}
      {tab === 'departments' && (
        <div className="card" style={{ padding: 0 }}>
          {depts.length === 0 ? <EmptyState message={t('hr.noDepartments')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.name')}</th>
                    <th>{t('hr.colDescription')}</th>
                    <th>{t('hr.colHeadcount')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {depts.map(d => {
                    const isArchived = !!d.archived_at;
                    return (
                    <tr key={d.id} className={isArchived ? 'row-archived' : undefined}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>
                        {d.name}
                        {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                      </td>
                      <td>{d.description || '—'}</td>
                      <td>{d.employee_count ?? 0}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {isArchived ? (
                            canEdit && <button className="btn btn-sm btn-secondary" style={{ color: '#166534', whiteSpace: 'nowrap' }}
                              onClick={() => setConfirm({ kind: 'restore-department', id: d.id, label: d.name })}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                          ) : (
                            <>
                              {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => openDeptEdit(d)}>{t('common.edit')}</button>}
                              {canDelete && <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ kind: 'department', id: d.id, label: d.name })}>{t('common.archive')}</button>}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Payroll tab ────────────────────────────────────────────────────── */}
      {tab === 'payroll' && (
        <div className="card" style={{ padding: 0 }}>
          {runs.length === 0 ? (
            <EmptyState message={t('hr.noPayrollRuns')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('hr.colPeriod')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('hr.colHeadcountShort')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colGross')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colBonuses')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colDeductions')}</th>
                    <th style={{ textAlign: 'right' }}>{t('hr.colNet')}</th>
                    <th>{t('hr.colPaid')}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setRunId(r.id)}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>
                        <span style={{ color: 'var(--accent)' }}>
                          {fmtDate(r.period_start)} → {fmtDate(r.period_end)}
                        </span>
                      </td>
                      <td><span className={`badge badge-${PAYROLL_BADGE[r.status] || 'gray'}`}>{payrollStatusLabel(r.status, t)}</span></td>
                      <td>{r.line_count ?? 0}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.total_gross || 0)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.total_bonuses || 0)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.total_deductions || 0)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.total_net || 0)}</td>
                      <td>{r.paid_at ? fmtDate(r.paid_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Leave tab ──────────────────────────────────────────────────────── */}
      {tab === 'leave' && (
        <div className="card" style={{ padding: 0 }}>
          {leaves.length === 0 ? <EmptyState message={t('hr.noLeave')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('hr.colEmployee')}</th>
                    <th>{t('hr.colLeaveType')}</th>
                    <th>{t('hr.colPeriod')}</th>
                    <th>{t('hr.colDays')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('hr.colReviewer')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {leaves.map(l => (
                    <tr key={l.id}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>
                        {l.employee_name}
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{l.employee_code}</div>
                      </td>
                      <td>{l.leave_type}</td>
                      <td>{fmtDate(l.start_date)} → {fmtDate(l.end_date)}</td>
                      <td>{l.days}</td>
                      <td><span className={`badge badge-${LEAVE_STATUS_BADGE[l.status] || 'gray'}`}>{leaveStatusLabel(l.status, t)}</span></td>
                      <td>{l.reviewer_name || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {l.status === 'Pending' && canApprove && <>
                            <button className="btn btn-sm btn-primary" onClick={() => reviewLeave(l.id, 'approve')}>{t('hr.approve')}</button>
                            <button className="btn btn-sm btn-danger"  onClick={() => reviewLeave(l.id, 'reject')}>{t('hr.reject')}</button>
                          </>}
                          {l.status === 'Pending' && canDelete && (
                            <button className="btn btn-sm btn-secondary" onClick={() => setConfirm({ kind: 'leave', id: l.id, label: l.employee_name })}>{t('common.delete')}</button>
                          )}
                          {l.status !== 'Pending' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'attendance' && (
        <AttendanceTab t={t} canEdit={canEdit} />
      )}

      {importing && (
        <ImportWizard entity="employees" title={`${t('imports.importBtn')} — ${t('hr.tabEmployees')}`}
          onClose={() => setImporting(false)} onDone={reloadAll} />
      )}

      {/* ── Employee modal ─────────────────────────────────────────────────── */}
      {empModal && (
        <Modal title={empEditId ? t('hr.editEmployee') : t('hr.addEmployee')} onClose={() => setEmpModal(false)} size="modal-lg">
          <form onSubmit={saveEmployee}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">{t('hr.fldFullName')} *</label>
                  <input className="form-control" required value={empForm.full_name}
                    onChange={e => setEmpForm(f => ({ ...f, full_name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldJobTitle')}</label>
                  <input className="form-control" value={empForm.job_title}
                    onChange={e => setEmpForm(f => ({ ...f, job_title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.colDepartment')}</label>
                  <select className="form-control" value={empForm.department_id}
                    onChange={e => setEmpForm(f => ({ ...f, department_id: e.target.value }))}>
                    <option value="">— {t('hr.none')} —</option>
                    {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
                <BranchField value={empForm.branch_id}
                  onChange={v => setEmpForm(f => ({ ...f, branch_id: v }))} />
                <div className="form-group">
                  <label className="form-label">{t('hr.fldEmploymentType')}</label>
                  <select className="form-control" value={empForm.employment_type}
                    onChange={e => setEmpForm(f => ({ ...f, employment_type: e.target.value }))}>
                    {EMPLOYMENT_TYPES.map(x => <option key={x} value={x}>{tEnumValue(x)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.status')}</label>
                  <select className="form-control" value={empForm.status}
                    onChange={e => setEmpForm(f => ({ ...f, status: e.target.value }))}>
                    {EMPLOYEE_STATUS.map(x => <option key={x} value={x}>{tEnumValue(x)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldManager')}</label>
                  <select className="form-control" value={empForm.manager_id}
                    onChange={e => setEmpForm(f => ({ ...f, manager_id: e.target.value }))}>
                    <option value="">— {t('hr.none')} —</option>
                    {emps.filter(e => e.id !== empEditId).map(e => (
                      <option key={e.id} value={e.id}>{e.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldHireDate')}</label>
                  <input type="date" className="form-control" value={empForm.hire_date || ''}
                    onChange={e => setEmpForm(f => ({ ...f, hire_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldEndDate')}</label>
                  <input type="date" className="form-control" value={empForm.end_date || ''}
                    onChange={e => setEmpForm(f => ({ ...f, end_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldPayType')}</label>
                  <select className="form-control" value={empForm.pay_type}
                    onChange={e => setEmpForm(f => ({ ...f, pay_type: e.target.value }))}>
                    {PAY_TYPES.map(x => (
                      <option key={x} value={x}>{t(`hr.payType${x}`)}</option>
                    ))}
                  </select>
                </div>
                {empForm.pay_type === 'Hourly' && (
                  <div className="form-group">
                    <label className="form-label">{t('hr.fldHourlyRate')}</label>
                    <NumberInput min="0" step="any" className="form-control"
                      value={empForm.hourly_rate}
                      onChange={e => setEmpForm(f => ({ ...f, hourly_rate: e.target.value }))} />
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                      {t('hr.hourlyRateHint')}
                    </div>
                  </div>
                )}
                <div className="form-group"
                  style={empForm.pay_type === 'Hourly' ? { display: 'none' } : undefined}>
                  <label className="form-label">{t('hr.fldSalary')}</label>
                  <NumberInput min="0" step="0.01" className="form-control" value={empForm.salary}
                    onChange={e => setEmpForm(f => ({ ...f, salary: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldEmail')}</label>
                  <input type="email" className="form-control" value={empForm.email || ''}
                    onChange={e => setEmpForm(f => ({ ...f, email: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldPhone')}</label>
                  <input className="form-control" value={empForm.phone || ''}
                    onChange={e => setEmpForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">{t('hr.fldAddress')}</label>
                  <input className="form-control" value={empForm.address || ''}
                    onChange={e => setEmpForm(f => ({ ...f, address: e.target.value }))} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">{t('hr.fldNotes')}</label>
                  <input className="form-control" value={empForm.notes || ''}
                    onChange={e => setEmpForm(f => ({ ...f, notes: e.target.value }))} />
                </div>

                {/* Change-tracking — visible only when EDITING. Auto-classified
                    (raise/promotion/transfer/...) when left blank, so this is
                    a polish field, not a required one. */}
                {empEditId && (
                  <>
                    <div className="form-group" style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
                      <label className="form-label" style={{ color: 'var(--text-3)' }}>
                        {t('hr.changeType')}
                        <span style={{ fontSize: 11, marginInlineStart: 6, fontStyle: 'italic' }}>
                          {t('hr.changeTypeHint')}
                        </span>
                      </label>
                      <select className="form-control" value={empForm.change_type || ''}
                        onChange={e => setEmpForm(f => ({ ...f, change_type: e.target.value }))}>
                        {CHANGE_TYPES.map(x =>
                          <option key={x} value={x}>{x === '' ? t('hr.changeAutoDetect') : changeLabel(x, t)}</option>
                        )}
                      </select>
                    </div>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label className="form-label">{t('hr.changeReason')}</label>
                      <input className="form-control" placeholder={t('hr.changeReasonPh')}
                        value={empForm.change_reason || ''}
                        onChange={e => setEmpForm(f => ({ ...f, change_reason: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setEmpModal(false)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Employee detail panel ──────────────────────────────────────────── */}
      {detailId && (
        <EmployeeDetail
          empId={detailId}
          canEdit={canEdit}
          onClose={() => setDetailId(null)}
          onEdit={emp => { setDetailId(null); openEmpEdit(emp); }}
          onChanged={() => { reloadEmps(); reloadSummary(); }}
        />
      )}

      {/* ── Payroll run drill-down / create panel ──────────────────────────── */}
      {runId && (
        <PayrollRunPanel
          runId={runId}
          canEdit={canEdit}
          canApprove={canApprove}
          canDelete={canDelete}
          onClose={() => setRunId(null)}
          onChanged={() => { reloadPayroll(); reloadSummary(); }}
        />
      )}

      {/* ── Department modal ───────────────────────────────────────────────── */}
      {deptModal && (
        <Modal title={deptEditId ? t('hr.editDepartment') : t('hr.addDepartment')} onClose={() => setDeptModal(false)}>
          <form onSubmit={saveDepartment}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t('common.name')} *</label>
                <input className="form-control" required value={deptForm.name}
                  onChange={e => setDeptForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('hr.colDescription')}</label>
                <input className="form-control" value={deptForm.description}
                  onChange={e => setDeptForm(f => ({ ...f, description: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setDeptModal(false)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Leave modal ────────────────────────────────────────────────────── */}
      {leaveModal && (
        <Modal title={t('hr.requestLeave')} onClose={() => setLeaveModal(false)}>
          <form onSubmit={saveLeave}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t('hr.colEmployee')} *</label>
                <select className="form-control" required value={leaveForm.employee_id}
                  onChange={e => setLeaveForm(f => ({ ...f, employee_id: e.target.value }))}>
                  <option value="">— {t('hr.selectEmployee')} —</option>
                  {emps.filter(e => e.status !== 'Terminated').map(e => (
                    <option key={e.id} value={e.id}>{e.full_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('hr.colLeaveType')}</label>
                  <select className="form-control" value={leaveForm.leave_type}
                    onChange={e => setLeaveForm(f => ({ ...f, leave_type: e.target.value }))}>
                    {LEAVE_TYPES.map(x => <option key={x} value={x}>{tEnumValue(x)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldStartDate')} *</label>
                  <input type="date" className="form-control" required value={leaveForm.start_date}
                    onChange={e => setLeaveForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('hr.fldEndDate')} *</label>
                  <input type="date" className="form-control" required value={leaveForm.end_date}
                    onChange={e => setLeaveForm(f => ({ ...f, end_date: e.target.value }))} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('hr.fldReason')}</label>
                <input className="form-control" value={leaveForm.reason}
                  onChange={e => setLeaveForm(f => ({ ...f, reason: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setLeaveModal(false)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : t('hr.submitRequest')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Confirm ────────────────────────────────────────────────────────── */}
      {confirm && (() => {
        const isRestore = confirm.kind === 'restore-employee' || confirm.kind === 'restore-department';
        return (
        <ConfirmModal
          title={isRestore ? t('common.restore') : confirm.kind === 'leave' ? t('common.delete') : t('common.archive')}
          message={
            isRestore
              ? t('common.restoreConfirm')
              : confirm.kind === 'leave'
                ? t('hr.confirmRemoveLeave', { name: confirm.label })
                : t('hr.confirmArchive', { name: confirm.label })
          }
          confirmLabel={isRestore ? t('common.restore') : confirm.kind === 'leave' ? t('common.delete') : t('common.archive')}
          confirmClass={isRestore ? undefined : 'btn-danger'}
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        />
        );
      })()}
    </div>
  );
}
