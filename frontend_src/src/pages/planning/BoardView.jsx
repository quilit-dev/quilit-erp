import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import { updateTaskStatus } from '../../api/client';
import { Badge, ProgressBar } from './ui';
import { STATUS_BADGE, PRIORITY_BADGE, STATUS_KEY, PRIORITY_KEY, tEnum, STATUSES } from './constants';

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

      <div className="kanban-board" style={{ display: 'grid', gridTemplateColumns: `repeat(${STATUSES.length}, 1fr)`, gap: 12, alignItems: 'start' }}>
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


export { BoardView };
