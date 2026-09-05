import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getPurchases, getPurchaseStats, createPurchase,
  updatePurchase, updatePurchaseStatus, voidPurchase, archivePurchase, unarchivePurchase,
  payPurchase, getPurchasePayments,
  getInventory, getUsedCategories, getSuppliers,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination, NumberInput, SupplierCombobox,
} from '../components/shared';
import { useCategories } from '../hooks/useCategories';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { usePermissions } from '../hooks/usePermissions';
import { useWarehouses } from '../hooks/useWarehouses';
import { useFocusId } from '../hooks/useFocusId';
import PayoutModal from '../components/PayoutModal.jsx';
import Attachments from '../components/Attachments.jsx';
import DocumentPostings from '../components/DocumentPostings.jsx';

import { fmtNum } from '../utils/format';
import SearchSelect from '../components/SearchSelect.jsx';

// ── Purchase form ────────────────────────────────────────────────────────────

function PurchaseForm({ initial = {}, inventoryItems = [], inventoryCategories = [], suppliers = [], onSave, onCancel, saving }) {
  const { t, tStatus, tCategory } = useLocale();
  const { settings, taxRates, exchangeRate } = useSettings();
  const fxRate = Number(exchangeRate?.rate) || 0;
  const hasRate = fxRate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
  const isEdit = !!initial.id;
  // Whether this order's goods and money have already moved. Editing one
  // that has is a restatement, not a correction on paper.
  const landed = !!(initial.stock_updated || initial.expense_recorded);

  const taxEnabled     = settings?.tax_enabled === '1';
  const activeTaxRates = (taxRates || []).filter(r => r.is_active);
  const defaultTaxRate = (taxRates || []).find(r => r.is_default) || null;

  // Owner-defined inventory categories (registry) lead; merge in any used +
  // the built-in preset as a fallback so the picker is never empty.
  const regCats = useCategories('inventory');
  const allCats = [...new Set([...regCats, ...inventoryCategories])];

  // Warehouse selector — the receipt will land here when the PO transitions
  // to 'Received'. Defaults to the user's default warehouse so existing
  // workflows don't change.
  const { warehouses, defaultId: defaultWarehouseId } = useWarehouses();

  // The DOCUMENT: one supplier, one delivery, one currency, one freight
  // charge. Everything that varies per product lives on a line instead.
  const [form, setForm] = useState({
    supplier:         initial.supplier         || '',
    // Cost may be typed in LBP; it converts to USD on the server at save. Edits
    // always start in USD (the stored PO cost is already USD).
    cost_currency:    'USD',
    additional_costs: initial.additional_costs || 0,
    status:           initial.status           || 'Ordered',
    notes:            initial.notes            || '',
    warehouse_id:     initial.warehouse_id     ?? '',
  });

  const blankLine = () => ({
    inventory_id: '', product_name: '', category: '',
    quantity: '', unit_cost: '', discount: '', tax_rate_id: null,
  });
  // An existing purchase arrives with its lines from the detail endpoint. One
  // opened before this shipped has none, so its header is folded back into a
  // single line rather than showing an empty editor.
  const [lines, setLines] = useState(() => {
    if (initial.items?.length) {
      return initial.items.map(l => ({
        inventory_id: l.inventory_id ?? '',
        product_name: l.product_name || '',
        category:     l.category || '',
        quantity:     l.quantity ?? '',
        unit_cost:    l.unit_cost ?? '',
        discount:     l.discount || '',
        tax_rate_id:  l.tax_rate_id ?? null,
      }));
    }
    if (initial.product_name) {
      return [{
        inventory_id: initial.inventory_id ?? '',
        product_name: initial.product_name,
        category:     initial.category || '',
        quantity:     initial.quantity ?? '',
        unit_cost:    initial.unit_cost ?? '',
        discount:     '',
        tax_rate_id:  initial.tax_rate_id ?? null,
      }];
    }
    return [blankLine()];
  });

  const setLine = (i, patch) =>
    setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const addLine  = () => setLines(ls => [...ls, blankLine()]);
  const dropLine = (i) => setLines(ls => ls.filter((_, n) => n !== i));

  // Pre-select the resolved default warehouse once it arrives, but only if
  // the operator hasn't already chosen one. Lets the user override.
  useEffect(() => {
    if (defaultWarehouseId && !form.warehouse_id) {
      setForm(f => ({ ...f, warehouse_id: defaultWarehouseId }));
    }

  }, [defaultWarehouseId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function pickInventory(i, id) {
    const patch = { inventory_id: id };
    const item = id && inventoryItems.find(x => String(x.id) === String(id));
    if (item) {
      if (item.name)       patch.product_name = item.name;
      if (item.category)   patch.category     = item.category;
      if (item.unit_price) patch.unit_cost    = item.unit_price;
    }
    setLine(i, patch);
  }

  // The form no longer offers a discount, but a line that already carries one
  // keeps it: it stays in state, in this total and in what is posted back, so
  // editing an order does not quietly cancel a discount somebody agreed.
  const lineNet = (l) => Math.max(
    (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_cost) || 0)
      - (parseFloat(l.discount) || 0), 0);

  const rateOf = (l) => (taxEnabled
    ? ((taxRates || []).find(r => r.id === l.tax_rate_id) || defaultTaxRate)
    : null);

  function submit(e) {
    e.preventDefault();
    onSave({
      supplier:         form.supplier,
      items: lines.map(l => ({
        inventory_id: l.inventory_id ? parseInt(l.inventory_id) : null,
        product_name: l.product_name,
        category:     (l.category || '').trim() || 'Other',
        quantity:     parseFloat(l.quantity),
        unit_cost:    parseFloat(l.unit_cost) || 0,
        discount:     parseFloat(l.discount)  || 0,
        tax_rate_id:  taxEnabled ? (l.tax_rate_id ?? null) : null,
      })),
      additional_costs: parseFloat(form.additional_costs) || 0,
      cost_currency:    form.cost_currency,
      exchange_rate:    form.cost_currency === 'LBP' ? fxRate : undefined,
      status:           form.status,
      notes:            form.notes,
      warehouse_id:     form.warehouse_id ? parseInt(form.warehouse_id) : null,
    });
  }

  // Mirrors the server: tax is per line on the discounted goods value, and
  // freight is outside the taxable base.
  const goods   = lines.reduce((a, l) => a + lineNet(l), 0);
  const taxAmt  = lines.reduce((a, l) => {
    const r = rateOf(l);
    return a + (r ? lineNet(l) * (Number(r.rate) || 0) / 100 : 0);
  }, 0);
  const total   = goods + (parseFloat(form.additional_costs) || 0) + taxAmt;

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        {/* Once the goods have landed, saving is a RESTATEMENT rather than an
            edit — so say so before it happens, not after. */}
        {isEdit && landed && (
          <div style={{
            display: 'flex', gap: 10, padding: '12px 14px',
            background: 'var(--caution-tint)', border: '1px solid var(--caution)',
            borderRadius: 8, marginBottom: 16,
          }}>
            <span style={{ fontSize: 18 }}>&#9888;&#65039;</span>
            <span style={{ fontSize: 13, color: 'var(--caution-ink)' }}>
              {t('purchases.restateWarning')}
            </span>
          </div>
        )}
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
              <SearchSelect
                className="form-control"
                value={form.warehouse_id}
                onChange={v => set('warehouse_id', v)}
                options={(warehouses).map(w => ({ value: w.id, label: `${w.code} · ${w.name}${w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}` }))} />
            </div>
          )}

          {/* THE LINES. A supplier invoice covering six products is one
              document with six lines, not six purchase orders — and the
              freight below is charged once for the delivery, then shared
              across them by value on the server. */}
          {/* `minWidth: 0` on both this and the scroll box below is what lets
              them shrink narrower than the table. A grid or flex child defaults
              to min-width:auto, so without it the box grows to the table's full
              width and the whole DIALOG scrolls sideways instead — dragging the
              supplier and notes fields along with it. */}
          <div className="form-group form-full" style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center',
                          justifyContent: 'space-between', gap: 10 }}>
              <label className="form-label" style={{ margin: 0 }}>
                {t('purchases.itemsLabel')}
              </label>
              <button type="button" className="btn btn-sm btn-secondary"
                onClick={addLine}>+ {t('purchases.addLine')}</button>
            </div>
            {/* The dialog is wide enough for every column at desktop size, so
                this only ever scrolls on a narrow screen. */}
            <div style={{ overflowX: 'auto', minWidth: 0 }}>
              <table style={{ width: '100%', minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 190 }}>{t('purchases.productNameLabel')}</th>
                    <th style={{ minWidth: 130 }}>{t('common.category')}</th>
                    <th style={{ width: 90,  textAlign: 'right' }}>{t('purchases.quantityLabel')}</th>
                    <th style={{ width: 110, textAlign: 'right' }}>{t('purchases.unitCost')}</th>
                    {taxEnabled && <th style={{ width: 130 }}>{t('common.taxCol')}</th>}
                    <th style={{ width: 90,  textAlign: 'right' }}>{t('common.total')}</th>
                    <th style={{ width: 34 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {/* One control, and the item's full name in it. Typing a
                            name here used to create a new inventory item, which
                            quietly produced a duplicate whenever somebody typed
                            the name of something already stocked. A purchase
                            restocks what you carry, so it picks from it. */}
                        <SearchSelect className="form-control" required
                          value={l.inventory_id}
                          onChange={v => pickInventory(i, v)}
                          placeholder={t('purchases.selectItem')}
                          options={inventoryItems.map(x => ({
                            value: x.id, label: x.name,
                          }))} />
                      </td>
                      <td>
                        <SearchSelect className="form-control" value={l.category}
                          onChange={v => setLine(i, { category: v })}
                          placeholder={t('purchases.selectCategory')}
                          options={(allCats).map(c => ({ value: c, label: tCategory(c) }))} />
                      </td>
                      <td>
                        <NumberInput className="form-control" step="1" min="1" required
                          style={{ textAlign: 'right' }}
                          value={l.quantity}
                          onChange={e => setLine(i, { quantity: e.target.value })} />
                      </td>
                      <td>
                        <NumberInput className="form-control" step="any" min="0"
                          style={{ textAlign: 'right' }}
                          value={l.unit_cost}
                          onChange={e => setLine(i, { unit_cost: e.target.value })} />
                      </td>
                      {taxEnabled && (
                        <td>
                          <SearchSelect className="form-control"
                            value={l.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                            onChange={v => setLine(i, { tax_rate_id: Number(v) || null })}
                            options={(activeTaxRates).map(r => ({
                              value: r.id, label: `${r.name} (${r.rate}%)` }))} />
                        </td>
                      )}
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {fmt(lineNet(l))}
                      </td>
                      <td>
                        {lines.length > 1 && (
                          <button type="button" className="btn btn-sm btn-secondary"
                            title={t('purchases.removeLine')}
                            onClick={() => dropLine(i)}>&times;</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.costCurrency')}</label>
            <SearchSelect
              className="form-control"
              value={form.cost_currency}
              onChange={v => set('cost_currency', v)}
              options={[{ value: 'USD', label: 'USD' }]} />
            {form.cost_currency === 'LBP' && hasRate && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {t('inventory.costLockedToUsd')}
              </div>
            )}
          </div>

          <div className="form-group">
            {/* Charged once for the delivery, then shared across the lines by
                value so each product lands at what it really cost. */}
            <label className="form-label">{t('purchases.additionalCostsDollar')}</label>
            <NumberInput className="form-control" step="any" min="0"
              value={form.additional_costs} onChange={e => set('additional_costs', e.target.value)} />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              {t('purchases.shippingSharedHint')}
            </div>
          </div>

          {!isEdit && (
            <div className="form-group">
              <label className="form-label">{t('purchases.statusLabel')}</label>
              <SearchSelect
                className="form-control"
                value={form.status}
                onChange={v => set('status', v)}
                options={[{ value: 'Ordered', label: tStatus('Ordered') },
                          { value: 'Received', label: tStatus('Received') },
                          { value: 'Paid', label: tStatus('Paid') }]} />
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

// One label over its value, for the header of the order view.
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const { tStatus } = useLocale();
  // 'Prepaid' and 'Deposit Paid' describe an order that has been paid for and
  // not yet delivered — money out, nothing on the shelf. Purple keeps them
  // visibly apart from the green of goods that have actually arrived, which is
  // the mistake worth making impossible at a glance.
  const map = {
    Ordered: 'yellow', Received: 'green', Paid: 'blue',
    Prepaid: 'purple', 'Deposit Paid': 'purple',
  };
  return <span className={`badge badge-${map[status] || 'gray'}`}>{tStatus(status)}</span>;
}

// ── What has been paid, and when ─────────────────────────────────────────────
// A purchase can be settled in instalments — a deposit on order, the balance on
// delivery — so "paid" is no longer one date on the header. The individual
// payments are the record, and this is where somebody reconciling a supplier
// statement finds them.

function PurchasePayments({ purchaseId }) {
  const { t, fmtDate, tEnumValue } = useLocale();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let alive = true;
    getPurchasePayments(purchaseId)
      .then(r => { if (alive) setRows(r.payments || []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [purchaseId]);

  if (rows === null) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
                   color: 'var(--text-3)', marginBottom: 8 }}>
        {t('purchases.paymentsTitle')}
      </h4>
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('purchases.noPayments')}</p>
      ) : (
        <table style={{ width: '100%' }}>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={r.voided_at ? { textDecoration: 'line-through',
                                                    color: 'var(--text-3)' } : undefined}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.paid_at)}</td>
                <td>{r.method ? tEnumValue(r.method) : '—'}</td>
                <td style={{ color: 'var(--text-3)' }}>{r.note || ''}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>${fmtNum(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

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
  const [voidTarget, setVoidTarget] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding,    setVoiding]    = useState(false);
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
  }, [focusId, purchases]);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const qs = new URLSearchParams({
        ...(statusFilter   ? { status:   statusFilter   } : {}),
        ...(supplierSearch ? { supplier: supplierSearch } : {}),
        ...(showArchived   ? { archived: 'only' }         : {}),
      }).toString();
      const [purch, st, cats] = await Promise.all([
        getPurchases(qs ? `?${qs}` : ''),
        getPurchaseStats(),
        getUsedCategories(),
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

  // Paying is the moment money leaves, so it asks how — and now how much,
  // because a pre-order is commonly a deposit and then a balance. Receiving is
  // a stock event and asks nothing.
  const [payingFor, setPayingFor] = useState(null);

  async function handlePay(purchase, { amount, ...payout }) {
    try {
      const res = await payPurchase(purchase.id, { amount, ...payout });
      toast(t('purchases.paymentRecorded', { amount: fmt(amount) }), 'green');
      setPayingFor(null);
      load();
      return res;
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleStatus(purchase, newStatus, payout = null) {
    try {
      await updatePurchaseStatus(purchase.id, newStatus, payout);
      toast(t('purchases.markedAs', { status: tStatus(newStatus) }));
      setPayingFor(null);
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

  async function handleVoid() {
    setVoiding(true);
    try {
      await voidPurchase(voidTarget.id, voidReason || 'Voided');
      toast(t('purchases.voided'), 'green');
      setVoidTarget(null); setVoidReason('');
      load();
    } catch (err) {
      // The server refuses with a 409 that says exactly how much of the receipt
      // is left. That sentence is the whole answer, so show it rather than a
      // generic failure the user would have to go and investigate.
      toast(err.message || t('purchases.voidFailed'), 'red');
    } finally {
      setVoiding(false);
    }
  }

  async function handleUnarchive() {
    try {
      await unarchivePurchase(restoreTarget.id);
      toast(t('purchases.purchaseRestored'));
      setRestoreTarget(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  // An order can span categories, so it matches if ANY of its lines does.
  const filtered = categoryFilter
    ? purchases.filter(p => (p.categories || []).includes(categoryFilter))
    : purchases;

  const purchaseCategories =
    [...new Set(purchases.flatMap(p => p.categories || []).filter(Boolean))].sort();
  const hasFilters = statusFilter || categoryFilter || supplierSearch;

  const { sorted: pagedPurchases, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  // ONE ROW PER LINE, with the document's own fields repeated. An accountant
  // reconciling a supplier statement works line by line; a row per order hides
  // exactly the detail they opened the export for. The freight and the order
  // total are written against the first line only, so summing the column still
  // gives the amount spent rather than counting the delivery charge once per
  // product.
  const exportData = filtered.flatMap(p => {
    const rows = (p.items || []).length ? p.items : [null];
    return rows.map((l, i) => ({
      'PO Number':       p.po_number,
      Supplier:          p.supplier,
      Line:              i + 1,
      Product:           l ? l.product_name : p.item_summary,
      Category:          (l ? l.category : (p.categories || [])[0]) || '',
      Quantity:          l ? l.quantity : p.total_quantity,
      'Unit Cost':       l ? l.unit_cost : '',
      Discount:          l ? (l.discount || 0) : 0,
      'Line Total':      l ? l.line_total : '',
      'VAT %':           l ? (l.tax_rate || 0) : 0,
      'VAT Amount':      l ? (l.tax_amount || 0) : 0,
      'Additional':      i === 0 ? p.additional_costs : '',
      'Order Total':     i === 0 ? p.total_cost : '',
      Status:            p.status,
      'Order Date':      fmtDate(p.ordered_at),
      'Received Date':   fmtDate(p.received_at),
      'Paid Date':       fmtDate(p.paid_at),
    }));
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('purchases.title')}</h1>
          <p className="page-subtitle">{t('purchases.ordersSubtitle', { count: filtered.length })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Purchases" sheetName="Purchases" />
          <button className="btn btn-primary" onClick={() => setModal('add')}>{t('purchases.addPurchase')}</button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        {[
          { label: t('purchases.statsOrdered'),    value: stats.ordered     || 0 },
          // Paid for and still coming. Money already with suppliers is an
          // asset, not a cost, and it is the figure somebody chasing a late
          // pre-order actually wants.
          { label: t('purchases.statsPrepaid'),    value: stats.prepaid     || 0 },
          { label: t('purchases.statsAdvances'),   value: fmt(stats.advances) },
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

          <SearchSelect
            className="form-control"
            style={{ width: 150, height: 34, fontSize: 13 }}
            value={statusFilter}
            onChange={v => setStatusFilter(v)}
            placeholder={t('purchases.allStatuses')}
            options={[{ value: 'Ordered', label: tStatus('Ordered') },
                      { value: 'Deposit Paid', label: tStatus('Deposit Paid') },
                      { value: 'Prepaid', label: tStatus('Prepaid') },
                      { value: 'Received', label: tStatus('Received') },
                      { value: 'Paid', label: tStatus('Paid') }]} />

          <SearchSelect
            className="form-control"
            style={{ width: 180, height: 34, fontSize: 13 }}
            value={categoryFilter}
            onChange={v => setCategoryFilter(v)}
            placeholder={t('purchases.allCategories')}
            options={(purchaseCategories).map(c => ({ value: c, label: tCategory(c) }))} />

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
        {loading && !filtered.length ? <LoadingSpinner /> :
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
                  <SortableTh label={t('purchases.product')}         sortKey="item_summary" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.category')}           sortKey="category"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.quantity')}           sortKey="total_quantity" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.linesCol')}        sortKey="line_count"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.total')}              sortKey="total_cost"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.status')}             sortKey="status"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('purchases.orderedAt')}       sortKey="ordered_at"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedPurchases.map(p => {
                  const isArchived = !!p.archived_at;
                  const isVoided   = !!p.voided_at;
                  return (
                  <tr key={p.id} className={isArchived || isVoided ? 'row-archived' : undefined}
                    style={{ cursor: 'pointer' }}
                    title={t('purchases.viewOrder')}
                    onClick={() => { setActivePurchase(p); setModal('details'); }}>
                    <td className="td-primary text-mono">
                      {p.po_number}
                      {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                      {/* The row stays in the list so the history reads true —
                          it is only the figures a void keeps it out of. */}
                      {isVoided && <span className="badge badge-red" style={{ marginInlineStart: 8 }}
                        title={p.void_reason || undefined}>{t('purchases.voidedBadge')}</span>}
                    </td>
                    <td className="td-primary">{p.supplier}</td>
                    <td>{p.item_summary || p.product_name}</td>
                    <td>
                      {(p.categories || []).length
                        ? (p.categories || []).slice(0, 2).map(cat => (
                            <span key={cat} className="badge badge-blue"
                              style={{ marginInlineEnd: 4 }}>{tCategory(cat)}</span>
                          ))
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>{p.total_quantity ?? p.quantity}</td>
                    {/* A unit cost is not a property of an order with several
                        lines, so the column says how many there are instead. */}
                    <td>{p.line_count ?? 1}</td>
                    {/* What is still owed goes UNDER the total rather than
                        in a column of its own: the table already carries ten,
                        and a partly-paid order is the minority case. Only
                        shown when there is something to say. */}
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      ${fmtNum(p.total_cost)}
                      {!isVoided && p.paid_total > 0.005 && p.outstanding > 0.005 && (
                        <div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-3)' }}>
                          {t('purchases.outstandingLabel')} ${fmtNum(p.outstanding)}
                        </div>
                      )}
                    </td>
                    <td>{isVoided
                      ? <StatusBadge status="Void" />
                      : <StatusBadge status={p.status} />}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(p.ordered_at)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: 'var(--affirm-ink)', whiteSpace: 'nowrap' }}
                            onClick={() => setRestoreTarget(p)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                        ) : isVoided ? (
                          /* Cancelled. The only thing left to do with it is
                             file it away — and archiving is refused until a
                             purchase IS cancelled, which is why the button
                             lives here and not on a live row. */
                          <button className="btn btn-sm btn-secondary"
                            title={p.void_reason || undefined}
                            onClick={() => { setActivePurchase(p); setModal('delete'); }}>
                            {t('common.archive')}
                          </button>
                        ) : (
                          <>
                            {/* Receiving is about the GOODS, so it is offered
                                whether or not the order has been paid for —
                                a pre-order that has been settled in advance is
                                still waiting to be delivered. */}
                            {!p.received_at && (
                              <button className="btn btn-sm btn-secondary"
                                onClick={() => handleStatus(p, 'Received')}>{t('purchases.receive')}</button>
                            )}
                            {/* ...and paying is about the MONEY, so it is
                                offered while anything is outstanding, before
                                the delivery as readily as after. This is what
                                makes a pre-order enterable without pretending
                                the stock has arrived. */}
                            {p.outstanding > 0.005 && (
                              <button className="btn btn-sm btn-secondary"
                                onClick={() => setPayingFor(p)}>
                                {p.received_at ? t('purchases.markPaid') : t('purchases.payNow')}
                              </button>
                            )}
                            {/* Offered whatever the status. A cost keyed wrong
                                used to be uncorrectable once the goods had
                                landed: the server restates the purchase
                                instead, re-valuing what is still on the shelf
                                and posting the rest as a cost correction. */}
                            <button className="btn btn-sm btn-secondary"
                              onClick={() => { setActivePurchase(p); setModal('edit'); }}>
                              {t('common.edit')}
                            </button>
                            {/* Offered whatever the status. An order voided
                                before it arrived reverses nothing; one voided
                                after takes the goods back off the shelf and
                                mirrors the ledger entry. */}
                            <button className="btn btn-sm btn-danger"
                              onClick={() => { setVoidTarget(p); setVoidReason(''); }}>
                              {t('purchases.void')}
                            </button>
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
        <Modal title={t('purchases.newPurchase')} onClose={() => setModal(null)} size="modal-xl">
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
      {payingFor && (
        <PayoutModal
          title={payingFor.received_at ? t('purchases.markPaid') : t('purchases.payNow')}
          summary={payingFor.received_at
            ? t('purchases.payoutSummary', {
                po: payingFor.po_number, supplier: payingFor.supplier || '' })
            : t('purchases.prepaySummary', {
                po: payingFor.po_number, supplier: payingFor.supplier || '' })}
          confirmLabel={t('purchases.recordPayment')}
          maxAmount={Number(payingFor.outstanding || 0)}
          amountLabel={t('purchases.amountToPay')}
          onConfirm={payout => handlePay(payingFor, payout)}
          onClose={() => setPayingFor(null)} />
      )}
      {modal === 'edit' && activePurchase && (
        <Modal title={t('purchases.editPOTitle', { po_number: activePurchase.po_number })} onClose={() => setModal(null)} size="modal-xl">
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
            <DocumentPostings document="purchase" id={activePurchase.id} />
          </div>
        </Modal>
      )}
      {/* THE ORDER, AS THE SUPPLIER SENT IT. A purchase holds several products
          now, and the list can only show the first one and a count — so the row
          opens the document itself. The landed cost is worth showing beside the
          unit cost: it is what the goods are actually worth on the shelf once
          the delivery charge has been shared out, and it is the figure the
          costing engine works from. */}
      {modal === 'details' && activePurchase && (
        <Modal title={activePurchase.po_number} onClose={() => setModal(null)} size="modal-xl">
          <div className="modal-body">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 16 }}>
              <Field label={t('purchases.supplier')}>{activePurchase.supplier}</Field>
              <Field label={t('common.status')}>
                {activePurchase.voided_at
                  ? <StatusBadge status="Void" />
                  : <StatusBadge status={activePurchase.status} />}
              </Field>
              <Field label={t('purchases.orderedAt')}>{fmtDate(activePurchase.ordered_at)}</Field>
              {activePurchase.received_at && (
                <Field label={t('purchases.receivedAt')}>{fmtDate(activePurchase.received_at)}</Field>
              )}
              {activePurchase.paid_at && (
                <Field label={t('purchases.paidAt')}>{fmtDate(activePurchase.paid_at)}</Field>
              )}
              {activePurchase.void_reason && (
                <Field label={t('purchases.voidReason')}>{activePurchase.void_reason}</Field>
              )}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>{t('purchases.product')}</th>
                    <th>{t('common.category')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.quantity')}</th>
                    <th style={{ textAlign: 'right' }}>{t('purchases.unitCost')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.taxCol')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.total')}</th>
                    <th style={{ textAlign: 'right' }}>{t('purchases.landedCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(activePurchase.items || []).map(l => (
                    <tr key={l.id}>
                      <td className="td-primary">{l.product_name}</td>
                      <td>{l.category ? tCategory(l.category) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{l.quantity}</td>
                      <td style={{ textAlign: 'right' }}>${fmtNum(l.unit_cost)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {Number(l.tax_amount) ? `$${fmtNum(l.tax_amount)}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>${fmtNum(l.line_total)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>
                        {l.landed_unit_cost != null ? `$${fmtNum(l.landed_unit_cost)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <table style={{ width: 280 }}>
                <tbody>
                  <tr>
                    <td style={{ color: 'var(--text-2)' }}>{t('purchases.itemsLabel')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.subtotal)}</td>
                  </tr>
                  <tr>
                    {/* Charged once for the delivery, then shared across the
                        lines by value — which is what the landed column shows. */}
                    <td style={{ color: 'var(--text-2)' }}>{t('purchases.additionalCostsDollar')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.additional_costs)}</td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--text-2)' }}>{t('common.taxCol')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.tax_total)}</td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td>{t('common.total')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.grand_total)}</td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--text-2)' }}>{t('purchases.paidLabel')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.paid_total)}</td>
                  </tr>
                  <tr style={{ fontWeight: 600 }}>
                    <td>{t('purchases.outstandingLabel')}</td>
                    <td style={{ textAlign: 'right' }}>${fmtNum(activePurchase.outstanding)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <PurchasePayments purchaseId={activePurchase.id} />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              {t('common.close')}
            </button>
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
      {voidTarget && (
        <Modal title={t('purchases.voidTitle')}
          onClose={() => { setVoidTarget(null); setVoidReason(''); }}>
          <div className="modal-body">
            <div style={{
              display: 'flex', gap: 10, padding: '12px 14px',
              background: 'var(--caution-tint)', border: '1px solid var(--caution)',
              borderRadius: 8, marginBottom: 16,
            }}>
              <span style={{ fontSize: 18 }}>&#9888;&#65039;</span>
              <span style={{ fontSize: 13, color: 'var(--caution-ink)' }}>
                {voidTarget.stock_updated
                  ? t('purchases.voidWarningStock', {
                      quantity: voidTarget.total_quantity ?? voidTarget.quantity,
                      product: voidTarget.item_summary || voidTarget.product_name,
                    })
                  : t('purchases.voidWarning')}
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">{t('purchases.voidReason')}</label>
              <input className="form-control" value={voidReason}
                onChange={e => setVoidReason(e.target.value)} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary"
              onClick={() => { setVoidTarget(null); setVoidReason(''); }}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={handleVoid} disabled={voiding}>
              {voiding ? t('purchases.voiding') : t('purchases.void')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
