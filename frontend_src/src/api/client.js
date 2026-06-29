// ─── Centralised API client ────────────────────────────────────────────────
const BASE = '';
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 600;
const RETRY_BACKOFF = 1.5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Branch context (multi-branch) ───────────────────────────────────────────
// "Branch" == a warehouse/location. When the user focuses a single branch via
// the sidebar switcher, every GET is transparently scoped with ?branch_id=. The
// backend ignores the param on endpoints that don't declare it (FastAPI drops
// undeclared query params), so this is a safe, central way to scope reads
// without touching every page. `null` means "all branches" (admin default).
let _branchFilter = null;
try {
  const v = localStorage.getItem('branch_filter');
  _branchFilter = v && v !== 'all' ? v : null;
} catch { /* localStorage unavailable */ }

export function setBranchFilter(id) {
  _branchFilter = (id == null || id === '' || id === 'all') ? null : String(id);
  try {
    if (_branchFilter == null) localStorage.removeItem('branch_filter');
    else localStorage.setItem('branch_filter', _branchFilter);
  } catch { /* ignore */ }
}

export function getBranchFilter() { return _branchFilter; }

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
    // Scope reads to the focused branch (see the branch-context block above).
    let url = `${BASE}${path}`;
    if (method === 'GET' && _branchFilter != null && !/[?&]branch_id=/.test(path)) {
      url += (path.includes('?') ? '&' : '?') + 'branch_id=' + encodeURIComponent(_branchFilter);
    }
    let res;
    try {
      res = await fetch(url, {
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

// Build a query-string suffix ("?a=1&b=2" or "") from a params object.
const _qs = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return q ? '?' + q : '';
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
export const getClients      = (params = {}, s) => api.get(`/api/clients/${_qs(params)}`, s);
export const unarchiveClient = (id) => api.patch(`/api/clients/${id}/unarchive`);
export const getClient       = (id) => api.get(`/api/clients/${id}`);
export const createClient    = (d) => api.post('/api/clients/', d);
export const updateClient    = (id, d) => api.put(`/api/clients/${id}`, d);
export const archiveClient   = (id, reason) => api.patch(`/api/clients/${id}/archive`, { reason });
// Each module owns a per-module unarchive helper (e.g. unarchiveClient above)
// powering its in-module "Show archived" restore. The generic
// `unarchiveItem(module, id)` remains as a cross-module fallback; the central
// Archives page itself is now a read-only overview.

// Projects
export const getProjects       = (params = {}, s) => api.get(`/api/projects/${_qs(params)}`, s);
export const getProject        = (id) => api.get(`/api/projects/${id}`);
export const createProject     = (d) => api.post('/api/projects/', d);
export const updateProject     = (id, d) => api.put(`/api/projects/${id}`, d);
export const archiveProject    = (id, reason) => api.patch(`/api/projects/${id}/archive`, { reason });
export const unarchiveProject  = (id) => api.patch(`/api/projects/${id}/unarchive`);

// Quotations (proposals only — no payments)
export const getQuotations       = (params = {}, s) => api.get(`/api/quotations/${_qs(params)}`, s);
export const getQuotation        = (id) => api.get(`/api/quotations/${id}`);
export const createQuotation     = (d)  => api.post('/api/quotations/', d);
export const updateQuotation     = (id, d) => api.put(`/api/quotations/${id}`, d);
export const voidQuotation       = (id, reason) => api.patch(`/api/quotations/${id}/void`, { reason });
export const unvoidQuotation     = (id) => api.patch(`/api/quotations/${id}/unvoid`);
export const archiveQuotation    = (id, reason) => api.patch(`/api/quotations/${id}/archive`, { reason });
export const unarchiveQuotation  = (id) => api.patch(`/api/quotations/${id}/unarchive`);
export const convertToInvoice    = (id) => api.post(`/api/quotations/${id}/convert-to-invoice`);
export const convertToProject    = (id) => api.post(`/api/quotations/${id}/convert-to-project`);

// Invoices + cumulative payments
export const getInvoices       = (params = {}, s) => api.get(`/api/invoices/${_qs(params)}`, s);
export const getInvoice        = (id)   => api.get(`/api/invoices/${id}`);
export const createInvoice     = (d)    => api.post('/api/invoices/', d);
export const updateInvoice     = (id, d) => api.put(`/api/invoices/${id}`, d);
export const archiveInvoice    = (id, reason) => api.patch(`/api/invoices/${id}/archive`, { reason });
export const unarchiveInvoice  = (id) => api.patch(`/api/invoices/${id}/unarchive`);
export const voidInvoice       = (id, reason) => api.patch(`/api/invoices/${id}/void`, { reason });
export const unvoidInvoice     = (id)         => api.patch(`/api/invoices/${id}/unvoid`);
export const addInvoicePayment    = (id, d)       => api.post(`/api/invoices/${id}/payments`, d);
export const deleteInvoicePayment = (invId, payId) => api.delete(`/api/invoices/${invId}/payments/${payId}`);

// Inventory
export const getInventory           = (params = {}, s) => api.get(`/api/inventory/${_qs(params)}`, s);
export const getInventoryByWarehouse = (itemId) => api.get(`/api/inventory/${itemId}/by-warehouse`);
export const getInventoryByWarehouseReport = () => api.get('/api/reports/inventory-by-warehouse');
export const getInventoryByAttributeReport = (attribute) => api.get(`/api/reports/inventory-by-attribute${attribute ? `?attribute=${encodeURIComponent(attribute)}` : ''}`);
export const createInventoryItem    = (d)    => api.post('/api/inventory/', d);
export const updateInventoryItem    = (id, d) => api.put(`/api/inventory/${id}`, d);
export const archiveInventoryItem   = (id)   => api.patch(`/api/inventory/${id}/archive`);
export const unarchiveInventoryItem = (id)   => api.patch(`/api/inventory/${id}/unarchive`);
export const updateStock            = (id, d) => api.patch(`/api/inventory/${id}/stock`, d);
export const getStockMovements      = (id)   => api.get(`/api/inventory/${id}/movements`);
export const deductToProject        = (id, d) => api.post(`/api/inventory/${id}/deduct-to-project`, d);
// Products & variants
export const getProducts            = (params = {}, s) => api.get(`/api/products/${_qs(params)}`, s);
export const getProduct             = (id)   => api.get(`/api/products/${id}`);
export const createProduct          = (d)    => api.post('/api/products/', d);
export const updateProduct          = (id, d) => api.put(`/api/products/${id}`, d);
export const archiveProduct         = (id)   => api.patch(`/api/products/${id}/archive`);
// Owner-defined category registry (per domain: inventory/expense/asset/project)
export const getCategories          = (domain) => api.get(`/api/categories${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`);
export const createCategory         = (d)     => api.post('/api/categories', d);
export const updateCategory         = (id, d) => api.put(`/api/categories/${id}`, d);
export const archiveCategory        = (id)    => api.patch(`/api/categories/${id}/archive`);
export const getAttributeDefs       = (params = {}) => api.get(`/api/products/attribute-defs${_qs(params)}`);
export const createAttributeDef     = (d)    => api.post('/api/products/attribute-defs', d);
export const updateAttributeDef     = (id, d) => api.put(`/api/products/attribute-defs/${id}`, d);
export const deleteAttributeDef     = (id)   => api.delete(`/api/products/attribute-defs/${id}`);
// Promotions (automatic POS discounts)
export const getPromotions          = (params = {}) => api.get(`/api/promotions/${_qs(params)}`);
export const getActivePromotions    = ()     => api.get('/api/promotions/active');
export const createPromotion        = (d)    => api.post('/api/promotions/', d);
export const updatePromotion        = (id, d) => api.put(`/api/promotions/${id}`, d);
export const togglePromotion        = (id)   => api.patch(`/api/promotions/${id}/toggle`);
export const archivePromotion       = (id)   => api.patch(`/api/promotions/${id}/archive`);
// Batch / lot tracking
export const getLots                = (params = {}) => api.get(`/api/inventory/lots${_qs(params)}`);
export const getLot                 = (id)   => api.get(`/api/inventory/lots/${id}`);

// Purchases
export const getPurchases         = (qs)   => api.get(`/api/purchases/${qs || ''}`);
export const getPurchaseStats     = ()     => api.get('/api/purchases/stats');
export const createPurchase       = (d)    => api.post('/api/purchases/', d);
export const createBulkPurchase   = (d)    => api.post('/api/purchases/bulk', d);
export const updatePurchase       = (id, d) => api.put(`/api/purchases/${id}`, d);
export const updatePurchaseStatus = (id, status) => api.patch(`/api/purchases/${id}/status`, { status });
export const archivePurchase      = (id)   => api.patch(`/api/purchases/${id}/archive`);
export const unarchivePurchase    = (id)   => api.patch(`/api/purchases/${id}/unarchive`);

// Finance
export const getMonthlyReport = (s) => api.get('/api/finance/monthly', s);
export const getExpenses        = (s) => api.get('/api/finance/expenses', s);
export const createExpense      = (d) => api.post('/api/finance/expenses', d);
export const updateExpense      = (id, d) => api.put(`/api/finance/expenses/${id}`, d);
export const voidExpense        = (id, reason) => api.patch(`/api/finance/expenses/${id}/void`, { reason });

// Finance — range-based endpoints
export const getFinanceRangeSummary = (params = {}, s) => api.get(`/api/finance/range-summary${_qs(params)}`, s);
export const getFinanceRangeMonthly = (params = {}, s) => api.get(`/api/finance/range-monthly${_qs(params)}`, s);
export const getFinanceRangeDetail  = (params = {}, s) => api.get(`/api/finance/range-detail${_qs(params)}`, s);

// Distinct category values actually used on inventory rows (not the registry).
// Kept for back-compat where a "categories in use" list is wanted.
export async function getUsedCategories() {
  const res = await fetch('/api/inventory/categories', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load categories');
  return res.json();
}
// Users (admin only)
export const getUsers            = (params = {}) => api.get(`/api/users/${_qs(params)}`);
export const getUser             = (id)    => api.get(`/api/users/${id}`);
export const createUser          = (d)     => api.post('/api/users/', d);
export const updateUser          = (id, d) => api.put(`/api/users/${id}`, d);
export const deleteUser          = (id)    => api.delete(`/api/users/${id}`);
export const resetUserPassword   = (id, d) => api.post(`/api/users/${id}/reset-password`, d);
export const toggleUserActive    = (id)    => api.patch(`/api/users/${id}/toggle-active`);
export const getUserSessions     = ()      => api.get('/api/users/sessions');
export const getOnlineUsers      = ()      => api.get('/api/users/online');
export const revokeSession       = (id)    => api.delete(`/api/users/sessions/${id}`);

// Roles (admin only)
export const getRoles            = ()      => api.get('/api/roles/');
export const getRole             = (id)    => api.get(`/api/roles/${id}`);
export const createRole          = (d)     => api.post('/api/roles/', d);
export const updateRole          = (id, d) => api.put(`/api/roles/${id}`, d);
export const deleteRole          = (id)    => api.delete(`/api/roles/${id}`);
export const setRolePermissions  = (id, d) => api.put(`/api/roles/${id}/permissions`, d);

// Suppliers
export const getSuppliers      = (params = {}) => api.get(`/api/suppliers/${_qs(params)}`);
export const getSupplier       = (id)    => api.get(`/api/suppliers/${id}`);
export const createSupplier    = (d)     => api.post('/api/suppliers/', d);
export const updateSupplier    = (id, d) => api.put(`/api/suppliers/${id}`, d);
export const archiveSupplier   = (id)    => api.patch(`/api/suppliers/${id}/archive`);
export const unarchiveSupplier = (id)    => api.patch(`/api/suppliers/${id}/unarchive`);

// Bulk import wizard (clients / suppliers / inventory)
export const getImportSchema = (entity)       => api.get(`/api/imports/${entity}/schema`);
export const validateImport  = (entity, body) => api.post(`/api/imports/${entity}/validate`, body);
export const commitImport    = (entity, body) => api.post(`/api/imports/${entity}/commit`, body);

// Audit log
export const getAuditLog = (params = {}) => api.get(`/api/audit/${_qs(params)}`);
export const getAuditFilters = () => api.get('/api/audit/filters');
export const purgeAuditLog = (olderThanDays) =>
  api.delete(`/api/audit/purge?older_than_days=${olderThanDays}`);

// Documents — only the writers are used at the moment; list/read/delete
// helpers exist server-side but are wired up per-feature elsewhere.
export const saveDocument       = (d)         => api.post('/api/documents/', d);
export const getDocumentContent = (id)        => api.get(`/api/documents/${id}/content`);

// Global search
export const searchAll = (q, signal) => api.get(`/api/search/?q=${encodeURIComponent(q)}`, signal);

// Settings — backup & integrity
export const getBackupStatus   = ()  => api.get('/api/settings/backup-status');
export const runBackupNow      = ()  => api.post('/api/settings/backup-now');
export const exportBackup      = (d) => api.post('/api/settings/backup-export', d);
export const runIntegrityCheck = ()  => api.get('/api/settings/integrity-check');

// Settings — exchange rate (manual, admin-set)
export const getExchangeRate   = ()  => api.get('/api/settings/exchange-rate');
export const setExchangeRate   = (d) => api.post('/api/settings/exchange-rate', d);

// Tax rates (admin-managed configuration)
export const getTaxRates    = (s)     => api.get('/api/tax-rates/', s);
export const createTaxRate  = (d)     => api.post('/api/tax-rates/', d);
export const updateTaxRate  = (id, d) => api.put(`/api/tax-rates/${id}`, d);
export const deleteTaxRate  = (id)    => api.delete(`/api/tax-rates/${id}`);

// Setup wizard (no auth). These bypass the shared `request()` interceptor, so
// they must parse defensively: a 500 returns plain text ("Internal Server
// Error"), which a naive r.json() turns into a confusing
// "Unexpected token 'I'…" instead of a real message.
async function _readSetupJson(res) {
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { /* non-JSON error page */ } }
  if (!res.ok) {
    throw new Error(
      (body && (body.detail || body.message)) ||
      (res.status >= 500
        ? 'Server error during setup. If you just reset the database, restart the app and try again.'
        : `Setup failed (HTTP ${res.status}).`)
    );
  }
  return body ?? {};
}
export const getSetupStatus  = ()  => fetch('/api/settings/setup-status').then(_readSetupJson);
export const completeSetup   = (d) => fetch('/api/settings/complete-setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d),
}).then(_readSetupJson);

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
export const getReportFinancial    = (params = {}, s) => api.get(`/api/reports/financial${_qs(params)}`, s);
export const getReportProjects     = (params = {}, s) => api.get(`/api/reports/projects${_qs(params)}`, s);
export const getReportClients      = (params = {}, s) => api.get(`/api/reports/clients${_qs(params)}`, s);
export const getReportInvoiceAging = (s)              => api.get('/api/reports/invoice-aging', s);
export const getReportExpenses     = (params = {}, s) => api.get(`/api/reports/expenses${_qs(params)}`, s);
export const getReportPipeline     = (params = {}, s) => api.get(`/api/reports/pipeline${_qs(params)}`, s);
export const getReportVAT          = (params = {}, s) => api.get(`/api/reports/vat${_qs(params)}`, s);
export const getBranchComparison   = (params = {}, s) => api.get(`/api/reports/branch-comparison${_qs(params)}`, s);

// CRM
export const getCRMDashboard   = (s)              => api.get('/api/crm/dashboard', s);
export const getCRMLeads       = (params = {}, s) => api.get(`/api/crm/leads${_qs(params)}`, s);
export const getCRMLead        = (id)             => api.get(`/api/crm/leads/${id}`);
export const createCRMLead     = (d)              => api.post('/api/crm/leads', d);
export const updateCRMLead     = (id, d)          => api.put(`/api/crm/leads/${id}`, d);
export const archiveCRMLead    = (id)             => api.patch(`/api/crm/leads/${id}/archive`);
export const unarchiveCRMLead  = (id)             => api.patch(`/api/crm/leads/${id}/unarchive`);
export const convertCRMLead    = (id, d)          => api.post(`/api/crm/leads/${id}/convert`, d);
export const getCRMContacts    = (params = {}, s) => api.get(`/api/crm/contacts${_qs(params)}`, s);
export const createCRMContact  = (d)              => api.post('/api/crm/contacts', d);
export const updateCRMContact  = (id, d)          => api.put(`/api/crm/contacts/${id}`, d);
export const deleteCRMContact  = (id)             => api.delete(`/api/crm/contacts/${id}`);
export const getCRMActivities  = (params = {}, s) => api.get(`/api/crm/activities${_qs(params)}`, s);
export const createCRMActivity = (d)              => api.post('/api/crm/activities', d);
export const updateCRMActivity = (id, d)          => api.put(`/api/crm/activities/${id}`, d);
export const toggleActivityDone = (id)            => api.patch(`/api/crm/activities/${id}/done`);
export const deleteCRMActivity = (id)             => api.delete(`/api/crm/activities/${id}`);
export const getCRMDeals       = (params = {}, s) => api.get(`/api/crm/deals${_qs(params)}`, s);
export const createCRMDeal     = (d)              => api.post('/api/crm/deals', d);
export const updateCRMDeal     = (id, d)          => api.put(`/api/crm/deals/${id}`, d);
export const updateDealStage   = (id, d)          => api.patch(`/api/crm/deals/${id}/stage`, d);
export const archiveCRMDeal    = (id)             => api.patch(`/api/crm/deals/${id}/archive`);
export const unarchiveCRMDeal  = (id)             => api.patch(`/api/crm/deals/${id}/unarchive`);
export const getCRMDropdownClients    = ()         => api.get('/api/crm/dropdown/clients');
export const getCRMDropdownQuotations = ()         => api.get('/api/crm/dropdown/quotations');
export const getCRMDropdownUsers      = ()         => api.get('/api/crm/dropdown/users');

// Planning
export const getPlanningProjects    = (params = {}, s) => api.get(`/api/planning/projects${_qs(params)}`, s);
export const createPlanningProject  = (d)              => api.post('/api/planning/projects', d);
export const updatePlanningProject  = (id, d)          => api.put(`/api/planning/projects/${id}`, d);
export const archivePlanningProject = (id)             => api.patch(`/api/planning/projects/${id}/archive`);
export const unarchivePlanningProject = (id)           => api.patch(`/api/planning/projects/${id}/unarchive`);
export const getPlanningTasks       = (params = {}, s) => api.get(`/api/planning/tasks${_qs(params)}`, s);
export const createPlanningTask     = (d)              => api.post('/api/planning/tasks', d);
export const updatePlanningTask     = (id, d)          => api.put(`/api/planning/tasks/${id}`, d);
export const updateTaskDates        = (id, d)          => api.patch(`/api/planning/tasks/${id}/dates`, d);
export const updateTaskStatus       = (id, d)          => api.patch(`/api/planning/tasks/${id}/status`, d);
export const updateTaskProgress     = (id, d)          => api.patch(`/api/planning/tasks/${id}/progress`, d);
export const archivePlanningTask    = (id)             => api.patch(`/api/planning/tasks/${id}/archive`);
export const unarchivePlanningTask  = (id)             => api.patch(`/api/planning/tasks/${id}/unarchive`);
export const getPlanningMilestones  = (params = {}, s) => api.get(`/api/planning/milestones${_qs(params)}`, s);
export const getPlanningSummary     = (s)              => api.get('/api/planning/summary', s);
export const getPlanningDropdownClients = ()           => api.get('/api/planning/dropdown/clients');
export const getPlanningDropdownUsers   = ()           => api.get('/api/planning/dropdown/users');

// Standalone calendar events (independent of projects/tasks)
export const getPlanningEvents      = (params = {}, s) => api.get(`/api/planning/events${_qs(params)}`, s);
export const createPlanningEvent    = (d)              => api.post('/api/planning/events', d);
export const updatePlanningEvent    = (id, d)          => api.put(`/api/planning/events/${id}`, d);
export const deletePlanningEvent    = (id)             => api.delete(`/api/planning/events/${id}`);

// Finance — accounting periods + reconciliation
export const getFinancePeriods   = ()              => api.get('/api/finance/periods');
export const lockPeriod          = (year, month)   => api.post(`/api/finance/periods/${year}/${month}/lock`);
export const unlockPeriod        = (year, month)   => api.post(`/api/finance/periods/${year}/${month}/unlock`);
export const getReconciliation   = ()              => api.get('/api/finance/reconciliation');

// Notifications
export const getNotifications      = (params = {}) => api.get(`/api/notifications/${_qs(params)}`);
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
export const getApprovalRequests    = (params = {}) => api.get(`/api/approval-requests/${_qs(params)}`);
export const getApprovalRequest     = (id)          => api.get(`/api/approval-requests/${id}`);
export const approveRequest         = (id, d = {})  => api.post(`/api/approval-requests/${id}/approve`, d);
export const rejectRequest          = (id, d = {})  => api.post(`/api/approval-requests/${id}/reject`, d);
export const forceApproveRequest    = (id, d = {})  => api.post(`/api/approval-requests/${id}/force-approve`, d);
export const cancelApprovalRequest  = (id, d = {})  => api.post(`/api/approval-requests/${id}/cancel`, d);

// Human Resources
export const getHRSummary        = ()            => api.get('/api/hr/summary');
export const getDepartments      = (params = {}) => api.get(`/api/hr/departments${_qs(params)}`);
export const createDepartment    = (d)           => api.post('/api/hr/departments', d);
export const updateDepartment    = (id, d)       => api.put(`/api/hr/departments/${id}`, d);
export const archiveDepartment   = (id)          => api.patch(`/api/hr/departments/${id}/archive`);
export const unarchiveDepartment = (id)          => api.patch(`/api/hr/departments/${id}/unarchive`);
export const getEmployees        = (params = {}) => api.get(`/api/hr/employees${_qs(params)}`);
export const getEmployee         = (id)          => api.get(`/api/hr/employees/${id}`);
export const createEmployee      = (d)           => api.post('/api/hr/employees', d);
export const updateEmployee      = (id, d)       => api.put(`/api/hr/employees/${id}`, d);
export const archiveEmployee     = (id)          => api.patch(`/api/hr/employees/${id}/archive`);
export const unarchiveEmployee   = (id)          => api.patch(`/api/hr/employees/${id}/unarchive`);
// Attendance (daily)
export const getAttendance        = (date)        => api.get(`/api/hr/attendance?date=${encodeURIComponent(date)}`);
export const saveAttendanceBulk   = (d)           => api.post('/api/hr/attendance/bulk', d);
export const getAttendanceSummary = (month)       => api.get(`/api/hr/attendance/summary?month=${encodeURIComponent(month)}`);
export const getLeaveRequests    = (params = {}) => api.get(`/api/hr/leave${_qs(params)}`);
export const createLeaveRequest  = (d)           => api.post('/api/hr/leave', d);
export const approveLeave        = (id, d = {})  => api.post(`/api/hr/leave/${id}/approve`, d);
export const rejectLeave         = (id, d = {})  => api.post(`/api/hr/leave/${id}/reject`, d);
export const deleteLeaveRequest  = (id)          => api.delete(`/api/hr/leave/${id}`);

// ── HR: employee file attachments (CV / contract / other) ─────────────────
// Uploads go through a raw fetch because they're multipart, not JSON. We
// keep the cookie-credentialed pattern so HttpOnly auth stays consistent
// with the rest of the API.
export async function uploadEmployeeFile(empId, kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  const res = await fetch(`/api/hr/employees/${empId}/files`, {
    method: 'POST', body: fd, credentials: 'include',
  });
  if (res.status === 401) {
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }
  if (!res.ok) { throw new Error(await extractError(res)); }
  return res.json();
}
export const getEmployeeFiles    = (empId)     => api.get(`/api/hr/employees/${empId}/files`);
export const deleteEmployeeFile  = (fileId)    => api.delete(`/api/hr/files/${fileId}`);
export const employeeFileURL     = (fileId)    => `/api/hr/files/${fileId}/download`;

// ── HR: payroll runs ───────────────────────────────────────────────────────
export const getPayrollRuns      = (params = {}) => api.get(`/api/hr/payroll/runs${_qs(params)}`);
export const getPayrollRun       = (id)          => api.get(`/api/hr/payroll/runs/${id}`);
export const createPayrollRun    = (d)           => api.post('/api/hr/payroll/runs', d);
export const updatePayrollLine   = (lineId, d)   => api.put(`/api/hr/payroll/lines/${lineId}`, d);
export const approvePayrollRun   = (id)          => api.post(`/api/hr/payroll/runs/${id}/approve`);
export const markPayrollRunPaid  = (id)          => api.post(`/api/hr/payroll/runs/${id}/mark-paid`);
export const cancelPayrollRun    = (id)          => api.post(`/api/hr/payroll/runs/${id}/cancel`);

// ── HR: contracts ──────────────────────────────────────────────────────────
export const getContracts          = (params = {}) => api.get(`/api/hr/contracts/${_qs(params)}`);
export const getContract           = (id)          => api.get(`/api/hr/contracts/${id}`);
export const createContract        = (d)           => api.post('/api/hr/contracts/', d);
export const updateContract        = (id, d)       => api.put(`/api/hr/contracts/${id}`, d);
export const setContractStatus     = (id, d)       => api.post(`/api/hr/contracts/${id}/status`, d);
export const archiveContract       = (id)          => api.patch(`/api/hr/contracts/${id}/archive`);
export const getContractPrintData  = (id)          => api.get(`/api/hr/contracts/${id}/print-data`);

// ── Recruitment ────────────────────────────────────────────────────────────
export const getRecruitmentSummary = ()          => api.get('/api/recruitment/summary');
export const getPositions          = (params = {}) => api.get(`/api/recruitment/positions${_qs(params)}`);
export const getPosition           = (id)          => api.get(`/api/recruitment/positions/${id}`);
export const createPosition        = (d)           => api.post('/api/recruitment/positions', d);
export const updatePosition        = (id, d)       => api.put(`/api/recruitment/positions/${id}`, d);
export const archivePosition       = (id)          => api.patch(`/api/recruitment/positions/${id}/archive`);

export const getApplicants         = (params = {}) => api.get(`/api/recruitment/applicants${_qs(params)}`);
export const getApplicant          = (id)          => api.get(`/api/recruitment/applicants/${id}`);
export const createApplicant       = (d)           => api.post('/api/recruitment/applicants', d);
export const updateApplicant       = (id, d)       => api.put(`/api/recruitment/applicants/${id}`, d);
export const changeApplicantStatus = (id, d)       => api.post(`/api/recruitment/applicants/${id}/status`, d);
export const archiveApplicant      = (id)          => api.patch(`/api/recruitment/applicants/${id}/archive`);
export const convertApplicant      = (id, d = {})  => api.post(`/api/recruitment/applicants/${id}/convert`, d);

export const scheduleInterview     = (appId, d)    => api.post(`/api/recruitment/applicants/${appId}/interviews`, d);
export const updateInterview       = (id, d)       => api.put(`/api/recruitment/interviews/${id}`, d);
export const deleteInterview       = (id)          => api.delete(`/api/recruitment/interviews/${id}`);

// Applicant file upload — multipart, parallel to uploadEmployeeFile.
export async function uploadApplicantFile(appId, kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  const res = await fetch(`/api/recruitment/applicants/${appId}/files`, {
    method: 'POST', body: fd, credentials: 'include',
  });
  if (res.status === 401) {
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }
  if (!res.ok) { throw new Error(await extractError(res)); }
  return res.json();
}
export const getApplicantFiles    = (appId)   => api.get(`/api/recruitment/applicants/${appId}/files`);
export const deleteApplicantFile  = (fileId)  => api.delete(`/api/recruitment/files/${fileId}`);
export const applicantFileURL     = (fileId)  => `/api/recruitment/files/${fileId}/download`;

// Pre-employment offer letters / draft contracts attached to an applicant.
// Distinct from hr/contracts (which require an employee record).
export const getApplicantOffers   = (appId)        => api.get(`/api/recruitment/applicants/${appId}/offers`);
export const createApplicantOffer = (appId, d)     => api.post(`/api/recruitment/applicants/${appId}/offers`, d);
export const updateOffer          = (offerId, d)   => api.put(`/api/recruitment/offers/${offerId}`, d);
export const changeOfferStatus    = (offerId, d)   => api.post(`/api/recruitment/offers/${offerId}/status`, d);
export const archiveOffer         = (offerId)      => api.patch(`/api/recruitment/offers/${offerId}/archive`);
export const getOfferPrintData    = (offerId)      => api.get(`/api/recruitment/offers/${offerId}/print-data`);

// ── HR Activities ───────────────────────────────────────────────────────────
// Personal HR queue — calls, meetings, interviews, emails, notes — with
// time-deferred reminder notifications. Scoped per user on the backend.
export const getHRActivities          = (params = {}, s) => api.get(`/api/hr-activities${_qs(params)}`, s);
export const getHRActivity            = (id)             => api.get(`/api/hr-activities/${id}`);
export const getHRActivitiesSummary   = ()               => api.get('/api/hr-activities/summary');
export const createHRActivity         = (d)              => api.post('/api/hr-activities', d);
export const updateHRActivity         = (id, d)          => api.put(`/api/hr-activities/${id}`, d);
export const completeHRActivity       = (id, d = {})     => api.patch(`/api/hr-activities/${id}/complete`, d);
export const archiveHRActivity        = (id)             => api.patch(`/api/hr-activities/${id}/archive`);
export const getHRActivityApplicants  = ()               => api.get('/api/hr-activities/dropdown/applicants');
export const getHRActivityEmployees   = ()               => api.get('/api/hr-activities/dropdown/employees');

// Point of Sale
export const getPosSession     = (s)          => api.get('/api/pos/session/current', s);
export const openPosSession    = (d)          => api.post('/api/pos/session/open', d);
export const closePosSession   = (d)          => api.post('/api/pos/session/close', d);
export const getPosSessions    = (params = {}) => api.get(`/api/pos/sessions${_qs(params)}`);
export const posCheckout       = (d)          => api.post('/api/pos/checkout', d);
export const getPosSales       = (params = {}) => api.get(`/api/pos/sales${_qs(params)}`);
export const getPosSale        = (id)         => api.get(`/api/pos/sales/${id}`);
export const returnPosSale     = (id, reason) => api.post(`/api/pos/sales/${id}/return`, { reason });
export const getPosProducts    = (search, s)  => api.get(`/api/pos/products${_qs(search ? { search } : {})}`, s);
export const getPosCashDrawers = ()            => api.get('/api/pos/cash-drawers');

// Cash & Daily Reconciliation
export const getCashDrawers          = ()           => api.get('/api/cash/drawers');
export const createCashDrawer        = (d)          => api.post('/api/cash/drawers', d);
export const updateCashDrawer        = (id, d)      => api.put(`/api/cash/drawers/${id}`, d);
export const getCashSummary          = (date)       => api.get(`/api/cash/summary${_qs(date ? { date } : {})}`);
export const getCashReconciliations  = (params = {}) => api.get(`/api/cash/reconciliations${_qs(params)}`);
export const getCashReconciliation   = (id)         => api.get(`/api/cash/reconciliations/${id}`);
export const openCashReconciliation  = (d)          => api.post('/api/cash/reconciliations', d);
export const addCashMovement         = (id, d)      => api.post(`/api/cash/reconciliations/${id}/movements`, d);
export const deleteCashMovement      = (id, mid)    => api.delete(`/api/cash/reconciliations/${id}/movements/${mid}`);
export const closeCashReconciliation = (id, d)      => api.post(`/api/cash/reconciliations/${id}/close`, d);
export const reopenCashReconciliation = (id)        => api.post(`/api/cash/reconciliations/${id}/reopen`);

// Manufacturing — versioned BOMs & production-order lifecycle
export const getBoms                  = ()          => api.get('/api/manufacturing/boms');
export const getBom                   = (id)        => api.get(`/api/manufacturing/boms/${id}`);
export const getBomVersions            = (id)        => api.get(`/api/manufacturing/boms/${id}/versions`);
export const createBom                = (d)         => api.post('/api/manufacturing/boms', d);
export const updateBom                = (id, d)     => api.put(`/api/manufacturing/boms/${id}`, d);
export const createBomVersion          = (id, d)     => api.post(`/api/manufacturing/boms/${id}/new-version`, d);
export const archiveBom                = (id)       => api.patch(`/api/manufacturing/boms/${id}/archive`);
export const getProductionOrders       = (params = {}) => api.get(`/api/manufacturing/orders${_qs(params)}`);
export const getProductionOrder        = (id)       => api.get(`/api/manufacturing/orders/${id}`);
export const createProductionOrder     = (d)        => api.post('/api/manufacturing/orders', d);
export const updateProductionOrder     = (id, d)    => api.put(`/api/manufacturing/orders/${id}`, d);
export const confirmProductionOrder    = (id)       => api.post(`/api/manufacturing/orders/${id}/confirm`);
export const startProductionOrder      = (id)       => api.post(`/api/manufacturing/orders/${id}/start`);
export const completeProductionOrder   = (id, d = {}) => api.post(`/api/manufacturing/orders/${id}/complete`, d);
export const cancelProductionOrder     = (id, reason) => api.post(`/api/manufacturing/orders/${id}/cancel`, { reason });
export const archiveProductionOrder    = (id)       => api.patch(`/api/manufacturing/orders/${id}/archive`);
export const getManufacturingProducts  = (params = {}) => api.get(`/api/manufacturing/products${_qs(params)}`);
export const getManufacturingSummary   = ()         => api.get('/api/manufacturing/summary');
export const getManufacturingAnalytics = (params = {}) => api.get(`/api/manufacturing/analytics${_qs(params)}`);
// Manufacturing resources — reusable per-hour cost rates (Labor, Electricity, CNC, …)
export const getResources    = (params = {}) => api.get(`/api/manufacturing/resources${_qs(params)}`);
export const createResource  = (d)     => api.post('/api/manufacturing/resources', d);
export const updateResource  = (id, d) => api.put(`/api/manufacturing/resources/${id}`, d);
export const archiveResource = (id)    => api.patch(`/api/manufacturing/resources/${id}/archive`);
// Quality control — quarantine inspections (release / reject / rework)
export const getQCInspections  = (params = {}) => api.get(`/api/manufacturing/qc${_qs(params)}`);
export const getQCInspection   = (id)    => api.get(`/api/manufacturing/qc/${id}`);
export const resolveQC         = (id, d) => api.post(`/api/manufacturing/qc/${id}/resolve`, d);

// Fixed Assets
export const getAssets          = (params = {}, s) => api.get(`/api/assets${_qs(params)}`, s);
export const getAsset           = (id)       => api.get(`/api/assets/${id}`);
export const getAssetsSummary   = (s)        => api.get('/api/assets/summary', s);
export const createAsset        = (d)        => api.post('/api/assets', d);
export const updateAsset        = (id, d)    => api.put(`/api/assets/${id}`, d);
export const depreciateAsset    = (id, d = {}) => api.post(`/api/assets/${id}/depreciate`, d);
export const runDepreciation    = (d = {})   => api.post('/api/assets/depreciation/run', d);
export const disposeAsset       = (id, d)    => api.post(`/api/assets/${id}/dispose`, d);
export const archiveAsset       = (id)       => api.patch(`/api/assets/${id}/archive`);

// Recurring Expenses
export const getRecurringExpenses   = (params = {}, s) => api.get(`/api/recurring-expenses${_qs(params)}`, s);
export const getRecurringExpense    = (id)    => api.get(`/api/recurring-expenses/${id}`);
export const createRecurringExpense = (d)     => api.post('/api/recurring-expenses', d);
export const updateRecurringExpense = (id, d) => api.put(`/api/recurring-expenses/${id}`, d);
export const toggleRecurringExpense = (id)    => api.patch(`/api/recurring-expenses/${id}/toggle`);
export const runRecurringExpense    = (id)    => api.post(`/api/recurring-expenses/${id}/run`);
export const runDueRecurringExpenses = ()     => api.post('/api/recurring-expenses/run-due');
export const archiveRecurringExpense = (id)   => api.patch(`/api/recurring-expenses/${id}/archive`);
export const unarchiveRecurringExpense = (id) => api.patch(`/api/recurring-expenses/${id}/unarchive`);

// ── Attachments (generic — files on any business entity) ─────────────────────
// One set of helpers backs every module. `entityType` is one of the keys in the
// backend ENTITY_REGISTRY (invoices, purchases, projects, expenses, assets,
// suppliers, clients, quotations, inventory).
export const getAttachments   = (entityType, entityId) =>
  api.get(`/api/attachments/${entityType}/${entityId}`);
export const deleteAttachment = (attachmentId) =>
  api.delete(`/api/attachments/file/${attachmentId}`);
export const attachmentURL    = (attachmentId, download = false) =>
  `/api/attachments/file/${attachmentId}${download ? '?download=true' : ''}`;
// Multipart upload — mirrors uploadEmployeeFile (cookie-credentialed, not JSON).
export async function uploadAttachment(entityType, entityId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/attachments/${entityType}/${entityId}`, {
    method: 'POST', body: fd, credentials: 'include',
  });
  if (res.status === 401) {
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }
  if (!res.ok) { throw new Error(await extractError(res)); }
  return res.json();
}

// ── Accounting (double-entry: Chart of Accounts, Journal, Ledger, statements) ─
export const getAccounts          = (params = {}) => api.get(`/api/accounting/accounts${_qs(params)}`);
export const createAccount        = (d)      => api.post('/api/accounting/accounts', d);
export const updateAccount        = (id, d)  => api.put(`/api/accounting/accounts/${id}`, d);
export const deleteAccount        = (id)     => api.delete(`/api/accounting/accounts/${id}`);
export const getJournalEntries    = (params = {}) => api.get(`/api/accounting/journal-entries${_qs(params)}`);
export const getJournalEntry      = (id)     => api.get(`/api/accounting/journal-entries/${id}`);
export const createJournalEntry   = (d)      => api.post('/api/accounting/journal-entries', d);
export const reverseJournalEntry  = (id)     => api.post(`/api/accounting/journal-entries/${id}/reverse`);
export const getGeneralLedger     = (params = {}) => api.get(`/api/accounting/general-ledger${_qs(params)}`);
export const getTrialBalance      = (params = {}) => api.get(`/api/accounting/trial-balance${_qs(params)}`);
export const getBalanceSheet      = (params = {}) => api.get(`/api/accounting/balance-sheet${_qs(params)}`);
export const getIncomeStatement   = (params = {}) => api.get(`/api/accounting/income-statement${_qs(params)}`);
export const getCashFlow          = (params = {}) => api.get(`/api/accounting/cash-flow${_qs(params)}`);
export const getAccountingSummary = (params = {}) => api.get(`/api/accounting/summary${_qs(params)}`);
// Financial-year closing
export const getFiscalYears   = ()     => api.get('/api/accounting/fiscal-years');
export const closeFiscalYear  = (year) => api.post(`/api/accounting/fiscal-years/${year}/close`);
export const reopenFiscalYear = (year) => api.post(`/api/accounting/fiscal-years/${year}/reopen`);

// Announcements — internal top-down communication
export const getAnnouncements           = (s)            => api.get('/api/announcements/', s);
export const getAnnouncementsSent       = ()             => api.get('/api/announcements/sent');
export const getAnnouncementsUnread     = (s)            => api.get('/api/announcements/unread-count', s);
export const getAnnouncement            = (id)           => api.get(`/api/announcements/${id}`);
export const createAnnouncement         = (d)            => api.post('/api/announcements/', d);
export const archiveAnnouncement        = (id)           => api.delete(`/api/announcements/${id}`);
export const acknowledgeAnnouncement    = (id)           => api.post(`/api/announcements/${id}/acknowledge`);
export const getAnnouncementComments    = (id)           => api.get(`/api/announcements/${id}/comments`);
export const postAnnouncementComment    = (id, body)     => api.post(`/api/announcements/${id}/comments`, { body });
export const deleteAnnouncementComment  = (id, cid)      => api.delete(`/api/announcements/${id}/comments/${cid}`);
export const getAnnouncementAudience    = (id)           => api.get(`/api/announcements/${id}/audience`);
export const getAnnouncementRolesMeta   = ()             => api.get('/api/announcements/meta/roles');
export const getAnnouncementUsersMeta   = ()             => api.get('/api/announcements/meta/users');

// Warehouses — multi-location stock
export const getWarehouses            = (params = {})  => api.get(`/api/warehouses/${_qs(params)}`);
export const getMyWarehouses          = ()             => api.get('/api/warehouses/me/accessible');
export const getBranchContext         = ()             => api.get('/api/warehouses/me/branch-context');
export const getWarehouse             = (id)           => api.get(`/api/warehouses/${id}`);
export const createWarehouse          = (d)            => api.post('/api/warehouses/', d);
export const updateWarehouse          = (id, d)        => api.put(`/api/warehouses/${id}`, d);
export const setDefaultWarehouse      = (id)           => api.post(`/api/warehouses/${id}/set-default`);
export const archiveWarehouse         = (id)           => api.patch(`/api/warehouses/${id}/archive`);
export const unarchiveWarehouse       = (id)           => api.patch(`/api/warehouses/${id}/unarchive`);
export const getWarehouseAccess       = (id)           => api.get(`/api/warehouses/${id}/access`);
export const grantWarehouseAccess     = (id, userId)   => api.post(`/api/warehouses/${id}/access`, { user_id: userId });
export const revokeWarehouseAccess    = (id, userId)   => api.delete(`/api/warehouses/${id}/access/${userId}`);
export const getWarehouseStock        = (id)           => api.get(`/api/warehouses/${id}/stock`);
// Stock transfers
export const getStockTransfers        = (params = {})  => api.get(`/api/warehouses/transfers/${_qs(params)}`);
export const getStockTransfer         = (id)           => api.get(`/api/warehouses/transfers/${id}`);
export const createStockTransfer      = (d)            => api.post('/api/warehouses/transfers/', d);
export const dispatchStockTransfer    = (id)           => api.post(`/api/warehouses/transfers/${id}/dispatch`);
export const receiveStockTransfer     = (id, d = {})   => api.post(`/api/warehouses/transfers/${id}/receive`, d);
export const cancelStockTransfer      = (id, reason)   => api.post(`/api/warehouses/transfers/${id}/cancel`, { reason });
