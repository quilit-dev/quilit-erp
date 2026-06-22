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

// ── Reference values (mirror backend/routers/hr.py) ─────────────────────────
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'];
const EMPLOYEE_STATUS  = ['Active', 'On Leave', 'Terminated'];
const LEAVE_TYPES      = ['Annual', 'Sick', 'Unpaid', 'Maternity', 'Paternity', 'Bereavement', 'Other'];

const EMP_STATUS_BADGE   = { Active: 'green',  'On Leave': 'yellow', Terminated: 'gray' };
const LEAVE_STATUS_BADGE = { Pending: 'yellow', Approved: 'green',   Rejected: 'red'  };
const PAYROLL_BADGE      = { Draft: 'gray', Approved: 'blue', Paid: 'green', Cancelled: 'red' };
const CHANGE_BADGE       = {
  hire: 'blue', raise: 'green', promotion: 'green', demotion: 'red',
  role_change: 'yellow', transfer: 'yellow', termination: 'red', adjustment: 'gray',
};
const CHANGE_TYPES = [
  '', 'raise', 'promotion', 'demotion', 'role_change', 'transfer', 'adjustment',
];

const EMPTY_EMPLOYEE = {
  full_name: '', job_title: '', department_id: '', employment_type: 'Full-time',
  status: 'Active', hire_date: '', end_date: '', email: '', phone: '',
  salary: 0, manager_id: '', address: '', notes: '', branch_id: '',
  change_type: '', change_reason: '',
};

// Friendly label for the change-row type. Locale-aware: maps the DB-stored
// English keys onto a translation lookup so AR/EN both render correctly.
// Falls back to the raw key when an unknown change type appears (forward
// compatibility with new types added on the server).
const changeLabel = (k, t) => {
  if (!k) return '';
  const map = {
    hire:        t('hr.changeHired'),
    raise:       t('hr.changeRaise'),
    promotion:   t('hr.changePromotion'),
    demotion:    t('hr.changeDemotion'),
    role_change: t('hr.changeRoleChange'),
    transfer:    t('hr.changeTransfer'),
    termination: t('hr.changeTermination'),
    adjustment:  t('hr.changeAdjustment'),
  };
  return map[k] || k;
};

// Localized labels for the DB-stored English status values. The DB keeps the
// canonical English code; the UI renders whichever language the operator
// chose. Falls back to the raw code when an unknown value appears.
const empStatusLabel = (s, t) => ({
  Active:     t('hr.statusActiveEmp'),
  'On Leave': t('hr.statusOnLeave'),
  Terminated: t('hr.statusTerminated'),
}[s] || s);

const leaveStatusLabel = (s, t) => ({
  Pending:  t('hr.statusPending'),
  Approved: t('hr.statusApproved'),
  Rejected: t('hr.statusRejected'),
}[s] || s);

const payrollStatusLabel = (s, t) => ({
  Draft:     t('hr.statusDraft'),
  Approved:  t('hr.statusApproved'),
  Paid:      t('hr.statusPaid'),
  Cancelled: t('hr.statusCancelled'),
}[s] || s);

const contractStatusLabel = (s, t) => ({
  Draft:      t('hr.contractStatusDraft'),
  Active:     t('hr.contractStatusActive'),
  Expired:    t('hr.contractStatusExpired'),
  Terminated: t('hr.contractStatusTerminated'),
}[s] || s);
const EMPTY_DEPT  = { name: '', description: '' };
const EMPTY_LEAVE = { employee_id: '', leave_type: 'Annual', start_date: '', end_date: '', reason: '' };

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
  const { t } = useLocale();
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
                    {EMPLOYMENT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.status')}</label>
                  <select className="form-control" value={empForm.status}
                    onChange={e => setEmpForm(f => ({ ...f, status: e.target.value }))}>
                    {EMPLOYEE_STATUS.map(x => <option key={x} value={x}>{x}</option>)}
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
                    {LEAVE_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
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


// ════════════════════════════════════════════════════════════════════════════
// EmployeeDetail — profile + salary timeline + files + payroll + leave
// ════════════════════════════════════════════════════════════════════════════
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

  const load = useCallback(async () => {
    if (isNew) return;
    setLoading(true); setError(null);
    try { setRun(await getPayrollRun(runId)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
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
      await load(); onChanged();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function doAction(action) {
    setBusy(true);
    try {
      if (action === 'approve') { await approvePayrollRun(run.id); toast(t('hr.runApproved')); }
      else if (action === 'pay') { const r = await markPayrollRunPaid(run.id); toast(t('hr.paidAndPosted', { id: r.expense_id })); }
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
                <th style={{ textAlign: 'right', width: 100 }}>{t('hr.colBase')}</th>
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
          <button className="btn btn-primary" disabled={busy} onClick={() => doAction('pay')}>{t('hr.markPaidAndPost')}</button>
        )}
        {run.status !== 'Paid' && run.status !== 'Cancelled' && canDelete && (
          <button className="btn btn-danger" disabled={busy} onClick={() => doAction('cancel')}>{t('hr.cancelRun')}</button>
        )}
      </div>
    </Modal>
  );
}

function PayrollLineRow({ line, editable, onPatch }) {
  const { t } = useLocale();
  const [base,    setBase]    = useState(String(line.base_salary || 0));
  const [bonus,   setBonus]   = useState(String(line.bonuses || 0));
  const [deduct,  setDeduct]  = useState(String(line.deductions || 0));
  const [otHours, setOtHours] = useState(String(line.overtime_hours || 0));
  const [otAmt,   setOtAmt]   = useState(String(line.overtime_amount || 0));

  // Autosave-on-blur — sends the four user-editable fields and lets the API
  // recompute the full breakdown (gross / tax / NSSF / net) atomically.
  function commit(patch) {
    onPatch({
      base_salary:     Number(base)   || 0,
      bonuses:         Number(bonus)  || 0,
      deductions:      Number(deduct) || 0,
      overtime_hours:  Number(otHours) || 0,
      overtime_amount: Number(otAmt) || 0,
      ...patch,
    });
  }
  return (
    <tr>
      <td className="td-primary" style={{ fontWeight: 600 }}>
        {line.employee_name}
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{line.job_title}{line.department_name ? ` · ${line.department_name}` : ''}</div>
      </td>
      <td>
        {editable
          ? <NumberInput step="0.01" min="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                   value={base} onChange={e => setBase(e.target.value)} onBlur={() => commit()} />
          : <div style={{ textAlign: 'right' }}>{fmt(line.base_salary || 0)}</div>}
      </td>
      <td>
        {editable
          ? <NumberInput step="0.01" min="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                   value={bonus} onChange={e => setBonus(e.target.value)} onBlur={() => commit()} />
          : <div style={{ textAlign: 'right' }}>{fmt(line.bonuses || 0)}</div>}
      </td>
      <td>
        {editable ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <NumberInput step="0.01" min="0" className="form-control"
                   style={{ textAlign: 'right', padding: '4px 6px', width: 50 }}
                   placeholder={t('hr.hoursPh')} value={otHours}
                   onChange={e => setOtHours(e.target.value)} onBlur={() => commit({ overtime_amount: null })} />
            <NumberInput step="0.01" min="0" className="form-control"
                   style={{ textAlign: 'right', padding: '4px 6px', width: 60 }}
                   placeholder={t('hr.amountPh')} value={otAmt}
                   onChange={e => setOtAmt(e.target.value)} onBlur={() => commit()} />
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
          ? <NumberInput step="0.01" min="0" className="form-control" style={{ textAlign: 'right', padding: '4px 6px' }}
                   value={deduct} onChange={e => setDeduct(e.target.value)} onBlur={() => commit()} />
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
const CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation', 'Internship', 'Consultant'];

function ContractsSection({ empId, canEdit }) {
  const { t } = useLocale();
  const [list,     setList]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing,  setEditing]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setList(await getContracts({ employee_id: empId })); }
    catch { /* silent — section will show empty */ }
    finally { setLoading(false); }
  }, [empId]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(id, status, reason = null) {
    try {
      await setContractStatus(id, { status, reason });
      toast(t('hr.contractStatusChanged', { status: contractStatusLabel(status, t) }));
      await load();
    }
    catch (err) { toast(err.message, 'error'); }
  }

  async function printContract(id) {
    try {
      const data = await getContractPrintData(id);
      printContractHTML(data.contract, data.company);
    } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <Section title={t('hr.employmentContracts')} right={canEdit && (
      <button className="btn btn-sm btn-primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
        {t('hr.newContract')}
      </button>
    )}>
      {loading ? <LoadingSpinner /> :
       list.length === 0 ? <EmptyState message={t('hr.noContractsOnFile')} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('hr.colNumber')}</th><th>{t('hr.colType')}</th><th>{t('common.status')}</th><th>{t('hr.colPeriod')}</th>
                <th style={{ textAlign: 'right' }}>{t('hr.colSalary')}</th><th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map(c => (
                <tr key={c.id}>
                  <td className="text-mono">{c.contract_number || `#${c.id}`}</td>
                  <td>{c.contract_type}</td>
                  <td><span className={`badge badge-${CONTRACT_BADGE[c.status] || 'gray'}`}>{contractStatusLabel(c.status, t)}</span></td>
                  <td>
                    {fmtDate(c.start_date)}{c.end_date ? ` → ${fmtDate(c.end_date)}` : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(c.salary || 0)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => printContract(c.id)}>📄 {t('hr.print')}</button>
                      {canEdit && (
                        <>
                          <button className="btn btn-sm btn-secondary" onClick={() => { setEditing(c); setFormOpen(true); }}>{t('common.edit')}</button>
                          {c.status === 'Draft' && (
                            <button className="btn btn-sm btn-primary" onClick={() => setStatus(c.id, 'Active')}>{t('hr.activate')}</button>
                          )}
                          {c.status === 'Active' && (
                            <button className="btn btn-sm btn-danger" onClick={() => {
                              const reason = window.prompt(t('hr.terminationReasonPrompt'), '');
                              if (reason !== null) setStatus(c.id, 'Terminated', reason || 'Terminated');
                            }}>{t('hr.terminate')}</button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <ContractForm
          empId={empId}
          existing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={async () => { setFormOpen(false); await load(); }}
        />
      )}
    </Section>
  );
}


function ContractForm({ empId, existing, onClose, onSaved }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => existing ? {
    contract_type:      existing.contract_type,
    start_date:         existing.start_date || '',
    end_date:           existing.end_date || '',
    probation_end_date: existing.probation_end_date || '',
    job_title:          existing.job_title || '',
    work_schedule:      existing.work_schedule || '',
    weekly_hours:       existing.weekly_hours ?? '',
    salary:             existing.salary ?? 0,
    salary_currency:    existing.salary_currency || 'USD',
    benefits:           existing.benefits || '',
    terms:              existing.terms || '',
  } : {
    contract_type:      'Permanent',
    start_date:         new Date().toISOString().slice(0, 10),
    end_date:           '',
    probation_end_date: '',
    job_title:          '',
    work_schedule:      'Mon–Fri 9:00–18:00',
    weekly_hours:       40,
    salary:             0,
    salary_currency:    'USD',
    benefits:           '',
    terms:              '',
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!form.start_date) { toast(t('hr.startDateRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        employee_id: empId,
        ...form,
        weekly_hours: form.weekly_hours !== '' ? Number(form.weekly_hours) : null,
        salary:       Number(form.salary) || 0,
        // dates with empty strings → null
        end_date:           form.end_date           || null,
        probation_end_date: form.probation_end_date || null,
      };
      if (existing) await updateContract(existing.id, payload);
      else          await createContract(payload);
      toast(existing ? t('hr.contractUpdated') : t('hr.contractCreated'));
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={existing ? t('hr.editContract') : t('hr.newEmploymentContract')} onClose={onClose} size="modal-lg">
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('hr.contractType')}</label>
              <select className="form-control" value={form.contract_type}
                onChange={e => setForm(f => ({ ...f, contract_type: e.target.value }))}>
                {CONTRACT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.jobTitleField')}</label>
              <input className="form-control" value={form.job_title}
                onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.fldStartDate')} *</label>
              <input type="date" required className="form-control" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.fldEndDate')}</label>
              <input type="date" className="form-control" value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.probationEnds')}</label>
              <input type="date" className="form-control" value={form.probation_end_date}
                onChange={e => setForm(f => ({ ...f, probation_end_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.weeklyHours')}</label>
              <NumberInput min="0" step="0.5" className="form-control" value={form.weekly_hours}
                onChange={e => setForm(f => ({ ...f, weekly_hours: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.workSchedule')}</label>
              <input className="form-control" value={form.work_schedule}
                onChange={e => setForm(f => ({ ...f, work_schedule: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.salaryField')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.salary}
                onChange={e => setForm(f => ({ ...f, salary: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.currencyField')}</label>
              <select className="form-control" value={form.salary_currency}
                onChange={e => setForm(f => ({ ...f, salary_currency: e.target.value }))}>
                {['USD', 'EUR', 'LBP', 'AED', 'SAR'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.benefitsField')}</label>
              <textarea className="form-control" rows={3} placeholder={t('hr.benefitsPh')}
                value={form.benefits}
                onChange={e => setForm(f => ({ ...f, benefits: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.additionalTerms')}</label>
              <textarea className="form-control" rows={4} placeholder={t('hr.additionalTermsPh')}
                value={form.terms}
                onChange={e => setForm(f => ({ ...f, terms: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// CONTRACT PDF — render contract HTML in a hidden iframe and trigger print.
// Mirrors the print pattern used by quotations / invoices, so the printed
// output stays consistent with the rest of the ERP.
// ════════════════════════════════════════════════════════════════════════════
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function printContractHTML(contract, company) {
  const esc = escapeHTML;
  const currency = contract.salary_currency || 'USD';
  const benefits = (contract.benefits || '').split('\n').filter(Boolean);
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Contract ${esc(contract.contract_number || contract.id)}</title>
  <style>
    @page { size: A4; margin: 22mm 18mm; }
    body  { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12pt; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 18px; }
    .head h1 { font-size: 22pt; margin: 0; letter-spacing: 1px; }
    .meta { font-size: 10pt; color: #475569; text-align: right; }
    h2 { font-size: 14pt; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin: 18px 0 8px; }
    table.kv { width: 100%; border-collapse: collapse; }
    table.kv td { padding: 4px 8px; vertical-align: top; font-size: 11pt; }
    table.kv td.k { color: #475569; width: 35%; }
    .clause { white-space: pre-wrap; font-size: 11pt; }
    ul { margin: 6px 0 6px 18px; padding: 0; }
    .sig { display: flex; justify-content: space-between; margin-top: 50px; }
    .sig .box { width: 45%; }
    .sig .line { border-top: 1px solid #1a1a1a; margin-top: 50px; padding-top: 4px; font-size: 10pt; color: #475569; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 9pt; background: #e2e8f0; color: #0f172a; }
  </style>
</head><body>

  <div class="head">
    <div>
      <h1>${esc(company.company_name || 'Employment Contract')}</h1>
      <div style="color:#475569;font-size:10pt;">
        ${esc(company.company_address || '')}
        ${company.company_phone ? `<br>${esc(company.company_phone)}` : ''}
        ${company.company_email ? ` · ${esc(company.company_email)}` : ''}
      </div>
    </div>
    <div class="meta">
      <div><strong>EMPLOYMENT CONTRACT</strong></div>
      <div>${esc(contract.contract_number || '')}</div>
      <div>${esc(contract.contract_type)} <span class="badge">${esc(contract.status)}</span></div>
    </div>
  </div>

  <p>This Employment Agreement (the <em>"Agreement"</em>) is entered into between
  <strong>${esc(company.company_name || 'the Company')}</strong> (the <em>"Employer"</em>)
  and <strong>${esc(contract.employee_name)}</strong> (the <em>"Employee"</em>), effective
  as of <strong>${esc(contract.start_date)}</strong>.</p>

  <h2>1. Parties</h2>
  <table class="kv">
    <tr><td class="k">Employer</td><td>${esc(company.company_name || '—')}</td></tr>
    <tr><td class="k">Employee</td><td>${esc(contract.employee_name)} (${esc(contract.employee_code || '')})</td></tr>
    <tr><td class="k">Email</td><td>${esc(contract.employee_email || '—')}</td></tr>
    <tr><td class="k">Phone</td><td>${esc(contract.employee_phone || '—')}</td></tr>
    <tr><td class="k">Address</td><td>${esc(contract.employee_address || '—')}</td></tr>
  </table>

  <h2>2. Position &amp; schedule</h2>
  <table class="kv">
    <tr><td class="k">Job title</td><td>${esc(contract.job_title || '—')}</td></tr>
    <tr><td class="k">Department</td><td>${esc(contract.department_name || '—')}</td></tr>
    <tr><td class="k">Manager</td><td>${esc(contract.manager_name || '—')}</td></tr>
    <tr><td class="k">Work schedule</td><td>${esc(contract.work_schedule || '—')}</td></tr>
    <tr><td class="k">Weekly hours</td><td>${contract.weekly_hours != null ? esc(contract.weekly_hours) : '—'}</td></tr>
  </table>

  <h2>3. Term</h2>
  <table class="kv">
    <tr><td class="k">Contract type</td><td>${esc(contract.contract_type)}</td></tr>
    <tr><td class="k">Start date</td><td>${esc(contract.start_date)}</td></tr>
    <tr><td class="k">End date</td><td>${esc(contract.end_date || 'Indefinite')}</td></tr>
    <tr><td class="k">Probation ends</td><td>${esc(contract.probation_end_date || '—')}</td></tr>
  </table>

  <h2>4. Compensation</h2>
  <p>The Employee shall receive a salary of
    <strong>${Number(contract.salary || 0).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })}</strong>
    payable on a regular schedule as set by the Employer, subject to applicable taxes
    and social-security contributions.</p>

  ${benefits.length ? `
  <h2>5. Benefits</h2>
  <ul>${benefits.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}

  ${contract.terms ? `
  <h2>${benefits.length ? '6' : '5'}. Additional terms</h2>
  <div class="clause">${esc(contract.terms)}</div>` : ''}

  <div class="sig">
    <div class="box">
      <div class="line">For the Employer</div>
    </div>
    <div class="box">
      <div class="line">${esc(contract.employee_name)}</div>
    </div>
  </div>

  <p style="margin-top:30px;color:#94a3b8;font-size:9pt;text-align:center;">
    ${esc(company.company_name || '')} · Generated by ERP on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
  </p>

</body></html>`;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(html);
  iframe.contentDocument.close();
  iframe.onload = () => {
    try {
      iframe.contentWindow.document.title = `Contract_${contract.contract_number || contract.id}.pdf`;
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }
  };
}

// ── Attendance tab (daily) ────────────────────────────────────────────────────
const ATT_STATUSES = ['Present', 'Absent', 'Late', 'Half-day', 'Leave'];
const ATT_LABEL_KEY = {
  'Present': 'hr.attPresent', 'Absent': 'hr.attAbsent', 'Late': 'hr.attLate',
  'Half-day': 'hr.attHalfday', 'Leave': 'hr.attLeave',
};

function AttendanceTab({ t, canEdit }) {
  const [view, setView]       = useState('day');     // 'day' | 'month'
  const [date, setDate]       = useState(() => new Date().toISOString().slice(0, 10));
  const [month, setMonth]     = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows]       = useState(null);
  const [summary, setSummary] = useState(null);
  const [saving, setSaving]   = useState(false);

  const load = useCallback(() => {
    setRows(null);
    getAttendance(date)
      .then(d => setRows((d.rows || []).map(r => ({ ...r, status: r.status || '' }))))
      .catch(e => { toast(e.message, 'red'); setRows([]); });
  }, [date]);
  const loadMonth = useCallback(() => {
    setSummary(null);
    getAttendanceSummary(month)
      .then(d => setSummary(d.rows || []))
      .catch(e => { toast(e.message, 'red'); setSummary([]); });
  }, [month]);
  useEffect(() => { if (view === 'day') load(); else loadMonth(); }, [view, load, loadMonth]);

  const setRow = (id, field, val) =>
    setRows(rs => rs.map(r => (r.employee_id === id ? { ...r, [field]: val } : r)));
  const markAllPresent = () => setRows(rs => rs.map(r => ({ ...r, status: 'Present' })));

  async function save() {
    setSaving(true);
    try {
      const records = (rows || [])
        .filter(r => r.status)                       // only rows that have a mark
        .map(r => ({
          employee_id: r.employee_id, status: r.status,
          hours: (r.hours === '' || r.hours == null) ? null : Number(r.hours),
          note: r.note || null,
        }));
      const res = await saveAttendanceBulk({ date, records });
      toast(`${t('hr.attSaved')} (${res.saved})`);
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  // Excel export of whichever view is showing — month = per-employee counts,
  // day = the day's roster. Uses the app's shared ExportButton.
  const exportData = view === 'month'
    ? (summary || []).map(emp => {
        const c = emp.counts || {};
        const row = { Employee: emp.full_name };
        let total = 0;
        ATT_STATUSES.forEach(s => { row[s] = c[s] || 0; total += c[s] || 0; });
        row.Total = total;
        return row;
      })
    : (rows || []).map(r => ({
        Employee: r.full_name, 'Job title': r.job_title || '',
        Status: r.status || '', Hours: r.hours ?? '', Notes: r.note || '',
      }));
  const exportName = view === 'month' ? `Attendance-${month}` : `Attendance-${date}`;
  const hasData = view === 'month' ? !!(summary && summary.length) : !!(rows && rows.length);

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="card-title">{t('hr.tabAttendance')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={`btn btn-sm ${view === 'day' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView('day')}>{t('hr.attDay')}</button>
          <button className={`btn btn-sm ${view === 'month' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView('month')}>{t('hr.attMonth')}</button>
        </div>
        {view === 'day' ? (
          <input type="date" className="form-control" style={{ width: 160 }}
            value={date} onChange={e => setDate(e.target.value)} />
        ) : (
          <input type="month" className="form-control" style={{ width: 160 }}
            value={month} onChange={e => setMonth(e.target.value)} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {hasData && (
            <ExportButton data={exportData} filename={exportName} sheetName="Attendance" />
          )}
          {view === 'day' && canEdit && (
            <button className="btn btn-secondary btn-sm" onClick={markAllPresent}
              disabled={!rows || !rows.length}>✓ {t('hr.attMarkAllPresent')}</button>
          )}
          {view === 'day' && canEdit && (
            <button className="btn btn-primary btn-sm" onClick={save}
              disabled={saving || !rows || !rows.length}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
        </div>
      </div>
      {view === 'day' ? (
        !rows ? <LoadingSpinner /> :
        rows.length === 0 ? <EmptyState message={t('hr.noEmployees')} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('hr.colEmployee')}</th>
              <th>{t('hr.attJobTitle')}</th>
              <th>{t('common.status')}</th>
              <th>{t('hr.attHours')}</th>
              <th>{t('common.notes')}</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.employee_id}>
                  <td className="td-primary">{r.full_name}</td>
                  <td style={{ color: 'var(--text-3)', fontSize: 13 }}>{r.job_title || '—'}</td>
                  <td>
                    <select className="form-control" style={{ minWidth: 130 }} value={r.status}
                      disabled={!canEdit} onChange={e => setRow(r.employee_id, 'status', e.target.value)}>
                      <option value="">{t('hr.attNotMarked')}</option>
                      {ATT_STATUSES.map(s => <option key={s} value={s}>{t(ATT_LABEL_KEY[s])}</option>)}
                    </select>
                  </td>
                  <td>
                    <NumberInput className="form-control" style={{ width: 80 }} min="0" step="0.5"
                      value={r.hours ?? ''} disabled={!canEdit}
                      onChange={e => setRow(r.employee_id, 'hours', e.target.value)} />
                  </td>
                  <td>
                    <input className="form-control" value={r.note || ''} disabled={!canEdit}
                      onChange={e => setRow(r.employee_id, 'note', e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      ) : (
        !summary ? <LoadingSpinner /> :
        summary.length === 0 ? <EmptyState message={t('hr.noEmployees')} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>{t('hr.colEmployee')}</th>
                {ATT_STATUSES.map(s => (
                  <th key={s} style={{ textAlign: 'center' }}>{t(ATT_LABEL_KEY[s])}</th>
                ))}
                <th style={{ textAlign: 'center' }}>{t('hr.attTotalMarked')}</th>
              </tr></thead>
              <tbody>
                {summary.map(emp => {
                  const cnt = emp.counts || {};
                  const total = ATT_STATUSES.reduce((a, s) => a + (cnt[s] || 0), 0);
                  return (
                    <tr key={emp.employee_id}>
                      <td className="td-primary">{emp.full_name}</td>
                      {ATT_STATUSES.map(s => (
                        <td key={s} style={{ textAlign: 'center' }}>{cnt[s] || 0}</td>
                      ))}
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

