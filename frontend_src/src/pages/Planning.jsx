import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, EmptyState, toast } from '../components/shared';
import {
  getPlanningProjects, createPlanningProject, updatePlanningProject, archivePlanningProject,
  getPlanningTasks, createPlanningTask, updatePlanningTask, archivePlanningTask,
  updateTaskDates, updateTaskStatus, updateTaskProgress,
  getPlanningMilestones, createPlanningMilestone, deletePlanningMilestone,
  getPlanningSummary, getPlanningDropdownClients, getPlanningDropdownUsers,
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
    if (!form.name.trim()) { toast('Project name is required', 'error'); return; }
    setSaving(true);
    try {
      const payload = { ...form, client_id: form.client_id || null };
      if (initial?.id) {
        await updatePlanningProject(initial.id, payload);
        toast('Project updated');
      } else {
        await createPlanningProject(payload);
        toast('Project created');
      }
      onSave();
    } catch (err) {
      toast(err.message || 'Error', 'error');
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
              <option value="">— None —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.projectStatus')}</label>
            <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
              {PROJ_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
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
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast('Task name is required', 'error'); return; }
    if (!form.project_id)  { toast('Project is required', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        project_id:   Number(form.project_id),
        assigned_to:  form.assigned_to  ? Number(form.assigned_to)  : null,
        milestone_id: form.milestone_id ? Number(form.milestone_id) : null,
        depends_on:   form.depends_on   ? Number(form.depends_on)   : null,
        progress:     Number(form.progress) || 0,
      };
      if (initial?.id) {
        await updatePlanningTask(initial.id, payload);
        toast('Task updated');
      } else {
        await createPlanningTask(payload);
        toast('Task created');
      }
      onSave();
    } catch (err) {
      toast(err.message || 'Error', 'error');
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
            <label className="form-label">Project *</label>
            <select className="form-control" value={form.project_id} onChange={e => set('project_id', e.target.value)} required>
              <option value="">— Select project —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.assignedTo')}</label>
            <select className="form-control" value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)}>
              <option value="">— Unassigned —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.status')}</label>
            <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.priority')}</label>
            <select className="form-control" value={form.priority} onChange={e => set('priority', e.target.value)}>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
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
                <option value="">— None —</option>
                {projMilestones.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          {projTasks.length > 0 && (
            <div className="form-group">
              <label className="form-label">{t('planning.dependsOn')}</label>
              <select className="form-control" value={form.depends_on} onChange={e => set('depends_on', e.target.value)}>
                <option value="">— None —</option>
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
  const { t } = useLocale();
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
    ? `${rangeStart.toLocaleDateString('en', { month: 'short', day: 'numeric' })} – ${rangeEnd.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : rangeStart.toLocaleDateString('en', { month: 'long', year: 'numeric' });

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
    else { months.push({ key, label: cursor.toLocaleDateString('en', { month: 'short', year: 'numeric' }), days: 1 }); }
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
        toast('Failed to save dates', 'error');
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
              style={{ borderRadius: 0, border: 'none', textTransform: 'capitalize', fontSize: 12 }}
              onClick={() => setViewMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {visibleTasks.length === 0 ? (
        <EmptyState message="No tasks in this date range. Use navigation to find tasks or add dates to tasks." />
      ) : (
        <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
          <div style={{ display: 'flex', userSelect: 'none' }}>

            {/* Left label column — fixed width, no scroll */}
            <div style={{ width: LEFT_W, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div style={{ height: MONTH_HDR_H, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', paddingLeft: 14, fontWeight: 700, fontSize: 12, color: 'var(--text-2)' }}>
                Task
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
                        title={`${task.name}  •  ${task.start_date} → ${task.end_date}  •  ${pct}% done`}
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
      toast('Failed to update status', 'error');
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
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>Drag cards between columns to update status</span>
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
              <Badge color={STATUS_BADGE[col.status]}>{col.status}</Badge>
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
                    <Badge color={PRIORITY_BADGE[task.priority] || 'blue'} style={{ fontSize: 9 }}>{task.priority}</Badge>
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
                  Drop tasks here
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

function ListView({ tasks, projects, onEdit, onArchive, onRefresh }) {
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
      toast('Failed to update progress', 'error');
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
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="form-control" style={{ width: 130 }} value={selPriority} onChange={e => setSelPriority(e.target.value)}>
            <option value="">All Priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('planning.taskName')}</th>
              <th>Project</th>
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
              <tr key={task.id}>
                <td className="td-primary" style={{ maxWidth: 220 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.project_color || '#4f8ef7', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.name}</span>
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
                <td><Badge color={STATUS_BADGE[task.status] || 'blue'}>{task.status}</Badge></td>
                <td><Badge color={PRIORITY_BADGE[task.priority] || 'blue'}>{task.priority}</Badge></td>
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
                      title="Click to edit progress">
                      <ProgressBar value={task.progress} color={task.project_color || '#4f8ef7'} style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 30, textAlign: 'right', fontWeight: 600 }}>{task.progress || 0}%</span>
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn btn-outline btn-sm" onClick={() => onEdit(task)} title="Edit task">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => onArchive(task)} title="Archive task"
                      style={{ color: 'var(--text-3)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                    </button>
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

// ─── CALENDAR VIEW ────────────────────────────────────────────────────────────

function CalendarView({ tasks, projects }) {
  const { t } = useLocale();
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selProject, setSelProject] = useState('');

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
  }

  const firstDay  = new Date(year, month, 1);
  const lastDay   = new Date(year, month + 1, 0);
  const startPad  = firstDay.getDay(); // 0=Sun
  const totalCells = Math.ceil((startPad + lastDay.getDate()) / 7) * 7;

  const filtered = selProject ? tasks.filter(t => String(t.project_id) === selProject) : tasks;

  function tasksForDay(d) {
    const iso = toIso(d);
    return filtered.filter(task => {
      if (!task.start_date || !task.end_date) return task.start_date === iso || task.end_date === iso;
      return iso >= task.start_date && iso <= task.end_date;
    });
  }

  const monthLabel = firstDay.toLocaleDateString('en', { month: 'long', year: 'numeric' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <select className="form-control" style={{ width: 200 }} value={selProject} onChange={e => setSelProject(e.target.value)}>
          <option value="">{t('planning.allProjects')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={prevMonth}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', minWidth: 160, textAlign: 'center' }}>{monthLabel}</span>
          <button className="btn btn-outline btn-sm" onClick={nextMonth}>›</button>
          <button className="btn btn-outline btn-sm" onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); }}>
            {t('planning.today')}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 300px)', minHeight: 380 }}>
        {/* Day name header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
          {dayNames.map(d => (
            <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-3)' }}>{d}</div>
          ))}
        </div>

        {/* Calendar grid — fills remaining card height */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: `repeat(${Math.ceil(totalCells / 7)}, 1fr)`, flex: 1, overflow: 'hidden' }}>
          {Array.from({ length: totalCells }, (_, i) => {
            const dayNum = i - startPad + 1;
            const valid  = dayNum >= 1 && dayNum <= lastDay.getDate();
            const d      = valid ? new Date(year, month, dayNum) : null;
            const isToday = d && d.toDateString() === today.toDateString();
            const dayTasks = d ? tasksForDay(d) : [];
            const isWknd  = d && isWeekend(d);

            return (
              <div key={i} style={{
                padding: '4px 6px', overflow: 'hidden',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                background: !valid ? 'var(--bg)' : isWknd ? 'color-mix(in srgb, var(--border) 20%, var(--card))' : 'var(--card)',
              }}>
                {valid && (
                  <>
                    <div style={{
                      fontWeight: isToday ? 800 : 500, fontSize: 12,
                      color: isToday ? '#fff' : 'var(--text-2)',
                      background: isToday ? 'var(--accent)' : 'transparent',
                      borderRadius: isToday ? '50%' : 0,
                      width: isToday ? 22 : 'auto', height: isToday ? 22 : 'auto',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      marginBottom: 4,
                    }}>
                      {dayNum}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {dayTasks.slice(0, 3).map(task => (
                        <div key={task.id} title={task.name} style={{
                          fontSize: 9, fontWeight: 600,
                          background: (task.project_color || '#4f8ef7') + '33',
                          color: task.project_color || '#4f8ef7',
                          borderLeft: `2px solid ${task.project_color || '#4f8ef7'}`,
                          borderRadius: '0 3px 3px 0', padding: '1px 4px',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {task.name}
                        </div>
                      ))}
                      {dayTasks.length > 3 && (
                        <div style={{ fontSize: 9, color: 'var(--text-3)', paddingLeft: 4 }}>+{dayTasks.length - 3} more</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── PROJECTS PANEL ───────────────────────────────────────────────────────────

function ProjectsPanel({ projects, tasks, onNew, onEdit, onArchive }) {
  const { t } = useLocale();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
      {projects.map(proj => {
        const projTasks = tasks.filter(t => t.project_id === proj.id);
        const done = projTasks.filter(t => t.status === 'Done').length;
        const pct  = projTasks.length ? Math.round((done / projTasks.length) * 100) : 0;

        return (
          <div key={proj.id} className="card" style={{ padding: 0, overflow: 'hidden', border: `1px solid var(--border)` }}>
            <div style={{ height: 5, background: proj.color || '#4f8ef7' }} />
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', lineHeight: 1.3 }}>{proj.name}</div>
                  {proj.client_name && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{proj.client_name}</div>}
                </div>
                <Badge color={proj.status === 'Active' ? 'green' : proj.status === 'On Hold' ? 'yellow' : proj.status === 'Completed' ? 'blue' : 'red'}>
                  {proj.status}
                </Badge>
              </div>
              {proj.description && <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.4 }}>{proj.description}</div>}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{done} / {projTasks.length} tasks done</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>{pct}%</span>
              </div>
              <ProgressBar value={pct} color={proj.color || '#4f8ef7'} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                {proj.start_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.start_date}</span>}
                {proj.start_date && proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>→</span>}
                {proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.end_date}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button className="btn btn-outline btn-sm" onClick={() => onEdit(proj)}>Edit</button>
                  <button className="btn btn-outline btn-sm" style={{ color: 'var(--text-3)' }} onClick={() => onArchive(proj)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg>
                  </button>
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

  // Data
  const fetchSummary  = useCallback(s => getPlanningSummary(s), []);
  const fetchProjects = useCallback(s => getPlanningProjects({}, s), []);
  const fetchTasks    = useCallback(s => getPlanningTasks({}, s), []);
  const fetchMilestones = useCallback(s => getPlanningMilestones({}, s), []);

  const { data: summary,    reload: reloadSummary }    = useData(fetchSummary);
  const { data: projects,   reload: reloadProjects,   loading: projLoading, error: projError } = useData(fetchProjects);
  const { data: tasks,      reload: reloadTasks,      loading: taskLoading }  = useData(fetchTasks);
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

  // Archive project
  async function handleArchiveProject(proj) {
    setArchProj(null);
    try {
      await archivePlanningProject(proj.id);
      toast('Project archived');
      reloadAll();
    } catch (e) { toast(e.message || 'Error', 'error'); }
  }

  // Archive task
  async function handleArchiveTask(task) {
    setArchTask(null);
    try {
      await archivePlanningTask(task.id);
      toast('Task archived');
      reloadAll();
    } catch (e) { toast(e.message || 'Error', 'error'); }
  }

  const VIEWS = [
    { key: 'projects', label: 'Projects' },
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
      <div className="tabs" style={{ marginBottom: 16 }}>
        {VIEWS.map(v => (
          <button key={v.key} className={`tab-btn${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {/* Loading / Error */}
      {(projLoading || taskLoading) && <LoadingSpinner />}
      {projError && <ErrorAlert message={projError} />}

      {!projLoading && !taskLoading && !projError && (
        <>
          {view === 'projects' && (
            <ProjectsPanel
              projects={safeProjects}
              tasks={safeTasks}
              onNew={() => { setEditProj(null); setProjModal(true); }}
              onEdit={p => { setEditProj(p); setProjModal(true); }}
              onArchive={p => setArchProj(p)}
            />
          )}
          {view === 'gantt' && (
            <GanttView tasks={safeTasks} projects={safeProjects} milestones={safeMilestones} onRefresh={reloadTasks} />
          )}
          {view === 'board' && (
            <BoardView tasks={safeTasks} projects={safeProjects} onRefresh={reloadAll} onEdit={t => { setEditTask(t); setTaskModal(true); }} />
          )}
          {view === 'list' && (
            <ListView
              tasks={safeTasks} projects={safeProjects}
              onEdit={t => { setEditTask(t); setTaskModal(true); }}
              onArchive={t => setArchTask(t)}
              onRefresh={reloadAll}
            />
          )}
          {view === 'calendar' && (
            <CalendarView tasks={safeTasks} projects={safeProjects} />
          )}
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
    </div>
  );
}
