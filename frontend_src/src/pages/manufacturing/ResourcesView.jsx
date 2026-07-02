import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, Modal, ConfirmModal, toast, NumberInput } from '../../components/shared';
import { getResources, createResource, updateResource, archiveResource } from '../../api/client';
import { Money } from './ui';

function ResourcesView({ canCreate, canEdit, canDelete }) {
  const { t } = useLocale();
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(null);   // resource being edited / created
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(() => getResources().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    try {
      const body = {
        name: modal.name, cost_type: 'per_hour',
        hourly_rate: Number(modal.hourly_rate) || 0,
        is_active: modal.is_active !== false, notes: modal.notes,
      };
      if (modal.id) await updateResource(modal.id, body);
      else await createResource(body);
      toast(`${modal.name} ✓`); setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function doArchive(r) {
    setConfirmDel(null);
    try { await archiveResource(r.id); load(); } catch (e) { toast(e.message, 'red'); }
  }

  if (!rows) return <LoadingSpinner />;
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="card-title">{t('manufacturing.tabResources')}</span>
        {canCreate && <button className="btn btn-sm btn-primary"
          onClick={() => setModal({ name: '', hourly_rate: 0, is_active: true })}>
          ＋ {t('manufacturing.newResource')}</button>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 16px 8px' }}>{t('manufacturing.resourcesIntro')}</p>
      {rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
          {t('manufacturing.noResources')}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('manufacturing.resourceName')}</th>
              <th>{t('manufacturing.costType')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.hourlyRate')}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="td-primary">{r.name}</td>
                  <td style={{ color: 'var(--text-3)' }}>{t('manufacturing.perHour')}</td>
                  <td style={{ textAlign: 'end' }}><Money value={r.hourly_rate} />/h</td>
                  <td style={{ textAlign: 'end' }}>
                    {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setModal({ ...r })}>{t('common.edit')}</button>}
                    {canDelete && <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }} onClick={() => setConfirmDel(r)}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? t('common.edit') : t('manufacturing.newResource')} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group form-full">
                <label className="form-label">{t('manufacturing.resourceName')}</label>
                <input className="form-control" value={modal.name} autoFocus
                  onChange={e => setModal(m => ({ ...m, name: e.target.value }))}
                  placeholder={t('manufacturing.resourceNamePlaceholder')} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.hourlyRate')} / h</label>
                <NumberInput min="0" step="0.01" className="form-control"
                  value={modal.hourly_rate} onChange={e => setModal(m => ({ ...m, hourly_rate: e.target.value }))} />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={!modal.name}>{t('common.save')}</button>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmModal title={t('manufacturing.archive')} confirmClass="btn-danger" confirmLabel={t('manufacturing.archive')}
          message={confirmDel.name} onConfirm={() => doArchive(confirmDel)} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

export { ResourcesView };
