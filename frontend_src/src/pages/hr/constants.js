// Shared HR reference values + status label helpers.
// Extracted from HR.jsx so the page orchestrator and its section/modal
// components (EmployeeDetail, PayrollRunPanel, ContractsSection, AttendanceTab)
// can all import them without duplicating — and without importing from the
// page itself (which would be a circular dependency).
//
// Reference values mirror backend/routers/hr.py.

export const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'];
export const EMPLOYEE_STATUS  = ['Active', 'On Leave', 'Terminated'];
export const LEAVE_TYPES      = ['Annual', 'Sick', 'Unpaid', 'Maternity', 'Paternity', 'Bereavement', 'Other'];

export const EMP_STATUS_BADGE   = { Active: 'green',  'On Leave': 'yellow', Terminated: 'gray' };
export const LEAVE_STATUS_BADGE = { Pending: 'yellow', Approved: 'green',   Rejected: 'red'  };
export const PAYROLL_BADGE      = { Draft: 'gray', Approved: 'blue', Paid: 'green', Cancelled: 'red' };
export const CHANGE_BADGE       = {
  hire: 'blue', raise: 'green', promotion: 'green', demotion: 'red',
  role_change: 'yellow', transfer: 'yellow', termination: 'red', adjustment: 'gray',
};
export const CHANGE_TYPES = [
  '', 'raise', 'promotion', 'demotion', 'role_change', 'transfer', 'adjustment',
];

export const EMPTY_EMPLOYEE = {
  full_name: '', job_title: '', department_id: '', employment_type: 'Full-time',
  status: 'Active', hire_date: '', end_date: '', email: '', phone: '',
  salary: 0, manager_id: '', address: '', notes: '', branch_id: '',
  change_type: '', change_reason: '',
};
export const EMPTY_DEPT  = { name: '', description: '' };
export const EMPTY_LEAVE = { employee_id: '', leave_type: 'Annual', start_date: '', end_date: '', reason: '' };

// Friendly label for the change-row type. Locale-aware: maps the DB-stored
// English keys onto a translation lookup so AR/EN both render correctly.
// Falls back to the raw key when an unknown change type appears (forward
// compatibility with new types added on the server).
export const changeLabel = (k, t) => {
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
// canonical English code; the UI renders whichever language the operator chose.
// Falls back to the raw code when an unknown value appears.
export const empStatusLabel = (s, t) => ({
  Active:     t('hr.statusActiveEmp'),
  'On Leave': t('hr.statusOnLeave'),
  Terminated: t('hr.statusTerminated'),
}[s] || s);

export const leaveStatusLabel = (s, t) => ({
  Pending:  t('hr.statusPending'),
  Approved: t('hr.statusApproved'),
  Rejected: t('hr.statusRejected'),
}[s] || s);

export const payrollStatusLabel = (s, t) => ({
  Draft:     t('hr.statusDraft'),
  Approved:  t('hr.statusApproved'),
  Paid:      t('hr.statusPaid'),
  Cancelled: t('hr.statusCancelled'),
}[s] || s);

export const contractStatusLabel = (s, t) => ({
  Draft:      t('hr.contractStatusDraft'),
  Active:     t('hr.contractStatusActive'),
  Expired:    t('hr.contractStatusExpired'),
  Terminated: t('hr.contractStatusTerminated'),
}[s] || s);
