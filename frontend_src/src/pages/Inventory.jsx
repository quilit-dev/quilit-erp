import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useEffect, useCallback } from 'react';
import {
  createInventoryItem, updateInventoryItem,
  archiveInventoryItem, updateStock, getStockMovements,
  getLots, getLot,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, toast, SortableTh, Pagination
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';

const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'm²', 'm³', 'box', 'roll', 'set', 'pair'];
const DEFAULT_CATEGORIES = ['Equipment', 'Materials', 'Safety', 'Tools', 'Consumables', 'Other'];
const PRODUCT_TYPES = ['raw_material', 'semi_finished', 'finished', 'consumable'];
const PRODUCT_TYPE_COLORS = {
  raw_material:  { bg: '#EFF6FF', color: '#2563EB' },
  semi_finished: { bg: '#FFFBEB', color: '#D97706' },
  finished:      { bg: '#ECFDF5', color: '#059669' },
  consumable:    { bg: '#F5F3FF', color: '#7C3AED' },
};

const fmtNum = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function CategoryBadge({ category }) {
  if (!category) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  return <span className="badge badge-accent">{category}</span>;
}

function ProductTypeBadge({ type }) {
  const { t } = useLocale();
  if (!type) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const s = PRODUCT_TYPE_COLORS[type] || { bg: '#F3F4F6', color: '#6B7280' };
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', background: s.bg, color: s.color,
    }}>{t(`inventory.ptype_${type}`)}</span>
  );
}

function ItemForm({ initial = {}, knownCategories = [], onSave, onCancel, saving }) {
  const { t } = useLocale();
  const isEdit = !!initial.id;
  const allCats = [...new Set([...knownCategories, ...DEFAULT_CATEGORIES])];

  const [form, setForm] = useState({
    name:           initial.name       || '',
    category:       initial.category   || '',
    product_type:   initial.product_type || '',
    customCategory: '',
    quantity:       initial.quantity   ?? 0,
    min_stock:      initial.min_stock  ?? 0,
    unit_cost:      initial.unit_cost ?? 0,
    sale_price:     initial.sale_price ?? 0,
    supplier:       initial.supplier   || '',
    unit:           initial.unit       || 'pcs',
    barcode:        initial.barcode    || '',
    lot_tracked:    !!initial.lot_tracked,
    shelf_life_days: initial.shelf_life_days ?? '',
  });

  const useCustom = form.category === '__custom__';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function submit(e) {
    e.preventDefault();
    const category = useCustom ? form.customCategory.trim() : form.category.trim();
    onSave({
      ...form, category: category || null, product_type: form.product_type || null,
      lot_tracked: !!form.lot_tracked,
      shelf_life_days: form.shelf_life_days === '' || form.shelf_life_days == null
        ? null : Number(form.shelf_life_days),
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.itemNameLabel')}</label>
            <input className="form-control" required value={form.name}
              onChange={e => set('name', e.target.value)} />
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('common.category')}</label>
            <select className="form-control" value={form.category}
              onChange={e => set('category', e.target.value)}>
              <option value="">{t('inventory.noCategory')}</option>
              {allCats.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__custom__">{t('inventory.addCategoryOption')}</option>
            </select>
            {useCustom && (
              <input className="form-control" style={{ marginTop: 8 }}
                placeholder={t('inventory.typeCategoryName')}
                value={form.customCategory}
                onChange={e => set('customCategory', e.target.value)} />
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.productTypeLabel')}</label>
            <select className="form-control" value={form.product_type}
              onChange={e => set('product_type', e.target.value)}>
              <option value="">{t('inventory.ptypeUnclassified')}</option>
              {PRODUCT_TYPES.map(p => <option key={p} value={p}>{t(`inventory.ptype_${p}`)}</option>)}
            </select>
          </div>

          {!isEdit && (
            <div className="form-group">
              <label className="form-label">{t('inventory.initialQuantity')}</label>
              <input className="form-control" type="number" step="1" min="0"
                value={form.quantity} onChange={e => set('quantity', e.target.value)} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('inventory.minStockAlert')}</label>
            <input className="form-control" type="number" step="1" min="0"
              value={form.min_stock} onChange={e => set('min_stock', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.unitCostLabel')}</label>
            <input className="form-control" type="number" step="any" min="0"
              value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceLabel')}</label>
            <input className="form-control" type="number" step="any" min="0"
              value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.unitLabel')}</label>
            <select className="form-control" value={form.unit}
              onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('inventory.supplierLabel')}</label>
            <input className="form-control" value={form.supplier}
              onChange={e => set('supplier', e.target.value)} />
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('inventory.barcodeLabel')}</label>
            <input className="form-control" value={form.barcode}
              placeholder={t('inventory.barcodePlaceholder')}
              onChange={e => set('barcode', e.target.value)} />
          </div>

          <div className="form-group form-full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={form.lot_tracked} onChange={e => set('lot_tracked', e.target.checked)} />
              {t('inventory.lotTracked')}
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('inventory.lotTrackedHint')}</span>
            </label>
            {form.lot_tracked && (
              <div style={{ marginTop: 8, maxWidth: 240 }}>
                <label className="form-label">{t('inventory.shelfLifeDays')}</label>
                <input className="form-control" type="number" min="0" step="1"
                  value={form.shelf_life_days}
                  onChange={e => set('shelf_life_days', e.target.value)}
                  placeholder={t('inventory.shelfLifeHint')} />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : isEdit ? t('common.save') : t('common.addItem')}
        </button>
      </div>
    </form>
  );
}

function StockForm({ item, onDone, onCancel }) {
  const { t } = useLocale();
  const [delta,  setDelta]  = useState('');
  const [type,   setType]   = useState('adjustment');
  const [note,   setNote]   = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const d = parseFloat(delta);
    if (isNaN(d) || d === 0) { toast(t('inventory.nonZeroQty'), 'red'); return; }
    setSaving(true);
    try {
      await updateStock(item.id, { delta: d, type, note });
      toast(t('inventory.stockUpdated'));
      onDone();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="alert alert-yellow" style={{ marginBottom: 16 }}>
          {t('inventory.currentStock')} <strong>{item.quantity} {item.unit}</strong>
        </div>
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.qtyChange')}</label>
            <input className="form-control" type="number" step="1" required
              placeholder="e.g. 10 or -5"
              value={delta} onChange={e => setDelta(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.type')}</label>
            <select className="form-control" value={type} onChange={e => setType(e.target.value)}>
              <option value="adjustment">{t('inventory.manualAdj')}</option>
              <option value="purchase">{t('inventory.purchaseReceipt')}</option>
              <option value="usage">{t('inventory.usageConsumption')}</option>
              <option value="return">{t('inventory.return')}</option>
              <option value="loss">{t('inventory.lossDamage')}</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.noteOptional')}</label>
            <input className="form-control" placeholder="Reason…"
              value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('inventory.updateStock')}
        </button>
      </div>
    </form>
  );
}

function MovementsModal({ item, onClose }) {
  const { t } = useLocale();
  const [movements, setMovements] = useState([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    getStockMovements(item.id)
      .then(setMovements)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [item.id]);

  return (
    <Modal title={t('inventory.stockHistory', { name: item.name })} onClose={onClose} size="modal-lg">
      {loading ? <LoadingSpinner /> : movements.length === 0 ? (
        <EmptyState message={t('inventory.noMovements')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('common.type')}</th>
                <th>{t('inventory.delta')}</th>
                <th>{t('inventory.before')}</th>
                <th>{t('inventory.after')}</th>
                <th>{t('inventory.noteRef')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{m.created_at?.slice(0, 16)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{m.type}</td>
                  <td style={{ fontWeight: 600, color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {m.delta >= 0 ? '+' : ''}{m.delta}
                  </td>
                  <td>{m.qty_before}</td>
                  <td>{m.qty_after}</td>
                  <td style={{ color: 'var(--text-3)' }}>{m.note || m.reference || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ── Lots & Expiry browser ────────────────────────────────────────────────────
const LOT_STATUS_BADGE = {
  expired:  { cls: 'badge-red',    key: 'inventory.expExpired' },
  expiring: { cls: 'badge-yellow', key: 'inventory.expExpiring' },
  ok:       { cls: 'badge-green',  key: 'inventory.expOk' },
  none:     { cls: 'badge-muted',  key: null },
};

function LotTraceModal({ lotId, onClose }) {
  const { t } = useLocale();
  const [lot, setLot] = useState(null);
  useEffect(() => { getLot(lotId).then(setLot).catch(e => toast(e.message, 'red')); }, [lotId]);
  return (
    <Modal title={lot ? `${t('inventory.lotNumber')} · ${lot.lot_number}` : t('inventory.trace')}
           onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {!lot ? <LoadingSpinner /> : (
          <>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              <strong>{lot.item_name}</strong> · {t('inventory.lotRemaining')}: {lot.quantity_remaining} {lot.item_unit} · ${fmtNum(lot.unit_cost)}/u
              <div style={{ color: 'var(--text-3)', marginTop: 4 }}>
                {t('inventory.mfgDate')}: {lot.manufacture_date || '—'} · {t('inventory.lotExpiry')}: {lot.expiry_date || '—'}
                {lot.source_ref ? ` · ${lot.source_type}: ${lot.source_ref}` : ''}
              </div>
            </div>

            <h4 style={{ fontSize: 14, margin: '12px 0 4px' }}>{t('inventory.madeFrom')}</h4>
            {(!lot.made_from || lot.made_from.length === 0)
              ? <p style={{ color: 'var(--text-3)', fontSize: 13, margin: 0 }}>—</p>
              : (<table className="table" style={{ fontSize: 12 }}><tbody>
                  {lot.made_from.map((m, i) => (
                    <tr key={i}>
                      <td>{m.input_item_name}</td>
                      <td className="text-mono">{m.input_lot_number}</td>
                      <td style={{ textAlign: 'end' }}>{m.quantity}</td>
                    </tr>
                  ))}
                </tbody></table>)}

            <h4 style={{ fontSize: 14, margin: '14px 0 4px' }}>{t('inventory.usedIn')}</h4>
            {(!lot.used_in || lot.used_in.length === 0)
              ? <p style={{ color: 'var(--text-3)', fontSize: 13, margin: 0 }}>—</p>
              : (<table className="table" style={{ fontSize: 12 }}>
                  <thead><tr>
                    <th>{t('inventory.lotDate')}</th><th>{t('inventory.lotUse')}</th>
                    <th>{t('inventory.lotDest')}</th><th style={{ textAlign: 'end' }}>{t('inventory.qty')}</th>
                  </tr></thead>
                  <tbody>
                    {lot.used_in.map((u, i) => (
                      <tr key={i}>
                        <td>{(u.created_at || '').slice(0, 10)}</td>
                        <td style={{ textTransform: 'capitalize' }}>{u.source_type}</td>
                        <td style={{ color: 'var(--text-3)' }}>
                          {u.output_item_name
                            ? `→ ${u.output_item_name} (${u.output_lot_number || ''})`
                            : (u.order_number || u.source_ref || '—')}
                        </td>
                        <td style={{ textAlign: 'end' }}>{u.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>)}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

function LotsBrowser() {
  const { t } = useLocale();
  const [rows, setRows] = useState(null);
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    getLots(expiringOnly ? { expiring: true } : {})
      .then(setRows).catch(e => { toast(e.message, 'red'); setRows([]); });
  }, [expiringOnly]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-title">{t('inventory.tabLots')}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} />
          {t('inventory.expiringOnly')}
        </label>
      </div>
      {!rows ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState message={t('inventory.noLots')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('inventory.lotNumber')}</th><th>{t('inventory.itemName')}</th>
              <th>{t('inventory.lotRemaining')}</th><th>{t('inventory.unitCost')}</th>
              <th>{t('inventory.lotExpiry')}</th><th>{t('inventory.expStatus')}</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(l => {
                const b = LOT_STATUS_BADGE[l.expiry_status] || LOT_STATUS_BADGE.none;
                return (
                  <tr key={l.id}>
                    <td className="text-mono">{l.lot_number}</td>
                    <td className="td-primary">{l.item_name}</td>
                    <td>{l.quantity_remaining} {l.item_unit}</td>
                    <td>${fmtNum(l.unit_cost)}</td>
                    <td>{l.expiry_date || '—'}</td>
                    <td>{b.key ? <span className={`badge ${b.cls}`}>{t(b.key)}</span> : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td style={{ textAlign: 'end' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => setDetailId(l.id)}>{t('inventory.trace')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {detailId && <LotTraceModal lotId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

export default function Inventory() {
  const { t } = useLocale();
  const [view, setView] = useState('items');   // 'items' | 'lots'
  const [search, setSearch] = usePersistedState('inventory.search', '');
  const [categoryFilter, setCategoryFilter] = usePersistedState('inventory.categoryFilter', '');
  const [lowStockOnly,   setLowStockOnly]   = useState(false);

  const [items,      setItems]      = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const [modal,      setModal]      = useState(null);
  const [activeItem, setActiveItem] = useState(null);
  const [saving,     setSaving]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const token   = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const params  = new URLSearchParams();
      if (search)         params.append('search',    search);
      if (categoryFilter) params.append('category',  categoryFilter);
      if (lowStockOnly)   params.append('low_stock', 'true');

      const [inv, cats] = await Promise.all([
        fetch(`/api/inventory/?${params}`, { headers }).then(r => r.json()),
        fetch('/api/inventory/categories',  { headers }).then(r => r.json()),
      ]);
      setItems(Array.isArray(inv)  ? inv  : []);
      setCategories(Array.isArray(cats) ? cats : []);
    } catch (err) {
      setFetchError(err.message || 'Failed to load inventory');
    } finally {
      setLoading(false);
    }
  }, [search, categoryFilter, lowStockOnly]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(data) {
    setSaving(true);
    try {
      await createInventoryItem(data);
      toast(t('inventory.itemAdded'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleEdit(data) {
    setSaving(true);
    try {
      await updateInventoryItem(activeItem.id, data);
      toast(t('inventory.itemUpdated'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleArchive() {
    try {
      await archiveInventoryItem(activeItem.id);
      toast(t('inventory.itemDeleted'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  const allKnownCats = [...new Set([...categories, ...items.map(i => i.category).filter(Boolean)])].sort();
  const totalValue   = items.reduce((s, i) => s + (i.quantity * i.unit_cost), 0);
  const lowCount     = items.filter(i => i.min_stock > 0 && i.quantity <= i.min_stock).length;
  const hasFilters   = search || categoryFilter || lowStockOnly;

  const { sorted: pagedItems, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(items);

  const exportData = items.map(i => ({
    Name: i.name, Category: i.category || '', Type: i.product_type || '',
    Quantity: i.quantity, Reserved: i.reserved_quantity || 0, Unit: i.unit,
    'Min Stock': i.min_stock, 'Unit Cost (Landed)': i.unit_cost,
    'Total Value': fmtNum(i.quantity * i.unit_cost),
    Supplier: i.supplier || '',
    Status: i.min_stock > 0 && i.quantity <= i.min_stock ? 'Low Stock' : 'OK',
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('inventory.title')}</h1>
          <p className="page-subtitle">
            {t('inventory.totalItems', { count: items.length })} · {t('common.totalValue')}: ${fmtNum(totalValue)}
            {lowCount > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>· ⚠ {lowCount} {t('inventory.lowStock')}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`btn btn-sm ${view === 'items' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('items')}>{t('inventory.tabItems')}</button>
            <button className={`btn btn-sm ${view === 'lots' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('lots')}>{t('inventory.tabLots')}</button>
          </div>
          {view === 'items' && <ExportButton data={exportData} filename="Inventory" sheetName="Inventory" />}
          {view === 'items' && <button className="btn btn-primary" onClick={() => setModal('add')}>{t('inventory.addItem')}</button>}
        </div>
      </div>

      {view === 'lots' && <LotsBrowser />}

      {/* Filters */}
      {view === 'items' && <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input className="form-control" style={{ paddingLeft: 32, height: 34, fontSize: 13 }}
              placeholder={t('inventory.searchNameSupplier')}
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <select className="form-control" style={{ width: 180, height: 34, fontSize: 13 }}
            value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="">{t('inventory.allCategories')}</option>
            {allKnownCats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={lowStockOnly}
              onChange={e => setLowStockOnly(e.target.checked)} />
            {t('inventory.lowStockOnly')}
          </label>

          {hasFilters && (
            <button className="btn btn-sm btn-secondary"
              onClick={() => { setSearch(''); setCategoryFilter(''); setLowStockOnly(false); }}>
              {t('common.clear')}
            </button>
          )}
        </div>
      </div>}

      {/* Table */}
      {view === 'items' && <div className="card">
        {loading    ? <LoadingSpinner /> :
         fetchError ? <ErrorAlert message={fetchError} onRetry={load} /> :
         items.length === 0 ? (
          <EmptyState message={hasFilters
            ? t('inventory.noItemsFiltered')
            : t('inventory.noItemsYet')} />
         ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('inventory.itemName')} sortKey="name"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.category')}    sortKey="category"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('inventory.typeHeader')} sortKey="product_type" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('inventory.stockHeader')} sortKey="quantity" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('inventory.minStock')} sortKey="min_stock"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('inventory.unitCost')} sortKey="unit_cost"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('inventory.totalValueHeader')}</th>
                  <SortableTh label={t('common.supplier')}    sortKey="supplier"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedItems.map(item => {
                  const isLow = item.min_stock > 0 && item.quantity <= item.min_stock;
                  return (
                    <tr key={item.id}>
                      <td className="td-primary">
                        {item.name}
                        {isLow && <span className="badge badge-red" style={{ marginLeft: 6 }}>{t('inventory.lowStock')}</span>}
                      </td>
                      <td><CategoryBadge category={item.category} /></td>
                      <td><ProductTypeBadge type={item.product_type} /></td>
                      <td style={{ color: isLow ? 'var(--red)' : undefined, fontWeight: isLow ? 600 : undefined }}>
                        {item.quantity} {item.unit}
                        {item.reserved_quantity > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>
                            {t('inventory.reservedQty', { qty: item.reserved_quantity })}
                          </div>
                        )}
                      </td>
                      <td>{item.min_stock} {item.unit}</td>
                      <td>${fmtNum(item.unit_cost)}</td>
                      <td style={{ fontWeight: 600 }}>${fmtNum(item.quantity * item.unit_cost)}</td>
                      <td>{item.supplier || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-sm btn-secondary"
                            onClick={() => { setActiveItem(item); setModal('stock'); }}>{t('inventory.adjustStock')}</button>
                          <button className="btn btn-sm btn-secondary"
                            onClick={() => { setActiveItem(item); setModal('history'); }}>{t('common.history')}</button>
                          <button className="btn btn-sm btn-secondary"
                            onClick={() => { setActiveItem(item); setModal('edit'); }}>{t('common.edit')}</button>
                          <button className="btn btn-sm btn-danger"
                            onClick={() => { setActiveItem(item); setModal('delete'); }}>Archive</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={items.length} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>}

      {modal === 'add' && (
        <Modal title={t('inventory.addInventoryItem')} onClose={() => setModal(null)}>
          <ItemForm knownCategories={allKnownCats} onSave={handleAdd} onCancel={() => setModal(null)} saving={saving} />
        </Modal>
      )}
      {modal === 'edit' && activeItem && (
        <Modal title={t('inventory.editItemTitle')} onClose={() => setModal(null)}>
          <ItemForm initial={activeItem} knownCategories={allKnownCats} onSave={handleEdit} onCancel={() => setModal(null)} saving={saving} />
        </Modal>
      )}
      {modal === 'stock' && activeItem && (
        <Modal title={t('inventory.adjustStockTitle', { name: activeItem.name })} onClose={() => setModal(null)}>
          <StockForm item={activeItem} onDone={() => { setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal === 'history' && activeItem && (
        <MovementsModal item={activeItem} onClose={() => setModal(null)} />
      )}
      {modal === 'delete' && activeItem && (
        <ConfirmModal
          title="Archive Item"
          message={`Archive "${activeItem.name}"? It will be hidden from inventory but can be restored from Archives. Note: items with stock > 0 cannot be archived.`}
          confirmLabel="Archive"
          confirmClass="btn-danger"
          onConfirm={handleArchive}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
