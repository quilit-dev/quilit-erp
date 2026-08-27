import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import { updateTaskProgress } from '../../api/client';
import { Badge, ProgressBar } from './ui';
import { PRIORITIES, STATUS_BADGE, PRIORITY_BADGE, STATUS_KEY, PRIORITY_KEY, tEnum, STATUSES } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

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
          <SearchSelect
            className="form-control"
            style={{ width: 180 }}
            value={selProject}
            onChange={v => setSelProject(v)}
            placeholder={t('planning.allProjects')}
            options={(projects || []).map(p => ({ value: p.id, label: p.name }))} />
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}
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

export { ListView };
