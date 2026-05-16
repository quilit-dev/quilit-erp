import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getPurchases, getPurchaseStats, createPurchase,
  updatePurchase, updatePurchaseStatus, archivePurchase,
  getInventory, getCategories, getSuppliers,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';

const PURCHASE_CATEGORIES = [
  'Equipment', 'Materials', 'Safety', 'Tools', 'Consumables', 'Other'
];

const fmtNum = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Supplier combobox ────────────────────────────────────────────────────────

function SupplierCombobox({ value, suppliers = [], onChange }) {
  const { t } = useLocale();
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState(value || '');
  const wrapRef = useRef(null);

  useEffect(() => { setQuery(value || ''); }, [value]);

  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim().length === 0
    ? suppliers.slice(0, 8)
    : suppliers.filter(s => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        className="form-control"
        placeholder={t('purchases.searchSupplierPlaceholder')}
        value={query}
        required
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); setOpen(true); onChange(e.target.value); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--surface-1, #fff)', border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 200, overflowY: 'auto',
        }}>
          <div style={{ padding: '4px 10px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
            textTransform: 'uppercase', color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
            {t('purchases.suppliersDropHeader')}
          </div>
          {filtered.map(s => (
            <div key={s.id}
              onMouseDown={() => { setQuery(s.name); setOpen(false); onChange(s.name); }}
              style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 13,
                borderBottom: '1px solid var(--border, #f1f5f9)', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2, #f8fafc)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontWeight: 500 }}>{s.name}</span>
              {s.contact_name && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{s.contact_name}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Purchase form ────────────────────────────────────────────────────────────

function PurchaseForm({ initial = {}, inventoryItems = [], inventoryCategories = [], suppliers = [], onSave, onCancel, saving }) {
  const { t, tStatus } = useLocale();
  const isEdit = !!initial.id;

  const allCats = [...new Set([...inventoryCategories, ...PURCHASE_CATEGORIES])].sort();

  const [form, setForm] = useState({
    supplier:         initial.supplier         || '',
    product_name:     initial.product_name     || '',
    category:         initial.category         || '',
    customCategory:   '',
    inventory_id:     initial.inventory_id     || '',
    quantity:         initial.quantity         || '',
    unit_cost:        initial.unit_cost        || '',
    additional_costs: initial.additional_costs || 0,
    status:           initial.status           || 'Ordered',
    notes:            initial.notes            || '',
  });

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
      status:           form.status,
      notes:            form.notes,
    });
  }

  const total = (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_cost) || 0)
              + (parseFloat(form.additional_costs) || 0);

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('purchases.supplierLabel')}</label>
            <SupplierCombobox
              value={form.supplier}
              suppliers={suppliers}
              onChange={v => set('supplier', v)}
            />
          </div>

          {!isEdit && (
            <div className="form-group form-full">
              <label className="form-label">{t('purchases.linkInventory')}</label>
              <select className="form-control" value={form.inventory_id} onChange={handleInventorySelect}>
                <option value="">{t('purchases.newNotLinked')}</option>
                {inventoryItems.map(i => (
                  <option key={i.id} value={i.id}>{i.name}{i.category ? ` (${i.category})` : ''}</option>
                ))}
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
              {allCats.map(c => <option key={c} value={c}>{c}</option>)}
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
            <input className="form-control" type="number" step="any" min="0.001" required
              value={form.quantity} onChange={e => set('quantity', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.unitCostDollar')}</label>
            <input className="form-control" type="number" step="any" min="0"
              value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">{t('purchases.additionalCostsDollar')}</label>
            <input className="form-control" type="number" step="any" min="0"
              value={form.additional_costs} onChange={e => set('additional_costs', e.target.value)} />
          </div>

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

export default function Purchases() {
  const { t, tStatus } = useLocale();
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

  const [modal,          setModal]          = useState(null);
  const [activePurchase, setActivePurchase] = useState(null);
  const [saving,         setSaving]         = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const [purch, st, cats] = await Promise.all([
        getPurchases(statusFilter || supplierSearch
          ? new URLSearchParams({
              ...(statusFilter   ? { status:   statusFilter   } : {}),
              ...(supplierSearch ? { supplier: supplierSearch } : {}),
            })
          : undefined),
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
  }, [statusFilter, supplierSearch]);

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
            {purchaseCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          {hasFilters && (
            <button className="btn btn-sm btn-secondary"
              onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSupplierSearch(''); }}>
              {t('common.clear')}
            </button>
          )}
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
                {pagedPurchases.map(p => (
                  <tr key={p.id}>
                    <td className="td-primary text-mono">{p.po_number}</td>
                    <td className="td-primary">{p.supplier}</td>
                    <td>{p.product_name}</td>
                    <td>
                      {p.category
                        ? <span className="badge badge-blue">{p.category}</span>
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>{p.quantity}</td>
                    <td>${fmtNum(p.unit_cost)}</td>
                    <td style={{ fontWeight: 600 }}>${fmtNum(p.total_cost)}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(p.ordered_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {p.status === 'Ordered' && (
                          <>
                            <button className="btn btn-sm btn-secondary"
                              onClick={() => handleStatus(p, 'Received')}>{t('purchases.receive')}</button>
                            <button className="btn btn-sm btn-secondary"
                              onClick={() => { setActivePurchase(p); setModal('edit'); }}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger"
                              onClick={() => { setActivePurchase(p); setModal('delete'); }}>Archive</button>
                          </>
                        )}
                        {p.status === 'Received' && (
                          <button className="btn btn-sm btn-secondary"
                            onClick={() => handleStatus(p, 'Paid')}>{t('purchases.markPaid')}</button>
                        )}
                        {p.status === 'Paid' && (
                          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('purchases.completed')}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
