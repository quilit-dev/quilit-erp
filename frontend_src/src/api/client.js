// ─── Centralised API client ────────────────────────────────────────────────
const BASE = '';
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 600;
const RETRY_BACKOFF = 1.5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function extractError(res) {
  const clone = res.clone();
  try {
    const body = await res.json();
    if (typeof body.detail === 'string')  return body.detail;
    if (Array.isArray(body.detail))       return body.detail.map(d => d.msg || String(d)).join('; ');
    if (typeof body.message === 'string') return body.message;
    return JSON.stringify(body);
  } catch {
    try { const t = await clone.text(); if (t && t.length < 300) return t; } catch {}
  }
  return `Server error (HTTP ${res.status})`;
}

async function request(method, path, body, signal) {
  let attempt = 0, delay = RETRY_DELAY;
  while (attempt < MAX_RETRIES) {
    attempt++;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const headers = { 'Content-Type': 'application/json' };
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method, headers, signal, credentials: 'include',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt < MAX_RETRIES) { await sleep(delay); delay *= RETRY_BACKOFF; continue; }
      throw new Error('Cannot reach server. Make sure the app is running.');
    }
    if (res.status === 401) {
      localStorage.removeItem('user');
      window.location.href = '/login';
      throw new Error('Session expired.');
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(delay); delay *= RETRY_BACKOFF; continue;
    }
    if (!res.ok) { throw new Error(await extractError(res)); }
    if (res.status === 204) return null;
    try { return await res.json(); } catch { throw new Error('Invalid server response.'); }
  }
  throw new Error('Server is not responding. Please try again.');
}

export const api = {
  get:    (p, s)    => request('GET',    p, undefined, s),
  post:   (p, b, s) => request('POST',   p, b, s),
  put:    (p, b, s) => request('PUT',    p, b, s),
  patch:  (p, b, s) => request('PATCH',  p, b, s),
  delete: (p, s)    => request('DELETE', p, undefined, s),
};

// Auth — login bypasses the shared interceptor so a 401 (wrong password)
// is shown as "Invalid credentials" instead of "Session expired."
export async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new Error('Invalid credentials. Please check your username and password.');
  if (res.status === 403) throw new Error('Account is disabled. Contact your administrator.');
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
export const logout = () => api.post('/api/auth/logout');
export const getMe  = () => api.get('/api/auth/me');

// Dashboard
export const getDashboard = (s) => api.get('/api/dashboard/', s);

// Clients
export const getClients      = (s) => api.get('/api/clients/', s);
export const getClient       = (id) => api.get(`/api/clients/${id}`);
export const createClient    = (d) => api.post('/api/clients/', d);
export const updateClient    = (id, d) => api.put(`/api/clients/${id}`, d);
export const archiveClient   = (id, reason) => api.patch(`/api/clients/${id}/archive`, { reason });
export const unarchiveClient = (id) => api.patch(`/api/clients/${id}/unarchive`);

// Projects
export const getProjects       = (s) => api.get('/api/projects/', s);
export const getProject        = (id) => api.get(`/api/projects/${id}`);
export const createProject     = (d) => api.post('/api/projects/', d);
export const updateProject     = (id, d) => api.put(`/api/projects/${id}`, d);
export const cancelProject     = (id, reason) => api.patch(`/api/projects/${id}/cancel`, { reason });
export const archiveProject    = (id, reason) => api.patch(`/api/projects/${id}/archive`, { reason });
export const unarchiveProject  = (id) => api.patch(`/api/projects/${id}/unarchive`);

// Quotations (proposals only — no payments)
export const getQuotations       = (s) => api.get('/api/quotations/', s);
export const getQuotation        = (id) => api.get(`/api/quotations/${id}`);
export const createQuotation     = (d)  => api.post('/api/quotations/', d);
export const updateQuotation     = (id, d) => api.put(`/api/quotations/${id}`, d);
export const cancelQuotation     = (id, reason) => api.patch(`/api/quotations/${id}/cancel`, { reason });
export const archiveQuotation    = (id, reason) => api.patch(`/api/quotations/${id}/archive`, { reason });
export const unarchiveQuotation  = (id) => api.patch(`/api/quotations/${id}/unarchive`);
export const convertToInvoice    = (id) => api.post(`/api/quotations/${id}/convert-to-invoice`);
export const convertToProject    = (id) => api.post(`/api/quotations/${id}/convert-to-project`);

// Invoices + cumulative payments
export const getInvoices       = (s)    => api.get('/api/invoices/', s);
export const getInvoice        = (id)   => api.get(`/api/invoices/${id}`);
export const createInvoice     = (d)    => api.post('/api/invoices/', d);
export const updateInvoice     = (id, d) => api.put(`/api/invoices/${id}`, d);
export const archiveInvoice    = (id, reason) => api.patch(`/api/invoices/${id}/archive`, { reason });
export const unarchiveInvoice  = (id)         => api.patch(`/api/invoices/${id}/unarchive`);
export const voidInvoice       = (id, reason) => api.patch(`/api/invoices/${id}/void`, { reason });
export const addInvoicePayment    = (id, d)       => api.post(`/api/invoices/${id}/payments`, d);
export const getInvoicePayments   = (id)           => api.get(`/api/invoices/${id}/payments`);
export const deleteInvoicePayment = (invId, payId) => api.delete(`/api/invoices/${invId}/payments/${payId}`);

// Inventory
export const getInventory           = (s)    => api.get('/api/inventory/', s);
export const createInventoryItem    = (d)    => api.post('/api/inventory/', d);
export const updateInventoryItem    = (id, d) => api.put(`/api/inventory/${id}`, d);
export const archiveInventoryItem   = (id)   => api.patch(`/api/inventory/${id}/archive`);
export const unarchiveInventoryItem = (id)   => api.patch(`/api/inventory/${id}/unarchive`);
export const updateStock            = (id, d) => api.patch(`/api/inventory/${id}/stock`, d);
export const getStockMovements      = (id)   => api.get(`/api/inventory/${id}/movements`);
export const deductToProject        = (id, d) => api.post(`/api/inventory/${id}/deduct-to-project`, d);

// Purchases
export const getPurchases         = (s)    => api.get('/api/purchases/', s);
export const getPurchaseStats     = ()     => api.get('/api/purchases/stats');
export const createPurchase       = (d)    => api.post('/api/purchases/', d);
export const updatePurchase       = (id, d) => api.put(`/api/purchases/${id}`, d);
export const updatePurchaseStatus = (id, status) => api.patch(`/api/purchases/${id}/status`, { status });
export const archivePurchase      = (id)   => api.patch(`/api/purchases/${id}/archive`);
export const unarchivePurchase    = (id)   => api.patch(`/api/purchases/${id}/unarchive`);

// Finance
export const getFinanceSummary = (params = {}, s) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/finance/summary${q ? '?' + q : ''}`, s);
};
export const getMonthlyReport = (s) => api.get('/api/finance/monthly', s);
export const getExpenses        = (s) => api.get('/api/finance/expenses', s);
export const createExpense      = (d) => api.post('/api/finance/expenses', d);
export const updateExpense      = (id, d) => api.put(`/api/finance/expenses/${id}`, d);
export const archiveExpense     = (id) => api.patch(`/api/finance/expenses/${id}/archive`);
export const unarchiveExpense   = (id) => api.patch(`/api/finance/expenses/${id}/unarchive`);
export const voidExpense        = (id, reason) => api.patch(`/api/finance/expenses/${id}/void`, { reason });

// Finance — range-based endpoints
export const getFinanceRangeSummary = (params = {}, s) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/finance/range-summary${q ? '?' + q : ''}`, s);
};
export const getFinanceRangeMonthly = (params = {}, s) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/finance/range-monthly${q ? '?' + q : ''}`, s);
};
export const getFinanceRangeDetail = (params = {}, s) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/finance/range-detail${q ? '?' + q : ''}`, s);
};

// Fetch existing categories from inventory table (already supported by your backend)
export async function getCategories() {
  const res = await fetch('/api/inventory/categories', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load categories');
  return res.json();
}
// Users (admin only)
export const getUsers            = (params = {}) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/users/${q ? '?' + q : ''}`); };
export const getUser             = (id)    => api.get(`/api/users/${id}`);
export const createUser          = (d)     => api.post('/api/users/', d);
export const updateUser          = (id, d) => api.put(`/api/users/${id}`, d);
export const deleteUser          = (id)    => api.delete(`/api/users/${id}`);
export const resetUserPassword   = (id, d) => api.post(`/api/users/${id}/reset-password`, d);
export const toggleUserActive    = (id)    => api.patch(`/api/users/${id}/toggle-active`);
export const getUserSessions     = ()      => api.get('/api/users/sessions');
export const revokeSession       = (id)    => api.delete(`/api/users/sessions/${id}`);

// Roles (admin only)
export const getRoles            = ()      => api.get('/api/roles/');
export const getRole             = (id)    => api.get(`/api/roles/${id}`);
export const createRole          = (d)     => api.post('/api/roles/', d);
export const updateRole          = (id, d) => api.put(`/api/roles/${id}`, d);
export const deleteRole          = (id)    => api.delete(`/api/roles/${id}`);
export const setRolePermissions  = (id, d) => api.put(`/api/roles/${id}/permissions`, d);
export const getRoleModules      = ()      => api.get('/api/roles/modules');

// Suppliers
export const getSuppliers      = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/suppliers/${q ? '?' + q : ''}`);
};
export const getSupplier       = (id)    => api.get(`/api/suppliers/${id}`);
export const createSupplier    = (d)     => api.post('/api/suppliers/', d);
export const updateSupplier    = (id, d) => api.put(`/api/suppliers/${id}`, d);
export const archiveSupplier   = (id)    => api.patch(`/api/suppliers/${id}/archive`);
export const unarchiveSupplier = (id)    => api.patch(`/api/suppliers/${id}/unarchive`);

// Audit log
export const getAuditLog = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/audit/${q ? '?' + q : ''}`);
};
export const purgeAuditLog = (olderThanDays) =>
  api.delete(`/api/audit/purge?older_than_days=${olderThanDays}`);

// Archives
export const getArchives    = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return api.get(q ? `/api/archives/?${q}` : '/api/archives/');
};
export const unarchiveItem = (module, id) => api.patch(`/api/archives/${module}/${id}/unarchive`);

// Documents
export const saveDocument       = (d)         => api.post('/api/documents/', d);
export const getDocuments       = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return api.get(`/api/documents/${q ? '?' + q : ''}`);
};
export const getDocumentContent = (id)        => api.get(`/api/documents/${id}/content`);
export const deleteDocument     = (id)        => api.delete(`/api/documents/${id}`);

// Global search
export const searchAll = (q, signal) => api.get(`/api/search/?q=${encodeURIComponent(q)}`, signal);

// Settings — backup & integrity
export const getBackupStatus   = ()  => api.get('/api/settings/backup-status');
export const runBackupNow      = ()  => api.post('/api/settings/backup-now');
export const runIntegrityCheck = ()  => api.get('/api/settings/integrity-check');

// Setup wizard (no auth)
export const getSetupStatus  = ()  => fetch('/api/settings/setup-status').then(r => r.json());
export const completeSetup   = (d) => fetch('/api/settings/complete-setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d),
}).then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.detail || 'Setup failed'); return b; });

// Auth — force password change
export const forceChangePassword = (new_password) => api.post('/api/auth/force-change-password', { new_password });

// Restore backup (.db file upload)
export function restoreBackup(file) {
  const fd = new FormData();
  fd.append('file', file);
  return fetch('/api/settings/restore', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  }).then(async r => {
    const b = await r.json();
    if (!r.ok) throw new Error(b.detail || 'Restore failed');
    return b;
  });
}

// Reports
export const getReportFinancial    = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/reports/financial${q ? '?' + q : ''}`, s); };
export const getReportProjects     = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/reports/projects${q ? '?' + q : ''}`, s); };
export const getReportClients      = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/reports/clients${q ? '?' + q : ''}`, s); };
export const getReportInvoiceAging = (s)              => api.get('/api/reports/invoice-aging', s);
export const getReportExpenses     = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/reports/expenses${q ? '?' + q : ''}`, s); };
export const getReportPipeline     = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/reports/pipeline${q ? '?' + q : ''}`, s); };

// CRM
export const getCRMDashboard   = (s)              => api.get('/api/crm/dashboard', s);
export const getCRMLeads       = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/crm/leads${q ? '?' + q : ''}`, s); };
export const getCRMLead        = (id)             => api.get(`/api/crm/leads/${id}`);
export const createCRMLead     = (d)              => api.post('/api/crm/leads', d);
export const updateCRMLead     = (id, d)          => api.put(`/api/crm/leads/${id}`, d);
export const archiveCRMLead    = (id)             => api.patch(`/api/crm/leads/${id}/archive`);
export const convertCRMLead    = (id, d)          => api.post(`/api/crm/leads/${id}/convert`, d);
export const getCRMContacts    = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/crm/contacts${q ? '?' + q : ''}`, s); };
export const createCRMContact  = (d)              => api.post('/api/crm/contacts', d);
export const updateCRMContact  = (id, d)          => api.put(`/api/crm/contacts/${id}`, d);
export const deleteCRMContact  = (id)             => api.delete(`/api/crm/contacts/${id}`);
export const getCRMActivities  = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/crm/activities${q ? '?' + q : ''}`, s); };
export const createCRMActivity = (d)              => api.post('/api/crm/activities', d);
export const updateCRMActivity = (id, d)          => api.put(`/api/crm/activities/${id}`, d);
export const toggleActivityDone = (id)            => api.patch(`/api/crm/activities/${id}/done`);
export const deleteCRMActivity = (id)             => api.delete(`/api/crm/activities/${id}`);
export const getCRMDeals       = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/crm/deals${q ? '?' + q : ''}`, s); };
export const createCRMDeal     = (d)              => api.post('/api/crm/deals', d);
export const updateCRMDeal     = (id, d)          => api.put(`/api/crm/deals/${id}`, d);
export const updateDealStage   = (id, d)          => api.patch(`/api/crm/deals/${id}/stage`, d);
export const archiveCRMDeal    = (id)             => api.patch(`/api/crm/deals/${id}/archive`);
export const getCRMDropdownClients    = ()         => api.get('/api/crm/dropdown/clients');
export const getCRMDropdownQuotations = ()         => api.get('/api/crm/dropdown/quotations');
export const getCRMDropdownUsers      = ()         => api.get('/api/crm/dropdown/users');

// Planning
export const getPlanningProjects    = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/planning/projects${q ? '?' + q : ''}`, s); };
export const createPlanningProject  = (d)              => api.post('/api/planning/projects', d);
export const updatePlanningProject  = (id, d)          => api.put(`/api/planning/projects/${id}`, d);
export const archivePlanningProject = (id)             => api.patch(`/api/planning/projects/${id}/archive`);
export const getPlanningTasks       = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/planning/tasks${q ? '?' + q : ''}`, s); };
export const createPlanningTask     = (d)              => api.post('/api/planning/tasks', d);
export const updatePlanningTask     = (id, d)          => api.put(`/api/planning/tasks/${id}`, d);
export const updateTaskDates        = (id, d)          => api.patch(`/api/planning/tasks/${id}/dates`, d);
export const updateTaskStatus       = (id, d)          => api.patch(`/api/planning/tasks/${id}/status`, d);
export const updateTaskProgress     = (id, d)          => api.patch(`/api/planning/tasks/${id}/progress`, d);
export const archivePlanningTask    = (id)             => api.patch(`/api/planning/tasks/${id}/archive`);
export const getPlanningMilestones  = (params = {}, s) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/planning/milestones${q ? '?' + q : ''}`, s); };
export const createPlanningMilestone = (d)             => api.post('/api/planning/milestones', d);
export const updatePlanningMilestone = (id, d)         => api.put(`/api/planning/milestones/${id}`, d);
export const deletePlanningMilestone = (id)            => api.delete(`/api/planning/milestones/${id}`);
export const getPlanningSummary     = (s)              => api.get('/api/planning/summary', s);
export const getPlanningDropdownClients = ()           => api.get('/api/planning/dropdown/clients');
export const getPlanningDropdownUsers   = ()           => api.get('/api/planning/dropdown/users');

// Finance — accounting periods + reconciliation
export const getFinancePeriods   = ()              => api.get('/api/finance/periods');
export const lockPeriod          = (year, month)   => api.post(`/api/finance/periods/${year}/${month}/lock`);
export const unlockPeriod        = (year, month)   => api.post(`/api/finance/periods/${year}/${month}/unlock`);
export const getReconciliation   = ()              => api.get('/api/finance/reconciliation');

// Notifications
export const getNotifications      = (params = {}) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/notifications/${q ? '?' + q : ''}`); };
export const getNotificationCount  = ()            => api.get('/api/notifications/count');
export const markNotificationRead  = (id)          => api.patch(`/api/notifications/${id}/read`);
export const markAllNotificationsRead = ()          => api.patch('/api/notifications/mark-all-read');
export const deleteNotification    = (id)          => api.delete(`/api/notifications/${id}`);
export const clearReadNotifications = ()           => api.delete('/api/notifications/clear-read');

// Approval Policies
export const getApprovalPolicies    = ()        => api.get('/api/approval-policies/');
export const getApprovalPolicyMeta  = ()        => api.get('/api/approval-policies/meta/modules');
export const createApprovalPolicy   = (d)       => api.post('/api/approval-policies/', d);
export const updateApprovalPolicy   = (id, d)   => api.put(`/api/approval-policies/${id}`, d);
export const toggleApprovalPolicy   = (id)      => api.patch(`/api/approval-policies/${id}/toggle`);
export const deleteApprovalPolicy   = (id)      => api.delete(`/api/approval-policies/${id}`);

// Approval Requests
export const getApprovalRequests    = (params = {}) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/approval-requests/${q ? '?' + q : ''}`); };
export const getApprovalRequest     = (id)          => api.get(`/api/approval-requests/${id}`);
export const getApprovalCount       = ()             => api.get('/api/approval-requests/count');
export const approveRequest         = (id, d = {})  => api.post(`/api/approval-requests/${id}/approve`, d);
export const rejectRequest          = (id, d = {})  => api.post(`/api/approval-requests/${id}/reject`, d);
export const forceApproveRequest    = (id, d = {})  => api.post(`/api/approval-requests/${id}/force-approve`, d);
export const cancelApprovalRequest  = (id, d = {})  => api.post(`/api/approval-requests/${id}/cancel`, d);
export const addApprovalComment     = (id, comment) => api.post(`/api/approval-requests/${id}/comments`, { comment });

// Human Resources
const _qs = (params) => { const q = new URLSearchParams(params).toString(); return q ? '?' + q : ''; };
export const getHRSummary        = ()            => api.get('/api/hr/summary');
export const getDepartments      = ()            => api.get('/api/hr/departments');
export const createDepartment    = (d)           => api.post('/api/hr/departments', d);
export const updateDepartment    = (id, d)       => api.put(`/api/hr/departments/${id}`, d);
export const archiveDepartment   = (id)          => api.patch(`/api/hr/departments/${id}/archive`);
export const getEmployees        = (params = {}) => api.get(`/api/hr/employees${_qs(params)}`);
export const getEmployee         = (id)          => api.get(`/api/hr/employees/${id}`);
export const createEmployee      = (d)           => api.post('/api/hr/employees', d);
export const updateEmployee      = (id, d)       => api.put(`/api/hr/employees/${id}`, d);
export const archiveEmployee     = (id)          => api.patch(`/api/hr/employees/${id}/archive`);
export const getLeaveRequests    = (params = {}) => api.get(`/api/hr/leave${_qs(params)}`);
export const createLeaveRequest  = (d)           => api.post('/api/hr/leave', d);
export const updateLeaveRequest  = (id, d)       => api.put(`/api/hr/leave/${id}`, d);
export const approveLeave        = (id, d = {})  => api.post(`/api/hr/leave/${id}/approve`, d);
export const rejectLeave         = (id, d = {})  => api.post(`/api/hr/leave/${id}/reject`, d);
export const deleteLeaveRequest  = (id)          => api.delete(`/api/hr/leave/${id}`);

// Recycle Bin
export const getRecycleBin      = (params = {}) => { const q = new URLSearchParams(params).toString(); return api.get(`/api/recycle_bin/${q ? '?' + q : ''}`); };
export const restoreItem        = (module, id)  => api.post(`/api/recycle_bin/restore/${module}/${id}`);
export const purgeItem          = (module, id)  => api.delete(`/api/recycle_bin/${module}/${id}`);
export const bulkRestoreItems   = (items)       => api.post('/api/recycle_bin/bulk-restore', { items });
export const bulkPurgeItems     = (items)       => api.post('/api/recycle_bin/bulk-purge', { items });
export const purgeExpired       = ()            => api.post('/api/recycle_bin/purge-expired');
