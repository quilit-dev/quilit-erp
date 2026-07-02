import { useState, useCallback, useEffect } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { Modal, ConfirmModal, LoadingSpinner, ErrorAlert, toast } from '../components/shared';
import {
  getPlanningProjects, archivePlanningProject, unarchivePlanningProject,
  getPlanningTasks, archivePlanningTask, unarchivePlanningTask,
  getPlanningMilestones, getPlanningSummary, getPlanningDropdownClients,
  getPlanningDropdownUsers, getProjects,
} from '../api/client';

// Views, forms, panels + shared ui/constants extracted into ./planning/ —
// this file is the orchestrator (view switch + shared data/state).
import { SummaryCards } from './planning/ui';
import { ProjectForm } from './planning/ProjectForm';
import { TaskForm } from './planning/TaskForm';
import { GanttView } from './planning/GanttView';
import { BoardView } from './planning/BoardView';
import { ListView } from './planning/ListView';
import { CalendarView } from './planning/CalendarView';
import { ProjectsPanel } from './planning/ProjectsPanel';

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
  // Projects from the operational Projects module (separate table from planning
  // projects) — offered in the New Project form so a planning project can be
  // started from an existing one instead of retyping its details.
  const [srcProjects, setSrcProjects] = useState([]);

  useEffect(() => {
    getPlanningDropdownClients().then(setClients).catch(() => {});
    getPlanningDropdownUsers().then(setUsers).catch(() => {});
    getProjects({}).then(r => setSrcProjects(Array.isArray(r) ? r : (r?.items || []))).catch(() => {});
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
            srcProjects={srcProjects}
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
