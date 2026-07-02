/**
 * Announcements — internal top-down comms.
 *
 * Layout
 *   ┌─ Header: title + "New announcement" (gated by perms) ───┐
 *   ├─ KPI strip: Total / Unread / Pending ack / Critical    │
 *   ├─ Tabs: Inbox · Sent (sent only for authors)            │
 *   ├─ Filter bar: search + priority + status                │
 *   └─ Row-card list ─────────────────────────────────────────┘
 *        clicking opens a detail modal with body, audience,
 *        acknowledgement and threaded comments.
 *
 * Notes
 *   - Recipients see "Inbox"; users with announcements.create also see "Sent"
 *     showing what they've published + acknowledgement progress.
 *   - The detail modal POSTs /{id}/acknowledge when the user clicks the
 *     "I acknowledge" button.
 *   - Comments are plain replies (no threading) — chosen deliberately to
 *     keep this a corporate tool, not a social feed.
 */

// Sections live in ./announcements/ — this file is the main page
// (KPI strip, tabs, filter bar, list).
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import { Modal, LoadingSpinner, EmptyState, toast } from '../components/shared';
import { getAnnouncements, getAnnouncementsSent } from '../api/client';
import { PRIORITIES, StatPill } from './announcements/ui';
import { AnnouncementRow, SentRow } from './announcements/rows';
import { ComposeForm } from './announcements/ComposeForm';
import { DetailModal } from './announcements/DetailModal';


// ── Main page ──────────────────────────────────────────────────────────────

export default function Announcements() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const canCreate = can('announcements', 'create');

  const [tab,        setTab]        = useState('inbox');   // 'inbox' | 'sent'
  const [search,     setSearch]     = useState('');
  const [priority,   setPriority]   = useState('');
  const [status,     setStatus]     = useState('');         // unread | read | pending_ack
  const [openId,     setOpenId]     = useState(null);
  const [composing,  setComposing]  = useState(false);

  const [inbox,   setInbox]   = useState(null);
  const [sent,    setSent]    = useState(null);
  const [loading, setLoading] = useState(true);

  const [params, setParams] = useSearchParams();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const promises = [getAnnouncements()];
      if (canCreate) promises.push(getAnnouncementsSent());
      const [inboxRows, sentRows] = await Promise.all(promises);
      setInbox(inboxRows || []);
      if (canCreate) setSent(sentRows || []);
    } catch (e) {
      toast(e.message || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [canCreate, t]);

  useEffect(() => { reload(); }, [reload]);

  // Honour ?open=<id> when navigating from a notification
  useEffect(() => {
    const o = params.get('open');
    if (o && !isNaN(Number(o))) {
      setOpenId(Number(o));
      params.delete('open'); setParams(params, { replace: true });
    }
  }, [params, setParams]);

  // ── Derived: KPI counts + filtered list ────────────────────────────────
  const kpis = useMemo(() => {
    const rows = inbox || [];
    return {
      total:   rows.length,
      unread:  rows.filter(a => !a.read_at).length,
      pending: rows.filter(a => a.requires_ack && !a.acknowledged_at).length,
      critical: rows.filter(a => a.priority === 'critical').length,
    };
  }, [inbox]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = inbox || [];
    return rows.filter(a => {
      if (priority && a.priority !== priority) return false;
      if (status === 'unread' && a.read_at) return false;
      if (status === 'read' && !a.read_at) return false;
      if (status === 'pending_ack' && (!a.requires_ack || a.acknowledged_at)) return false;
      if (q && !`${a.title} ${a.body} ${a.author_name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inbox, search, priority, status]);

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('announcements.pageTitle')}</h1>
          <p className="page-subtitle">{t('announcements.pageSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canCreate && (
            <button className="btn btn-primary btn-sm" onClick={() => setComposing(true)}>
              + {t('announcements.newAnnouncement')}
            </button>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12, marginBottom: 18,
      }}>
        <StatPill label={t('announcements.kpiTotal')}     value={kpis.total} />
        <StatPill label={t('announcements.kpiUnread')}    value={kpis.unread}   color={kpis.unread > 0 ? '#2563eb' : undefined} />
        <StatPill label={t('announcements.kpiPendingAck')} value={kpis.pending}  color={kpis.pending > 0 ? '#ea580c' : undefined} />
        <StatPill label={t('announcements.kpiCritical')}  value={kpis.critical} color={kpis.critical > 0 ? '#dc2626' : undefined} />
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab-btn${tab === 'inbox' ? ' active' : ''}`} onClick={() => setTab('inbox')}>
          {t('announcements.inbox')} {kpis.unread > 0 && (
            <span style={{ marginInlineStart: 6, fontSize: 10, fontWeight: 700,
                            background: 'var(--accent)', color: '#fff', padding: '1px 6px', borderRadius: 999 }}>
              {kpis.unread}
            </span>
          )}
        </button>
        {canCreate && (
          <button className={`tab-btn${tab === 'sent' ? ' active' : ''}`} onClick={() => setTab('sent')}>
            {t('announcements.sent')}
          </button>
        )}
      </div>

      {/* Filter bar — only on inbox */}
      {tab === 'inbox' && (
        <div className="card" style={{ padding: 12, marginBottom: 12,
              display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search-input-wrap" style={{ flex: 1, minWidth: 220 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input className="form-control search-input" placeholder={t('common.search')}
                   value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="form-control" style={{ width: 160 }} value={priority}
                  onChange={e => setPriority(e.target.value)}>
            <option value="">{t('announcements.allPriorities')}</option>
            {PRIORITIES.map(p => (
              <option key={p} value={p}>{t(`announcements.priority_${p}`)}</option>
            ))}
          </select>
          <select className="form-control" style={{ width: 170 }} value={status}
                  onChange={e => setStatus(e.target.value)}>
            <option value="">{t('announcements.allStatuses')}</option>
            <option value="unread">{t('announcements.filterUnread')}</option>
            <option value="read">{t('announcements.filterRead')}</option>
            <option value="pending_ack">{t('announcements.filterPendingAck')}</option>
          </select>
        </div>
      )}

      {/* List */}
      {loading && <LoadingSpinner />}
      {!loading && tab === 'inbox' && (
        filtered.length === 0
          ? <EmptyState icon="📭" message={t('announcements.emptyInbox')} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filtered.map(a => (
                <AnnouncementRow key={a.id} a={a} t={t} onOpen={() => setOpenId(a.id)} />
              ))}
            </div>
          )
      )}
      {!loading && tab === 'sent' && (
        (sent || []).length === 0
          ? <EmptyState icon="📤" message={t('announcements.emptySent')} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sent.map(a => (
                <SentRow key={a.id} a={a} t={t} onOpen={() => setOpenId(a.id)} />
              ))}
            </div>
          )
      )}

      {/* Modals */}
      {openId !== null && (
        <DetailModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
      {composing && (
        <Modal title={t('announcements.newAnnouncement')} onClose={() => setComposing(false)} size="md">
          <ComposeForm onSave={() => { setComposing(false); reload(); }}
                        onClose={() => setComposing(false)} />
        </Modal>
      )}
    </div>
  );
}
