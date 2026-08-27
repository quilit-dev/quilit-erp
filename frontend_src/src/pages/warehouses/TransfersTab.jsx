import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, toast, NumberInput } from '../../components/shared';
import {
  getWarehouses, getInventory, getBranchContext,
  getStockTransfers, getStockTransfer, createStockTransfer,
  dispatchStockTransfer, receiveStockTransfer, cancelStockTransfer,
} from '../../api/client';
import { STATUS_BADGE, statusLabel } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

function TransfersTab({ canEdit, t }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [items, setItems]     = useState([]);
  const [form, setForm]       = useState({ from_warehouse_id: '', to_warehouse_id: '', notes: '', items: [{ inventory_id: '', quantity: 1 }] });
  const [busy, setBusy]       = useState(false);
  // Branch-scoped users (Branch Managers) may only REPLENISH their own branch
  // from a central (non-branch) warehouse — mirror that in the form so they
  // never pick a combo the backend would reject.
  const [branchCtx, setBranchCtx] = useState({ is_global: true, home_branch_id: null });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [tx, w, bc] = await Promise.all([
        getStockTransfers({ limit: 200 }), getWarehouses({}),
        getBranchContext().catch(() => ({ is_global: true, home_branch_id: null })),
      ]);
      setRows(tx);
      setWarehouses(w.filter(x => !x.archived_at && x.is_active));
      setBranchCtx(bc || { is_global: true, home_branch_id: null });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openCreate() {
    // Scoped users can only transfer INTO their own branch — lock the destination.
    const lockedTo = branchCtx.is_global ? '' : (branchCtx.home_branch_id ?? '');
    setForm({ from_warehouse_id: '', to_warehouse_id: lockedTo, notes: '', items: [{ inventory_id: '', quantity: 1 }] });
    if (!items.length) {
      try { setItems(await getInventory()); } catch { /* ignore */ }
    }
    setModal('create');
  }

  async function openDetail(row) {
    try {
      const detail = await getStockTransfer(row.id);
      setModal({ ...detail });
    } catch (e) { toast(e.message, 'red'); }
  }

  async function save() {
    if (!form.from_warehouse_id || !form.to_warehouse_id) return toast(t('warehouses.toastErrPickSrcDst'), 'red');
    if (Number(form.from_warehouse_id) === Number(form.to_warehouse_id)) return toast(t('warehouses.toastErrSameSrcDst'), 'red');
    const cleanedItems = form.items
      .filter(i => i.inventory_id && Number(i.quantity) > 0)
      .map(i => ({ inventory_id: Number(i.inventory_id), quantity: Number(i.quantity), note: i.note || null }));
    if (!cleanedItems.length) return toast(t('warehouses.toastErrNoLines'), 'red');
    setBusy(true);
    try {
      await createStockTransfer({
        from_warehouse_id: Number(form.from_warehouse_id),
        to_warehouse_id:   Number(form.to_warehouse_id),
        notes: form.notes || null,
        items: cleanedItems,
      });
      toast(t('warehouses.toastDraftCreated'), 'green');
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  async function action(name, tid, payload) {
    setBusy(true);
    try {
      if (name === 'dispatch') { await dispatchStockTransfer(tid); toast(t('warehouses.toastDispatched'), 'green'); }
      else if (name === 'receive') { await receiveStockTransfer(tid, payload || {}); toast(t('warehouses.toastReceived'), 'green'); }
      else if (name === 'cancel') { await cancelStockTransfer(tid, payload?.reason || t('warehouses.cancelReasonDraft')); toast(t('warehouses.toastCancelled'), 'green'); }
      setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={load} />;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
          {t(rows.length === 1 ? 'warehouses.transferCount' : 'warehouses.transferCount_plural', { count: rows.length })}
        </div>
        {canEdit && (
          <button className="btn btn-primary btn-sm" onClick={openCreate}>{t('warehouses.newTransferBtn')}</button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="🚚" title={t('warehouses.noneTransfersTitle')}
          subtitle={canEdit ? t('warehouses.noneTransfersAdmin') : t('warehouses.noneTransfersIdle')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('warehouses.colNumber')}</th>
              <th>{t('warehouses.colFromTo')}</th>
              <th>{t('warehouses.status')}</th>
              <th>{t('warehouses.colCreated')}</th>
              <th>{t('warehouses.colNotes')}</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}>
                  <td className="td-mono">{r.transfer_number}</td>
                  <td>
                    <span className="td-mono" style={{ color: 'var(--text-3)' }}>{r.from_code}</span>
                    <span style={{ color: 'var(--text-3)', margin: '0 6px' }}>→</span>
                    <span className="td-mono">{r.to_code}</span>
                  </td>
                  <td><span className={`badge ${STATUS_BADGE[r.status] || ''}`}>{statusLabel(t, r.status)}</span></td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{r.notes ? r.notes.slice(0, 60) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {modal === 'create' && (
        <Modal title={t('warehouses.newTransferTitle')} onClose={() => setModal(null)} size="modal-lg">
          <div className="modal-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">{t('warehouses.fromLabel')}</label>
                <SearchSelect
                  className="form-control"
                  value={form.from_warehouse_id}
                  onChange={v => setForm(f => ({ ...f, from_warehouse_id: v }))}
                  placeholder={t('warehouses.pickSource')}
                  options={(warehouses
                    // Scoped users may only pull from a central (non-branch) warehouse.
                    .filter(w => branchCtx.is_global || (w.type || '').toLowerCase() !== 'branch')).map(w => ({ value: w.id, label: `${w.code} · ${w.name}` }))} />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">{t('warehouses.toLabel')}</label>
                <SearchSelect
                  className="form-control"
                  disabled={!branchCtx.is_global}
                  value={form.to_warehouse_id}
                  onChange={v => setForm(f => ({ ...f, to_warehouse_id: v }))}
                  placeholder={t('warehouses.pickDestination')}
                  options={(warehouses
                    // Scoped users can only transfer INTO their own branch.
                    .filter(w => (branchCtx.is_global || Number(w.id) === Number(branchCtx.home_branch_id))
                                 && Number(w.id) !== Number(form.from_warehouse_id))).map(w => ({ value: w.id, label: `${w.code} · ${w.name}` }))} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('warehouses.colNotes')}</label>
              <input className="form-control" value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder={t('warehouses.transferNotesHint')} />
            </div>

            <div className="form-group" style={{ marginBottom: 6 }}>
              <label className="form-label">{t('warehouses.itemsHeader')}</label>
            </div>
            <div className="table-wrap" style={{ marginBottom: 8 }}>
              <table>
                <thead><tr>
                  <th>{t('warehouses.colItem')}</th>
                  <th style={{ width: 110 }}>{t('warehouses.colQuantity')}</th>
                  <th style={{ width: 40 }}></th>
                </tr></thead>
                <tbody>
                  {form.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>
                        <SearchSelect
                          className="form-control"
                          value={it.inventory_id}
                          onChange={v => setForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, inventory_id: v } : x) }))}
                          placeholder={t('warehouses.pickItem')}
                          options={(items || []).map(i => ({ value: i.id, label: `${i.name} (${i.unit || 'pcs'})` }))} />
                      </td>
                      <td>
                        <NumberInput className="form-control" min={0.01} step={1} value={it.quantity}
                          onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x) }))} />
                      </td>
                      <td>
                        {form.items.length > 1 && (
                          <button className="btn btn-sm" style={{ color: 'var(--red)' }}
                            onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))}>×</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-sm btn-outline" type="button"
              onClick={() => setForm(f => ({ ...f, items: [...f.items, { inventory_id: '', quantity: 1 }] }))}>
              {t('warehouses.addLine')}
            </button>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? t('common.saving') : t('warehouses.createDraftBtn')}
            </button>
          </div>
        </Modal>
      )}

      {/* Detail modal */}
      {modal && typeof modal === 'object' && modal.transfer_number && (
        <Modal title={modal.transfer_number} onClose={() => setModal(null)} size="modal-lg">
          <div className="modal-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <div className="form-label" style={{ marginBottom: 2 }}>{t('warehouses.fromLabel')}</div>
                <div style={{ fontWeight: 600 }}>{modal.from_code}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{modal.from_name}</div>
              </div>
              <div>
                <div className="form-label" style={{ marginBottom: 2 }}>{t('warehouses.toLabel')}</div>
                <div style={{ fontWeight: 600 }}>{modal.to_code}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{modal.to_name}</div>
              </div>
              <div>
                <div className="form-label" style={{ marginBottom: 2 }}>{t('warehouses.detailStatus')}</div>
                <div><span className={`badge ${STATUS_BADGE[modal.status]}`}>{statusLabel(t, modal.status)}</span></div>
              </div>
            </div>

            <div className="table-wrap" style={{ marginBottom: 16 }}>
              <table>
                <thead><tr>
                  <th>{t('warehouses.colItem')}</th>
                  <th style={{ width: 110, textAlign: 'right' }}>{t('warehouses.colDispatched')}</th>
                  <th style={{ width: 110, textAlign: 'right' }}>{t('warehouses.colReceived')}</th>
                </tr></thead>
                <tbody>
                  {(modal.items || []).map(it => (
                    <tr key={it.id}>
                      <td>{it.inventory_name}</td>
                      <td style={{ textAlign: 'right' }} className="td-mono">{it.quantity}</td>
                      <td style={{ textAlign: 'right' }} className="td-mono">{it.received_quantity ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              <div>{t('warehouses.detailCreated')}: {new Date(modal.created_at).toLocaleString()}</div>
              {modal.dispatched_at && <div>{t('warehouses.detailDispatched')}: {new Date(modal.dispatched_at).toLocaleString()}</div>}
              {modal.received_at   && <div>{t('warehouses.detailReceived')}: {new Date(modal.received_at).toLocaleString()}</div>}
              {modal.cancelled_at  && <div>{t('warehouses.detailCancelled')}: {new Date(modal.cancelled_at).toLocaleString()} — {modal.cancel_reason}</div>}
              {modal.notes && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>📝 {modal.notes}</div>}
            </div>
          </div>
          <div className="modal-footer">
            {canEdit && modal.status === 'Draft' && (
              <>
                <button className="btn btn-outline" disabled={busy}
                  onClick={() => action('cancel', modal.id, { reason: t('warehouses.cancelReasonDraft') })}>
                  {t('warehouses.cancelTransferBtn')}
                </button>
                <button className="btn btn-primary" disabled={busy}
                  onClick={() => action('dispatch', modal.id)}>{t('warehouses.dispatchBtn')}</button>
              </>
            )}
            {canEdit && modal.status === 'In Transit' && (
              <>
                <button className="btn btn-outline" disabled={busy}
                  onClick={() => action('cancel', modal.id, { reason: t('warehouses.cancelReasonInTransit') })}>
                  {t('warehouses.cancelBtnShort')}
                </button>
                <button className="btn btn-primary" disabled={busy}
                  onClick={() => action('receive', modal.id, {})}>{t('warehouses.receiveFullBtn')}</button>
              </>
            )}
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('warehouses.closeBtn')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}


export { TransfersTab };
