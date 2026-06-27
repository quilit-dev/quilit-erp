import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getPurchases, getPurchaseStats, createPurchase, createBulkPurchase,
  updatePurchase, updatePurchaseStatus, archivePurchase, unarchivePurchase,
  getInventory, getCategories, getSuppliers, getProducts, getProduct,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination, NumberInput, SupplierCombobox,
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { usePermissions } from '../hooks/usePermissions';
import { useWarehouses } from '../hooks/useWarehouses';
import { useFocusId } from '../hooks/useFocusId';
import Attachments from '../components/Attachments.jsx';

const PURCHASE_CATEGORIES = [
  'Equipment', 'Materials', 'Safety', 'Tools', 'Consumables', 'Other'
];

const fmtNum = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Purchase form ────────────────────────────────────────────────────────────

function PurchaseForm({ initial = {}, inventoryItems = [], inventoryCategories = [], suppliers = [], onSave, onCancel, saving }) {
  const { t, tStatus, tCategory } = useLocale();
  const { settings, taxRates, exchangeRate } = useSettings();
  const fxRate = Number(exchangeRate?.rate) || 0;
  const hasRate = fxRate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
  const isEdit = !!initial.id;

  const taxEnabled     = settings?.tax_enabled === '1';
  const activeTaxRates = (taxRates || []).filter(r => r.is_active);
  const defaultTaxRate = (taxRates || []).find(r => r.is_default) || null;

  const allCats = [...new Set([...inventoryCategories, ...PURCHASE_CATEGORIES])].sort();

  // Warehouse selector — the receipt will land here when the PO transitions
  // to 'Received'. Defaults to the user's default warehouse so existing
  // workflows don't change.
  const { warehouses, defaultId: defaultWarehouseId } = useWarehouses();

  const [form, setForm] = useState({
    supplier:         initial.supplier         || '',
    product_name:     initial.product_name     || '',
    category:         initial.category         || '',
    customCategory:   '',
    inventory_id:     initial.inventory_id     || '',
    quantity:         initial.quantity         || '',
    unit_cost:        initial.unit_cost        || '',
    // Cost may be typed in LBP; it converts to USD on the server at save. Edits
    // always start in USD (the stored PO cost is already USD).
    cost_currency:    'USD',
    additional_costs: initial.additional_costs || 0,
    tax_rate_id:      initial.tax_rate_id      ?? null,
    status:           initial.status           || 'Ordered',
    notes:            initial.notes            || '',
    warehouse_id:     initial.warehouse_id     ?? '',
  });

  // Pre-select the resolved default warehouse once it arrives, but only if
  // the operator hasn't already chosen one. Lets the user override.
  useEffect(() => {
    if (defaultWarehouseId && !form.warehouse_id) {
      setForm(f => ({ ...f, warehouse_id: defaultWarehouseId }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultWarehouseId]);

  const useCustom = form.category === '__custom__';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function handleInventorySelect(e) {
    const id = e.target.value;
    set('inventory_id', id);
    if (id) {
      const item = inventoryItems.find(i => String(i.id) === String(id));
      if (item) {
        if (item.name)       set('product_name', item.name);
        if (item.category)   set('category',     item.category);
        if (item.unit_price) set('unit_cost',     item.unit_price);
      }
    }
  }

  function submit(e) {
    e.preventDefault();
    const category = useCustom ? form.customCategory.trim() : form.category.trim();
    onSave({
      supplier:         form.supplier,
      product_name:     form.product_name,
      category:         category || 'Other',
      inventory_id:     form.inventory_id ? parseInt(form.inventory_id) : null,
      quantity:         parseFloat(form.quantity),
      unit_cost:        parseFloat(form.unit_cost)        || 0,
      additional_costs: parseFloat(form.additional_costs) || 0,
      cost_currency:    form.cost_currency,
      exchange_rate:    form.cost_currency === 'LBP' ? fxRate : undefined,
      tax_rate_id:      taxEnabled ? (form.tax_rate_id ?? null) : null,
      status:           form.status,
      notes:            form.notes,
      warehouse_id:     form.warehouse_id ? parseInt(form.warehouse_id) : null,
    });
  }

  const goods   = (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_cost) || 0);
  const selRate = taxEnabled
    ? ((taxRates || []).find(r => r.id === form.tax_rate_id) || defaultTaxRate)
    : null;
  const taxAmt  = selRate ? goods * (Number(selRate.rate) || 0) / 100 : 0;
  const total   = goods + (parseFloat(form.additional_costs) || 0) + taxAmt;

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('purchases.supplierLabel')}</label>
            <SupplierCombobox
              value={form.supplier}
              suppliers={suppliers}
              required
              onChange={v => set('supplier', v)}
            />
          </div>

          {warehouses.length > 0 && (
            <div className="form-group form-full">
              <label className="form-label">{t('warehouses.receiveAt')}</label>
              <select className="form-control"
                value={form.warehouse_id}
                onChange={e => set('warehouse_id', e.target.value)}>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}{w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!isEdit && (
            <div className="form-group form-full">
              <label className="form-label">{t('purchases.linkInventory')}</label>
              <select className="form-control" value={form.inventory_id} onChange={handleInventorySelect}>
                <option value="">{t('purchases.newNotLinked')}</option>
                {(() => {
                  // Group variant SKUs under their product so the list isn't a
                  // flat wall of "iPhone 15 — 256GB/Black" rows.
                  const groups = new Map();   // product_name -> variants
                  const loose = [];
                  inventoryItems.forEach(i => {
                    if (i.product_id) {
                      const k = i.product_name || i.name;
                      (groups.get(k) || groups.set(k, []).get(k)).push(i);
                    } else loose.push(i);
                  });
                  return [
                    ...[...groups.entries()].map(([name, vs]) => (
                      <optgroup key={`g-${name}`} label={name}>
                        {vs.map(i => (
                          <option key={i.id} value={i.id}>{i.variant_label || i.name}</option>
                        ))}
                      </optgroup>
                    )),
                    ...loose.map(i => (
                      <option key={i.id} value={i.id}>{i.name}{i.category ? ` (${i.category})` : ''}</option>
                    )),
                  ];
                })()}
              </select>
            </div>
          )}

          <div className="form-group form-full">
            <label className="form-label">{t('purchases.productNameLabel')}</label>
            <input className="form-control" required value={form.product_name}
              onChange={e => set('product_name', e.target.value)} />
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('common.category')}</label>
            <select className="form-control" value={form.category}
              onChange={e => set('category', e.target.value)}>
              <option value="">{t('purchases.selectCategory')}</option>
              {allCats.map(c => <option key={c} value={c}>{tCategory(c)}</option>)}
              <option value="__custom__">{t('purchases.addCategoryOption')}</option>
            </select>
            {useCustom && (
              <input className="form-control" style={{ marginTop: 8 }}
                placeholder={t('purchases.typeCategoryName')}
                value={form.customCategory}
                onChange={e => set('customCategory', e.target.value)} />
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.quantityLabel')}</label>
            <NumberInput className="form-control" step="1" min="1" required
              value={form.quantity} onChange={e => set('quantity', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.unitCostDollar')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
              <select className="form-control" style={{ width: 86 }}
                value={form.cost_currency} onChange={e => set('cost_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.cost_currency === 'LBP' && hasRate && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {t('inventory.costLockedToUsd')} ≈ ${fmtNum((parseFloat(form.unit_cost) || 0) / fxRate)}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.additionalCostsDollar')}</label>
            <NumberInput className="form-control" step="any" min="0"
              value={form.additional_costs} onChange={e => set('additional_costs', e.target.value)} />
          </div>

          {taxEnabled && (
            <div className="form-group">
              <label className="form-label">{t('common.taxCol')}</label>
              <select className="form-control"
                value={form.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                onChange={e => set('tax_rate_id', Number(e.target.value) || null)}>
                {activeTaxRates.map(r => (
                  <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                ))}
              </select>
            </div>
          )}

          {!isEdit && (
            <div className="form-group">
              <label className="form-label">{t('purchases.statusLabel')}</label>
              <select className="form-control" value={form.status}
                onChange={e => set('status', e.target.value)}>
                <option value="Ordered">{tStatus('Ordered')}</option>
                <option value="Received">{tStatus('Received')}</option>
                <option value="Paid">{tStatus('Paid')}</option>
              </select>
            </div>
          )}

          {total > 0 && (
            <div className="form-group form-full">
              <div className="alert alert-green" style={{ marginBottom: 0 }}>
                {t('purchases.totalLabel')} <strong>{fmt(total)}</strong>
              </div>
            </div>
          )}

          <div className="form-group form-full">
            <label className="form-label">{t('purchases.notesLabel')}</label>
            <textarea className="form-control" rows={2} value={form.notes}
              onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : isEdit ? t('common.save') : t('purchases.createPurchase')}
        </button>
      </div>
    </form>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const { tStatus } = useLocale();
  const map = { Ordered: 'yellow', Received: 'green', Paid: 'blue' };
  return <span className={`badge badge-${map[status] || 'gray'}`}>{tStatus(status)}</span>;
}

// ── Main page ────────────────────────────────────────────────────────────────

// ── Order Variants — raise one PO per variant of a product in a single grid ──
function OrderVariantsModal({ suppliers = [], onDone, onCancel }) {
  const { t } = useLocale();
  const { warehouses, defaultId } = useWarehouses();
  const { exchangeRate } = useSettings();
  const fxRate = Number(exchangeRate?.rate) || 0;
  const hasRate = fxRate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';

  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [variants, setVariants] = useState([]);   // [{id, variant_label, quantity, unit_cost, _qty, _cost}]
  const [supplier, setSupplier] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [costCurrency, setCostCurrency] = useState('USD');
  const [status, setStatus] = useState('Ordered');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProducts().then(p => setProducts(Array.isArray(p) ? p : [])).catch(() => setProducts([]));
  }, []);
  useEffect(() => { if (defaultId) setWarehouseId(String(defaultId)); }, [defaultId]);

  async function pickProduct(id) {
    setProductId(id);
    setVariants([]);
    if (!id) return;
    try {
      const p = await getProduct(id);
      setVariants((p.variants || []).map(v => ({
        ...v, _qty: '', _cost: v.unit_cost ?? 0,
      })));
    } catch (err) { toast(err.message, 'red'); }
  }

  const setRow = (id, k, val) => setVariants(vs => vs.map(v => v.id === id ? { ...v, [k]: val } : v));
  const lines = variants.filter(v => Number(v._qty) > 0);
  const totalQty = lines.reduce((s, v) => s + (Number(v._qty) || 0), 0);

  async function submit() {
    if (!supplier.trim()) { toast(t('purchases.supplierRequired'), 'red'); return; }
    if (lines.length === 0) { toast(t('purchases.addQtyToVariant'), 'red'); return; }
    setSaving(true);
    try {
      const res = await createBulkPurchase({
        supplier: supplier.trim(),
        warehouse_id: warehouseId ? Number(warehouseId) : null,
        cost_currency: costCurrency,
        exchange_rate: costCurrency === 'LBP' ? fxRate : undefined,
        status,
        lines: lines.map(v => ({
          inventory_id: v.id,
          quantity: Number(v._qty) || 0,
          unit_cost: Number(v._cost) || 0,
        })),
      });
      toast(t('purchases.bulkCreated', { count: res.created }));
      onDone();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('purchases.supplierLabel')}</label>
            <SupplierCombobox value={supplier} suppliers={suppliers} onChange={setSupplier} required />
          </div>
          <div className="form-group">
            <label className="form-label">{t('purchases.productLabel')}</label>
            <select className="form-control" value={productId} onChange={e => pickProduct(e.target.value)}>
              <option value="">{t('purchases.selectProduct')}</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({t('inventory.variantCountBadge', { count: p.variant_count })})</option>
              ))}
            </select>
          </div>
          {warehouses.length > 0 && (
            <div className="form-group">
              <label className="form-label">{t('warehouses.receiveAt')}</label>
              <select className="form-control" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('purchases.costCurrency')}</label>
            <select className="form-control" value={costCurrency} onChange={e => setCostCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value={secondary} disabled={!hasRate}>{secondary}</option>
            </select>
          </div>
        </div>

        {productId && variants.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '12px 0' }}>{t('purchases.noVariantsForProduct')}</div>
        )}
        {variants.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: '45vh', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t('purchases.variant')}</th>
                  <th>{t('inventory.stockHeader')}</th>
                  <th style={{ width: 110 }}>{t('purchases.quantityLabel')}</th>
                  <th style={{ width: 150 }}>{t('purchases.unitCost')} ({costCurrency})</th>
                </tr>
              </thead>
              <tbody>
                {variants.map(v => (
                  <tr key={v.id}>
                    <td className="td-primary">{v.variant_label || v.name}</td>
                    <td>{v.quantity} {v.unit}</td>
                    <td>
                      <NumberInput className="form-control" step="1" min="0" placeholder="0"
                        value={v._qty} onChange={e => setRow(v.id, '_qty', e.target.value)} />
                    </td>
                    <td>
                      <NumberInput className="form-control" step="any" min="0"
                        value={v._cost} onChange={e => setRow(v.id, '_cost', e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {t('purchases.bulkSummary', { lines: lines.length, qty: totalQty })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={saving || lines.length === 0} onClick={submit}>
            {saving ? t('common.saving') : t('purchases.createOrders')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Purchases() {
  const { t, tStatus, tCategory } = useLocale();
  const { can } = usePermissions();
  const [purchases,           setPurchases]           = useState([]);
  const [stats,               setStats]               = useState({});
  const [inventoryItems,      setInventoryItems]      = useState([]);
  const [inventoryCategories, setInventoryCategories] = useState([]);
  const [supplierList,        setSupplierList]        = useState([]);
  const [loading,             setLoading]             = useState(true);
  const [fetchError,          setFetchError]          = useState(null);

  const [statusFilter, setStatusFilter] = usePersistedState('purchases.statusFilter', '');
  const [categoryFilter, setCategoryFilter] = usePersistedState('purchases.categoryFilter', '');
  const [supplierSearch, setSupplierSearch] = usePersistedState('purchases.supplierSearch', '');
  const [showArchived, setShowArchived] = usePersistedState('purchases.showArchived', false);
  const [restoreTarget, setRestoreTarget] = useState(null);

  const [modal,          setModal]          = useState(null);
  const [activePurchase, setActivePurchase] = useState(null);
  const [saving,         setSaving]         = useState(false);

  // Global-search deep link (?focus=<id>) → open that purchase order.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId != null && purchases?.length) {
      const p = purchases.find(x => x.id === focusId);
      if (p) { setActivePurchase(p); setModal('edit'); clearFocus(); }
    }
  }, [focusId, purchases]);   // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const qs = new URLSearchParams({
        ...(statusFilter   ? { status:   statusFilter   } : {}),
        ...(supplierSearch ? { supplier: supplierSearch } : {}),
        ...(showArchived   ? { include_archived: '1' }    : {}),
      }).toString();
      const [purch, st, cats] = await Promise.all([
        getPurchases(qs ? `?${qs}` : ''),
        getPurchaseStats(),
        getCategories(),
      ]);
      setPurchases(Array.isArray(purch) ? purch : []);
      setStats(st || {});
      setInventoryCategories(Array.isArray(cats) ? cats : []);

      getSuppliers().then(sups => setSupplierList(Array.isArray(sups) ? sups : [])).catch(() => {});
      getInventory().then(inv => setInventoryItems(Array.isArray(inv) ? inv : [])).catch(() => {});
    } catch (err) {
      setFetchError(err.message || 'Failed to load purchases');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, supplierSearch, showArchived]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(data) {
    setSaving(true);
    try {
      const result = await createPurchase(data);
      toast(t('purchases.poCreated', { po: result.po_number }));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleEdit(data) {
    setSaving(true);
    try {
      await updatePurchase(activePurchase.id, data);
      toast(t('purchases.purchaseUpdatedMsg'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleStatus(purchase, newStatus) {
    try {
      await updatePurchaseStatus(purchase.id, newStatus);
      toast(t('purchases.markedAs', { status: tStatus(newStatus) }));
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleDelete() {
    try {
      await archivePurchase(activePurchase.id);
      toast(t('purchases.purchaseDeletedMsg'));
      setModal(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleUnarchive() {
    try {
      await unarchivePurchase(restoreTarget.id);
      toast(t('purchases.purchaseRestored'));
      setRestoreTarget(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  const filtered = categoryFilter
    ? purchases.filter(p => p.category === categoryFilter)
    : purchases;

  const purchaseCategories = [...new Set(purchases.map(p => p.category).filter(Boolean))].sort();
  const hasFilters = statusFilter || categoryFilter || supplierSearch;

  const { sorted: pagedPurchases, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  const exportData = filtered.map(p => ({
    'PO Number':       p.po_number,
    Supplier:          p.supplier,
    Product:           p.product_name,
    Category:          p.category     || '',
    Quantity:          p.quantity,
    'Unit Cost':       p.unit_cost,
    'Additional':      p.additional_costs,
    'VAT %':           p.tax_rate || 0,
    'VAT Amount':      p.tax_amount || 0,
    Total:             p.total_cost,
    Status:            p.status,
    'Order Date':      fmtDate(p.ordered_at),
    'Received Date':   fmtDate(p.received_at),
    'Paid Date':       fmtDate(p.paid_at),
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('purchases.title')}</h1>
          <p className="page-subtitle">{t('purchases.ordersSubtitle', { count: filtered.length })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Purchases" sheetName="Purchases" />
          <button className="btn btn-secondary" onClick={() => setModal('orderVariants')}>{t('purchases.orderVariants')}</button>
          <button className="btn btn-primary" onClick={() => setModal('add')}>{t('purchases.addPurchase')}</button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        {[
          { label: t('purchases.statsOrdered'),    value: stats.ordered     || 0 },
          { label: t('purchases.statsReceived'),   value: stats.received    || 0 },
          { label: t('purchases.statsPaid'),       value: stats.paid        || 0 },
          { label: t('purchases.statsTotalSpent'), value: fmt(stats.total_spent) },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input className="form-control" style={{ paddingLeft: 32, height: 34, fontSize: 13 }}
              placeholder={t('purchases.searchSupplierPlaceholder')}
              value={supplierSearch} onChange={e => setSupplierSearch(e.target.value)} />
          </div>

          <select className="form-control" style={{ width: 150, height: 34, fontSize: 13 }}
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">{t('purchases.allStatuses')}</option>
            <option value="Ordered">{tStatus('Ordered')}</option>
            <option value="Received">{tStatus('Received')}</option>
            <option value="Paid">{tStatus('Paid')}</option>
          </select>

          <select className="form-control" style={{ width: 180, height: 34, fontSize: 13 }}
            value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="">{t('purchases.allCategories')}</option>
            {purchaseCategories.map(c => <option key={c} value={c}>{tCategory(c)}</option>)}
          </select>

          {hasFilters && (
            <button className="btn btn-sm btn-secondary"
              onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSupplierSearch(''); }}>
              {t('common.clear')}
            </button>
          )}

          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        {loading    ? <LoadingSpinner /> :
         fetchError ? <ErrorAlert message={fetchError} onRetry={load} /> :
         filtered.length === 0 ? (
          <EmptyState message={hasFilters
            ? t('purchases.noOrdersFiltered')
            : t('purchases.noOrdersYet')} />
         ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('purchases.poNumber')}        sortKey="po_number"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.supplier')}        sortKey="supplier"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.product')}         sortKey="product_name" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.category')}           sortKey="category"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.quantity')}           sortKey="quantity"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.unitCost')}        sortKey="unit_cost"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.total')}              sortKey="total_cost"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.status')}             sortKey="status"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.orderedAt')}       sortKey="ordered_at"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedPurchases.map(p => {
                  const isArchived = !!p.archived_at;
                  return (
                  <tr key={p.id} className={isArchived ? 'row-archived' : undefined}>
                    <td className="td-primary text-mono">
                      {p.po_number}
                      {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                    </td>
                    <td className="td-primary">{p.supplier}</td>
                    <td>{p.product_name}</td>
                    <td>
                      {p.category
                        ? <span className="badge badge-blue">{tCategory(p.category)}</span>
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>{p.quantity}</td>
                    <td>${fmtNum(p.unit_cost)}</td>
                    <td style={{ fontWeight: 600 }}>${fmtNum(p.total_cost)}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(p.ordered_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: '#166534', whiteSpace: 'nowrap' }}
                            onClick={() => setRestoreTarget(p)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                        ) : (
                          <>
                            {p.status === 'Ordered' && (
                              <>
                                <button className="btn btn-sm btn-secondary"
                                  onClick={() => handleStatus(p, 'Received')}>{t('purchases.receive')}</button>
                                <button className="btn btn-sm btn-secondary"
                                  onClick={() => { setActivePurchase(p); setModal('edit'); }}>{t('common.edit')}</button>
                                <button className="btn btn-sm btn-danger"
                                  onClick={() => { setActivePurchase(p); setModal('delete'); }}>{t('common.archive')}</button>
                              </>
                            )}
                            {p.status === 'Received' && (
                              <button className="btn btn-sm btn-secondary"
                                onClick={() => handleStatus(p, 'Paid')}>{t('purchases.markPaid')}</button>
                            )}
                            {p.status === 'Paid' && (
                              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('purchases.completed')}</span>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>

      {modal === 'add' && (
        <Modal title={t('purchases.newPurchase')} onClose={() => setModal(null)} size="modal-lg">
          <PurchaseForm
            inventoryItems={inventoryItems}
            inventoryCategories={inventoryCategories}
            suppliers={supplierList}
            onSave={handleAdd}
            onCancel={() => setModal(null)}
            saving={saving}
          />
        </Modal>
      )}
      {modal === 'orderVariants' && (
        <Modal title={t('purchases.orderVariantsTitle')} onClose={() => setModal(null)} size="modal-lg">
          <OrderVariantsModal
            suppliers={supplierList}
            onDone={() => { setModal(null); load(); }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === 'edit' && activePurchase && (
        <Modal title={t('purchases.editPOTitle', { po_number: activePurchase.po_number })} onClose={() => setModal(null)} size="modal-lg">
          <PurchaseForm
            initial={activePurchase}
            inventoryItems={inventoryItems}
            inventoryCategories={inventoryCategories}
            suppliers={supplierList}
            onSave={handleEdit}
            onCancel={() => setModal(null)}
            saving={saving}
          />
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
            <Attachments entityType="purchases" entityId={activePurchase.id} canEdit={can('purchases', 'edit')} />
          </div>
        </Modal>
      )}
      {modal === 'delete' && activePurchase && (
        <ConfirmModal
          title={t('purchases.deleteTitle')}
          message={t('purchases.deleteMsg', { po_number: activePurchase.po_number })}
          onConfirm={handleDelete}
          onCancel={() => setModal(null)}
        />
      )}
      {restoreTarget && (
        <ConfirmModal
          message={t('common.restoreConfirm')}
          confirmLabel={t('common.restore')}
          onConfirm={handleUnarchive}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}
