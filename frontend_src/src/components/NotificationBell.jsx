import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, getNotificationCount,
} from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

const POLL_MS = 30_000;

// ── Type → visual config ──────────────────────────────────────────────────────
const TYPE_CONFIG = {
  invoice_paid: {
    bg: 'var(--green-light)', color: 'var(--green)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  },
  payment_received: {
    bg: 'var(--green-light)', color: 'var(--green)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  },
  invoice_overdue: {
    bg: 'var(--red-light)', color: 'var(--red)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  },
  low_stock: {
    bg: 'var(--yellow-light)', color: 'var(--yellow)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  },
  purchase_received: {
    bg: 'var(--blue-light)', color: 'var(--blue)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  },
  quotation_accepted: {
    bg: 'var(--green-light)', color: 'var(--green)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="15" y2="11"/></svg>,
  },
  task_due_soon: {
    bg: 'var(--yellow-light)', color: 'var(--yellow)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  },
  deal_won: {
    bg: 'var(--purple-light)', color: 'var(--purple)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>,
  },
  deal_lost: {
    bg: 'var(--red-light)', color: 'var(--red)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>,
  },
  lead_converted: {
    bg: 'var(--blue-light)', color: 'var(--blue)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>,
  },
  system: {
    bg: 'var(--surface-3)', color: 'var(--text-3)',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  },
};

function typeConfig(type) {
  return TYPE_CONFIG[type] || TYPE_CONFIG.system;
}

// ── Relative time ─────────────────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return '';
  try {
    const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
    if (diff < 60)   return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(ts + 'Z').toLocaleDateString();
  } catch { return ''; }
}

// ── Bell button + dropdown ────────────────────────────────────────────────────
export default function NotificationBell() {
  const navigate    = useNavigate();
  const { t }       = useLocale();
  const [open, setOpen]           = useState(false);
  const [notifs, setNotifs]       = useState([]);
  const [unread, setUnread]       = useState(0);
  const [loading, setLoading]     = useState(false);
  const wrapRef                   = useRef(null);

  const fetchCount = useCallback(async () => {
    try {
      const d = await getNotificationCount();
      setUnread(d.unread_count ?? 0);
    } catch {}
  }, []);

  const fetchNotifs = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getNotifications({ limit: 20 });
      setNotifs(d.notifications ?? []);
      setUnread(d.unread_count ?? 0);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  // Poll for count every 30s
  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, POLL_MS);
    return () => clearInterval(id);
  }, [fetchCount]);

  // Fetch full list when opened
  useEffect(() => {
    if (open) fetchNotifs();
  }, [open, fetchNotifs]);

  // Click outside to close
  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  async function handleMarkAll() {
    await markAllNotificationsRead();
    setNotifs(prev => prev.map(n => ({ ...n, is_read: 1 })));
    setUnread(0);
  }

  async function handleRead(notif, e) {
    e?.stopPropagation();
    if (!notif.is_read) {
      await markNotificationRead(notif.id);
      setNotifs(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: 1 } : n));
      setUnread(prev => Math.max(0, prev - 1));
    }
    if (notif.link) { navigate(notif.link); setOpen(false); }
  }

  async function handleDelete(notif, e) {
    e.stopPropagation();
    await deleteNotification(notif.id);
    setNotifs(prev => prev.filter(n => n.id !== notif.id));
    if (!notif.is_read) setUnread(prev => Math.max(0, prev - 1));
  }

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        className={`notif-bell-btn${unread > 0 ? ' has-unread' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={t('notifications.title')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-dropdown-header">
            <span className="notif-dropdown-title">
              {t('notifications.title')}
              {unread > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, background: 'var(--red)', color: '#fff', borderRadius: 99, padding: '1px 7px' }}>
                  {unread}
                </span>
              )}
            </span>
            <div className="notif-dropdown-actions">
              {unread > 0 && (
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={handleMarkAll}>
                  {t('notifications.markAllRead')}
                </button>
              )}
            </div>
          </div>

          <div className="notif-dropdown-scroll">
            {loading && notifs.length === 0 ? (
              <div className="notif-empty">
                <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'spin .8s linear infinite' }} />
              </div>
            ) : notifs.length === 0 ? (
              <div className="notif-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <p>{t('notifications.empty')}</p>
              </div>
            ) : (
              notifs.map(n => {
                const cfg = typeConfig(n.type);
                return (
                  <div
                    key={n.id}
                    className={`notif-item${!n.is_read ? ' unread' : ''}`}
                    onClick={e => handleRead(n, e)}
                  >
                    <div className="notif-icon" style={{ background: cfg.bg, color: cfg.color }}>
                      {cfg.icon}
                    </div>
                    <div className="notif-content">
                      <div className="notif-item-title">{n.title}</div>
                      {n.body && <div className="notif-item-body">{n.body}</div>}
                      <div className="notif-item-time">{timeAgo(n.created_at)}</div>
                    </div>
                    {!n.is_read && <div className="notif-unread-dot" />}
                    <button className="notif-item-del" onClick={e => handleDelete(n, e)} title={t('common.delete')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="notif-dropdown-footer">
            <a href="/notifications" onClick={e => { e.preventDefault(); navigate('/notifications'); setOpen(false); }}>
              {t('notifications.viewAll')}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
