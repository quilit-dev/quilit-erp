import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import { getPlanningDropdownUsers, createPlanningEvent, updatePlanningEvent } from '../../api/client';
import { toIso, EVENT_COLORS } from './constants';

function EventForm({ initial, defaultDate, currentUserId, onSave, onClose, onDelete }) {
  const { t } = useLocale();
  // Editing an existing event you don't own — you were invited, so you can
  // see the details but can't modify them. Mirrors Google/Outlook semantics
  // and matches the backend ownership check on PUT/DELETE.
  const isEdit     = !!initial?.id;
  const isOwner    = !isEdit || (currentUserId != null && initial.owner_id === currentUserId);
  const readOnly   = isEdit && !isOwner;
  // Single source of truth — initial wins; otherwise defaultDate seeds start_date.
  const seedDate = initial?.start_date || defaultDate || toIso(new Date());
  const [form, setForm] = useState({
    title:       initial?.title       || '',
    description: initial?.description || '',
    start_date:  seedDate,
    end_date:    initial?.end_date    || '',
    start_time:  initial?.start_time  || '',
    end_time:    initial?.end_time    || '',
    all_day:     initial ? !!initial.all_day : true,
    color:       initial?.color       || EVENT_COLORS[0],
    attendees:   Array.isArray(initial?.attendees) ? initial.attendees : [],
  });
  const [saving, setSaving] = useState(false);
  // Lazy-load the user dropdown so the form opens fast even on slow connections.
  const [userOptions, setUserOptions] = useState([]);
  useEffect(() => {
    getPlanningDropdownUsers().then(setUserOptions).catch(() => setUserOptions([]));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (readOnly) return;       // belt-and-braces — buttons are hidden too
    if (!form.title.trim()) { toast(t('planning.eventTitleRequired'), 'error'); return; }
    if (!form.start_date)   { toast(t('planning.startDateRequired'), 'error'); return; }
    if (form.end_date && form.end_date < form.start_date) {
      toast(t('planning.endBeforeStart'), 'error'); return;
    }
    setSaving(true);
    try {
      const payload = {
        title:       form.title.trim(),
        description: form.description || null,
        start_date:  form.start_date,
        end_date:    form.end_date || null,
        start_time:  form.all_day ? null : (form.start_time || null),
        end_time:    form.all_day ? null : (form.end_time || null),
        all_day:     form.all_day ? 1 : 0,
        color:       form.color,
        attendees:   form.attendees,           // [] means "no attendees / clear"
      };
      if (isEdit) {
        const res = await updatePlanningEvent(initial.id, payload);
        const newly = res?.attendees_notified || 0;
        toast(newly > 0
          ? t('planning.eventUpdatedNotified', { n: newly })
          : t('planning.eventUpdated'));
      } else {
        const res = await createPlanningEvent(payload);
        const newly = res?.attendees_notified || 0;
        toast(newly > 0
          ? t('planning.eventCreatedNotified', { n: newly })
          : t('planning.eventCreated'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function toggleAttendee(uid) {
    setForm(f => ({
      ...f,
      attendees: f.attendees.includes(uid)
        ? f.attendees.filter(x => x !== uid)
        : [...f.attendees, uid],
    }));
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">
        {readOnly && (
          <div style={{
            padding: '8px 12px', marginBottom: 12, borderRadius: 6,
            background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--accent) 25%, var(--border))',
            fontSize: 12, color: 'var(--text-2)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <span>
              {t('planning.eventReadOnly', { owner: initial?.owner_name || '' })}
            </span>
          </div>
        )}

        <div className="form-group form-full">
          <label className="form-label">{t('planning.eventTitle')} *</label>
          <input className="form-control" value={form.title}
                 onChange={e => set('title', e.target.value)} autoFocus={!readOnly} required
                 disabled={readOnly}
                 placeholder={t('planning.eventTitlePlaceholder')} />
        </div>

        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('planning.startDate')} *</label>
            <input type="date" className="form-control" value={form.start_date}
                   onChange={e => set('start_date', e.target.value)} required
                   disabled={readOnly} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.endDate')}</label>
            <input type="date" className="form-control" value={form.end_date}
                   onChange={e => set('end_date', e.target.value)}
                   min={form.start_date || undefined}
                   disabled={readOnly} />
          </div>
        </div>

        <div className="form-group form-full" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id="evt-all-day" type="checkbox" checked={form.all_day}
                 onChange={e => set('all_day', e.target.checked)}
                 disabled={readOnly}
                 style={{ width: 16, height: 16, cursor: readOnly ? 'not-allowed' : 'pointer' }} />
          <label htmlFor="evt-all-day" style={{ fontSize: 13, color: 'var(--text-2)', cursor: readOnly ? 'not-allowed' : 'pointer', margin: 0 }}>
            {t('planning.allDay')}
          </label>
        </div>

        {!form.all_day && (
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('planning.startTime')}</label>
              <input type="time" className="form-control" value={form.start_time}
                     onChange={e => set('start_time', e.target.value)}
                     disabled={readOnly} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('planning.endTime')}</label>
              <input type="time" className="form-control" value={form.end_time}
                     onChange={e => set('end_time', e.target.value)}
                     disabled={readOnly} />
            </div>
          </div>
        )}

        {/* Attendees — picking anyone here fires them a notification */}
        <div className="form-group form-full">
          <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('planning.attendees')}
            {form.attendees.length > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.3px',
                background: 'var(--accent)', color: 'var(--accent-ink)',
                padding: '1px 7px', borderRadius: 999,
              }}>{form.attendees.length}</span>
            )}
          </label>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8,
            background: 'var(--surface-2)', borderRadius: 8,
            border: '1px solid var(--border)',
            maxHeight: 140, overflowY: 'auto',
          }}>
            {userOptions.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
                {t('planning.noTeammates')}
              </span>
            )}
            {userOptions.map(u => {
              const active = form.attendees.includes(u.id);
              // In read-only mode, only render the chips that ARE attendees —
              // showing the full roster as inert grey chips would look broken.
              if (readOnly && !active) return null;
              return (
                <button key={u.id} type="button"
                  onClick={readOnly ? undefined : () => toggleAttendee(u.id)}
                  disabled={readOnly}
                  style={{
                    padding: '4px 11px', borderRadius: 999,
                    border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--border)',
                    background: active ? 'var(--accent)' : 'var(--surface)',
                    color: active ? '#fff' : 'var(--text-2)',
                    fontSize: 12, fontWeight: 600,
                    cursor: readOnly ? 'default' : 'pointer',
                    transition: 'all .12s',
                  }}>
                  {u.name || u.username}
                </button>
              );
            })}
          </div>
          {!readOnly && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              {t('planning.attendeesHint')}
            </div>
          )}
        </div>

        <div className="form-group form-full">
          <label className="form-label">{t('planning.eventColor')}</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {EVENT_COLORS.map(c => (
              <button key={c} type="button"
                onClick={readOnly ? undefined : () => set('color', c)}
                disabled={readOnly}
                aria-label={c}
                style={{
                  width: 26, height: 26, borderRadius: '50%', background: c, border: 'none',
                  cursor: readOnly ? 'default' : 'pointer',
                  opacity: readOnly && form.color !== c ? 0.35 : 1,
                  outline: form.color === c ? `3px solid ${c}` : '2px solid transparent',
                  outlineOffset: 2, boxShadow: form.color === c ? '0 0 0 2px var(--bg)' : 'none',
                  transition: 'all .15s',
                }}
              />
            ))}
          </div>
        </div>

        <div className="form-group form-full">
          <label className="form-label">{t('planning.eventDescription')}</label>
          <textarea className="form-control" rows={3} value={form.description}
                    onChange={e => set('description', e.target.value)}
                    disabled={readOnly}
                    placeholder={t('planning.eventDescriptionPlaceholder')} />
        </div>

        {isEdit && initial?.owner_name && (
          <div className="form-group form-full" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('planning.createdBy')}: <strong style={{ color: 'var(--text-2)' }}>{initial.owner_name}</strong>
          </div>
        )}
      </div>
      <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          {isEdit && isOwner && (
            <button type="button" className="btn btn-outline btn-sm"
                    style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                    onClick={() => onDelete(initial)}
                    disabled={saving}>
              {t('common.delete')}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>
            {readOnly ? t('common.close') : t('common.cancel')}
          </button>
          {!readOnly && (
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? t('common.saving') : (isEdit ? t('common.save') : t('common.create'))}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}


// ─── CALENDAR VIEW ────────────────────────────────────────────────────────────
// Standalone events only — projects/tasks live in the Gantt + Board + List
// views. Click an empty day to add an event; click an event to edit/delete.


export { EventForm };
