import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import { createPlanningProject, createPlanningTask, updatePlanningTask } from '../../api/client';
import { PRIORITIES, STATUS_KEY, PRIORITY_KEY, STATUSES } from './constants';

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


export { TaskForm };
