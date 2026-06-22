/**
 * Warehouses — multi-location stock administration.
 *
 * Three tabs in one page so the operator doesn't have to navigate between
 * separate screens:
 *
 *   1. Warehouses — list/create/edit + Set Default + archive.
 *   2. Transfers — stock movements between warehouses (Draft → In Transit →
 *      Completed) with the full audit trail.
 *   3. Access  — who can transact in each warehouse (admin-only).
 *
 * All UI strings flow through useLocale → t('warehouses.*') so the page
 * mirrors correctly in both English and Arabic (RTL).
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, toast, fmt as fmtUsd, NumberInput} from '../components/shared';
import {
  getWarehouses, createWarehouse, updateWarehouse, archiveWarehouse, unarchiveWarehouse,
  setDefaultWarehouse, getWarehouseStock,
  getWarehouseAccess, grantWarehouseAccess, revokeWarehouseAccess,
  getUsers,
  getStockTransfers, createStockTransfer, dispatchStockTransfer,
  receiveStockTransfer, cancelStockTransfer, getStockTransfer,
  getInventory,
} from '../api/client';

const WAREHOUSE_TYPES = ['Main', 'Branch', 'Production', 'Damaged', 'Transit', 'Returns'];
const TYPE_COLOR = {
  Main:       'var(--blue)',
  Branch:     'var(--accent)',
  Production: 'var(--purple)',
  Damaged:    'var(--red)',
  Transit:    'var(--yellow)',
  Returns:    'var(--text-3)',
};

const STATUS_BADGE = {
  Draft:       'badge-yellow',
  'In Transit':'badge-blue',
  Completed:   'badge-green',
  Cancelled:   'badge-red',
};

// Backend statuses are bare English strings — map them through the locale so
// Arabic users see translated labels. Falls back to the raw value if a
// status without a translation slips through (defensive).
function statusLabel(t, raw) {
  const key = {
    'Draft':      'statusDraft',
    'In Transit': 'statusInTransit',
    'Completed':  'statusCompleted',
    'Cancelled':  'statusCancelled',
  }[raw];
  return key ? t(`warehouses.${key}`) : raw;
}

// ── Stock-at-warehouse modal ──────────────────────────────────────────────
// Click "View stock" on any warehouse row to see every item it holds, with
// quantity / unit cost / value (= qty × unit cost; same company-wide unit
// cost used in the Inventory-by-Warehouse report per the Phase 1 design
// decision to defer per-warehouse costing).
//
// Includes a search box and aggregate totals at the bottom so the operator
// can answer "what's at this location?" without leaving the page.
function StockAtWarehouseModal({ warehouse, onClose, t }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    getWarehouseStock(warehouse.id)
      .then(setRows)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [warehouse.id]);

  // Filter live, sort by value descending so the operator sees the high-
  // capital items first. Service-only sales would have zero stock — skip
  // those by default but include them if they actually have a balance.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(r => !q
        || (r.name || '').toLowerCase().includes(q)
        || (r.category || '').toLowerCase().includes(q))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
  }, [rows, search]);

  const totalValue = filtered.reduce((s, r) => s + (r.value || 0), 0);
  const totalQty   = filtered.reduce((s, r) => s + (r.quantity || 0), 0);
  const skuCount   = filtered.filter(r => (r.quantity || 0) > 0).length;

  return (
    <Modal
      title={`${warehouse.code} · ${warehouse.name}`}
      onClose={onClose}
      size="modal-lg"
    >
      <div className="modal-body">
        {/* Search + summary ribbon */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            className="form-control"
            style={{ flex: '1 1 220px', minWidth: 0 }}
            placeholder={t('warehouses.stockSearchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('warehouses.stockSummary', {
              skus: skuCount,
              qty:  Number(totalQty).toLocaleString(),
            })}
          </div>
        </div>

        {loading ? <LoadingSpinner /> : error ? <ErrorAlert message={error} /> : (
          filtered.length === 0 ? (
            <EmptyState
              icon="📦"
              title={t('warehouses.stockEmptyTitle')}
              subtitle={search
                ? t('warehouses.stockEmptyHintSearch')
                : t('warehouses.stockEmptyHint')}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t('warehouses.colItem')}</th>
                  <th>{t('inventory.category') || t('warehouses.colCategory') || 'Category'}</th>
                  <th style={{ textAlign: 'right' }}>{t('warehouses.colQuantity')}</th>
                  <th style={{ textAlign: 'right' }}>{t('warehouses.colUnitCost')}</th>
                  <th style={{ textAlign: 'right' }}>{t('warehouses.colValue')}</th>
                </tr></thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id}>
                      <td className="td-primary">
                        {r.name}
                        {r.reserved_quantity > 0 && (
                          <span className="badge badge-yellow" style={{ marginInlineStart: 8, fontSize: 10 }}>
                            {t('warehouses.reservedBadge', { qty: r.reserved_quantity })}
                          </span>
                        )}
                        {r.quarantine_quantity > 0 && (
                          <span className="badge badge-red" style={{ marginInlineStart: 8, fontSize: 10 }}>
                            {t('warehouses.quarantineBadge', { qty: r.quarantine_quantity })}
                          </span>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-3)' }}>{r.category || '—'}</td>
                      <td style={{ textAlign: 'right' }} className="td-mono">
                        {Number(r.quantity || 0).toLocaleString()} {r.unit || ''}
                      </td>
                      <td style={{ textAlign: 'right' }} className="td-mono">{fmtUsd(r.unit_cost || 0)}</td>
                      <td style={{ textAlign: 'right' }} className="td-primary">{fmtUsd(r.value || 0)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                    <td colSpan={2} style={{ textAlign: 'right' }}>{t('warehouses.colTotalValue')}</td>
                    <td style={{ textAlign: 'right' }} className="td-mono">
                      {Number(totalQty).toLocaleString()}
                    </td>
                    <td />
                    <td style={{ textAlign: 'right' }} className="td-primary">{fmtUsd(totalValue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('warehouses.closeBtn')}</button>
      </div>
    </Modal>
  );
}


// ── Warehouses tab ────────────────────────────────────────────────────────
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
              <select className="form-control" value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                {WAREHOUSE_TYPES.map(typ => <option key={typ} value={typ}>{t(`warehouses.type_${typ}`)}</option>)}
              </select>
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

// ── Access tab ────────────────────────────────────────────────────────────
function AccessTab({ t }) {
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers]   = useState([]);
  const [grants, setGrants] = useState({});
  const [selectedWid, setSelectedWid] = useState(null);
  const [picker, setPicker] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [w, u] = await Promise.all([getWarehouses({}), getUsers()]);
      setWarehouses(w.filter(x => !x.archived_at));
      setUsers(u);
      if (w[0] && selectedWid === null) setSelectedWid(w[0].id);
      const g = {};
      for (const x of w) g[x.id] = await getWarehouseAccess(x.id);
      setGrants(g);
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-line */ }, []);

  if (loading) return <LoadingSpinner />;
  if (!warehouses.length) return <EmptyState icon="🏬" title={t('warehouses.noneTitle')} subtitle={t('warehouses.noneAdmin')} />;

  const current = warehouses.find(w => w.id === selectedWid) || warehouses[0];
  const currentGrants = grants[current.id] || [];

  async function grant(uid) {
    try { await grantWarehouseAccess(current.id, uid); toast(t('warehouses.toastAccessGranted'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
    setPicker(null);
  }
  async function revoke(uid) {
    try { await revokeWarehouseAccess(current.id, uid); toast(t('warehouses.toastAccessRevoked'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div>
      <div style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13, color: 'var(--text-2)' }}>
        <strong>{t('warehouses.defaultPolicy')}</strong> {t('warehouses.defaultPolicyExplain')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
        <div>
          <div className="form-label" style={{ marginBottom: 6 }}>
            {t('warehouses.warehouseLabel')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {warehouses.map(w => (
              <button key={w.id}
                onClick={() => setSelectedWid(w.id)}
                className={`btn btn-sm ${w.id === current.id ? 'btn-primary' : 'btn-outline'}`}
                style={{ justifyContent: 'flex-start', display: 'flex', gap: 8 }}>
                <span className="td-mono">{w.code}</span>
                <span style={{ color: 'var(--text-3)' }}>·</span>
                <span>{w.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{current.name} ({current.code})</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {currentGrants.length === 0
                  ? t('warehouses.noGrantsInline')
                  : t(currentGrants.length === 1 ? 'warehouses.someGrants' : 'warehouses.someGrants_plural', { count: currentGrants.length })}
              </div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setPicker({ warehouse_id: current.id })}>
              {t('warehouses.grantBtn')}
            </button>
          </div>
          {currentGrants.length === 0 ? (
            <EmptyState icon="🌐" title={t('warehouses.noGrantsTitle')} subtitle={t('warehouses.noGrantsHint')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t('warehouses.colUser')}</th>
                  <th>{t('warehouses.colGranted')}</th>
                  <th style={{ textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {currentGrants.map(g => (
                    <tr key={g.user_id}>
                      <td className="td-primary">{g.full_name || g.username}</td>
                      <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{new Date(g.granted_at).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-sm" style={{ color: 'var(--red)' }} onClick={() => revoke(g.user_id)}>
                          {t('warehouses.revokeBtn')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {picker && (
        <Modal title={t('warehouses.grantModalTitle')} onClose={() => setPicker(null)}>
          <div className="modal-body">
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
              {t('warehouses.grantModalExplain', { name: current.name })}
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {users.filter(u => !currentGrants.find(g => g.user_id === u.id)).map(u => (
                <div key={u.id} style={{ padding: '6px 4px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{u.full_name || u.username}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>@{u.username}</div>
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => grant(u.id)}>{t('warehouses.grantBtnRow')}</button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Transfers tab ─────────────────────────────────────────────────────────
function TransfersTab({ canEdit, t }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [items, setItems]     = useState([]);
  const [form, setForm]       = useState({ from_warehouse_id: '', to_warehouse_id: '', notes: '', items: [{ inventory_id: '', quantity: 1 }] });
  const [busy, setBusy]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [tx, w] = await Promise.all([getStockTransfers({ limit: 200 }), getWarehouses({})]);
      setRows(tx);
      setWarehouses(w.filter(x => !x.archived_at && x.is_active));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openCreate() {
    setForm({ from_warehouse_id: '', to_warehouse_id: '', notes: '', items: [{ inventory_id: '', quantity: 1 }] });
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
                <select className="form-control" value={form.from_warehouse_id}
                  onChange={e => setForm(f => ({ ...f, from_warehouse_id: e.target.value }))}>
                  <option value="">{t('warehouses.pickSource')}</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">{t('warehouses.toLabel')}</label>
                <select className="form-control" value={form.to_warehouse_id}
                  onChange={e => setForm(f => ({ ...f, to_warehouse_id: e.target.value }))}>
                  <option value="">{t('warehouses.pickDestination')}</option>
                  {warehouses.filter(w => Number(w.id) !== Number(form.from_warehouse_id)).map(w => (
                    <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                  ))}
                </select>
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
                        <select className="form-control" value={it.inventory_id}
                          onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, inventory_id: e.target.value } : x) }))}>
                          <option value="">{t('warehouses.pickItem')}</option>
                          {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit || 'pcs'})</option>)}
                        </select>
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

// ── Main page ─────────────────────────────────────────────────────────────
export default function Warehouses() {
  const { t } = useLocale();
  const { can, isSuperadmin } = usePermissions();
  const [tab, setTab] = useState('warehouses');

  const canEdit = isSuperadmin || can('warehouses', 'edit') || can('warehouses', 'create');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('warehouses.title')}</h1>
          <p className="page-subtitle">{t('warehouses.subtitle')}</p>
        </div>
      </div>

      {/* Use the shared .tabs / .tab-btn pattern so the typography matches
          every other page (Accounting, ProjectDetail, etc.). The earlier
          inline-styled version was a few pixels heavier and looked off. */}
      <div className="tabs">
        {[
          { key: 'warehouses', label: t('warehouses.tabWarehouses') },
          { key: 'transfers',  label: t('warehouses.tabTransfers')  },
          { key: 'access',     label: t('warehouses.tabAccess')     },
        ].map(it => (
          <button key={it.key}
            className={`tab-btn${tab === it.key ? ' active' : ''}`}
            onClick={() => setTab(it.key)}>
            {it.label}
          </button>
        ))}
      </div>

      {tab === 'warehouses' && <WarehousesTab canEdit={canEdit} t={t} />}
      {tab === 'transfers'  && <TransfersTab  canEdit={canEdit} t={t} />}
      {tab === 'access'     && <AccessTab t={t} />}
    </div>
  );
}
