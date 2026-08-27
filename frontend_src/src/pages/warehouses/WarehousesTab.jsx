import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, toast } from '../../components/shared';
import {
  getWarehouses, createWarehouse, updateWarehouse, archiveWarehouse,
  unarchiveWarehouse, setDefaultWarehouse,
} from '../../api/client';
import { WAREHOUSE_TYPES, TYPE_COLOR } from './constants';
import { StockAtWarehouseModal } from './StockAtWarehouseModal';
import SearchSelect from '../../components/SearchSelect.jsx';

function WarehousesTab({ canEdit, t }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState({ code: '', name: '', type: 'Main', address: '', phone: '', notes: '', is_active: true });
  const [confirm, setConfirm] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [stockModal, setStockModal] = useState(null);   // warehouse row whose stock to show

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await getWarehouses({ include_archived: true })); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setForm({ code: '', name: '', type: 'Main', address: '', phone: '', notes: '', is_active: true });
    setModal('create');
  }
  function openEdit(row) {
    setForm({
      code: row.code, name: row.name, type: row.type,
      address: row.address || '', phone: row.phone || '', notes: row.notes || '',
      is_active: !!row.is_active,
    });
    setModal({ ...row });
  }
  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      return toast(t('warehouses.toastNeedCodeName'), 'red');
    }
    setSaving(true);
    try {
      if (modal === 'create') {
        await createWarehouse(form);
        toast(t('warehouses.toastCreated'), 'green');
      } else {
        const { code, ...rest } = form;
        await updateWarehouse(modal.id, rest);
        toast(t('warehouses.toastUpdated'), 'green');
      }
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }
  async function makeDefault(row) {
    try {
      await setDefaultWarehouse(row.id);
      toast(t('warehouses.toastDefaultSet', { code: row.code }), 'green'); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function doArchive() {
    try { await archiveWarehouse(confirm.id); toast(t('warehouses.toastArchived'), 'green'); setConfirm(null); load(); }
    catch (e) { toast(e.message, 'red'); setConfirm(null); }
  }
  async function doRestore(row) {
    try { await unarchiveWarehouse(row.id); toast(t('warehouses.toastRestored'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={load} />;

  const active   = rows.filter(r => !r.archived_at);
  const archived = rows.filter(r =>  r.archived_at);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
          {t('warehouses.activeCount', { count: active.length })}
          {archived.length > 0 && t('warehouses.archivedSuffix', { count: archived.length })}
        </div>
        {canEdit && (
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            {t('warehouses.addBtn')}
          </button>
        )}
      </div>

      {active.length === 0 ? (
        <EmptyState icon="🏬" title={t('warehouses.noneTitle')}
          subtitle={canEdit ? t('warehouses.noneAdmin') : t('warehouses.noneUser')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('warehouses.code')}</th>
              <th>{t('warehouses.name')}</th>
              <th>{t('warehouses.type')}</th>
              <th>{t('warehouses.status')}</th>
              <th>{t('warehouses.address')}</th>
              <th style={{ textAlign: 'right' }}>{t('warehouses.actions')}</th>
            </tr></thead>
            <tbody>
              {active.map(r => (
                <tr key={r.id}>
                  <td className="td-mono">{r.code}</td>
                  <td className="td-primary">
                    {r.name}
                    {r.is_default ? <span className="badge badge-blue" style={{ marginInlineStart: 8 }}>{t('warehouses.defaultBadge')}</span> : null}
                  </td>
                  <td>
                    <span className="badge" style={{
                      background: (TYPE_COLOR[r.type] || 'var(--text-3)') + '20',
                      color: TYPE_COLOR[r.type] || 'var(--text-3)',
                      border: `1px solid ${(TYPE_COLOR[r.type] || 'var(--text-3)')}40`,
                    }}>{t(`warehouses.type_${r.type}`) || r.type}</span>
                  </td>
                  <td>{r.is_active
                      ? <span className="badge badge-green">{t('warehouses.activeBadge')}</span>
                      : <span className="badge badge-yellow">{t('warehouses.inactiveBadge')}</span>}
                  </td>
                  <td>{r.address || '—'}</td>
                  <td onClick={e => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    {/* "View stock" is available to anyone who can see the
                        warehouse — it's the answer to "what's in here?". */}
                    <button className="btn btn-sm btn-outline" onClick={() => setStockModal(r)}
                      title={t('warehouses.viewStockTitle')}>
                      {t('warehouses.viewStock')}
                    </button>{canEdit && <>{' '}
                    {!r.is_default && (
                      <button className="btn btn-sm btn-outline" onClick={() => makeDefault(r)} title={t('warehouses.setDefaultTitle')}>
                        {t('warehouses.setDefault')}
                      </button>
                    )}{' '}
                    <button className="btn btn-sm btn-outline" onClick={() => openEdit(r)}>{t('warehouses.edit')}</button>{' '}
                    <button className="btn btn-sm" style={{ color: 'var(--red)' }}
                      onClick={() => setConfirm(r)}
                      disabled={r.is_default}
                      title={r.is_default ? t('warehouses.archiveBlocked') : t('warehouses.archive')}>
                      {t('warehouses.archive')}
                    </button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {archived.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary style={{ color: 'var(--text-3)', cursor: 'pointer', fontSize: 13 }}>
            {t('warehouses.archivedHeader', { count: archived.length })}
          </summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr>
                <th>{t('warehouses.code')}</th>
                <th>{t('warehouses.name')}</th>
                <th>{t('warehouses.type')}</th>
                <th>{t('warehouses.archivedAt')}</th>
                {canEdit && <th style={{ textAlign: 'right' }}>{t('warehouses.actions')}</th>}
              </tr></thead>
              <tbody>
                {archived.map(r => (
                  <tr key={r.id} className="row-archived">
                    <td className="td-mono">{r.code}</td>
                    <td>{r.name}</td>
                    <td>{t(`warehouses.type_${r.type}`) || r.type}</td>
                    <td>{r.archived_at ? new Date(r.archived_at).toLocaleDateString() : ''}</td>
                    {canEdit && (
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-sm btn-outline" onClick={() => doRestore(r)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Create / Edit modal */}
      {modal && (
        <Modal title={modal === 'create' ? t('warehouses.newTitle') : t('warehouses.editTitle', { code: modal.code })} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">{t('warehouses.codeLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-control" value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase().replace(/\s+/g,'-') }))}
                disabled={modal !== 'create'}
                placeholder={t('warehouses.codePlaceholder')} maxLength={32} />
              <small style={{ color: 'var(--text-3)' }}>{t('warehouses.codeHint')}</small>
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.nameLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="form-control" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} maxLength={120} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.typeLabel')}</label>
              <SearchSelect
                className="form-control"
                value={form.type}
                onChange={v => setForm(f => ({ ...f, type: v }))}
                options={(WAREHOUSE_TYPES).map(typ => ({ value: typ, label: t(`warehouses.type_${typ}`) }))} />
              <small style={{ color: 'var(--text-3)' }}>{t(`warehouses.desc_${form.type}`)}</small>
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.addressLabel')}</label>
              <input className="form-control" value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.phoneLabel')}</label>
              <input className="form-control" value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.notesLabel')}</label>
              <textarea className="form-control" rows={3} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                {t('warehouses.activeChk')}
              </label>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmModal
          message={t('warehouses.confirmArchive', { code: confirm.code })}
          confirmLabel={t('warehouses.archiveAction')}
          confirmClass="btn-danger"
          onConfirm={doArchive}
          onCancel={() => setConfirm(null)}
        />
      )}

      {stockModal && (
        <StockAtWarehouseModal
          warehouse={stockModal}
          onClose={() => setStockModal(null)}
          t={t}
        />
      )}
    </>
  );
}


export { WarehousesTab };
