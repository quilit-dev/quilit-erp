import { useState, useEffect, useCallback } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, ConfirmModal, LoadingSpinner, toast, fmtDate } from '../../components/shared';
import {
  getAnnouncement, archiveAnnouncement, acknowledgeAnnouncement,
  getAnnouncementComments, postAnnouncementComment, deleteAnnouncementComment,
  getAnnouncementAudience,
} from '../../api/client';
import { PRIORITY_STYLE, PriorityChip } from './ui';


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

export { DetailModal };
