import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useEffect, useCallback } from 'react';
import {
  createInventoryItem, updateInventoryItem,
  archiveInventoryItem, unarchiveInventoryItem, updateStock, getStockMovements,
  getLots, getLot, getInventoryByWarehouse, getSuppliers,
  getAttributeDefs, createProduct,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, toast, SortableTh, Pagination, NumberInput, SupplierCombobox,
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { useWarehouses } from '../hooks/useWarehouses';
import { useFocusId } from '../hooks/useFocusId';
import ImportWizard from '../components/ImportWizard';

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

function ItemForm({ initial = {}, knownCategories = [], suppliers = [], onSave, onCancel, saving }) {
  const { t } = useLocale();
  const { exchangeRate } = useSettings();
  const rate = Number(exchangeRate?.rate) || 0;
  const hasRate = rate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
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
    // Cost is always stored in USD, so editing always starts in USD even if it
    // was originally typed in LBP. Sale price keeps its native currency.
    cost_currency:  'USD',
    sale_price:     initial.sale_price ?? 0,
    price_currency: (initial.price_currency || 'USD'),
    supplier:       initial.supplier   || '',
    unit:           initial.unit       || 'pcs',
    barcode:        initial.barcode    || '',
    lot_tracked:    !!initial.lot_tracked,
    shelf_life_days: initial.shelf_life_days ?? '',
  });

  const useCustom = form.category === '__custom__';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Live equivalent in the *other* currency for a field entered in `cur`.
  function equiv(value, cur) {
    if (!hasRate || !value) return null;
    const n = Number(value) || 0;
    return cur === 'LBP'
      ? `≈ $${fmtNum(n / rate)}`
      : `≈ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n * rate)} ${secondary}`;
  }

  function submit(e) {
    e.preventDefault();
    const category = useCustom ? form.customCategory.trim() : form.category.trim();
    onSave({
      ...form, category: category || null, product_type: form.product_type || null,
      lot_tracked: !!form.lot_tracked,
      // Cost typed in LBP converts to USD server-side at this rate.
      exchange_rate: form.cost_currency === 'LBP' ? rate : undefined,
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
              <NumberInput className="form-control" step="1" min="0"
                value={form.quantity} onChange={e => set('quantity', e.target.value)} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('inventory.minStockAlert')}</label>
            <NumberInput className="form-control" step="1" min="0"
              value={form.min_stock} onChange={e => set('min_stock', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.unitCostLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
              <select className="form-control" style={{ width: 86 }}
                value={form.cost_currency} onChange={e => set('cost_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.cost_currency === 'USD'
              ? null
              : <div className="form-help" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                  {t('inventory.costLockedToUsd')} {equiv(form.unit_cost, form.cost_currency)}
                </div>}
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
              <select className="form-control" style={{ width: 86 }}
                value={form.price_currency} onChange={e => set('price_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {equiv(form.sale_price, form.price_currency) && (
              <div className="form-help" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {form.price_currency === 'USD'
                  ? equiv(form.sale_price, 'USD')
                  : `${t('inventory.salePriceFloatsHint')} ${equiv(form.sale_price, form.price_currency)}`}
              </div>
            )}
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
            <SupplierCombobox
              value={form.supplier}
              suppliers={suppliers}
              onChange={v => set('supplier', v)} />
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
                <NumberInput className="form-control" min="0" step="1"
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
  const [warehouseId, setWarehouseId] = useState('');
  const [perWarehouse, setPerWarehouse] = useState([]);
  // Adjustments are warehouse-specific — show the per-warehouse breakdown
  // alongside the form so the operator can see what's where before adjusting.
  const { warehouses, defaultId } = useWarehouses();
  useEffect(() => {
    if (defaultId && !warehouseId) setWarehouseId(defaultId);
  }, [defaultId, warehouseId]);
  useEffect(() => {
    getInventoryByWarehouse(item.id)
      .then(setPerWarehouse)
      .catch(() => setPerWarehouse([]));
  }, [item.id]);

  const selectedWh = perWarehouse.find(p => p.warehouse_id === Number(warehouseId));

  async function submit(e) {
    e.preventDefault();
    const d = parseFloat(delta);
    if (isNaN(d) || d === 0) { toast(t('inventory.nonZeroQty'), 'red'); return; }
    setSaving(true);
    try {
      await updateStock(item.id, {
        delta: d, type, note,
        warehouse_id: warehouseId ? Number(warehouseId) : null,
      });
      toast(t('inventory.stockUpdated'));
      onDone();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="alert alert-yellow" style={{ marginBottom: 16 }}>
          {t('inventory.currentStock')} <strong>{item.quantity} {item.unit}</strong> {t('warehouses.breakdownTotal')}
          {perWarehouse.length > 0 && (
            <span style={{ color: 'var(--text-3)', fontSize: 12, marginInlineStart: 8 }}>
              · {perWarehouse.filter(p => p.quantity > 0).map(p => `${p.code} ${p.quantity}`).join(' · ') || t('warehouses.breakdownNone')}
            </span>
          )}
        </div>
        <div className="form-grid">
          {warehouses.length > 0 && (
            <div className="form-group form-full">
              <label className="form-label">{t('warehouses.field')}</label>
              <select className="form-control" value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}>
                {warehouses.map(w => {
                  const onHand = perWarehouse.find(p => p.warehouse_id === w.id)?.quantity ?? 0;
                  return (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name} ({onHand}{t('warehouses.onHandSuffix')})
                    </option>
                  );
                })}
              </select>
              {selectedWh && (
                <small style={{ color: 'var(--text-3)' }}>
                  {t('warehouses.adjustHint', { code: selectedWh.code })}
                </small>
              )}
            </div>
          )}
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.qtyChange')}</label>
            <NumberInput className="form-control" step="1" required
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

// ── Product + variant builder ──────────────────────────────────────────────
// Creates a parent product and the cross-product of its variant axes (Size ×
// Color …). Each combination becomes its own inventory SKU on the server.
function ProductBuilder({ knownCategories = [], onSave, onCancel, saving }) {
  const { t } = useLocale();
  const { settings, exchangeRate } = useSettings();
  const rate = Number(exchangeRate?.rate) || 0;
  const hasRate = rate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
  const businessType = settings?.business_type || '';
  const allCats = [...new Set([...knownCategories, ...DEFAULT_CATEGORIES])];

  const [defs, setDefs] = useState([]);
  const [form, setForm] = useState({
    name: '', category: '', brand: '', barcode_prefix: '',
    unit: 'pcs', unit_cost: 0, cost_currency: 'USD',
    sale_price: 0, price_currency: 'USD', min_stock: 0,
  });
  // axisSel[name] = Set of chosen values; descriptors[name] = string
  const [axisSel, setAxisSel] = useState({});
  const [descriptors, setDescriptors] = useState({});
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    // Pull both the business-type presets and any global attributes.
    Promise.all([
      businessType ? getAttributeDefs({ scope_type: 'business', scope_value: businessType }) : Promise.resolve([]),
      getAttributeDefs({ scope_type: 'global' }),
    ]).then(([a, b]) => setDefs([...(a || []), ...(b || [])])).catch(() => setDefs([]));
  }, [businessType]);

  const axes = defs.filter(d => d.is_variant_axis);
  const descs = defs.filter(d => !d.is_variant_axis);

  function toggleAxis(name, val) {
    setAxisSel(s => {
      const next = new Set(s[name] || []);
      next.has(val) ? next.delete(val) : next.add(val);
      return { ...s, [name]: next };
    });
  }

  // Live preview: how many variants will be generated.
  const chosenAxes = axes
    .map(a => ({ name: a.name, values: [...(axisSel[a.name] || [])] }))
    .filter(a => a.values.length > 0);
  const variantCount = chosenAxes.reduce((n, a) => n * a.values.length, chosenAxes.length ? 1 : 1);

  function equiv(value, cur) {
    if (!hasRate || !value) return null;
    const n = Number(value) || 0;
    return cur === 'LBP' ? `≈ $${fmtNum(n / rate)}`
      : `≈ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n * rate)} ${secondary}`;
  }

  function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('inventory.productNameRequired'), 'red'); return; }
    const cleanDesc = {};
    descs.forEach(d => { if (descriptors[d.name]) cleanDesc[d.name] = descriptors[d.name]; });
    if (form.brand) cleanDesc.Brand = form.brand;
    onSave({
      name: form.name.trim(), category: form.category || null, brand: form.brand || null,
      barcode_prefix: form.barcode_prefix || null, unit: form.unit,
      min_stock: Number(form.min_stock) || 0,
      unit_cost: Number(form.unit_cost) || 0, cost_currency: form.cost_currency,
      exchange_rate: form.cost_currency === 'LBP' ? rate : undefined,
      sale_price: Number(form.sale_price) || 0, price_currency: form.price_currency,
      axes: chosenAxes, descriptors: cleanDesc,
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        {!businessType && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
            {t('inventory.noBusinessTypeHint')}
          </div>
        )}
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.productNameLabel')}</label>
            <input className="form-control" required value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.category')}</label>
            <select className="form-control" value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">{t('inventory.noCategory')}</option>
              {allCats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.brandLabel')}</label>
            <input className="form-control" value={form.brand} onChange={e => set('brand', e.target.value)} />
          </div>
        </div>

        {/* Variant axes */}
        {axes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="form-label" style={{ marginBottom: 6 }}>{t('inventory.variantOptionsLabel')}</div>
            {axes.map(a => (
              <div key={a.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{a.name}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(a.options || []).map(opt => {
                    const on = (axisSel[a.name] || new Set()).has(opt);
                    return (
                      <button type="button" key={opt} onClick={() => toggleAxis(a.name, opt)}
                        className={`btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`}>
                        {opt}
                      </button>
                    );
                  })}
                  {(!a.options || a.options.length === 0) && (
                    <input className="form-control" style={{ height: 30, fontSize: 12 }}
                      placeholder={t('inventory.commaSeparatedValues')}
                      onBlur={e => {
                        const vals = e.target.value.split(',').map(v => v.trim()).filter(Boolean);
                        setAxisSel(s => ({ ...s, [a.name]: new Set(vals) }));
                      }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Descriptors (non-varying) */}
        {descs.length > 0 && (
          <div className="form-grid" style={{ marginTop: 8 }}>
            {descs.map(d => (
              <div key={d.id} className="form-group">
                <label className="form-label">{d.name}</label>
                <input className="form-control" value={descriptors[d.name] || ''}
                  onChange={e => setDescriptors(s => ({ ...s, [d.name]: e.target.value }))} />
              </div>
            ))}
          </div>
        )}

        {/* Base price/cost — inherited by every variant */}
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="form-group">
            <label className="form-label">{t('inventory.unitCostLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
              <select className="form-control" style={{ width: 80 }} value={form.cost_currency}
                onChange={e => set('cost_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.cost_currency === 'LBP' && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('inventory.costLockedToUsd')} {equiv(form.unit_cost, 'LBP')}</div>}
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
              <select className="form-control" style={{ width: 80 }} value={form.price_currency}
                onChange={e => set('price_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.price_currency === 'LBP' && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('inventory.salePriceFloatsHint')} {equiv(form.sale_price, 'LBP')}</div>}
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.barcodePrefixLabel')}</label>
            <input className="form-control" value={form.barcode_prefix}
              onChange={e => set('barcode_prefix', e.target.value)} placeholder="e.g. TSHIRT-" />
          </div>
        </div>
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {t('inventory.variantsToCreate', { count: variantCount })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('inventory.createProductBtn')}
          </button>
        </div>
      </div>
    </form>
  );
}

export default function Inventory() {
  const { t } = useLocale();
  const [view, setView] = useState('items');   // 'items' | 'lots'
  const [search, setSearch] = usePersistedState('inventory.search', '');
  const [categoryFilter, setCategoryFilter] = usePersistedState('inventory.categoryFilter', '');
  const [lowStockOnly,   setLowStockOnly]   = useState(false);
  const [showArchived,   setShowArchived]   = usePersistedState('inventory.showArchived', false);

  const [items,      setItems]      = useState([]);
  const [categories, setCategories] = useState([]);
  const [suppliers,  setSuppliers]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState(null);

  // Suppliers power the item form's search-select; load once (filter-independent).
  useEffect(() => {
    getSuppliers().then(s => setSuppliers(Array.isArray(s) ? s : [])).catch(() => {});
  }, []);

  const [modal,      setModal]      = useState(null);
  const [importing,  setImporting]  = useState(false);
  const [activeItem, setActiveItem] = useState(null);
  const [saving,     setSaving]     = useState(false);
  // Product ids the user has collapsed in the list (variants expanded by default).
  const [collapsed,  setCollapsed]  = useState(() => new Set());
  const toggleCollapsed = (pid) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(pid) ? next.delete(pid) : next.add(pid);
    return next;
  });

  // Global-search deep link (?focus=<id>) → open that item's edit modal.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId != null && items?.length) {
      const it = items.find(x => x.id === focusId);
      if (it) { setView('items'); setActiveItem(it); setModal('edit'); clearFocus(); }
    }
  }, [focusId, items]);   // eslint-disable-line react-hooks/exhaustive-deps

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
      if (showArchived)   params.append('include_archived', '1');

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
  }, [search, categoryFilter, lowStockOnly, showArchived]);

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

  async function handleAddProduct(data) {
    setSaving(true);
    try {
      const res = await createProduct(data);
      toast(t('inventory.productCreated', { count: res.variant_count }));
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

  async function handleUnarchive() {
    try {
      await unarchiveInventoryItem(activeItem.id);
      toast(t('inventory.itemRestored'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  const allKnownCats = [...new Set([...categories, ...items.map(i => i.category).filter(Boolean)])].sort();
  const totalValue   = items.reduce((s, i) => s + (i.quantity * i.unit_cost), 0);
  const lowCount     = items.filter(i => i.min_stock > 0 && i.quantity <= i.min_stock).length;
  const hasFilters   = search || categoryFilter || lowStockOnly;

  const { sorted: pagedItems, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(items);

  // Per-product roll-up (across ALL variants, not just the current page) so a
  // product header can show its variant count, total stock and total value.
  const productAgg = (() => {
    const m = new Map();
    for (const it of items) {
      if (it.product_id == null) continue;
      const a = m.get(it.product_id) || { name: it.product_name || it.name, count: 0, stock: 0, value: 0 };
      a.count += 1;
      a.stock += Number(it.quantity) || 0;
      a.value += (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0);
      if (it.product_name) a.name = it.product_name;
      m.set(it.product_id, a);
    }
    return m;
  })();

  function renderItemRow(item, indent = false) {
    const isLow = item.min_stock > 0 && item.quantity <= item.min_stock;
    const isArchived = !!item.archived_at;
    // For a variant, show its short label ("M / Red") rather than the long
    // "Product — M / Red" name, since the product header already names it.
    const display = indent && item.variant_label ? item.variant_label : item.name;
    return (
      <tr key={item.id} className={isArchived ? 'row-archived' : undefined}>
        <td className="td-primary" style={indent ? { paddingInlineStart: 28 } : undefined}>
          {display}
          {isLow && !isArchived && <span className="badge badge-red" style={{ marginLeft: 6 }}>{t('inventory.lowStock')}</span>}
          {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
          {item.attributes && Object.keys(item.attributes).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
              {Object.entries(item.attributes).map(([k, v]) => (
                <span key={k} className="badge badge-accent" style={{ fontSize: 10 }}>{k}: {v}</span>
              ))}
            </div>
          )}
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
            {isArchived ? (
              <button className="btn btn-sm btn-secondary" style={{ color: '#166534', whiteSpace: 'nowrap' }}
                onClick={() => { setActiveItem(item); setModal('restore'); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
            ) : (
              <>
                <button className="btn btn-sm btn-secondary"
                  onClick={() => { setActiveItem(item); setModal('stock'); }}>{t('inventory.adjustStock')}</button>
                <button className="btn btn-sm btn-secondary"
                  onClick={() => { setActiveItem(item); setModal('history'); }}>{t('common.history')}</button>
                <button className="btn btn-sm btn-secondary"
                  onClick={() => { setActiveItem(item); setModal('edit'); }}>{t('common.edit')}</button>
                <button className="btn btn-sm btn-danger"
                  onClick={() => { setActiveItem(item); setModal('delete'); }}>{t('common.archive')}</button>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  const exportData = items.map(i => ({
    Name: i.name, Category: i.category || '', Type: i.product_type || '',
    Quantity: i.quantity, Reserved: i.reserved_quantity || 0, Unit: i.unit,
    'Min Stock': i.min_stock, 'Unit Cost (Landed, USD)': i.unit_cost,
    'Sale Price': i.sale_price || 0,
    'Price Currency': i.price_currency || 'USD',
    'Total Value': fmtNum(i.quantity * i.unit_cost),
    Barcode: i.barcode || '',
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
          {view === 'items' && <button className="btn btn-secondary" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>}
          {view === 'items' && <button className="btn btn-secondary" onClick={() => setModal('product')}>{t('inventory.newProductBtn')}</button>}
          {view === 'items' && <button className="btn btn-primary" onClick={() => setModal('add')}>{t('inventory.addItem')}</button>}
        </div>
      </div>

      {importing && (
        <ImportWizard entity="inventory" title={`${t('imports.importBtn')} — ${t('inventory.title')}`}
          onClose={() => setImporting(false)} onDone={load} />
      )}

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

          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
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
                {(() => {
                  // Group contiguous variants of the same product under a
                  // collapsible header row. Standalone items render flat.
                  const rows = [];
                  let prevPid;
                  pagedItems.forEach(item => {
                    const pid = item.product_id;
                    if (pid != null && pid !== prevPid) {
                      const agg = productAgg.get(pid) || { name: item.product_name || item.name, count: 0, stock: 0, value: 0 };
                      const isOpen = !collapsed.has(pid);
                      rows.push(
                        <tr key={`ph-${pid}`} style={{ background: 'var(--bg-2, var(--bg))', cursor: 'pointer' }}
                          onClick={() => toggleCollapsed(pid)}>
                          <td className="td-primary" colSpan={3}>
                            <span style={{ display: 'inline-block', width: 12, transition: 'transform .15s',
                              transform: isOpen ? 'rotate(90deg)' : 'none' }}>▸</span>
                            {' '}<strong>{agg.name}</strong>
                            <span className="badge badge-accent" style={{ marginInlineStart: 8, fontSize: 10 }}>
                              {t('inventory.variantCountBadge', { count: agg.count })}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600 }}>{agg.stock}</td>
                          <td />
                          <td />
                          <td style={{ fontWeight: 600 }}>${fmtNum(agg.value)}</td>
                          <td />
                          <td />
                        </tr>
                      );
                    }
                    prevPid = pid;
                    if (pid != null && collapsed.has(pid)) return;  // hidden when collapsed
                    rows.push(renderItemRow(item, pid != null));
                  });
                  return rows;
                })()}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={items.length} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>}

      {modal === 'add' && (
        <Modal title={t('inventory.addInventoryItem')} onClose={() => setModal(null)}>
          <ItemForm knownCategories={allKnownCats} suppliers={suppliers} onSave={handleAdd} onCancel={() => setModal(null)} saving={saving} />
        </Modal>
      )}
      {modal === 'product' && (
        <Modal title={t('inventory.newProductTitle')} onClose={() => setModal(null)} size="lg">
          <ProductBuilder knownCategories={allKnownCats} onSave={handleAddProduct} onCancel={() => setModal(null)} saving={saving} />
        </Modal>
      )}
      {modal === 'edit' && activeItem && (
        <Modal title={t('inventory.editItemTitle')} onClose={() => setModal(null)}>
          <ItemForm initial={activeItem} knownCategories={allKnownCats} suppliers={suppliers} onSave={handleEdit} onCancel={() => setModal(null)} saving={saving} />
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
          title={t('inventory.archiveItemTitle')}
          message={t('inventory.archiveItemConfirm', { name: activeItem.name })}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={handleArchive}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === 'restore' && activeItem && (
        <ConfirmModal
          message={t('common.restoreConfirm')}
          confirmLabel={t('common.restore')}
          onConfirm={handleUnarchive}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
