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
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import {
  Modal, ConfirmModal, LoadingSpinner, EmptyState, toast, fmtDate,
} from '../components/shared';
import {
  getAnnouncements, getAnnouncementsSent, getAnnouncement,
  createAnnouncement, archiveAnnouncement, acknowledgeAnnouncement,
  getAnnouncementComments, postAnnouncementComment, deleteAnnouncementComment,
  getAnnouncementAudience,
  getAnnouncementRolesMeta, getAnnouncementUsersMeta,
} from '../api/client';


// ── Priority styling ────────────────────────────────────────────────────────
//
// Each priority maps to a single accent colour used everywhere it appears —
// the row-card left rail, the priority chip, and the detail-modal header.
// Keeping these in one place keeps the visual language tight.

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const PRIORITY_STYLE = {
  low:      { color: '#64748b', bg: 'rgba(100,116,139,.10)', label: 'Low' },
  medium:   { color: '#2563eb', bg: 'rgba(37,99,235,.10)',   label: 'Medium' },
  high:     { color: '#ea580c', bg: 'rgba(234,88,12,.10)',   label: 'High' },
  critical: { color: '#dc2626', bg: 'rgba(220,38,38,.10)',   label: 'Critical' },
};


// ── Small presentational helpers ───────────────────────────────────────────

function PriorityChip({ priority, t }) {
  const s = PRIORITY_STYLE[priority] || PRIORITY_STYLE.medium;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 9px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px',
      textTransform: 'uppercase',
      background: s.bg, color: s.color,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 50, background: s.color }} />
      {t(`announcements.priority_${priority}`) || s.label}
    </span>
  );
}


function StatPill({ label, value, color = 'var(--text)' }) {
  return (
    <div className="stat-card" style={{ padding: '12px 14px', minWidth: 0 }}>
      <div className="stat-label">{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 800, color, letterSpacing: '-0.4px',
        marginTop: 2, fontFeatureSettings: '"tnum"',
      }}>{value ?? 0}</div>
    </div>
  );
}


// ── Row card — single announcement summary in the list ─────────────────────

function AnnouncementRow({ a, onOpen, t }) {
  const unread = !a.read_at;
  const pendingAck = a.requires_ack && !a.acknowledged_at;
  const ps = PRIORITY_STYLE[a.priority] || PRIORITY_STYLE.medium;
  const snippet = (a.body || '').replace(/\s+/g, ' ').slice(0, 160);

  return (
    <div
      onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="card"
      style={{
        position: 'relative', cursor: 'pointer',
        padding: '14px 16px 14px 20px',
        border: `1px solid ${unread ? 'var(--border-strong, var(--border))' : 'var(--border)'}`,
        borderInlineStart: `4px solid ${ps.color}`,
        background: unread
          ? 'color-mix(in srgb, ' + ps.color + ' 4%, var(--card))'
          : 'var(--card)',
        boxShadow: 'var(--shadow-xs)',
        transition: 'transform 160ms var(--ease, ease), box-shadow 160ms var(--ease, ease), background 160ms var(--ease, ease)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 8px 22px rgba(15,23,42,.06)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'var(--shadow-xs)';
      }}
    >
      {a.pinned && (
        <span style={{
          position: 'absolute', top: 10, right: 14,
          fontSize: 10, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase',
          color: 'var(--text-3)',
        }}>📌 {t('announcements.pinned')}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <PriorityChip priority={a.priority} t={t} />
        <div style={{
          fontWeight: unread ? 700 : 600, fontSize: 14.5,
          color: unread ? 'var(--text)' : 'var(--text-2)',
          letterSpacing: '-0.1px',
          flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{a.title}</div>
        {unread && (
          <span style={{
            width: 8, height: 8, borderRadius: 50,
            background: ps.color, flexShrink: 0,
            boxShadow: `0 0 0 3px ${ps.color}22`,
          }} aria-label="unread" />
        )}
      </div>

      <div style={{
        fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{snippet}</div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        fontSize: 11, color: 'var(--text-3)', marginTop: 2,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{a.author_name}</span>
        <span>·</span>
        <span>{fmtDate(a.published_at)}</span>
        {a.comment_count > 0 && (
          <>
            <span>·</span>
            <span>💬 {a.comment_count}</span>
          </>
        )}
        {pendingAck && (
          <span style={{
            marginInlineStart: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'rgba(234,88,12,.10)', color: '#ea580c',
            fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px', textTransform: 'uppercase',
          }}>{t('announcements.pendingAck')}</span>
        )}
        {a.acknowledged_at && (
          <span style={{
            marginInlineStart: pendingAck ? 0 : 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'rgba(16,185,129,.10)', color: '#059669',
            fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px', textTransform: 'uppercase',
          }}>✓ {t('announcements.acknowledged')}</span>
        )}
      </div>
    </div>
  );
}


// ── Sent row card (author's view) ──────────────────────────────────────────

function SentRow({ a, onOpen, t }) {
  const ackPct = a.requires_ack && a.total_recipients > 0
    ? Math.round((a.total_acked / a.total_recipients) * 100) : null;
  const readPct = a.total_recipients > 0
    ? Math.round((a.total_read / a.total_recipients) * 100) : 0;
  const ps = PRIORITY_STYLE[a.priority] || PRIORITY_STYLE.medium;

  return (
    <div
      onClick={onOpen}
      className="card"
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        padding: '14px 16px 14px 20px',
        border: '1px solid var(--border)',
        borderInlineStart: `4px solid ${ps.color}`,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
        opacity: a.archived_at ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PriorityChip priority={a.priority} t={t} />
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtDate(a.published_at)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
                    fontSize: 12, color: 'var(--text-2)' }}>
        <span><strong style={{ color: 'var(--text)' }}>{a.total_recipients}</strong> {t('announcements.recipients')}</span>
        <span>·</span>
        <span><strong style={{ color: 'var(--text)' }}>{readPct}%</strong> {t('announcements.read')}</span>
        {ackPct !== null && (
          <>
            <span>·</span>
            <span><strong style={{ color: ackPct === 100 ? '#059669' : '#ea580c' }}>{ackPct}%</strong>{' '}
              {t('announcements.acknowledged')}</span>
          </>
        )}
        {a.archived_at && (
          <span style={{ marginInlineStart: 'auto', fontSize: 10.5, fontWeight: 700,
                          letterSpacing: '.4px', textTransform: 'uppercase',
                          color: 'var(--text-3)' }}>
            {t('announcements.archived')}
          </span>
        )}
      </div>
    </div>
  );
}


// ── Compose form ───────────────────────────────────────────────────────────

function ComposeForm({ onSave, onClose }) {
  const { t } = useLocale();
  const [form, setForm] = useState({
    title: '', body: '', priority: 'medium',
    audience_type: 'all', audience_ids: [],
    requires_ack: false, pinned: false, expires_at: '',
  });
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    getAnnouncementRolesMeta().then(setRoles).catch(() => {});
    getAnnouncementUsersMeta().then(setUsers).catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function toggleId(id) {
    setForm(f => {
      const has = f.audience_ids.includes(id);
      return { ...f, audience_ids: has ? f.audience_ids.filter(x => x !== id) : [...f.audience_ids, id] };
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) { toast(t('announcements.titleRequired'), 'error'); return; }
    if (!form.body.trim())  { toast(t('announcements.bodyRequired'),  'error'); return; }
    if (form.audience_type !== 'all' && form.audience_ids.length === 0) {
      toast(t('announcements.audienceRequired'), 'error'); return;
    }
    setSaving(true);
    try {
      await createAnnouncement({
        title: form.title.trim(),
        body:  form.body.trim(),
        priority: form.priority,
        audience_type: form.audience_type,
        audience_ids:  form.audience_type === 'all' ? null : form.audience_ids,
        requires_ack:  form.requires_ack,
        pinned:        form.pinned,
        expires_at:    form.expires_at || null,
      });
      toast(t('announcements.published'));
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  // Visual style for selectable role/user chips.
  const chip = (active) => ({
    padding: '6px 12px', borderRadius: 999,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid',
    borderColor: active ? 'var(--accent)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--text-2)',
    transition: 'all .12s',
  });

  return (
    <form onSubmit={submit}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Title */}
        <div className="form-group form-full">
          <label className="form-label">{t('announcements.title')} *</label>
          <input className="form-control" autoFocus required
                 value={form.title} onChange={e => set('title', e.target.value)}
                 placeholder={t('announcements.titlePlaceholder')} />
        </div>

        {/* Body */}
        <div className="form-group form-full">
          <label className="form-label">{t('announcements.body')} *</label>
          <textarea className="form-control" rows={6} required
                    value={form.body} onChange={e => set('body', e.target.value)}
                    placeholder={t('announcements.bodyPlaceholder')} />
        </div>

        {/* Priority — radio chips */}
        <div className="form-group form-full">
          <label className="form-label">{t('announcements.priority')}</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {PRIORITIES.map(p => {
              const s = PRIORITY_STYLE[p];
              const active = form.priority === p;
              return (
                <button key={p} type="button" onClick={() => set('priority', p)}
                  style={{
                    padding: '8px 14px', borderRadius: 8,
                    border: '1.5px solid', borderColor: active ? s.color : 'var(--border)',
                    background: active ? s.color : 'transparent',
                    color: active ? '#fff' : s.color,
                    fontSize: 12, fontWeight: 700, letterSpacing: '.3px',
                    textTransform: 'uppercase', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    transition: 'all .12s',
                  }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50,
                                 background: active ? '#fff' : s.color }} />
                  {t(`announcements.priority_${p}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Audience selector */}
        <div className="form-group form-full">
          <label className="form-label">{t('announcements.audience')}</label>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, marginBottom: 10 }}>
            {['all', 'roles', 'users'].map(typ => {
              const active = form.audience_type === typ;
              return (
                <button key={typ} type="button"
                  onClick={() => set('audience_type', typ)}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8,
                    border: '1.5px solid', borderColor: active ? 'var(--accent)' : 'var(--border)',
                    background: active ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'var(--surface)',
                    color: active ? 'var(--accent)' : 'var(--text-2)',
                    fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                    transition: 'all .12s',
                  }}>
                  {t(`announcements.audience_${typ}`)}
                </button>
              );
            })}
          </div>

          {form.audience_type === 'roles' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 10,
                          background: 'var(--surface-2)', borderRadius: 8 }}>
              {roles.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>}
              {roles.map(r => (
                <button key={r.id} type="button" onClick={() => toggleId(r.id)}
                        style={chip(form.audience_ids.includes(r.id))}>
                  {r.name}
                </button>
              ))}
            </div>
          )}
          {form.audience_type === 'users' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 10,
                          background: 'var(--surface-2)', borderRadius: 8,
                          maxHeight: 200, overflowY: 'auto' }}>
              {users.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>}
              {users.map(u => (
                <button key={u.id} type="button" onClick={() => toggleId(u.id)}
                        style={chip(form.audience_ids.includes(u.id))}>
                  {u.full_name || u.username}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Options */}
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('announcements.expiresAt')}</label>
            <input type="date" className="form-control" value={form.expires_at}
                   onChange={e => set('expires_at', e.target.value)} />
          </div>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.requires_ack}
                     onChange={e => set('requires_ack', e.target.checked)}
                     style={{ width: 16, height: 16, cursor: 'pointer' }} />
              {t('announcements.requiresAck')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.pinned}
                     onChange={e => set('pinned', e.target.checked)}
                     style={{ width: 16, height: 16, cursor: 'pointer' }} />
              {t('announcements.pinToTop')}
            </label>
          </div>
        </div>
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : t('announcements.publish')}
        </button>
      </div>
    </form>
  );
}


// ── Detail modal: body, audience, ack, comments ────────────────────────────

function DetailModal({ id, onClose, onChanged }) {
  const { t } = useLocale();
  const { user, isSuperadmin } = usePermissions();
  const [ann, setAnn] = useState(null);
  const [comments, setComments] = useState([]);
  const [audience, setAudience] = useState(null);  // author-only roster
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [acking, setAcking] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        getAnnouncement(id),
        getAnnouncementComments(id).catch(() => []),
      ]);
      setAnn(a); setComments(c || []);
      if (a.is_author || isSuperadmin) {
        getAnnouncementAudience(id).then(setAudience).catch(() => {});
      }
    } catch (e) {
      toast(e.message || t('common.error'), 'error');
      onClose();
    }
  }, [id, isSuperadmin, t, onClose]);

  useEffect(() => { load(); }, [load]);

  async function ack() {
    setAcking(true);
    try { await acknowledgeAnnouncement(id); toast(t('announcements.acknowledged')); await load(); onChanged?.(); }
    catch (e) { toast(e.message || t('common.error'), 'error'); }
    finally { setAcking(false); }
  }

  async function postComment(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await postAnnouncementComment(id, draft.trim());
      setDraft('');
      const c = await getAnnouncementComments(id); setComments(c || []);
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
    finally { setPosting(false); }
  }

  async function delComment(cid) {
    try {
      await deleteAnnouncementComment(id, cid);
      const c = await getAnnouncementComments(id); setComments(c || []);
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  async function archive() {
    setConfirmArchive(false);
    try {
      await archiveAnnouncement(id);
      toast(t('announcements.archivedToast'));
      onChanged?.();
      onClose();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  if (!ann) {
    return (
      <Modal title={t('announcements.loading')} onClose={onClose} size="lg">
        <div style={{ padding: 60 }}><LoadingSpinner /></div>
      </Modal>
    );
  }

  const ps = PRIORITY_STYLE[ann.priority] || PRIORITY_STYLE.medium;
  const canArchive = ann.is_author || isSuperadmin;

  return (
    <Modal title={null} onClose={onClose} size="lg">
      {/* Custom header with priority accent */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid var(--border)',
        background: `linear-gradient(180deg, ${ps.color}0F 0%, transparent 100%)`,
        position: 'relative',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <PriorityChip priority={ann.priority} t={t} />
          {ann.pinned && (
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px',
                            color: 'var(--text-3)', textTransform: 'uppercase' }}>
              📌 {t('announcements.pinned')}
            </span>
          )}
          {ann.expires_at && (
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px',
                            color: 'var(--text-3)', textTransform: 'uppercase' }}>
              {t('announcements.expires')}: {fmtDate(ann.expires_at)}
            </span>
          )}
          <span style={{ marginInlineStart: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
            {fmtDate(ann.published_at)}
          </span>
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: '-0.4px',
                      color: 'var(--text)' }}>{ann.title}</h2>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
          {t('announcements.from')} <strong style={{ color: 'var(--text-2)' }}>{ann.author_name}</strong>
          {' · '}
          {t('announcements.audience')}: <strong style={{ color: 'var(--text-2)' }}>{ann.audience?.label}</strong>
        </div>
      </div>

      <div className="modal-body" style={{ paddingTop: 16 }}>
        {/* Body */}
        <div style={{
          fontSize: 14, lineHeight: 1.65, color: 'var(--text)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{ann.body}</div>

        {/* Acknowledge */}
        {!!ann.requires_ack && (
          <div style={{
            marginTop: 18, padding: '12px 14px', borderRadius: 8,
            border: '1px solid', display: 'flex', alignItems: 'center', gap: 12,
            background: ann.acknowledged_at ? 'rgba(16,185,129,.08)' : 'rgba(234,88,12,.08)',
            borderColor:  ann.acknowledged_at ? 'rgba(16,185,129,.30)' : 'rgba(234,88,12,.30)',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 50, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: ann.acknowledged_at ? '#059669' : '#ea580c', color: '#fff',
            }}>
              {ann.acknowledged_at
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                {ann.acknowledged_at ? t('announcements.youAcked') : t('announcements.ackRequired')}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                {ann.acknowledged_at
                  ? `${t('announcements.acknowledgedOn')} ${fmtDate(ann.acknowledged_at)}`
                  : t('announcements.ackHint')}
              </div>
            </div>
            {!ann.acknowledged_at && (
              <button className="btn btn-primary btn-sm" onClick={ack} disabled={acking}>
                {acking ? t('common.saving') : t('announcements.acknowledgeBtn')}
              </button>
            )}
          </div>
        )}

        {/* Audience roster (author or superadmin) */}
        {audience && (
          <div style={{ marginTop: 22 }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '.6px',
              textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8,
            }}>{t('announcements.roster')}</div>
            <div style={{
              maxHeight: 220, overflowY: 'auto',
              border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--surface-2)',
            }}>
              {audience.map(r => (
                <div key={r.user_id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderBottom: '1px solid var(--border)',
                  fontSize: 12.5,
                }}>
                  <span style={{ flex: 1, color: 'var(--text-2)' }}>
                    {r.full_name || r.username}
                    <span style={{ marginInlineStart: 6, color: 'var(--text-3)', fontSize: 11 }}>
                      {r.role}
                    </span>
                  </span>
                  <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px',
                                  textTransform: 'uppercase',
                                  color: r.read_at ? '#059669' : 'var(--text-3)' }}>
                    {r.read_at ? '✓ ' + t('announcements.read') : t('announcements.unread')}
                  </span>
                  {ann.requires_ack && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px',
                                    textTransform: 'uppercase',
                                    color: r.acknowledged_at ? '#2563eb' : 'var(--text-3)' }}>
                      {r.acknowledged_at ? '✓ ' + t('announcements.acknowledged') : t('announcements.pendingAck')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div style={{ marginTop: 22 }}>
          <div style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: '.6px',
            textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 10,
          }}>
            {t('announcements.comments')} {comments.length > 0 && `(${comments.length})`}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {comments.length === 0 && (
              <div style={{
                padding: 14, textAlign: 'center', fontSize: 12,
                color: 'var(--text-3)', background: 'var(--surface-2)',
                borderRadius: 8, border: '1px dashed var(--border)',
              }}>
                {t('announcements.noComments')}
              </div>
            )}
            {comments.map(c => (
              <div key={c.id} style={{
                padding: '10px 12px', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                               fontSize: 12, marginBottom: 4 }}>
                  <strong style={{ color: 'var(--text)' }}>{c.author_name}</strong>
                  <span style={{ color: 'var(--text-3)' }}>· {fmtDate(c.created_at)}</span>
                  {(c.author_id === user.id || isSuperadmin) && (
                    <button onClick={() => delComment(c.id)}
                      style={{ marginInlineStart: 'auto', all: 'unset', cursor: 'pointer',
                                fontSize: 11, color: 'var(--text-3)' }}
                      title={t('common.delete')}>
                      ✕
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5,
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {c.body}
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={postComment} style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-control"
              placeholder={t('announcements.commentPlaceholder')}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              maxLength={2000}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={posting || !draft.trim()}>
              {t('announcements.post')}
            </button>
          </form>
        </div>
      </div>

      <div className="modal-footer">
        {canArchive && (
          <button className="btn btn-outline btn-sm"
                  style={{ color: 'var(--red, #dc2626)', borderColor: 'var(--red, #dc2626)' }}
                  onClick={() => setConfirmArchive(true)}>
            {t('announcements.archive')}
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>

      {confirmArchive && (
        <ConfirmModal
          title={t('announcements.archiveConfirmTitle')}
          message={t('announcements.archiveConfirmMessage')}
          confirmLabel={t('announcements.archive')}
          confirmClass="btn-danger"
          onConfirm={archive}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
    </Modal>
  );
}


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
