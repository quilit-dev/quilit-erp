// Inventory — items list with stock ops, lots browser, and product builder.
// Forms/modals live in ./inventory/ — this file is the main list + tabs.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import { useCategories } from '../hooks/useCategories';
import { usePermissions } from '../hooks/usePermissions';
import { useFocusId } from '../hooks/useFocusId';
import {
  createInventoryItem, updateInventoryItem,
  archiveInventoryItem, unarchiveInventoryItem, getSuppliers, createProduct,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, toast, SortableTh, Pagination,
} from '../components/shared';
import ImportWizard from '../components/ImportWizard';

import { fmtNum, CategoryBadge, ProductTypeBadge } from './inventory/ui';
import { ItemForm } from './inventory/ItemForm';
import { StockForm } from './inventory/StockForm';
import { MovementsModal } from './inventory/MovementsModal';
import { LotsBrowser } from './inventory/Lots';
import { ProductBuilder } from './inventory/ProductBuilder';

export default function Inventory() {
  const { t, tCategory } = useLocale();
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
  }, [focusId, items]);

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

  // The server strips cost for roles without the capability, so these
  // columns would otherwise render as blank cells rather than being absent.
  const { can } = usePermissions();
  const showCost = can('costs');

  const regInvCats = useCategories('inventory');
  const allKnownCats = [...new Set([...regInvCats, ...categories, ...items.map(i => i.category).filter(Boolean)])];
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
        {showCost && <td>${fmtNum(item.unit_cost)}</td>}
        {showCost && (
          <td style={{ fontWeight: 600 }}>${fmtNum(item.quantity * item.unit_cost)}</td>
        )}
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

  // Export is a ROUND TRIP, not a report: the headers match the import
  // wizard's field labels exactly, so a sheet can be exported, edited in Excel
  // and imported back. Anything that is derived or system-owned (values, stock
  // reserved by orders, status) is appended after the importable block and
  // ignored on the way back in.
  //
  // Attribute columns are whatever THIS tenant has defined, unioned across the
  // visible rows — a fixed list would silently drop a customer's own fields.
  const attributeColumns = useMemo(() => {
    const seen = new Set();
    items.forEach(i => Object.keys(i.attributes || {}).forEach(k => seen.add(k)));
    return [...seen].sort();
  }, [items]);

  const exportData = items.map(i => {
    const row = {
      // ── importable: these headers match the import field labels ──
      Name: i.name,
      Category: i.category || '',
      'Product type': i.product_type || '',
      Quantity: i.quantity,
      'Min stock': i.min_stock,
      'Unit cost': i.unit_cost,
      'Sale price': i.sale_price || 0,
      'Price currency': i.price_currency || 'USD',
      Supplier: i.supplier || '',
      Unit: i.unit || '',
      Barcode: i.barcode || '',
      'Lot tracked': i.lot_tracked ? 'yes' : 'no',
      'Shelf life (days)': i.shelf_life_days ?? '',
      'Product (groups variants)': i.product_name || '',
    };
    // One column per tenant-defined attribute, blank where the item has none,
    // so the sheet stays rectangular and Excel-friendly.
    attributeColumns.forEach(name => { row[name] = (i.attributes || {})[name] || ''; });

    // ── read-only: derived or system-managed ──
    row['Variant'] = i.variant_label || '';
    row['Reserved'] = i.reserved_quantity || 0;
    row['Quarantine'] = i.quarantine_quantity || 0;
    row['Total value'] = fmtNum((i.quantity || 0) * (i.unit_cost || 0));
    row['Status'] = i.min_stock > 0 && i.quantity <= i.min_stock ? 'Low Stock' : 'OK';
    return row;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('inventory.title')}</h1>
          <p className="page-subtitle">
            {t('inventory.totalItems', { count: items.length })}
            {/* Stock value is quantity x cost, so it divides back out. */}
            {showCost && <> · {t('common.totalValue')}: ${fmtNum(totalValue)}</>}
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
            {allKnownCats.map(c => <option key={c} value={c}>{tCategory(c)}</option>)}
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
                  {showCost && <SortableTh label={t('inventory.unitCost')} sortKey="unit_cost"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />}
                  {showCost && <th>{t('inventory.totalValueHeader')}</th>}
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
