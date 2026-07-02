import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, Modal, ConfirmModal, toast } from '../../components/shared';
import { getBom, getBomVersions, archiveBom } from '../../api/client';
import { num, Money, TypeTag } from './ui';

function BomDetailModal({ bomId, canEdit, canDelete, onClose, onEdit, onNewVersion, onArchived }) {
  const { t } = useLocale();
  const [bom, setBom]   = useState(null);
  const [vers, setVers] = useState([]);
  const [error, setError] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getBom(bomId).then(setBom).catch(e => setError(e.message));
    getBomVersions(bomId).then(setVers).catch(() => {});
  }, [bomId]);
  useEffect(() => { load(); }, [load]);

  return (
    <Modal title={bom ? `${bom.name} · v${bom.version}` : t('manufacturing.tabBoms')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!bom && !error && <LoadingSpinner />}
        {bom && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
              {t('manufacturing.outputProduct')}: <strong>{bom.output_name}</strong>
              {' '}<TypeTag type={bom.output_product_type} />
              {' · '}{t('manufacturing.batchYield')}: <strong>{num(bom.output_quantity)}</strong>
              {!bom.is_active && <span className="badge badge-red" style={{ marginInlineStart: 8 }}>{t('manufacturing.inactive')}</span>}
            </div>

            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>{t('manufacturing.component')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.effectiveQty')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.unitCost')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.lineCost')}</th>
                </tr>
              </thead>
              <tbody>
                {bom.components.map(c => (
                  <tr key={c.id}>
                    <td>
                      {c.component_name}
                      {c.is_subassembly && (
                        <span className="badge badge-accent" style={{ marginInlineStart: 6, fontSize: 10 }}>
                          {t('manufacturing.subassembly')}
                        </span>
                      )}
                      {c.scrap_pct > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)', marginInlineStart: 6 }}>
                          +{num(c.scrap_pct)}% {t('manufacturing.scrap')}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'end' }}>{num(c.effective_quantity)}</td>
                    <td style={{ textAlign: 'end' }}><Money value={c.unit_cost} /></td>
                    <td style={{ textAlign: 'end' }}><Money value={c.line_cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {bom.resources && bom.resources.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12.5 }}>
                <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>
                  {t('manufacturing.resources')} · {t('manufacturing.standardHours')}: {num(bom.standard_hours)}
                </div>
                {bom.resources.map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{r.name}</span><span><Money value={r.hourly_rate} />/h</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span><Money value={bom.material_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}</span><Money value={bom.conversion_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.batchCost')}</span><Money value={bom.batch_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                <span>{t('manufacturing.unitCost')}</span>
                <span><Money value={bom.unit_cost} /> {t('manufacturing.perUnit')}</span>
              </div>
            </div>

            {vers.length > 1 && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.versionHistory')}</h4>
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>
                    {vers.map(v => (
                      <tr key={v.id}>
                        <td style={{ fontWeight: 600 }}>v{v.version}</td>
                        <td>{v.is_active ? <span className="badge badge-green">{t('manufacturing.current')}</span> : ''}</td>
                        <td style={{ color: 'var(--text-3)' }}>{v.revision_note || '—'}</td>
                        <td style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{(v.created_at || '').slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {bom && canDelete && (
          <button className="btn btn-secondary btn-danger" onClick={() => setConfirmArchive(true)}>
            {t('manufacturing.archive')}
          </button>
        )}
        {bom && canEdit && <button className="btn btn-secondary" onClick={() => onEdit(bom)}>{t('common.edit')}</button>}
        {bom && canEdit && (
          <button className="btn btn-primary" onClick={() => onNewVersion(bom)}>{t('manufacturing.newVersion')}</button>
        )}
      </div>
      {confirmArchive && bom && (
        <ConfirmModal title={t('manufacturing.archive')}
          message={t('manufacturing.archiveBomConfirm', { name: bom.name })}
          confirmLabel={t('manufacturing.archive')} confirmClass="btn-danger"
          onCancel={() => setConfirmArchive(false)}
          onConfirm={async () => {
            try { await archiveBom(bom.id); toast(t('manufacturing.archived'), 'green'); onArchived(); }
            catch (e) { toast(e.message, 'red'); }
            setConfirmArchive(false);
          }} />
      )}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ORDER CREATE MODAL
// ════════════════════════════════════════════════════════════════════════════

export { BomDetailModal };
