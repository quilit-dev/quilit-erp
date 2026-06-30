import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, clearReadNotifications,
} from '../api/client';
import { LoadingSpinner, EmptyState } from '../components/shared.jsx';
import { useLocale } from '../hooks/useLocale.jsx';

// ── Type config (same palette as NotificationBell) ───────────────────────────
//
// One entry per notification type the backend can emit. Keep in sync with
// `backend/routers/notifications.py::NOTIFICATION_TYPE_MODULE` — a missing
// entry here renders as the generic "system" badge, which is technically
// safe but loses the visual cue.
const TYPE_CONFIG = {
  // Sales / billing
  invoice_paid:         { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Invoice Paid',    icon: 'check-circle' },
  payment_received:     { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Payment',         icon: 'credit-card'  },
  invoice_overdue:      { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Overdue',         icon: 'alert-circle' },
  quotation_accepted:   { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Quotation',       icon: 'file-check'   },
  // Operations / stock
  low_stock:            { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Low Stock',       icon: 'package'      },
  low_stock_warehouse:  { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Low Stock (WH)',  icon: 'package'      },
  purchase_received:    { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Purchase',        icon: 'truck'        },
  transfer_dispatched:  { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Incoming',        icon: 'truck'        },
  transfer_received:    { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Received',        icon: 'check-circle' },
  transfer_cancelled:   { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Cancelled',       icon: 'x-circle'     },
  // Planning + CRM
  task_due_soon:        { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Task Due',        icon: 'calendar'     },
  planning_event:       { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Event',           icon: 'calendar'     },
  deal_won:             { bg: 'var(--purple-light)', color: 'var(--purple)', label: 'Deal Won',        icon: 'trophy'       },
  deal_lost:            { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Deal Lost',       icon: 'x-circle'     },
  lead_converted:       { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Lead Converted',  icon: 'user-check'   },
  // Manufacturing
  production_completed: { bg: 'var(--purple-light)', color: 'var(--purple)', label: 'Production',      icon: 'package'      },
  // Fixed Assets + Cash + Expenses
  asset_depreciated:    { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Depreciation',    icon: 'trending-down' },
  cash_variance:        { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Cash Variance',   icon: 'dollar-sign'  },
  recurring_generated:  { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Recurring',       icon: 'dollar-sign'  },
  // Accounting (lazy system gen)
  period_unlocked:      { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Period Open',     icon: 'alert-circle' },
  fx_rate_stale:        { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'FX Stale',        icon: 'alert-circle' },
  // HR — leave + payroll + contracts + activities
  leave_requested:      { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Leave',           icon: 'calendar'     },
  leave_approved:       { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Leave Approved',  icon: 'check-circle' },
  leave_rejected:       { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Leave Rejected',  icon: 'x-circle'     },
  payroll_approved:     { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Payroll Ready',   icon: 'check-circle' },
  payroll_paid:         { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Payroll Paid',    icon: 'credit-card'  },
  contract_expiring:    { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Contract Ends',   icon: 'alert-circle' },
  hr_activity_reminder: { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Reminder',        icon: 'calendar'     },
  // Recruitment
  recruitment_status:   { bg: 'var(--blue-light)',   color: 'var(--blue)',   label: 'Applicant',       icon: 'user-check'   },
  recruitment_hired:    { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Hired',           icon: 'trophy'       },
  // Internal comms
  announcement:         { bg: 'var(--purple-light)', color: 'var(--purple)', label: 'Announcement',    icon: 'info'         },
  announcement_comment: { bg: 'var(--purple-light)', color: 'var(--purple)', label: 'Comment',         icon: 'info'         },
  // Approval workflow (emitted by approval_engine on every module that uses it)
  approval_request:     { bg: 'var(--yellow-light)', color: 'var(--yellow)', label: 'Approval Needed', icon: 'clock'        },
  approval_approved:    { bg: 'var(--green-light)',  color: 'var(--green)',  label: 'Approved',        icon: 'check-circle' },
  approval_rejected:    { bg: 'var(--red-light)',    color: 'var(--red)',    label: 'Rejected',        icon: 'x-circle'     },
  system:               { bg: 'var(--surface-3)',    color: 'var(--text-3)', label: 'System',          icon: 'info'         },
};

const ICONS = {
  'check-circle': <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  'credit-card':  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  'alert-circle': <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  'package':      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  'truck':        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  'file-check':   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="15" y2="11"/></svg>,
  'calendar':     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  'trophy':       <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>,
  'x-circle':     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>,
  'user-check':   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>,
  'trending-down':<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>,
  'dollar-sign':  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  'clock':        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  'info':         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
};

const TABS = [
  { key: 'all',         labelKey: 'notifications.tabAll' },
  { key: 'unread',      labelKey: 'notifications.tabUnread' },
  { key: 'finance',     labelKey: 'notifications.tabFinance',    types: [
      'invoice_paid','payment_received','invoice_overdue','cash_variance',
      'asset_depreciated','recurring_generated','period_unlocked','fx_rate_stale',
  ] },
  { key: 'stock',       labelKey: 'notifications.tabInventory',  types: [
      'low_stock','low_stock_warehouse','purchase_received','production_completed',
      'transfer_dispatched','transfer_received','transfer_cancelled',
  ] },
  { key: 'crm',         labelKey: 'notifications.tabCrm',        types: ['deal_won','deal_lost','lead_converted','quotation_accepted'] },
  { key: 'hr',          labelKey: 'notifications.tabHr',         types: [
      'leave_requested','leave_approved','leave_rejected',
      'payroll_approved','payroll_paid','contract_expiring','hr_activity_reminder',
      'recruitment_status','recruitment_hired',
  ] },
  { key: 'approvals',   labelKey: 'notifications.tabApprovals',  types: ['approval_request','approval_approved','approval_rejected'] },
  { key: 'tasks',       labelKey: 'notifications.tabTasks',      types: ['task_due_soon','planning_event'] },
];

function typeConf(type) {
  return TYPE_CONFIG[type] || TYPE_CONFIG.system;
}

// Localised badge label for a notification type (falls back to the generic
// "system" label for any type without its own entry).
function typeLabel(t, type) {
  return t(`notifications.types.${TYPE_CONFIG[type] ? type : 'system'}`);
}

function timeAgo(ts, t) {
  if (!ts) return '';
  try {
    const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
    if (diff < 60)    return t('notifications.justNow');
    if (diff < 3600)  return t('notifications.minAgo',  { n: Math.floor(diff / 60) });
    if (diff < 86400) return t('notifications.hrAgo',   { n: Math.floor(diff / 3600) });
    if (diff < 604800) return t('notifications.daysAgo', { n: Math.floor(diff / 86400) });
    return new Date(ts + 'Z').toLocaleDateString();
  } catch { return ''; }
}

function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

export default function Notifications() {
  const navigate    = useNavigate();
  const { t }       = useLocale();
  const [tab, setTab]         = useState('all');
  const [notifs, setNotifs]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread]   = useState(0);
  const [total, setTotal]     = useState(0);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (tab === 'unread') params.unread_only = true;
      const tabDef = TABS.find(t => t.key === tab);
      // type_filter: for category tabs we load all and filter client-side
      const d = await getNotifications({ ...params, limit: 100 });
      let list = d.notifications ?? [];
      if (tabDef?.types) list = list.filter(n => tabDef.types.includes(n.type));
      setNotifs(list);
      setUnread(d.unread_count ?? 0);
      setTotal(d.total ?? list.length);
    } catch {} finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  async function handleClick(n) {
    if (!n.is_read) {
      await markNotificationRead(n.id);
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, is_read: 1 } : x));
      setUnread(prev => Math.max(0, prev - 1));
    }
    if (n.link) navigate(n.link);
  }

  async function handleDelete(n, e) {
    e.stopPropagation();
    await deleteNotification(n.id);
    setNotifs(prev => prev.filter(x => x.id !== n.id));
    if (!n.is_read) setUnread(prev => Math.max(0, prev - 1));
  }

  async function handleMarkAll() {
    await markAllNotificationsRead();
    setNotifs(prev => prev.map(n => ({ ...n, is_read: 1 })));
    setUnread(0);
  }

  async function handleClearRead() {
    setClearing(true);
    try {
      await clearReadNotifications();
      setNotifs(prev => prev.filter(n => !n.is_read));
    } finally { setClearing(false); }
  }

  const hasRead = notifs.some(n => n.is_read);

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">{t('notifications.title')}</h1>
          <p className="page-subtitle">
            {unread > 0
              ? t('notifications.subtitle', { count: unread })
              : t('notifications.subtitleNone')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasRead && (
            <button className="btn btn-outline" onClick={handleClearRead} disabled={clearing}>
              {clearing ? '…' : t('notifications.clearRead')}
            </button>
          )}
          {unread > 0 && (
            <button className="btn btn-primary" onClick={handleMarkAll}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><polyline points="20 6 9 17 4 12"/></svg>
              {t('notifications.markAllRead')}
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ marginBottom: 16 }}>
        <div className="notif-page-tab-bar">
          {TABS.map(tb => (
            <button
              key={tb.key}
              className={`notif-page-tab${tab === tb.key ? ' active' : ''}`}
              onClick={() => setTab(tb.key)}
            >
              {t(tb.labelKey)}
              {tb.key === 'unread' && unread > 0 && (
                <span style={{ marginLeft: 6, background: 'var(--red)', color: '#fff', borderRadius: 99, fontSize: 10, fontWeight: 700, padding: '1px 5px' }}>
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}>
          <LoadingSpinner />
        </div>
      ) : notifs.length === 0 ? (
        <div className="card" style={{ padding: '60px 20px' }}>
          <EmptyState message={tab === 'unread' ? t('notifications.noUnread') : t('notifications.empty')} />
        </div>
      ) : (
        <div className="notif-page-list">
          {notifs.map(n => {
            const cfg = typeConf(n.type);
            const Icon = ICONS[cfg.icon] || ICONS.info;
            return (
              <div
                key={n.id}
                className={`notif-page-item${!n.is_read ? ' unread' : ''}`}
                onClick={() => handleClick(n)}
              >
                {!n.is_read && <div className="notif-page-unread-dot" />}
                <div className="notif-page-icon" style={{ background: cfg.bg, color: cfg.color }}>
                  {Icon}
                </div>
                <div className="notif-page-content">
                  <div className="notif-page-title">{n.title}</div>
                  {n.body && <div className="notif-page-body">{n.body}</div>}
                  <div className="notif-page-meta">
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 99, background: cfg.bg, color: cfg.color }}>
                      {typeLabel(t, n.type)}
                    </span>
                    <span className="notif-page-time" title={fmtDate(n.created_at)}>
                      {timeAgo(n.created_at, t)}
                    </span>
                  </div>
                </div>
                <div className="notif-page-actions">
                  {!n.is_read && (
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={async e => {
                        e.stopPropagation();
                        await markNotificationRead(n.id);
                        setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, is_read: 1 } : x));
                        setUnread(prev => Math.max(0, prev - 1));
                      }}
                      title={t('notifications.markRead')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: '3px 8px', color: 'var(--text-3)' }}
                    onClick={e => handleDelete(n, e)}
                    title={t('common.delete')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {notifs.length > 0 && (
        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
          {notifs.length} {t('notifications.showing')}
        </div>
      )}
    </div>
  );
}
