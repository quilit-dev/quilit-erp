import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { getUserSessions, getOnlineUsers, getAuditLog, getAuditFilters, verifyAuditChain, purgeAuditLog, getUsers, getRoles, revokeSession } from '../api/client';
import { LoadingSpinner, ErrorAlert, toast } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';

const ACTION_COLORS = {
  create: 'green', update: 'blue', edit: 'blue', delete: 'red', restore: 'yellow',
  payment: 'accent', reset_password: 'red', enable: 'green', disable: 'red',
  update_permissions: 'blue',
  void: 'red', unvoid: 'green', archive: 'yellow', unarchive: 'green',
  approve: 'green', reject: 'red', force_approve: 'yellow', cancel: 'red',
  login: 'blue', logout: 'gray', change_password: 'red',
  mark_paid: 'accent', stock_adjust: 'blue', status_change: 'blue',
  convert_to_invoice: 'accent', convert_to_project: 'accent',
  export: 'yellow', import: 'yellow', backup: 'yellow', purge: 'red',
};

function KpiCard({ label, value, sub, color = 'accent' }) {
  return (
    <div className="card" style={{ padding: '16px 20px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: `var(--${color})`, margin: '4px 0 2px' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{sub}</div>}
    </div>
  );
}

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function parseUa(ua) {
  if (!ua) return '—';
  if (/Chrome/.test(ua) && !/Edg|OPR/.test(ua)) return 'Chrome';
  if (/Firefox/.test(ua)) return 'Firefox';
  if (/Edg/.test(ua)) return 'Edge';
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/OPR|Opera/.test(ua)) return 'Opera';
  return 'Browser';
}

export default function AdminDashboard() {
  const { t } = useLocale();
  const me = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; } })();

  // Pretty names for known module keys; anything not listed falls back to the
  // raw key, so a new audited module is never hidden — at worst unstyled.
  const MODULE_LABELS = {
    dashboard: t('nav.dashboard'), clients: t('nav.clients'), client: t('nav.clients'),
    projects: t('nav.projects'), project: t('nav.projects'),
    quotations: t('nav.quotations'), quotation: t('nav.quotations'),
    invoices: t('nav.invoices'), invoice: t('nav.invoices'),
    inventory: t('nav.inventory'), warehouses: t('nav.warehouses'), warehouse: t('nav.warehouses'),
    purchases: t('nav.purchases'), purchase: t('nav.purchases'),
    suppliers: t('nav.suppliers'), supplier: t('nav.suppliers'),
    finance: t('nav.finance'), expenses: t('nav.expenses'), expense: t('nav.expenses'),
    accounting: t('nav.accounting'), journal_entry: t('nav.accounting'),
    reports: t('nav.reports'), crm: t('nav.crm'), planning: t('nav.planning'),
    planning_milestone: t('nav.planning'), planning_event: t('nav.planning'),
    pos: t('nav.pos'), cash: t('nav.cash'),
    manufacturing: t('nav.manufacturing'),
    asset: t('nav.fixedAssets'), assets: t('nav.fixedAssets'),
    hr: t('nav.hr'), hr_employee: t('nav.hr'), hr_department: t('nav.hr'),
    hr_leave: t('nav.hr'), hr_payroll_run: t('nav.hr'), hr_payroll_line: t('nav.hr'),
    hr_employee_file: t('nav.hr'), hr_contracts: t('nav.hrContracts'),
    hr_activities: t('nav.hrActivities'), recruitment: t('nav.recruitment'),
    announcements: t('nav.announcements'), announcement: t('nav.announcements'),
    recurring_expense: t('nav.expenses'), attachment: t('admin.attachmentsModule'),
    document: t('nav.quotations'), tax_rate: t('nav.settings'),
    approval_policy: t('nav.approvals'), approval_request: t('nav.approvals'),
    settings: t('nav.settings'), users: t('nav.users'), user: t('nav.users'),
    roles: t('nav.roles'), role: t('nav.roles'),
    audit: t('nav.audit'), auth: t('admin.authModule'),
  };

  const [tab,      setTab]      = useState('sessions');
  const [sessions, setSessions] = useState([]);
  const [online,   setOnline]   = useState({ count: 0, users: [], window_minutes: 5 });
  const [audit,    setAudit]    = useState({ rows: [], total: 0 });
  const [chain,    setChain]    = useState(null);   // audit-integrity result
  const [verifying, setVerifying] = useState(false);
  const [users,    setUsers]    = useState([]);
  const [roles,    setRoles]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  // Audit filters
  const [af, setAf] = useState({ module: '', action: '', username: '', from_date: '', to_date: '' });
  const [offset, setOffset] = useState(0);
  // Dropdown choices come from the log itself (distinct modules / actions),
  // so they can never go stale as new audited actions are added.
  const [filterOpts, setFilterOpts] = useState({ modules: [], actions: [] });
  const LIMIT = 50;

  // Purge state
  const [purgedays, setPurgeDays]       = useState(365);
  const [purging,   setPurging]         = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  async function loadOverview() {
    setLoading(true); setError('');
    try {
      const [s, u, r, o] = await Promise.all([getUserSessions(), getUsers(), getRoles(), getOnlineUsers()]);
      setSessions(s); setUsers(u); setRoles(r); setOnline(o);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadAudit() {
    setLoading(true); setError('');
    try {
      const params = { limit: LIMIT, offset, ...Object.fromEntries(Object.entries(af).filter(([, v]) => v)) };
      setAudit(await getAuditLog(params));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function exportAudit() {
    try {
      const params = { limit: 500, offset: 0, ...Object.fromEntries(Object.entries(af).filter(([, v]) => v)) };
      const data = await getAuditLog(params);
      const rows = data.rows.map(r => ({
        'Date / Time': r.created_at || '',
        'User':        r.username || '',
        'Action':      r.action || '',
        'Module':      MODULE_LABELS[r.module] || r.module || '',
        'Reference':   r.record_ref || '',
        'Detail':      (() => { try { const d = JSON.parse(r.detail); return Object.entries(d).map(([k,v]) => `${k}: ${v}`).join(', '); } catch { return r.detail || ''; } })(),
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Activity Log');
      XLSX.writeFile(wb, `activity-log-${new Date().toISOString().slice(0,10)}.xlsx`);
    } catch (e) {
      setError(t('common.error') + ': ' + e.message);
    }
  }

  async function handlePurge() {
    setPurging(true);
    try {
      const res = await purgeAuditLog(purgedays);
      toast(t('admin.purgeToast', { count: res.deleted, days: purgedays }));
      setConfirmPurge(false);
      loadAudit();
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setPurging(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);
  useEffect(() => { if (tab === 'audit') loadAudit(); }, [tab, af, offset]);
  useEffect(() => {
    if (tab === 'audit') getAuditFilters().then(setFilterOpts).catch(() => {});
  }, [tab]);

  // Live online indicator — poll every 30s without reloading the whole page.
  useEffect(() => {
    const tick = () => {
      getOnlineUsers().then(setOnline).catch(() => {});
      getUserSessions().then(setSessions).catch(() => {});
    };
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  const activeUsers   = users.filter(u => u.is_active).length;
  const disabledUsers = users.length - activeUsers;
  const onlineIds     = new Set((online.users || []).map(u => u.id));

  const tabs = [
    { key: 'sessions', label: t('admin.activeSessions') },
    { key: 'audit',    label: t('admin.activityLog') },
  ];

  const purgeOptions = [
    { value: 30,  label: t('admin.days30') },
    { value: 90,  label: t('admin.days90') },
    { value: 180, label: t('admin.days180') },
    { value: 365, label: t('admin.year1') },
    { value: 730, label: t('admin.years2') },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('admin.title')}</h1>
          <p className="page-subtitle">{t('admin.subtitle2')}</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadOverview}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          {t('admin.refreshBtn')}
        </button>
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <KpiCard label={t('admin.totalUsers')}       value={users.length}    color="accent" />
        <KpiCard label={t('admin.activeUsersLabel')} value={activeUsers}     color="green" />
        <KpiCard label={t('admin.disabledUsersLabel')} value={disabledUsers} color="red" />
        <KpiCard label={t('admin.liveSessions')}     value={sessions.length} color="blue" />
        {/* Online-now indicator — a live count with a pulsing green dot. */}
        <div className="card" style={{ padding: '16px 20px', flex: 1, minWidth: 120 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>{t('admin.onlineNow')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '4px 0 2px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                           background: online.count > 0 ? 'var(--green)' : 'var(--text-3)',
                           boxShadow: online.count > 0 ? '0 0 0 3px rgba(34,197,94,0.25)' : 'none' }} />
            <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--green)' }}>{online.count}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('admin.onlineSub', { min: online.window_minutes })}</div>
        </div>
        <KpiCard label={t('admin.rolesDefined')}     value={roles.length}    color="accent" />
      </div>

      {error && <ErrorAlert message={error} />}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {tabs.map(tb => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '8px 14px', fontSize: 13.5, fontWeight: tab === tb.key ? 700 : 500,
              color: tab === tb.key ? 'var(--accent)' : 'var(--text-2)',
              borderBottom: tab === tb.key ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color .15s',
            }}
          >{tb.label}</button>
        ))}
      </div>

      {/* Sessions Tab */}
      {tab === 'sessions' && (
        loading ? <LoadingSpinner /> : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('users.user')}</th>
                  <th>{t('admin.ipAddress')}</th>
                  <th>{t('admin.browser')}</th>
                  <th>{t('admin.connected')}</th>
                  <th>{t('admin.lastActive')}</th>
                  <th>{t('admin.expires')}</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>{t('admin.noActiveSessions')}</td></tr>
                )}
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          title={onlineIds.has(s.user_id) ? t('admin.online') : t('admin.idle')}
                          style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                   background: onlineIds.has(s.user_id) ? 'var(--green)' : 'var(--text-3)',
                                   boxShadow: onlineIds.has(s.user_id) ? '0 0 0 3px rgba(34,197,94,0.25)' : 'none' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{s.full_name || s.username}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>@{s.username}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, fontFamily: 'monospace', color: 'var(--text-2)' }}>{s.ip_address || '—'}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{parseUa(s.user_agent)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{fmtTs(s.created_at)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{fmtTs(s.last_active)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{fmtTs(s.expires_at)}</td>
                    <td>
                      {s.user_id !== me.id ? (
                        <button
                          className="btn btn-sm"
                          style={{ color: 'var(--red)', background: 'var(--red-light)', border: 'none', fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 6, cursor: 'pointer' }}
                          title={t('admin.revoke')}
                          onClick={async () => {
                            try {
                              await revokeSession(s.id);
                              toast(t('admin.sessionRevoked'));
                              loadOverview();
                            } catch (e) { toast(e.message, 'red'); }
                          }}
                        >
                          {t('admin.revoke')}
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('admin.you')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Audit Log Tab */}
      {tab === 'audit' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input className="form-control" style={{ width: 140 }} placeholder={t('admin.username')}
              value={af.username} onChange={e => { setAf(f => ({ ...f, username: e.target.value })); setOffset(0); }} />
            <select className="form-control" style={{ width: 160 }} value={af.module} onChange={e => { setAf(f => ({ ...f, module: e.target.value })); setOffset(0); }}>
              <option value="">{t('admin.allModules')}</option>
              {filterOpts.modules.map(k => <option key={k} value={k}>{MODULE_LABELS[k] || k}</option>)}
            </select>
            <select className="form-control" style={{ width: 160 }} value={af.action} onChange={e => { setAf(f => ({ ...f, action: e.target.value })); setOffset(0); }}>
              <option value="">{t('admin.allActions')}</option>
              {filterOpts.actions.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
            <input className="form-control" type="date" style={{ width: 140 }} value={af.from_date}
              onChange={e => { setAf(f => ({ ...f, from_date: e.target.value })); setOffset(0); }} />
            <input className="form-control" type="date" style={{ width: 140 }} value={af.to_date}
              onChange={e => { setAf(f => ({ ...f, to_date: e.target.value })); setOffset(0); }} />
            <button className="btn btn-secondary btn-sm" onClick={() => { setAf({ module: '', action: '', username: '', from_date: '', to_date: '' }); setOffset(0); }}>
              {t('common.clear')}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={exportAudit} title={t('admin.exportExcel')}>
              {t('admin.exportExcel')}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={verifying} title={t('admin.verifyIntegrityHint')}
              onClick={async () => {
                setVerifying(true); setChain(null);
                try { setChain(await verifyAuditChain()); }
                catch (e) { setChain({ ok: false, error: e.message }); }
                finally { setVerifying(false); }
              }}>
              {verifying ? t('admin.verifying') : t('admin.verifyIntegrity')}
            </button>
            {chain && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px',
                borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: chain.ok ? 'var(--green-light)' : 'var(--red-light)',
                color: chain.ok ? 'var(--green)' : 'var(--red)' }}>
                {chain.ok
                  ? t('admin.chainIntact', { n: chain.checked })
                  : t('admin.chainBroken', { id: chain.broken_at_id ?? '?' })}
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{t('admin.purgeOlderThan')}</span>
              <select
                className="form-control"
                style={{ width: 110, fontSize: 12 }}
                value={purgedays}
                onChange={e => setPurgeDays(Number(e.target.value))}
              >
                {purgeOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--red-light)', color: 'var(--red)', border: '1px solid var(--red)', fontWeight: 600, whiteSpace: 'nowrap' }}
                onClick={() => setConfirmPurge(true)}
              >
                {t('admin.purgeBtn')}
              </button>
            </div>
          </div>

          {loading ? <LoadingSpinner /> : (
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('admin.time')}</th>
                    <th>{t('users.user')}</th>
                    <th>{t('admin.action')}</th>
                    <th>{t('admin.module')}</th>
                    <th>{t('admin.reference')}</th>
                    <th>{t('admin.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.rows.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>{t('admin.noActivity')}</td></tr>
                  )}
                  {audit.rows.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtTs(r.created_at)}</td>
                      <td style={{ fontSize: 13, fontWeight: 600 }}>@{r.username}</td>
                      <td>
                        <span className={`badge badge-${ACTION_COLORS[r.action] || 'gray'}`}>{r.action}</span>
                      </td>
                      <td style={{ fontSize: 12.5 }}>{MODULE_LABELS[r.module] || r.module}</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{r.record_ref || '—'}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.detail ? (() => { try { const d = JSON.parse(r.detail); return Object.entries(d).map(([k,v]) => `${k}: ${v}`).join(', '); } catch { return r.detail; } })() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {audit.total > LIMIT && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-3)' }}>
                    {t('admin.showing', { from: offset + 1, to: Math.min(offset + LIMIT, audit.total), total: audit.total })}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm btn-secondary" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - LIMIT))}>{t('common.previous')}</button>
                    <button className="btn btn-sm btn-secondary" disabled={offset + LIMIT >= audit.total} onClick={() => setOffset(o => o + LIMIT)}>{t('common.next')}</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Purge confirmation modal */}
      {confirmPurge && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">{t('admin.confirmPurgeTitle')}</span>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 12, padding: '10px 14px', background: 'var(--red-light)', borderRadius: 8, marginBottom: 14, border: '1px solid var(--red)' }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <span style={{ fontSize: 13, color: 'var(--red)', lineHeight: 1.5 }}
                  dangerouslySetInnerHTML={{ __html: t('admin.purgeWarning', { days: `<strong>${purgedays}</strong>` }) }}
                />
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-2)', margin: 0 }}>
                {t('admin.purgeKeepNote', { days: purgedays })}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmPurge(false)} disabled={purging}>{t('common.cancel')}</button>
              <button
                className="btn btn-danger"
                onClick={handlePurge}
                disabled={purging}
              >
                {purging ? t('admin.purging') : t('admin.purgeConfirmBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
