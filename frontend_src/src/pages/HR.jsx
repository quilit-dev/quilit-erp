import { useState, useCallback } from 'react';
import { useData } from '../hooks/useData';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  fmt, fmtDate, toast,
} from '../components/shared';
import {
  getHRSummary,
  getDepartments, createDepartment, updateDepartment, archiveDepartment,
  getEmployees, createEmployee, updateEmployee, archiveEmployee,
  getLeaveRequests, createLeaveRequest, approveLeave, rejectLeave, deleteLeaveRequest,
} from '../api/client';

// ── Reference values (mirror backend/routers/hr.py) ─────────────────────────
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'];
const EMPLOYEE_STATUS  = ['Active', 'On Leave', 'Terminated'];
const LEAVE_TYPES      = ['Annual', 'Sick', 'Unpaid', 'Maternity', 'Paternity', 'Bereavement', 'Other'];

const EMP_STATUS_BADGE   = { Active: 'green',  'On Leave': 'yellow', Terminated: 'gray' };
const LEAVE_STATUS_BADGE = { Pending: 'yellow', Approved: 'green',   Rejected: 'red'  };

const EMPTY_EMPLOYEE = {
  full_name: '', job_title: '', department_id: '', employment_type: 'Full-time',
  status: 'Active', hire_date: '', end_date: '', email: '', phone: '',
  salary: 0, manager_id: '', address: '', notes: '',
};
const EMPTY_DEPT  = { name: '', description: '' };
const EMPTY_LEAVE = { employee_id: '', leave_type: 'Annual', start_date: '', end_date: '', reason: '' };

// ── KPI card ────────────────────────────────────────────────────────────────
function Kpi({ label, value, accent, bg }) {
  return (
    <div className="stat-card" style={{ background: bg }}>
      <div className="stat-label" style={{ color: accent }}>{label}</div>
      <div className="stat-value" style={{ color: accent }}>{value}</div>
    </div>
  );
}

export default function HR() {
  const { t } = useLocale();
  const { can } = usePermissions();

  const [tab, setTab] = useState('employees');

  const { data: summary,     reload: reloadSummary }                   = useData(getHRSummary);
  const { data: departments, reload: reloadDepts }                     = useData(getDepartments);
  const { data: employees, loading, error, reload: reloadEmps }        = useData(useCallback(() => getEmployees(), []));
  const { data: leave,       reload: reloadLeave }                     = useData(useCallback(() => getLeaveRequests(), []));

  const reloadAll = useCallback(() => {
    reloadSummary(); reloadDepts(); reloadEmps(); reloadLeave();
  }, [reloadSummary, reloadDepts, reloadEmps, reloadLeave]);

  const depts   = Array.isArray(departments) ? departments : [];
  const emps    = Array.isArray(employees)   ? employees   : [];
  const leaves  = Array.isArray(leave)       ? leave       : [];

  // ── Modals state ──────────────────────────────────────────────────────────
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
      if (confirm.kind === 'employee')   { await archiveEmployee(confirm.id);   toast('Employee archived'); }
      if (confirm.kind === 'department') { await archiveDepartment(confirm.id); toast('Department archived'); }
      if (confirm.kind === 'leave')      { await deleteLeaveRequest(confirm.id); toast('Leave request removed'); }
      setConfirm(null); reloadAll();
    } catch (err) { toast(err.message || 'Action failed', 'error'); setConfirm(null); }
  }

  const s = summary || {};
  const TABS = [
    { key: 'employees',   label: t('hr.tabEmployees'),   count: emps.length },
    { key: 'departments', label: t('hr.tabDepartments'), count: depts.length },
    { key: 'leave',       label: t('hr.tabLeave'),       count: leaves.length },
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
        <Kpi label={t('hr.kpiTotal')}    value={s.total_employees ?? 0} accent="#1d4ed8" bg="#dbeafe" />
        <Kpi label={t('hr.kpiActive')}   value={s.active ?? 0}          accent="#16a34a" bg="#dcfce7" />
        <Kpi label={t('hr.kpiOnLeave')}  value={s.on_leave ?? 0}        accent="#b45309" bg="#fef3c7" />
        <Kpi label={t('hr.kpiDepts')}    value={s.departments ?? 0}     accent="#7c3aed" bg="#ede9fe" />
        <Kpi label={t('hr.kpiPending')}  value={s.pending_leave ?? 0}   accent="#dc2626" bg="#fee2e2" />
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
        <div style={{ marginLeft: 'auto' }}>
          {tab === 'employees' && canCreate && (
            <button className="btn btn-primary" onClick={openEmpCreate}>{t('hr.addEmployee')}</button>
          )}
          {tab === 'departments' && canCreate && (
            <button className="btn btn-primary" onClick={openDeptCreate}>{t('hr.addDepartment')}</button>
          )}
          {tab === 'leave' && canCreate && (
            <button className="btn btn-primary" onClick={openLeaveCreate}>{t('hr.requestLeave')}</button>
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
                  {emps.map(e => (
                    <tr key={e.id}>
                      <td className="text-mono">{e.employee_code || '—'}</td>
                      <td className="td-primary" style={{ fontWeight: 600 }}>{e.full_name}</td>
                      <td>{e.job_title || '—'}</td>
                      <td>{e.department_name || '—'}</td>
                      <td>{e.employment_type}</td>
                      <td><span className={`badge badge-${EMP_STATUS_BADGE[e.status] || 'gray'}`}>{e.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => openEmpEdit(e)}>{t('common.edit')}</button>}
                          {canDelete && <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ kind: 'employee', id: e.id, label: e.full_name })}>{t('common.archive')}</button>}
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
                  {depts.map(d => (
                    <tr key={d.id}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>{d.name}</td>
                      <td>{d.description || '—'}</td>
                      <td>{d.employee_count ?? 0}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => openDeptEdit(d)}>{t('common.edit')}</button>}
                          {canDelete && <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ kind: 'department', id: d.id, label: d.name })}>{t('common.archive')}</button>}
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
                      <td><span className={`badge badge-${LEAVE_STATUS_BADGE[l.status] || 'gray'}`}>{l.status}</span></td>
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
                  <input type="number" min="0" step="0.01" className="form-control" value={empForm.salary}
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
      {confirm && (
        <ConfirmModal
          title={confirm.kind === 'leave' ? t('common.delete') : t('common.archive')}
          message={
            confirm.kind === 'leave'
              ? t('hr.confirmRemoveLeave', { name: confirm.label })
              : t('hr.confirmArchive', { name: confirm.label })
          }
          confirmLabel={confirm.kind === 'leave' ? t('common.delete') : t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
