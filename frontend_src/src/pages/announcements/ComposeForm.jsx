import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import {
  createAnnouncement, getAnnouncementRolesMeta, getAnnouncementUsersMeta,
} from '../../api/client';
import { PRIORITIES, PRIORITY_STYLE } from './ui';


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

export { ComposeForm };
