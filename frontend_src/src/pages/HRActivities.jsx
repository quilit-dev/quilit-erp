import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { Modal, ConfirmModal, EmptyState, toast } from '../components/shared';
import {
  getHRActivities, getHRActivity, getHRActivitiesSummary,
  createHRActivity, updateHRActivity, completeHRActivity, archiveHRActivity,
  getHRActivityApplicants, getHRActivityEmployees,
} from '../api/client';

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPES = ['Call', 'Meeting', 'Interview', 'Email', 'Note', 'Task'];
const TYPE_COLOR = {
  Call:      '#0ea5e9',
  Meeting:   '#4f8ef7',
  Interview: '#10b981',
  Email:     '#f59e0b',
  Note:      '#6b7280',
  Task:      '#8b5cf6',
};
const TYPE_ICON = {
  Call:      '📞',
  Meeting:   '👥',
  Interview: '🎯',
  Email:     '✉️',
  Note:      '📝',
  Task:      '✅',
};
const REMINDER_CHOICES = [
  { value: 0,    key: 'hrActivities.remindNone' },
  { value: 5,    key: 'hrActivities.remind5m'   },
  { value: 15,   key: 'hrActivities.remind15m'  },
  { value: 30,   key: 'hrActivities.remind30m'  },
  { value: 60,   key: 'hrActivities.remind1h'   },
  { value: 120,  key: 'hrActivities.remind2h'   },
  { value: 1440, key: 'hrActivities.remind1d'   },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

/** ISO local-time string suitable for <input type="datetime-local">. */
function nowLocalIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Back-end stores 'YYYY-MM-DD HH:MM:SS' (UTC). Convert to a local
 *  datetime-local input value for editing.  */
function backendToLocal(s) {
  if (!s) return '';
  // Treat as UTC, render in local TZ
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a local datetime-local value back to the backend's 'YYYY-MM-DD HH:MM:SS' UTC string. */
function localToBackend(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

function formatWhen(s, lang) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  const locale = lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en';
  return d.toLocaleString(locale, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function relativeFromNow(s, t) {
  if (!s) return '';
  const target = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(target)) return '';
  const diffMin = Math.round((target - new Date()) / 60000);
  const abs = Math.abs(diffMin);
  // Localisation note: the suffix is its own key so RTL languages can flip
  // word order without a template-engine plural feature.
  const suffix = diffMin >= 0 ? t('hrActivities.relFromNow') : t('hrActivities.relAgo');
  if (abs < 60)       return t('hrActivities.relMinutes', { n: abs,                       suffix });
  if (abs < 60 * 24)  return t('hrActivities.relHours',   { n: Math.round(abs / 60),      suffix });
  return                   t('hrActivities.relDays',      { n: Math.round(abs / 1440),    suffix });
}

function Pill({ color, children, faded }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      background: `${color}${faded ? '12' : '22'}`,
      color, border: `1px solid ${color}33`,
    }}>{children}</span>
  );
}

// ─── Summary cards ──────────────────────────────────────────────────────────

function SummaryCards({ summary, active, onSelect }) {
  const { t } = useLocale();
  if (!summary) return null;
  const cards = [
    { key: 'today',    label: t('hrActivities.cardToday'),    value: summary.today,       accent: '#4f8ef7' },
    { key: 'upcoming', label: t('hrActivities.cardUpcoming'), value: summary.upcoming_14, accent: '#10b981' },
    { key: 'overdue',  label: t('hrActivities.cardOverdue'),  value: summary.overdue,     accent: '#ef4444' },
    { key: 'done',     label: t('hrActivities.cardDone7d'),   value: summary.done_7d,     accent: '#6b7280' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
      {cards.map(c => {
        const selected = active === c.key;
        return (
          <button key={c.key} type="button" onClick={() => onSelect(c.key)}
            className="stat-card"
            style={{
              all: 'unset', cursor: 'pointer',
              '--card-accent': c.accent,
              outline: selected ? `2px solid ${c.accent}` : '1px solid var(--border)',
              outlineOffset: -1, borderRadius: 8, padding: 14, background: 'var(--card)',
              display: 'flex', flexDirection: 'column', gap: 4,
              transition: 'outline-color .15s, transform .15s',
            }}>
            <div className="stat-label">{c.label}</div>
            <div className="stat-value">{c.value ?? 0}</div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Activity form modal ────────────────────────────────────────────────────

function ActivityForm({ initial, applicants, employees, onSave, onClose }) {
  const { t } = useLocale();
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(() => ({
    activity_type:           initial?.activity_type        || 'Meeting',
    subject:                 initial?.subject              || '',
    description:             initial?.description          || '',
    scheduled_at_local:      initial?.scheduled_at ? backendToLocal(initial.scheduled_at)
                                                  : nowLocalIso(),
    duration_min:            initial?.duration_min ?? 30,
    location:                initial?.location             || '',
    applicant_id:            initial?.applicant_id         || '',
    employee_id:             initial?.employee_id          || '',
    reminder_minutes_before: initial?.reminder_minutes_before ?? 15,
  }));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.subject.trim())       { toast(t('hrActivities.subjectRequired'), 'error'); return; }
    if (!form.scheduled_at_local)   { toast(t('hrActivities.scheduledRequired'), 'error'); return; }

    setSaving(true);
    try {
      const payload = {
        activity_type:           form.activity_type,
        subject:                 form.subject.trim(),
        description:             form.description || null,
        scheduled_at:            localToBackend(form.scheduled_at_local),
        duration_min:            Number(form.duration_min) || 0,
        location:                form.location || null,
        applicant_id:            form.applicant_id ? Number(form.applicant_id) : null,
        employee_id:             form.employee_id  ? Number(form.employee_id)  : null,
        reminder_minutes_before: Number(form.reminder_minutes_before),
      };
      if (isEdit) {
        await updateHRActivity(initial.id, payload);
        toast(t('hrActivities.updated'));
      } else {
        const res = await createHRActivity(payload);
        toast(res.reminder_scheduled
              ? t('hrActivities.createdWithReminder')
              : t('hrActivities.created'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  // Choosing an applicant clears the employee link (and vice versa) — a single
  // activity is always *about* one person, not both. UI nudges this rule.
  function pickApplicant(v) { setForm(f => ({ ...f, applicant_id: v, employee_id: '' })); }
  function pickEmployee(v)  { setForm(f => ({ ...f, employee_id: v, applicant_id: '' })); }

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">
        <div className="form-grid">
          {/* Type — visual chips so people don't have to read the dropdown */}
          <div className="form-group form-full">
            <label className="form-label">{t('hrActivities.type')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {TYPES.map(tp => {
                const active = form.activity_type === tp;
                const color  = TYPE_COLOR[tp];
                return (
                  <button key={tp} type="button"
                    onClick={() => set('activity_type', tp)}
                    style={{
                      all: 'unset', cursor: 'pointer',
                      padding: '6px 12px', borderRadius: 999,
                      border: `1px solid ${active ? color : 'var(--border)'}`,
                      background: active ? color : 'var(--surface)',
                      color: active ? '#fff' : 'var(--text-2)',
                      fontSize: 12, fontWeight: 600,
                      transition: 'all .12s',
                    }}>
                    <span style={{ marginInlineEnd: 6 }}>{TYPE_ICON[tp]}</span>
                    {t(`hrActivities.type_${tp.toLowerCase()}`)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('hrActivities.subject')} *</label>
            <input className="form-control" value={form.subject}
                   onChange={e => set('subject', e.target.value)} autoFocus required
                   placeholder={t('hrActivities.subjectPlaceholder')} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('hrActivities.scheduledAt')} *</label>
            <input type="datetime-local" className="form-control"
                   value={form.scheduled_at_local}
                   onChange={e => set('scheduled_at_local', e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('hrActivities.duration')}</label>
            <input type="number" min="0" step="5" className="form-control"
                   value={form.duration_min}
                   onChange={e => set('duration_min', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('hrActivities.linkApplicant')}</label>
            <select className="form-control" value={form.applicant_id}
                    onChange={e => pickApplicant(e.target.value)}>
              <option value="">{t('common.none')}</option>
              {applicants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('hrActivities.linkEmployee')}</label>
            <select className="form-control" value={form.employee_id}
                    onChange={e => pickEmployee(e.target.value)}>
              <option value="">{t('common.none')}</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">{t('hrActivities.location')}</label>
            <input className="form-control" value={form.location}
                   onChange={e => set('location', e.target.value)}
                   placeholder={t('hrActivities.locationPlaceholder')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('hrActivities.reminder')}</label>
            <select className="form-control" value={form.reminder_minutes_before}
                    onChange={e => set('reminder_minutes_before', Number(e.target.value))}>
              {REMINDER_CHOICES.map(r => (
                <option key={r.value} value={r.value}>{t(r.key)}</option>
              ))}
            </select>
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('hrActivities.notes')}</label>
            <textarea className="form-control" rows={3} value={form.description}
                      onChange={e => set('description', e.target.value)}
                      placeholder={t('hrActivities.notesPlaceholder')} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : (isEdit ? t('common.save') : t('common.create'))}
        </button>
      </div>
    </form>
  );
}

// ─── Activity row in the list ───────────────────────────────────────────────

function ActivityRow({ activity, scope, onEdit, onComplete, onArchive }) {
  const { t, lang } = useLocale();
  const color = TYPE_COLOR[activity.activity_type] || '#6b7280';
  const linked = activity.applicant_name
    ? { kind: t('hrActivities.applicantLabel'), name: activity.applicant_name }
    : activity.employee_name
      ? { kind: t('hrActivities.employeeLabel'), name: activity.employee_name }
      : null;
  const isOverdue = activity.status === 'Planned' &&
    new Date(activity.scheduled_at.replace(' ', 'T') + 'Z') < new Date();
  const isDone = activity.status === 'Done';

  return (
    <div className="card" style={{
      padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12,
      borderLeft: `3px solid ${color}`,
      opacity: isDone ? 0.7 : 1,
    }}>
      <div style={{
        flexShrink: 0, width: 36, height: 36, borderRadius: 8,
        background: `${color}22`, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 18,
      }}>
        {TYPE_ICON[activity.activity_type]}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{
            fontWeight: 700, fontSize: 13, color: 'var(--text)',
            textDecoration: isDone ? 'line-through' : 'none',
          }}>
            {activity.subject}
          </span>
          <Pill color={color}>{t(`hrActivities.type_${activity.activity_type.toLowerCase()}`)}</Pill>
          {isOverdue && (
            <Pill color="#ef4444">{t('hrActivities.overdue')}</Pill>
          )}
          {isDone && (
            <Pill color="#10b981">{t('hrActivities.done')}</Pill>
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <span>
            🗓 {formatWhen(activity.scheduled_at, lang)}
            {!isDone && (
              <span style={{ marginInlineStart: 6, color: isOverdue ? '#ef4444' : 'var(--text-3)' }}>
                ({relativeFromNow(activity.scheduled_at, t)})
              </span>
            )}
          </span>
          {activity.duration_min > 0 && <span>⏱ {activity.duration_min}m</span>}
          {activity.location && <span>📍 {activity.location}</span>}
          {linked && <span>{linked.kind}: <strong style={{ color: 'var(--text-2)' }}>{linked.name}</strong></span>}
          {activity.reminder_minutes_before > 0 && !isDone && (
            <span>⏰ {t('hrActivities.remindsBeforeShort', { n: activity.reminder_minutes_before })}</span>
          )}
        </div>

        {activity.description && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.4 }}>
            {activity.description}
          </div>
        )}
        {isDone && activity.completed_notes && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.4, fontStyle: 'italic' }}>
            ✓ {activity.completed_notes}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        {!isDone && (
          <button className="btn btn-primary btn-sm" onClick={() => onComplete(activity)}>
            ✓ {t('hrActivities.markDone')}
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={() => onEdit(activity)}>
          {t('common.edit')}
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => onArchive(activity)}
                style={{ color: 'var(--text-3)' }}>
          {t('common.archive')}
        </button>
      </div>
    </div>
  );
}

// ─── Complete-confirmation modal (with optional outcome notes) ──────────────

function CompleteModal({ activity, onConfirm, onClose }) {
  const { t } = useLocale();
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function go() {
    setSaving(true);
    try {
      await completeHRActivity(activity.id, { completed_notes: notes.trim() || null });
      toast(t('hrActivities.markedDone'));
      onConfirm();
    } catch (e) {
      toast(e.message || t('common.error'), 'error');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={t('hrActivities.completeTitle')} onClose={onClose} size="sm">
      <div className="modal-body">
        <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--text-2)' }}>
          {t('hrActivities.completePrompt')} <strong>{activity.subject}</strong>
        </div>
        <div className="form-group form-full">
          <label className="form-label">{t('hrActivities.completeNotesLabel')}</label>
          <textarea className="form-control" rows={3} value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder={t('hrActivities.completeNotesPlaceholder')} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={go} disabled={saving}>
          {saving ? t('common.saving') : t('hrActivities.markDone')}
        </button>
      </div>
    </Modal>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

const SCOPE_TABS = ['upcoming', 'today', 'overdue', 'done', 'all'];
const SCOPE_KEY  = {
  upcoming: 'hrActivities.scopeUpcoming',
  today:    'hrActivities.scopeToday',
  overdue:  'hrActivities.scopeOverdue',
  done:     'hrActivities.scopeDone',
  all:      'hrActivities.scopeAll',
};
const CARD_TO_SCOPE = { today: 'today', upcoming: 'upcoming', overdue: 'overdue', done: 'done' };

export default function HRActivities() {
  const { t } = useLocale();
  const [scope, setScope] = useState('upcoming');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState(null);     // null | { id?, … }
  const [modalOpen, setModalOpen] = useState(false);
  const [completing, setCompleting] = useState(null);
  const [archiving, setArchiving] = useState(null);

  const fetchActivities = useCallback(s => getHRActivities(
    { scope, ...(typeFilter ? { activity_type: typeFilter } : {}) }, s,
  ), [scope, typeFilter]);
  const fetchSummary = useCallback(s => getHRActivitiesSummary(s), []);

  // useData seeds `data` as null while the first request is in flight — coerce
  // to [] so the filter/map below never explodes on the loading render.
  // The second arg to useData is the dep list for its internal useCallback;
  // pass [scope, typeFilter] so changing a filter actually triggers a refetch.
  const { data: activitiesRaw, loading, reload: reloadList } = useData(fetchActivities, [scope, typeFilter]);
  const activities = activitiesRaw || [];
  const { data: summary,        reload: reloadSummary } = useData(fetchSummary);

  // Reference data for the form's dropdowns. Fetched once on mount — applicant
  // and employee rosters change rarely vs. the activity list, so re-fetching
  // them on every modal open would be wasteful.
  const [applicants, setApplicants] = useState([]);
  const [employees,  setEmployees]  = useState([]);
  useEffect(() => {
    getHRActivityApplicants().then(setApplicants).catch(() => setApplicants([]));
    getHRActivityEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);

  function reloadAll() { reloadList(); reloadSummary(); }

  const filtered = useMemo(() => {
    if (!search.trim()) return activities;
    const q = search.trim().toLowerCase();
    return activities.filter(a =>
      (a.subject || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.applicant_name || '').toLowerCase().includes(q) ||
      (a.employee_name  || '').toLowerCase().includes(q),
    );
  }, [activities, search]);

  function openCreate()         { setEditing(null);  setModalOpen(true); }
  async function openEdit(a)    {
    try {
      // Re-fetch the row so the form sees fresh state (description, notes, etc.)
      const full = await getHRActivity(a.id);
      setEditing(full);
      setModalOpen(true);
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  async function doArchive(a) {
    setArchiving(null);
    try {
      await archiveHRActivity(a.id);
      toast(t('hrActivities.archived'));
      reloadAll();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  return (
    <div className="page-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>{t('hrActivities.pageTitle')}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-3)', fontSize: 13 }}>
            {t('hrActivities.pageSubtitle')}
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          + {t('hrActivities.newActivity')}
        </button>
      </div>

      {/* KPI cards — clicking one jumps to that scope */}
      <SummaryCards
        summary={summary}
        active={CARD_TO_SCOPE[scope] || ''}
        onSelect={key => setScope(key)}
      />

      {/* Toolbar: scope tabs + search + type filter */}
      <div className="card" style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
            {SCOPE_TABS.map(s => (
              <button key={s}
                className={scope === s ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
                style={{ borderRadius: 0, border: 'none', fontSize: 12 }}
                onClick={() => setScope(s)}>
                {t(SCOPE_KEY[s])}
              </button>
            ))}
          </div>
          <input
            className="form-control"
            style={{ flex: 1, minWidth: 200 }}
            placeholder={t('hrActivities.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="form-control" style={{ width: 150 }}
                  value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">{t('hrActivities.allTypes')}</option>
            {TYPES.map(tp => (
              <option key={tp} value={tp}>{t(`hrActivities.type_${tp.toLowerCase()}`)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      {loading ? null : filtered.length === 0 ? (
        <EmptyState
          icon="📭"
          message={search ? t('hrActivities.emptySearch') : t(`hrActivities.empty_${scope}`)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(a => (
            <ActivityRow key={a.id} activity={a} scope={scope}
              onEdit={openEdit}
              onComplete={ac => setCompleting(ac)}
              onArchive={ac => setArchiving(ac)}
            />
          ))}
        </div>
      )}

      {/* Create / edit modal */}
      {modalOpen && (
        <Modal
          title={editing ? t('hrActivities.editTitle') : t('hrActivities.newActivity')}
          onClose={() => setModalOpen(false)}
          size="md"
        >
          <ActivityForm
            initial={editing}
            applicants={applicants}
            employees={employees}
            onSave={() => { setModalOpen(false); reloadAll(); }}
            onClose={() => setModalOpen(false)}
          />
        </Modal>
      )}

      {/* Complete modal — captures outcome notes inline */}
      {completing && (
        <CompleteModal
          activity={completing}
          onClose={() => setCompleting(null)}
          onConfirm={() => { setCompleting(null); reloadAll(); }}
        />
      )}

      {/* Archive confirmation */}
      {archiving && (
        <ConfirmModal
          title={t('hrActivities.archiveTitle')}
          message={`${t('hrActivities.archivePrompt')} "${archiving.subject}"?`}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={() => doArchive(archiving)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
