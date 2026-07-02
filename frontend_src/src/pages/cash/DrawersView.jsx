import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { EmptyState } from '../../components/shared';
import { DrawerModal } from './modals';

// ── Drawers view ────────────────────────────────────────────────────────────
function DrawersView({ canCreate, canEdit, drawers, reload }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(null);

  return (
    <div>
      {canCreate && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>{t('cash.addDrawer')}</button>
        </div>
      )}
      {drawers.length === 0 && <EmptyState message={t('cash.noDrawers')} icon="🗄️" />}
      {drawers.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>{t('cash.drawerName')}</th><th>{t('cash.active')}</th>
                  <th>{t('cash.autoCapture')}</th><th></th></tr>
            </thead>
            <tbody>
              {drawers.map(d => (
                <tr key={d.id}>
                  <td><strong>{d.name}</strong></td>
                  <td>
                    <span className={`badge badge-${d.is_active ? 'green' : 'gray'}`}>
                      {d.is_active ? t('cash.active') : '—'}
                    </span>
                  </td>
                  <td>{d.auto_capture ? <span className="badge badge-blue">{t('cash.autoCapture')}</span> : '—'}</td>
                  <td>
                    {canEdit && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(d)}>
                        {t('common.edit')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <DrawerModal drawer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

export { DrawersView };
