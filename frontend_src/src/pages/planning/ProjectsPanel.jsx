import { useLocale } from '../../hooks/useLocale.jsx';
import { Badge, ProgressBar } from './ui';
import { PROJ_STATUS_KEY, tEnum } from './constants';

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
            <div style={{ height: 5, background: proj.color || 'var(--info)' }} />
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
              <ProgressBar value={pct} color={proj.color || 'var(--info)'} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                {proj.start_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.start_date}</span>}
                {proj.start_date && proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>→</span>}
                {proj.end_date && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{proj.end_date}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {isArchived ? (
                    <button className="btn btn-outline btn-sm" onClick={() => onRestore(proj)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
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


export { ProjectsPanel };
