import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState } from '../../components/shared';
import { getBoms } from '../../api/client';
import { Money, TypeTag } from './ui';
import { BomModal } from './BomModal';
import { BomDetailModal } from './BomDetailModal';

function BomsView({ canCreate, canEdit, canDelete, products, refreshKey, bump }) {
  const { t } = useLocale();
  const [rows, setRows]   = useState(null);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);   // {mode, bom} | null
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getBoms().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div>
      {canCreate && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ mode: 'create' })}>
            {t('manufacturing.newBom')}
          </button>
        </div>
      )}
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('manufacturing.noBoms')} icon="📋" />}
      {rows && rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('manufacturing.bomName')}</th>
                  <th>{t('manufacturing.outputProduct')}</th>
                  <th>{t('manufacturing.version')}</th>
                  <th>{t('manufacturing.components')}</th>
                  <th>{t('manufacturing.batchCost')}</th>
                  <th>{t('manufacturing.unitCost')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(b => (
                  <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(b.id)}>
                    <td><strong>{b.name}</strong>{!b.is_active &&
                      <span className="badge badge-red" style={{ marginInlineStart: 6 }}>{t('manufacturing.inactive')}</span>}</td>
                    <td>{b.output_name} <TypeTag type={b.output_product_type} /></td>
                    <td>v{b.version}</td>
                    <td>{b.component_count}</td>
                    <td><Money value={b.batch_cost} /></td>
                    <td><Money value={b.unit_cost} /></td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDetailId(b.id)}>
                        {t('common.view')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {modal && (
        <BomModal mode={modal.mode} bom={modal.bom} products={products}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); bump(); }} />
      )}
      {detailId && (
        <BomDetailModal bomId={detailId} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)}
          onEdit={(bom) => { setDetailId(null); setModal({ mode: 'edit', bom }); }}
          onNewVersion={(bom) => { setDetailId(null); setModal({ mode: 'version', bom }); }}
          onArchived={() => { setDetailId(null); load(); bump(); }} />
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export { BomsView };
