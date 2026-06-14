import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, EmptyState, toast } from '../components/shared';
import {
  getPlanningProjects, createPlanningProject, updatePlanningProject, archivePlanningProject, unarchivePlanningProject,
  getPlanningTasks, createPlanningTask, updatePlanningTask, archivePlanningTask, unarchivePlanningTask,
  updateTaskDates, updateTaskStatus, updateTaskProgress,
  getPlanningMilestones,
  getPlanningSummary, getPlanningDropdownClients, getPlanningDropdownUsers,
  getPlanningEvents, createPlanningEvent, updatePlanningEvent, deletePlanningEvent,
} from '../api/client';

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUSES   = ['To Do', 'In Progress', 'Review', 'Done', 'Blocked'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const PROJ_STATUSES = ['Active', 'On Hold', 'Completed', 'Cancelled'];

const STATUS_BADGE = {
  'To Do':       'blue',
  'In Progress': 'yellow',
  'Review':      'purple',
  'Done':        'green',
  'Blocked':     'red',
};
const PRIORITY_BADGE = {
  Low:      'blue',
  Medium:   'yellow',
  High:     'orange',
  Critical: 'red',
};
const PROJECT_COLORS = [
  '#4f8ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];

// Maps for translating the English values stored in DB / used as keys
const STATUS_KEY = {
  'To Do':       'planning.statusTodo',
  'In Progress': 'planning.statusInProgress',
  'Review':      'planning.statusReview',
  'Done':        'planning.statusDone',
  'Blocked':     'planning.statusBlocked',
};
const PRIORITY_KEY = {
  Low:      'planning.priorityLow',
  Medium:   'planning.priorityMedium',
  High:     'planning.priorityHigh',
  Critical: 'planning.priorityCritical',
};
const PROJ_STATUS_KEY = {
  Active:      'planning.projectActive',
  'On Hold':   'planning.projectOnHold',
  Completed:   'planning.projectCompleted',
  Cancelled:   'planning.projectCancelled',
};

// Translate an enum value, falling back to the raw value if it has no key
function tEnum(t, map, val) {
  return map[val] ? t(map[val]) : (val ?? '');
}

// Gantt constants
const DAY_W  = 30;   // px per day
const ROW_H  = 40;   // px per row
const LEFT_W = 230;  // px for sticky left column

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? null : d;
}
function toIso(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function Badge({ color, children, style }) {
  return (
    <span className={`badge badge-${color}`} style={style}>{children}</span>
  );
}

function ProgressBar({ value, color, style }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', ...style }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color || 'var(--accent)', borderRadius: 3, transition: 'width .3s' }} />
    </div>
  );
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary }) {
  const { t } = useLocale();
  if (!summary) return null;
  const cards = [
    { label: t('planning.activeProjects'), value: summary.active_projects, accent: '#4f8ef7' },
    { label: t('planning.totalTasks'),     value: summary.total_tasks,     accent: '#8b5cf6' },
    { label: t('planning.inProgress'),     value: summary.in_progress,     accent: '#f59e0b' },
    { label: t('planning.overdueTasks'),   value: summary.overdue_tasks,   accent: '#ef4444' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} className="stat-card" style={{ '--card-accent': c.accent }}>
          <div className="stat-label">{c.label}</div>
          <div className="stat-value">{c.value ?? 0}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Project Form ─────────────────────────────────────────────────────────────

function ProjectForm({ initial, clients, onSave, onClose }) {
  const { t } = useLocale();
  const [form, setForm] = useState({
    name: '', description: '', color: '#4f8ef7',
    start_date: '', end_date: '', status: 'Active',
    ...(initial
      ? { ...initial, client_id: initial.client_id || '' }
      : { client_id: '' }),
  });
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('planning.projectNameRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = { ...form, client_id: form.client_id || null };
      if (initial?.id) {
        await updatePlanningProject(initial.id, payload);
        toast(t('planning.projectUpdated'));
      } else {
        await createPlanningProject(payload);
        toast(t('planning.projectCreated'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">
        <div className="form-group form-full">
          <label className="form-label">{t('planning.projectName')} *</label>
          <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} required />
        </div>
        <div className="form-group form-full">
          <label className="form-label">{t('planning.projectDesc')}</label>
          <textarea className="form-control" rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('planning.projectClient')}</label>
            <select className="form-control" value={form.client_id} onChange={e => set('client_id', e.target.value)}>
              <option value="">{t('planning.noneOption')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.projectStatus')}</label>
            <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
              {PROJ_STATUSES.map(s => <option key={s} value={s}>{t(PROJ_STATUS_KEY[s])}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.startDate')}</label>
            <input type="date" className="form-control" value={form.start_date || ''} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.endDate')}</label>
            <input type="date" className="form-control" value={form.end_date || ''} onChange={e => set('end_date', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">{t('planning.projectColor')}</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {PROJECT_COLORS.map(c => (
              <button key={c} type="button"
                onClick={() => set('color', c)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                  outline: form.color === c ? `3px solid ${c}` : '2px solid transparent',
                  outlineOffset: 2, boxShadow: form.color === c ? '0 0 0 2px var(--bg)' : 'none',
                  transition: 'all .15s',
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : (initial?.id ? t('common.save') : t('common.create'))}
        </button>
      </div>
    </form>
  );
}

// ─── Task Form ────────────────────────────────────────────────────────────────

function TaskForm({ initial, projects, users, milestones, tasks, onSave, onClose }) {
  const { t } = useLocale();
  // Sentinel value for "type a new project name inline". When the picker is
  // set to this, the new-project name input shows up and the task save flow
  // first creates the project, then references its id.
  const NEW_PROJECT = '__new__';

  const [form, setForm] = useState({
    name: '', description: '',
    status: 'To Do', priority: 'Medium', start_date: '', end_date: '',
    progress: 0,
    ...(initial
      ? {
          ...initial,
          project_id:   initial.project_id   || '',
          assigned_to:  initial.assigned_to  || '',
          milestone_id: initial.milestone_id || '',
          depends_on:   initial.depends_on   || '',
        }
      : { project_id: '', assigned_to: '', milestone_id: '', depends_on: '' }),
  });
  const [newProjectName, setNewProjectName] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('planning.taskNameRequired'), 'error'); return; }

    // Project handling — three legitimate cases:
    //   1. existing project picked → numeric id
    //   2. "(No project)" picked   → null (server buckets into "(General)")
    //   3. "+ New project..."      → create on the fly, use returned id
    let resolvedProjectId = null;
    if (form.project_id === NEW_PROJECT) {
      const name = newProjectName.trim();
      if (!name) { toast(t('planning.newProjectNameRequired'), 'error'); return; }
      try {
        const created = await createPlanningProject({ name, status: 'Active' });
        resolvedProjectId = created.id || created.project_id || created;
      } catch (err) {
        toast(err.message || t('common.error'), 'error');
        return;
      }
    } else if (form.project_id) {
      resolvedProjectId = Number(form.project_id);
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        project_id:   resolvedProjectId,
        assigned_to:  form.assigned_to  ? Number(form.assigned_to)  : null,
        milestone_id: form.milestone_id ? Number(form.milestone_id) : null,
        depends_on:   form.depends_on   ? Number(form.depends_on)   : null,
        progress:     Number(form.progress) || 0,
      };
      if (initial?.id) {
        await updatePlanningTask(initial.id, payload);
        toast(t('planning.taskUpdated'));
      } else {
        await createPlanningTask(payload);
        toast(t('planning.taskCreated'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const projMilestones = milestones.filter(m => String(m.project_id) === String(form.project_id));
  const projTasks = tasks.filter(t => String(t.project_id) === String(form.project_id) && t.id !== initial?.id);

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('planning.taskName')} *</label>
            <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.project')}</label>
            <select className="form-control" value={form.project_id}
                    onChange={e => set('project_id', e.target.value)}>
              <option value="">{t('planning.noProjectOption')}</option>
              <option value={NEW_PROJECT}>+ {t('planning.newProjectOption')}</option>
              {projects.length > 0 && <option disabled>──────────────</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {form.project_id === NEW_PROJECT && (
              <input
                className="form-control"
                style={{ marginTop: 6 }}
                placeholder={t('planning.newProjectNamePlaceholder')}
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                autoFocus
              />
            )}
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.assignedTo')}</label>
            <select className="form-control" value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)}>
              <option value="">{t('planning.unassignedOption')}</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.status')}</label>
            <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.priority')}</label>
            <select className="form-control" value={form.priority} onChange={e => set('priority', e.target.value)}>
              {PRIORITIES.map(p => <option key={p} value={p}>{t(PRIORITY_KEY[p])}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.startDate')}</label>
            <input type="date" className="form-control" value={form.start_date || ''} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.endDate')}</label>
            <input type="date" className="form-control" value={form.end_date || ''} onChange={e => set('end_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.progress')} ({form.progress}%)</label>
            <input type="range" min="0" max="100" step="5"
              value={form.progress} onChange={e => set('progress', Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          {projMilestones.length > 0 && (
            <div className="form-group">
              <label className="form-label">{t('planning.milestone')}</label>
              <select className="form-control" value={form.milestone_id} onChange={e => set('milestone_id', e.target.value)}>
                <option value="">{t('planning.noneOption')}</option>
                {projMilestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          {projTasks.length > 0 && (
            <div className="form-group">
              <label className="form-label">{t('planning.dependsOn')}</label>
              <select className="form-control" value={form.depends_on} onChange={e => set('depends_on', e.target.value)}>
                <option value="">{t('planning.noneOption')}</option>
                {projTasks.map(tk => <option key={tk.id} value={tk.id}>{tk.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group form-full">
            <label className="form-label">{t('planning.taskDesc')}</label>
            <textarea className="form-control" rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : (initial?.id ? t('common.save') : t('common.create'))}
        </button>
      </div>
    </form>
  );
}

// ─── GANTT VIEW ───────────────────────────────────────────────────────────────

function GanttView({ tasks, projects, milestones, onRefresh }) {
  const { t, lang } = useLocale();
  const dateLocale = lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en';
  const [selProject, setSelProject] = useState('');
  const [viewMode, setViewMode] = useState('month'); // 'week' | 'month'
  const dragRef      = useRef(null);
  const rightGridRef = useRef(null);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [dayW, setDayW] = useState(DAY_W);

  useEffect(() => { setLocalTasks(tasks); }, [tasks]);

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  const [viewStart, setViewStart] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 3);
    return d;
  });

  const DAYS = viewMode === 'week' ? 7 : 30;
  const rangeStart = viewStart;
  const rangeEnd   = addDays(viewStart, DAYS - 1);
  const totalDays  = DAYS;

  // Measure the right panel so days always fill the full available width
  useEffect(() => {
    if (!rightGridRef.current) return;
    function measure() {
      const w = rightGridRef.current?.getBoundingClientRect().width;
      if (w && w > 0) setDayW(Math.floor(w / DAYS));
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rightGridRef.current);
    return () => ro.disconnect();
  }, [DAYS]);

  function goPrev()  { setViewStart(d => addDays(d, -DAYS)); }
  function goNext()  { setViewStart(d => addDays(d, DAYS)); }
  function goToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 3);
    setViewStart(d);
  }

  const navLabel = viewMode === 'week'
    ? `${rangeStart.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} – ${rangeEnd.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : rangeStart.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });

  const filtered = selProject
    ? localTasks.filter(tk => String(tk.project_id) === selProject)
    : localTasks;

  const visibleTasks = filtered.filter(tk => {
    if (!tk.start_date && !tk.end_date) return false;
    const s = toDate(tk.start_date) || toDate(tk.end_date);
    const e = toDate(tk.end_date)   || toDate(tk.start_date);
    return s <= rangeEnd && e >= rangeStart;
  });

  // Build month label groups
  const months = [];
  let cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    const ex = months.find(m => m.key === key);
    if (ex) { ex.days++; }
    else { months.push({ key, label: cursor.toLocaleDateString(dateLocale, { month: 'short', year: 'numeric' }), days: 1 }); }
    cursor = addDays(cursor, 1);
  }

  function startDrag(e, task, type) {
    if (e.button !== 0) return;
    e.preventDefault();
    const s = toDate(task.start_date);
    const en = toDate(task.end_date);
    // capture dayW at drag-start so resize doesn't break if window is resized mid-drag
    dragRef.current = { taskId: task.id, type, startX: e.clientX, origStart: s, origEnd: en, curStart: s, curEnd: en, dayW };

    function onMove(ev) {
      const dr = dragRef.current;
      if (!dr) return;
      const days = Math.round((ev.clientX - dr.startX) / dr.dayW);
      if (dr.type === 'move') {
        dr.curStart = addDays(dr.origStart, days);
        dr.curEnd   = addDays(dr.origEnd, days);
      } else if (dr.type === 'resize-left') {
        const ns = addDays(dr.origStart, days);
        if (ns < dr.origEnd) dr.curStart = ns;
      } else {
        const ne = addDays(dr.origEnd, days);
        if (ne > dr.origStart) dr.curEnd = ne;
      }
      setLocalTasks(prev => prev.map(tk =>
        tk.id === dr.taskId ? { ...tk, start_date: toIso(dr.curStart), end_date: toIso(dr.curEnd) } : tk
      ));
    }

    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const dr = dragRef.current;
      if (!dr) return;
      dragRef.current = null;
      try {
        await updateTaskDates(dr.taskId, { start_date: toIso(dr.curStart), end_date: toIso(dr.curEnd) });
      } catch {
        toast(t('planning.failedSaveDates'), 'error');
        onRefresh();
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const todayOffset = daysBetween(rangeStart, today);
  const MONTH_HDR_H = 36;
  const DAY_HDR_H   = viewMode === 'week' ? 52 : 28;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select className="form-control" style={{ width: 200 }}
          value={selProject} onChange={e => setSelProject(e.target.value)}>
          <option value="">{t('planning.allProjects')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button className="btn btn-outline btn-sm" onClick={goPrev}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', minWidth: 200, textAlign: 'center' }}>{navLabel}</span>
          <button className="btn btn-outline btn-sm" onClick={goNext}>›</button>
          <button className="btn btn-outline btn-sm" onClick={goToday}>{t('planning.today')}</button>
        </div>

        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {(['week', 'month']).map(mode => (
            <button key={mode}
              className={viewMode === mode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
              style={{ borderRadius: 0, border: 'none', fontSize: 12 }}
              onClick={() => setViewMode(mode)}
            >
              {t('planning.' + mode)}
            </button>
          ))}
        </div>
      </div>

      {visibleTasks.length === 0 ? (
        <EmptyState message={t('planning.noTasksInRange')} />
      ) : (
        <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
          <div style={{ display: 'flex', userSelect: 'none' }}>

            {/* Left label column — fixed width, no scroll */}
            <div style={{ width: LEFT_W, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div style={{ height: MONTH_HDR_H, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', paddingLeft: 14, fontWeight: 700, fontSize: 12, color: 'var(--text-2)' }}>
                {t('planning.taskColumn')}
              </div>
              <div style={{ height: DAY_HDR_H, borderBottom: '2px solid var(--border)', background: 'var(--surface-2)' }} />
              {visibleTasks.map((task, i) => (
                <div key={task.id} style={{
                  height: ROW_H, display: 'flex', alignItems: 'center',
                  paddingLeft: 12, paddingRight: 8,
                  borderBottom: '1px solid var(--border)',
                  background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.project_color || '#4f8ef7', marginRight: 8, flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>{task.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.project_name}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Right grid — flex:1 so it always fills remaining width exactly */}
            <div ref={rightGridRef} style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
              {/* Month header row */}
              <div style={{ display: 'flex', height: MONTH_HDR_H, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                {months.map(m => (
                  <div key={m.key} style={{
                    width: m.days * dayW, flexShrink: 0,
                    borderRight: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', paddingLeft: 10,
                    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
                  }}>
                    {m.label}
                  </div>
                ))}
              </div>

              {/* Day header row — taller in week view to show day names */}
              <div style={{ display: 'flex', height: DAY_HDR_H, borderBottom: '2px solid var(--border)', background: 'var(--surface-2)' }}>
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = addDays(rangeStart, i);
                  const wknd = isWeekend(d);
                  const isToday = daysBetween(today, d) === 0;
                  return (
                    <div key={i} style={{
                      width: dayW, flexShrink: 0,
                      borderRight: '1px solid var(--border)',
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 2,
                      background: isToday
                        ? 'var(--accent-light)'
                        : wknd ? 'color-mix(in srgb, var(--border) 55%, transparent)' : 'transparent',
                    }}>
                      {viewMode === 'week' && (
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: isToday ? 'var(--accent)' : 'var(--text-3)' }}>
                          {d.toLocaleDateString('en', { weekday: 'short' })}
                        </span>
                      )}
                      <span style={{
                        fontSize: viewMode === 'week' ? 18 : 10,
                        fontWeight: isToday ? 800 : viewMode === 'week' ? 600 : 400,
                        color: isToday ? 'var(--accent)' : wknd ? 'var(--text-3)' : 'var(--text-2)',
                        lineHeight: 1,
                      }}>
                        {d.getDate()}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Task rows + bars */}
              <div style={{ position: 'relative' }}>
                {visibleTasks.map((task, i) => {
                  const rawS = toDate(task.start_date) || toDate(task.end_date);
                  const rawE = toDate(task.end_date)   || toDate(task.start_date);
                  const s = rawS < rangeStart ? rangeStart : rawS;
                  const e = rawE > rangeEnd   ? rangeEnd   : rawE;
                  const barLeft  = daysBetween(rangeStart, s) * dayW;
                  const barWidth = Math.max(dayW, (daysBetween(s, e) + 1) * dayW);
                  const color = task.project_color || '#4f8ef7';
                  const pct   = task.progress || 0;

                  return (
                    <div key={task.id} style={{
                      height: ROW_H,
                      borderBottom: '1px solid var(--border)',
                      background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                      position: 'relative',
                    }}>
                      {/* Weekend column shading */}
                      {Array.from({ length: totalDays }, (_, di) => {
                        const d = addDays(rangeStart, di);
                        if (!isWeekend(d)) return null;
                        return <div key={di} style={{ position: 'absolute', left: di * dayW, top: 0, width: dayW, height: '100%', background: 'color-mix(in srgb, var(--border) 40%, transparent)', pointerEvents: 'none' }} />;
                      })}

                      {/* Task bar */}
                      <div
                        onMouseDown={e2 => startDrag(e2, task, 'move')}
                        style={{
                          position: 'absolute', left: barLeft, top: 7,
                          width: barWidth, height: ROW_H - 14,
                          background: `linear-gradient(135deg, ${color}ee 0%, ${color}aa 100%)`,
                          border: `1px solid ${color}`,
                          borderRadius: 5, cursor: 'grab',
                          display: 'flex', alignItems: 'center',
                          overflow: 'hidden',
                          boxShadow: `0 2px 8px ${color}44, inset 0 1px 0 rgba(255,255,255,.25)`,
                        }}
                        title={`${task.name}  •  ${task.start_date} → ${task.end_date}  •  ${t('planning.pctDone', { p: pct })}`}
                      >
                        {/* Progress fill overlay */}
                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: 'rgba(255,255,255,.18)', pointerEvents: 'none', borderRadius: '5px 0 0 5px', transition: 'width .3s' }} />
                        {/* Left resize handle */}
                        <div onMouseDown={e2 => { e2.stopPropagation(); startDrag(e2, task, 'resize-left'); }}
                          style={{ width: 7, height: '100%', cursor: 'ew-resize', position: 'absolute', left: 0, top: 0, zIndex: 2, borderRadius: '5px 0 0 5px', background: 'rgba(0,0,0,.12)' }} />
                        {/* Label */}
                        <span style={{ paddingLeft: 10, paddingRight: 8, fontSize: 11, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'relative', zIndex: 1, textShadow: '0 1px 3px rgba(0,0,0,.5)', flex: 1 }}>
                          {task.name}
                          {pct > 0 && <span style={{ opacity: .7, fontWeight: 400, marginLeft: 5, fontSize: 10 }}>{pct}%</span>}
                        </span>
                        {/* Right resize handle */}
                        <div onMouseDown={e2 => { e2.stopPropagation(); startDrag(e2, task, 'resize-right'); }}
                          style={{ width: 7, height: '100%', cursor: 'ew-resize', position: 'absolute', right: 0, top: 0, zIndex: 2, borderRadius: '0 5px 5px 0', background: 'rgba(0,0,0,.12)' }} />
                      </div>
                    </div>
                  );
                })}

                {/* Today line */}
                {todayOffset >= 0 && todayOffset < totalDays && (
                  <div style={{
                    position: 'absolute',
                    left: todayOffset * dayW + Math.floor(dayW / 2) - 1,
                    top: 0, bottom: 0, width: 2,
                    background: 'var(--red)', opacity: .85,
                    pointerEvents: 'none', zIndex: 5,
                  }}>
                    <div style={{ position: 'absolute', top: -3, left: -4, width: 10, height: 10, borderRadius: '50%', background: 'var(--red)' }} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BOARD VIEW ───────────────────────────────────────────────────────────────

function BoardView({ tasks, projects, onRefresh, onEdit }) {
  const { t } = useLocale();
  const [selProject, setSelProject] = useState('');
  const [dragOver, setDragOver] = useState(null);

  const filtered = selProject ? tasks.filter(t => String(t.project_id) === selProject) : tasks;
  const cols = STATUSES.map(s => ({ status: s, tasks: filtered.filter(t => t.status === s) }));

  function handleDragStart(e, taskId) {
    e.dataTransfer.setData('taskId', String(taskId));
    e.dataTransfer.effectAllowed = 'move';
  }

  async function handleDrop(e, targetStatus) {
    e.preventDefault();
    setDragOver(null);
    const taskId = Number(e.dataTransfer.getData('taskId'));
    if (!taskId) return;
    try {
      await updateTaskStatus(taskId, { status: targetStatus });
      onRefresh();
    } catch {
      toast(t('planning.failedUpdateStatus'), 'error');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <select className="form-control" style={{ width: 200 }}
          value={selProject} onChange={e => setSelProject(e.target.value)}>
          <option value="">{t('planning.allProjects')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>{t('planning.dragColumnsHint')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STATUSES.length}, 1fr)`, gap: 12, alignItems: 'start' }}>
        {cols.map(col => (
          <div key={col.status}
            onDragOver={e => { e.preventDefault(); setDragOver(col.status); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => handleDrop(e, col.status)}
            style={{
              background: dragOver === col.status ? 'color-mix(in srgb, var(--accent) 8%, var(--card))' : 'var(--bg)',
              border: `1.5px solid ${dragOver === col.status ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8, padding: 10, minHeight: 300, transition: 'all .15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              <Badge color={STATUS_BADGE[col.status]}>{tEnum(t, STATUS_KEY, col.status)}</Badge>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>{col.tasks.length}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {col.tasks.map(task => (
                <div key={task.id}
                  draggable
                  onDragStart={e => handleDragStart(e, task.id)}
                  onClick={() => onEdit(task)}
                  className="card"
                  style={{ padding: 10, cursor: 'grab', transition: 'box-shadow .15s', border: '1px solid var(--border)' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 4, lineHeight: 1.3 }}>{task.name}</div>
                  {task.project_name && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: task.project_color || '#4f8ef7', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{task.project_name}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: task.progress > 0 ? 6 : 0 }}>
                    <Badge color={PRIORITY_BADGE[task.priority] || 'blue'} style={{ fontSize: 9 }}>{tEnum(t, PRIORITY_KEY, task.priority)}</Badge>
                    {task.assignee_name && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>· {task.assignee_name}</span>}
                    {task.end_date && (
                      <span style={{ fontSize: 10, color: new Date(task.end_date) < new Date() && task.status !== 'Done' ? 'var(--red)' : 'var(--text-3)', marginLeft: 'auto' }}>
                        {task.end_date}
                      </span>
                    )}
                  </div>
                  {task.progress > 0 && <ProgressBar value={task.progress} color={task.project_color || '#4f8ef7'} />}
                </div>
              ))}

              {col.tasks.length === 0 && (
                <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
                  {t('planning.dropTasksHere')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LIST VIEW ────────────────────────────────────────────────────────────────

function ListView({ tasks, projects, onEdit, onArchive, onRestore, onRefresh }) {
  const { t } = useLocale();
  const [selProject, setSelProject] = useState('');
  const [selStatus,  setSelStatus]  = useState('');
  const [selPriority, setSelPriority] = useState('');
  const [search, setSearch] = useState('');
  const [editingProgress, setEditingProgress] = useState(null);

  const filtered = tasks.filter(task => {
    if (selProject && String(task.project_id) !== selProject) return false;
    if (selStatus  && task.status !== selStatus)   return false;
    if (selPriority && task.priority !== selPriority) return false;
    if (search && !task.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  async function saveProgress(taskId, value) {
    setEditingProgress(null);
    try {
      await updateTaskProgress(taskId, { progress: value });
      onRefresh();
    } catch {
      toast(t('planning.failedUpdateProgress'), 'error');
    }
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      {/* Filter toolbar — matches card-header pattern used across all modules */}
      <div className="card-header">
        <div className="search-bar" style={{ margin: 0, flex: 1, flexWrap: 'wrap', gap: 8 }}>
          <div className="search-input-wrap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input className="form-control search-input" placeholder={t('common.search')} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="form-control" style={{ width: 180 }} value={selProject} onChange={e => setSelProject(e.target.value)}>
            <option value="">{t('planning.allProjects')}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="form-control" style={{ width: 140 }} value={selStatus} onChange={e => setSelStatus(e.target.value)}>
            <option value="">{t('common.allStatuses')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
          </select>
          <select className="form-control" style={{ width: 130 }} value={selPriority} onChange={e => setSelPriority(e.target.value)}>
            <option value="">{t('planning.allPriorities')}</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{t(PRIORITY_KEY[p])}</option>)}
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('planning.taskName')}</th>
              <th>{t('planning.project')}</th>
              <th>{t('planning.assignedTo')}</th>
              <th>{t('common.status')}</th>
              <th>{t('planning.priority')}</th>
              <th>{t('planning.startDate')}</th>
              <th>{t('planning.endDate')}</th>
              <th style={{ minWidth: 120 }}>{t('planning.progress')}</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{t('planning.noTasksYet')}</td></tr>
            ) : filtered.map(task => (
              <tr key={task.id} className={task.archived_at ? 'row-archived' : ''}>
                <td className="td-primary" style={{ maxWidth: 220 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.project_color || '#4f8ef7', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.name}</span>
                    {task.archived_at && <Badge color="gray" style={{ flexShrink: 0 }}>{t('common.archivedBadge')}</Badge>}
                  </div>
                </td>
                <td>
                  {task.project_name
                    ? <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: task.project_color || '#4f8ef7', flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{task.project_name}</span>
                      </span>
                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: task.assignee_name ? 'var(--text-2)' : 'var(--text-3)' }}>
                  {task.assignee_name || '—'}
                </td>
                <td><Badge color={STATUS_BADGE[task.status] || 'blue'}>{tEnum(t, STATUS_KEY, task.status)}</Badge></td>
                <td><Badge color={PRIORITY_BADGE[task.priority] || 'blue'}>{tEnum(t, PRIORITY_KEY, task.priority)}</Badge></td>
                <td style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{task.start_date || '—'}</td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: task.end_date && new Date(task.end_date) < new Date() && task.status !== 'Done' ? 'var(--red)' : 'var(--text-2)' }}>
                  {task.end_date || '—'}
                </td>
                <td style={{ minWidth: 120 }}>
                  {editingProgress === task.id ? (
                    <input type="range" min="0" max="100" step="5" defaultValue={task.progress}
                      style={{ width: '100%' }}
                      onMouseUp={e => saveProgress(task.id, Number(e.target.value))}
                      autoFocus
                      onBlur={e => saveProgress(task.id, Number(e.target.value))}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                      onClick={() => setEditingProgress(task.id)}
                      title={t('planning.clickEditProgress')}>
                      <ProgressBar value={task.progress} color={task.project_color || '#4f8ef7'} style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 30, textAlign: 'right', fontWeight: 600 }}>{task.progress || 0}%</span>
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    {task.archived_at ? (
                      <button className="btn btn-outline btn-sm" onClick={() => onRestore(task)} title={t('common.restore')}>
                        ↩️ {t('common.restore')}
                      </button>
                    ) : (
                      <>
                        <button className="btn btn-outline btn-sm" onClick={() => onEdit(task)} title={t('planning.editTaskTitle')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button className="btn btn-outline btn-sm" onClick={() => onArchive(task)} title={t('planning.archiveTaskTitle')}
                          style={{ color: 'var(--text-3)' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── EVENT FORM ───────────────────────────────────────────────────────────────
// Used inside the calendar modal to create or edit a standalone event.
// `initial` is either `null` (create, pre-filled with the date the user clicked)
// or an existing event row (edit). Submits via the parent's onSave callback so
// the calendar can refetch and close the modal in one place.

const EVENT_COLORS = [
  '#4f8ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];

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
                background: 'var(--accent)', color: '#fff',
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

function CalendarView() {
  const { t, lang } = useLocale();
  const { user: currentUser } = usePermissions();
  const currentUserId = currentUser?.id ?? null;
  const dateLocale = lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en';
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  // Modal state — null = closed; { date } = create; { event } = edit
  const [modal, setModal] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  // Events fetched for the visible window — refetched when month changes
  // or after any create/update/delete.
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const firstDay   = new Date(year, month, 1);
  const lastDay    = new Date(year, month + 1, 0);
  const startPad   = firstDay.getDay();                                  // 0=Sun
  const totalCells = Math.ceil((startPad + lastDay.getDate()) / 7) * 7;
  // Pull a slightly wider window so events that overlap into the visible
  // padding rows still render (e.g. a multi-day event that starts in the
  // previous month and ends in this one).
  const winStart   = toIso(addDays(firstDay, -startPad));
  const winEnd     = toIso(addDays(lastDay,  totalCells - startPad - lastDay.getDate()));

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getPlanningEvents({ start: winStart, end: winEnd });
      setEvents(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast(e.message || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [winStart, winEnd, t]);

  useEffect(() => { reload(); }, [reload]);

  function prevMonth() { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); }
  function nextMonth() { if (month === 11) { setYear(y => y + 1); setMonth(0); }  else setMonth(m => m + 1); }
  function goToday()   { setYear(today.getFullYear()); setMonth(today.getMonth()); }

  // Events whose date range includes `d` (inclusive on both ends).
  function eventsForDay(d) {
    const iso = toIso(d);
    return events.filter(ev => {
      const s = ev.start_date;
      const e = ev.end_date || ev.start_date;
      return iso >= s && iso <= e;
    });
  }

  async function handleDelete(ev) {
    setConfirmDel(null);
    try {
      await deletePlanningEvent(ev.id);
      toast(t('planning.eventDeleted'));
      setModal(null);
      reload();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  const monthLabel = firstDay.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });
  const dayNames   = Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + i).toLocaleDateString(dateLocale, { weekday: 'short' }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('planning.calendarHint')}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={prevMonth} aria-label={t('common.previous')}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', minWidth: 160, textAlign: 'center' }}>
            {monthLabel}
          </span>
          <button className="btn btn-outline btn-sm" onClick={nextMonth} aria-label={t('common.next')}>›</button>
          <button className="btn btn-outline btn-sm" onClick={goToday}>{t('planning.today')}</button>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ date: toIso(today) })}>
            + {t('planning.newEvent')}
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="card" style={{
        padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        height: 'calc(100vh - 300px)', minHeight: 420, opacity: loading ? 0.65 : 1,
        transition: 'opacity .15s',
      }}>
        {/* Day-name header */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0,
        }}>
          {dayNames.map((d, i) => (
            <div key={i} style={{
              padding: '8px 0', textAlign: 'center',
              fontSize: 11, fontWeight: 700, letterSpacing: '.5px',
              color: 'var(--text-3)', textTransform: 'uppercase',
            }}>{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
          gridTemplateRows: `repeat(${Math.ceil(totalCells / 7)}, 1fr)`,
          flex: 1, overflow: 'hidden',
        }}>
          {Array.from({ length: totalCells }, (_, i) => {
            const dayNum  = i - startPad + 1;
            const valid   = dayNum >= 1 && dayNum <= lastDay.getDate();
            const d       = valid ? new Date(year, month, dayNum) : null;
            const isToday = d && d.toDateString() === today.toDateString();
            const isWknd  = d && isWeekend(d);
            const dayEvts = d ? eventsForDay(d) : [];

            return (
              <div
                key={i}
                onClick={valid ? () => setModal({ date: toIso(d) }) : undefined}
                style={{
                  padding: '6px 6px 4px', overflow: 'hidden', position: 'relative',
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  background: !valid
                    ? 'var(--bg)'
                    : isWknd
                      ? 'color-mix(in srgb, var(--border) 18%, var(--card))'
                      : 'var(--card)',
                  cursor: valid ? 'pointer' : 'default',
                  transition: 'background .15s',
                }}
                onMouseEnter={e => { if (valid) e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 6%, var(--card))'; }}
                onMouseLeave={e => {
                  if (!valid) return;
                  e.currentTarget.style.background = isWknd
                    ? 'color-mix(in srgb, var(--border) 18%, var(--card))'
                    : 'var(--card)';
                }}
              >
                {valid && (
                  <>
                    {/* Date number */}
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 4,
                    }}>
                      <div style={{
                        fontWeight: isToday ? 800 : 600, fontSize: 12,
                        color: isToday ? '#fff' : 'var(--text-2)',
                        background: isToday ? 'var(--accent)' : 'transparent',
                        borderRadius: isToday ? '50%' : 0,
                        width: isToday ? 22 : 'auto', height: isToday ? 22 : 'auto',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {dayNum}
                      </div>
                      {/* Quick-add button — only visible when there's space */}
                      {dayEvts.length === 0 && (
                        <span style={{
                          fontSize: 11, color: 'var(--text-3)', opacity: 0.6,
                          fontWeight: 600, transition: 'opacity .15s',
                        }}>+</span>
                      )}
                    </div>

                    {/* Event chips */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {dayEvts.slice(0, 3).map(ev => {
                        const color = ev.color || '#4f8ef7';
                        const tm = !ev.all_day && ev.start_time ? ev.start_time + ' ' : '';
                        const attCount = Array.isArray(ev.attendees) ? ev.attendees.length : 0;
                        return (
                          <button key={ev.id}
                            type="button"
                            onClick={e2 => { e2.stopPropagation(); setModal({ event: ev }); }}
                            title={`${ev.title}${tm ? '  •  ' + tm : ''}${attCount ? '  •  ' + attCount + ' attendees' : ''}`}
                            style={{
                              all: 'unset',
                              fontSize: 10, fontWeight: 600, cursor: 'pointer',
                              background: color + '26',
                              color, borderLeft: `3px solid ${color}`,
                              borderRadius: '0 4px 4px 0',
                              padding: '2px 6px', whiteSpace: 'nowrap',
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              display: 'flex', alignItems: 'center', gap: 4,
                              maxWidth: '100%',
                            }}
                          >
                            {tm && <span style={{ opacity: 0.7, fontWeight: 500 }}>{tm}</span>}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                              {ev.title}
                            </span>
                            {attCount > 0 && (
                              <span style={{
                                fontSize: 9, fontWeight: 700, opacity: 0.85,
                                background: color + '55', padding: '0 5px',
                                borderRadius: 999, color,
                              }}>
                                👥{attCount}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {dayEvts.length > 3 && (
                        <div style={{ fontSize: 9, color: 'var(--text-3)', paddingLeft: 4, fontWeight: 600 }}>
                          {t('planning.moreCount', { n: dayEvts.length - 3 })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Event modal — create or edit */}
      {modal && (
        <Modal
          title={modal.event ? t('planning.editEvent') : t('planning.newEvent')}
          onClose={() => setModal(null)}
          size="md"
        >
          <EventForm
            initial={modal.event || null}
            defaultDate={modal.date}
            currentUserId={currentUserId}
            onSave={() => { setModal(null); reload(); }}
            onClose={() => setModal(null)}
            onDelete={ev => setConfirmDel(ev)}
          />
        </Modal>
      )}

      {/* Delete confirmation */}
      {confirmDel && (
        <ConfirmModal
          title={t('planning.deleteEvent')}
          message={`${t('planning.deleteEventConfirm')} "${confirmDel.title}"?`}
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={() => handleDelete(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// ─── PROJECTS PANEL ───────────────────────────────────────────────────────────

function ProjectsPanel({ projects, tasks, onNew, onEdit, onArchive, onRestore }) {
  const { t } = useLocale();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
      {projects.map(proj => {
        const projTasks = tasks.filter(t => t.project_id === proj.id);
        const done = projTasks.filter(t => t.status === 'Done').length;
        const pct  = projTasks.length ? Math.round((done / projTasks.length) * 100) : 0;
        const isArchived = !!proj.archived_at;

        return (
          <div key={proj.id} className="card" style={{ padding: 0, overflow: 'hidden', border: `1px solid var(--border)`, opacity: isArchived ? 0.62 : 1 }}>
            <div style={{ height: 5, background: proj.color || '#4f8ef7' }} />
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', lineHeight: 1.3, textDecoration: isArchived ? 'line-through' : 'none' }}>{proj.name}</div>
                  {proj.client_name && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{proj.client_name}</div>}
                </div>
                {isArchived ? (
                  <Badge color="gray">{t('common.archivedBadge')}</Badge>
                ) : (
                  <Badge color={proj.status === 'Active' ? 'green' : proj.status === 'On Hold' ? 'yellow' : proj.status === 'Completed' ? 'blue' : 'red'}>
                    {tEnum(t, PROJ_STATUS_KEY, proj.status)}
                  </Badge>
                )}
              </div>
              {proj.description && <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.4 }}>{proj.description}</div>}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{done} / {projTasks.length} {t('planning.tasksDone')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>{pct}%</span>
              </div>
              <ProgressBar value={pct} color={proj.color || '#4f8ef7'} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                {proj.start_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.start_date}</span>}
                {proj.start_date && proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>→</span>}
                {proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.end_date}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {isArchived ? (
                    <button className="btn btn-outline btn-sm" onClick={() => onRestore(proj)}>↩️ {t('common.restore')}</button>
                  ) : (
                    <>
                      <button className="btn btn-outline btn-sm" onClick={() => onEdit(proj)}>{t('common.edit')}</button>
                      <button className="btn btn-outline btn-sm" style={{ color: 'var(--text-3)' }} onClick={() => onArchive(proj)}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Add project card */}
      <div onClick={onNew} className="card" style={{
        padding: 0, overflow: 'hidden', border: '2px dashed var(--border)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 140,
        transition: 'border-color .15s, background .15s',
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
      >
        <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{t('planning.newProject')}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Planning() {
  const { t } = useLocale();

  const [view, setView] = useState('board');  // 'projects' | 'gantt' | 'board' | 'list' | 'calendar'

  // Modals
  const [projModal,   setProjModal]   = useState(false);
  const [editProj,    setEditProj]    = useState(null);
  const [taskModal,   setTaskModal]   = useState(false);
  const [editTask,    setEditTask]    = useState(null);
  const [archProj,    setArchProj]    = useState(null);
  const [archTask,    setArchTask]    = useState(null);
  const [restoreProj, setRestoreProj] = useState(null);
  const [restoreTask, setRestoreTask] = useState(null);

  // Show archived — only the Projects and List views surface archived records
  // (with a Restore action). Board, Gantt and Calendar always work off the
  // active set, so inert records never clutter the live planning surfaces.
  const [showArchived, setShowArchived] = useState(false);

  // Data
  const fetchSummary  = useCallback(s => getPlanningSummary(s), []);
  const fetchProjects = useCallback(s => getPlanningProjects({ include_archived: showArchived }, s), [showArchived]);
  const fetchTasks    = useCallback(s => getPlanningTasks({ include_archived: showArchived }, s), [showArchived]);
  const fetchMilestones = useCallback(s => getPlanningMilestones({}, s), []);

  const { data: summary,    reload: reloadSummary }    = useData(fetchSummary);
  const { data: projects,   reload: reloadProjects,   loading: projLoading, error: projError } = useData(fetchProjects, [showArchived]);
  const { data: tasks,      reload: reloadTasks,      loading: taskLoading }  = useData(fetchTasks, [showArchived]);
  const { data: milestones, reload: reloadMilestones } = useData(fetchMilestones);

  const [clients, setClients] = useState([]);
  const [users,   setUsers]   = useState([]);

  useEffect(() => {
    getPlanningDropdownClients().then(setClients).catch(() => {});
    getPlanningDropdownUsers().then(setUsers).catch(() => {});
  }, []);

  function reloadAll() {
    reloadSummary(); reloadProjects(); reloadTasks(); reloadMilestones();
  }

  const safeProjects   = projects   || [];
  const safeTasks      = tasks      || [];
  const safeMilestones = milestones || [];

  // Active-only slices for the live planning surfaces. When "Show archived" is
  // off the fetch already excludes archived rows, so these equal the full set;
  // when it's on, board/gantt still ignore the archived records.
  const activeProjects = safeProjects.filter(p => !p.archived_at);
  const activeTasks    = safeTasks.filter(tk => !tk.archived_at);

  // Archive project
  async function handleArchiveProject(proj) {
    setArchProj(null);
    try {
      await archivePlanningProject(proj.id);
      toast(t('planning.projectArchived'));
      reloadAll();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  // Archive task
  async function handleArchiveTask(task) {
    setArchTask(null);
    try {
      await archivePlanningTask(task.id);
      toast(t('planning.taskArchived'));
      reloadAll();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  // Restore project
  async function handleRestoreProject(proj) {
    setRestoreProj(null);
    try {
      await unarchivePlanningProject(proj.id);
      toast(t('common.restore'));
      reloadAll();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  // Restore task
  async function handleRestoreTask(task) {
    setRestoreTask(null);
    try {
      await unarchivePlanningTask(task.id);
      toast(t('common.restore'));
      reloadAll();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  const VIEWS = [
    { key: 'projects', label: t('planning.viewProjects') },
    { key: 'gantt',    label: t('planning.viewGantt') },
    { key: 'board',    label: t('planning.viewBoard') },
    { key: 'list',     label: t('planning.viewList') },
    { key: 'calendar', label: t('planning.viewCalendar') },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('planning.title')}</h1>
          <p className="page-subtitle">{t('planning.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline btn-sm" onClick={() => { setEditProj(null); setProjModal(true); }}>
            + {t('planning.newProject')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => { setEditTask(null); setTaskModal(true); }}>
            + {t('planning.newTask')}
          </button>
        </div>
      </div>

      {/* KPI Summary */}
      <SummaryCards summary={summary} />

      {/* View tabs */}
      <div className="tabs" style={{ marginBottom: 16, display: 'flex', alignItems: 'center' }}>
        {VIEWS.map(v => (
          <button key={v.key} className={`tab-btn${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
        {/* Show-archived toggle — only meaningful on the views that render
            archived records (Projects cards + List table). */}
        {(view === 'projects' || view === 'list') && (
          <label className="archived-toggle" style={{ marginLeft: 'auto' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
        )}
      </div>

      {/* Loading / Error */}
      {(projLoading || taskLoading) && <LoadingSpinner />}
      {projError && <ErrorAlert message={projError} />}

      {!projLoading && !taskLoading && !projError && (
        <>
          {view === 'projects' && (
            <ProjectsPanel
              projects={safeProjects}
              tasks={activeTasks}
              onNew={() => { setEditProj(null); setProjModal(true); }}
              onEdit={p => { setEditProj(p); setProjModal(true); }}
              onArchive={p => setArchProj(p)}
              onRestore={p => setRestoreProj(p)}
            />
          )}
          {view === 'gantt' && (
            <GanttView tasks={activeTasks} projects={activeProjects} milestones={safeMilestones} onRefresh={reloadTasks} />
          )}
          {view === 'board' && (
            <BoardView tasks={activeTasks} projects={activeProjects} onRefresh={reloadAll} onEdit={t => { setEditTask(t); setTaskModal(true); }} />
          )}
          {view === 'list' && (
            <ListView
              tasks={safeTasks} projects={safeProjects}
              onEdit={t => { setEditTask(t); setTaskModal(true); }}
              onArchive={t => setArchTask(t)}
              onRestore={t => setRestoreTask(t)}
              onRefresh={reloadAll}
            />
          )}
          {view === 'calendar' && <CalendarView />}
        </>
      )}

      {/* Project Modal */}
      {projModal && (
        <Modal
          title={editProj ? t('planning.editProject') : t('planning.newProject')}
          onClose={() => setProjModal(false)}
          size="md"
        >
          <ProjectForm
            initial={editProj}
            clients={clients}
            onSave={() => { setProjModal(false); reloadAll(); }}
            onClose={() => setProjModal(false)}
          />
        </Modal>
      )}

      {/* Task Modal */}
      {taskModal && (
        <Modal
          title={editTask ? t('planning.editTask') : t('planning.newTask')}
          onClose={() => setTaskModal(false)}
          size="md"
        >
          <TaskForm
            initial={editTask}
            projects={safeProjects}
            users={users}
            milestones={safeMilestones}
            tasks={safeTasks}
            onSave={() => { setTaskModal(false); reloadAll(); }}
            onClose={() => setTaskModal(false)}
          />
        </Modal>
      )}

      {/* Archive project confirm */}
      {archProj && (
        <ConfirmModal
          title={t('planning.archiveProject')}
          message={`${t('planning.archiveProjectConfirm')} "${archProj.name}"?`}
          onConfirm={() => handleArchiveProject(archProj)}
          onCancel={() => setArchProj(null)}
        />
      )}

      {/* Archive task confirm */}
      {archTask && (
        <ConfirmModal
          title={t('planning.archiveTask')}
          message={`${t('planning.archiveTaskConfirm')} "${archTask.name}"?`}
          onConfirm={() => handleArchiveTask(archTask)}
          onCancel={() => setArchTask(null)}
        />
      )}

      {/* Restore project confirm */}
      {restoreProj && (
        <ConfirmModal
          title={t('common.restore')}
          message={`${t('common.restoreConfirm')} "${restoreProj.name}"`}
          confirmLabel={t('common.restore')}
          confirmClass="btn-primary"
          onConfirm={() => handleRestoreProject(restoreProj)}
          onCancel={() => setRestoreProj(null)}
        />
      )}

      {/* Restore task confirm */}
      {restoreTask && (
        <ConfirmModal
          title={t('common.restore')}
          message={`${t('common.restoreConfirm')} "${restoreTask.name}"`}
          confirmLabel={t('common.restore')}
          confirmClass="btn-primary"
          onConfirm={() => handleRestoreTask(restoreTask)}
          onCancel={() => setRestoreTask(null)}
        />
      )}
    </div>
  );
}
