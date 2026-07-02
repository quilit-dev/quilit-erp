// Cash — daily drawer reconciliation (Today / History / Drawers).
// Views + modals live in ./cash/ — this file is the orchestrator.
import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { EmptyState } from '../components/shared';
import { getCashDrawers } from '../api/client';
import { OpenDayModal } from './cash/modals';
import { ReconDetailModal } from './cash/ReconDetailModal';
import { TodayView } from './cash/TodayView';
import { HistoryView } from './cash/HistoryView';
import { DrawersView } from './cash/DrawersView';

// ── Page ────────────────────────────────────────────────────────────────────
export default function Cash() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('today');
  const [drawers, setDrawers] = useState([]);
  const [openDayFor, setOpenDayFor] = useState(undefined);
  const [detailId, setDetailId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const canView   = can('cash', 'view');
  const canCreate = can('cash', 'create');
  const canEdit   = can('cash', 'edit');
  const canDelete = can('cash', 'delete');

  const loadDrawers = useCallback(() => {
    getCashDrawers().then(setDrawers).catch(() => {});
  }, []);
  useEffect(() => { loadDrawers(); }, [loadDrawers]);

  const refresh = () => setRefreshKey(k => k + 1);

  const tabs = [
    { key: 'today',   label: t('cash.tabToday') },
    { key: 'history', label: t('cash.tabHistory') },
    { key: 'drawers', label: t('cash.tabDrawers') },
  ];

  if (!canView) return <EmptyState message={t('cash.subtitle')} icon="🔒" />;

  return (
    <div>
      {/* Workspace-style page header with title + subtitle on the left and
          the "Open Day" primary action on the right. */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('cash.title')}</h1>
          <p className="page-subtitle">{t('cash.subtitle')}</p>
        </div>
        <div className="page-actions">
          {canCreate && (
            <button className="btn btn-primary" onClick={() => setOpenDayFor(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              {t('cash.openDay')}
            </button>
          )}
        </div>
      </div>

      {/* Workspace tabs — clean underline style, consistent with the rest
          of the modules. */}
      <div className="tabs">
        {tabs.map(tb => (
          <button key={tb.key}
            className={`tab-btn${view === tb.key ? ' active' : ''}`}
            onClick={() => setView(tb.key)}>
            {tb.label}
          </button>
        ))}
      </div>

      {view === 'today' && (
        <TodayView canCreate={canCreate} onOpenDay={(id) => setOpenDayFor(id)}
          openDetail={setDetailId} refreshKey={refreshKey} />
      )}
      {view === 'history' && (
        <HistoryView drawers={drawers} openDetail={setDetailId} refreshKey={refreshKey} />
      )}
      {view === 'drawers' && (
        <DrawersView canCreate={canCreate} canEdit={canEdit} drawers={drawers} reload={loadDrawers} />
      )}

      {openDayFor !== undefined && (
        <OpenDayModal drawers={drawers} presetDrawerId={openDayFor}
          onClose={() => setOpenDayFor(undefined)}
          onOpened={() => { setOpenDayFor(undefined); refresh(); }} />
      )}
      {detailId && (
        <ReconDetailModal reconId={detailId}
          canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)} onChanged={refresh} />
      )}
    </div>
  );
}
