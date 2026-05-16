import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getRecycleBin, restoreItem, purgeItem,
  bulkRestoreItems, bulkPurgeItems, purgeExpired,
} from '../api/client.js';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, SortableTh, Pagination } from '../components/shared.jsx';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';

const MODULE_BADGE = {
  clients:    'badge-purple',
  projects:   'badge-green',
  quotations: 'badge-yellow',
  invoices:   'badge-blue',
  inventory:  'badge-accent',
  purchases:  'badge-red',
  expenses:   'badge-gray',
};

function ModuleBadge({ module, label }) {
  return (
    <span className={`badge ${MODULE_BADGE[module] || 'badge-gray'}`}>{label}</span>
  );
}

function DaysChip({ days }) {
  const { t } = useLocale();
  if (days === null || days === undefined) return null;
  const urgent = days <= 3;
  return (
    <span className={`badge ${urgent ? 'badge-red' : 'badge-gray'}`}>
      {days === 0 ? t('recycleBin.expiresToday') : t('recycleBin.daysLeft', { n: days })}
    </span>
  );
}

function ConfirmTypedModal({ title, description, danger, onClose, onConfirm }) {
  const { t } = useLocale();
  const word = t('recycleBin.typeToProceed');
  const [typed, setTyped] = useState('');
  const ready = typed.trim().toLowerCase() === word.toLowerCase();

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <p style={{ color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.6 }}>
          {description}
        </p>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">
            {t('recycleBin.typeLabel')} <strong style={{ color: danger ? 'var(--red)' : 'var(--text)' }}>{word}</strong>
          </label>
          <input
            className="form-control"
            placeholder={word}
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoFocus
          />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={!ready}
        >
          {title}
        </button>
      </div>
    </Modal>
  );
}

function ConfirmModal({ title, description, danger, onClose, onConfirm }) {
  const { t } = useLocale();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <p style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>{description}</p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
          {title}
        </button>
      </div>
    </Modal>
  );
}

const ALL_MODULES = ['clients', 'projects', 'quotations', 'invoices', 'inventory', 'purchases', 'expenses'];

export default function RecycleBin() {
  const { t } = useLocale();

  const MODULE_LABELS = {
    clients:    t('nav.clients'),
    projects:   t('nav.projects'),
    quotations: t('nav.quotations'),
    invoices:   t('nav.invoices'),
    inventory:  t('nav.inventory'),
    purchases:  t('nav.purchases'),
    expenses:   t('nav.expenses'),
  };

  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [toast, setToast]       = useState(null);

  const [search, setSearch] = usePersistedState('recycle.search', '');
  const [module, setModule] = usePersistedState('recycle.module', '');
  const [dateFrom, setDateFrom] = usePersistedState('recycle.dateFrom', '');
  const [dateTo, setDateTo] = usePersistedState('recycle.dateTo', '');

  const [selected, setSelected] = useState(new Set());
  const [modal, setModal]       = useState(null);
  const [busy, setBusy]         = useState(false);

  const debounceRef = useRef(null);

  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = {};
      if (module)   params.module    = module;
      if (search)   params.search    = search;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo)   params.date_to   = dateTo;
      const data = await getRecycleBin(params);
      setItems(data);
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [module, search, dateFrom, dateTo]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => { purgeExpired().catch(() => {}); }, []);

  function toggleSelect(key) {
    setSelected(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleAll() {
    setSelected(selected.size === items.length ? new Set() : new Set(items.map(i => `${i.module}:${i.id}`)));
  }
  function selectedItems() {
    return items.filter(i => selected.has(`${i.module}:${i.id}`));
  }

  const { sorted: pagedItems, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(items);

  async function doRestore(item) {
    setBusy(true);
    try {
      await restoreItem(item.module, item.id);
      showToast(t('recycleBin.restoredMsg', { label: item.label }));
      setModal(null); load();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function doPurge(item) {
    setBusy(true);
    try {
      await purgeItem(item.module, item.id);
      showToast(t('recycleBin.purgedMsg', { label: item.label }));
      setModal(null); load();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function doBulkRestore() {
    setBusy(true);
    try {
      const sel = selectedItems().map(i => ({ module: i.module, id: i.id }));
      const res = await bulkRestoreItems(sel);
      showToast(t('recycleBin.bulkRestoredMsg', { count: res.restored }));
      setModal(null); load();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function doBulkPurge() {
    setBusy(true);
    try {
      const sel = selectedItems().map(i => ({ module: i.module, id: i.id }));
      const res = await bulkPurgeItems(sel);
      showToast(t('recycleBin.bulkPurgedMsg', { count: res.purged }));
      setModal(null); load();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  const selCount    = selected.size;
  const allSelected = items.length > 0 && selected.size === items.length;
  const hasFilters  = !!(search || module || dateFrom || dateTo);

  return (
    <div>
      {toast && (
        <div
          className={`alert ${toast.type === 'error' ? 'alert-red' : 'alert-green'}`}
          style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, minWidth: 260, boxShadow: 'var(--shadow-lg)', animation: 'fadeIn .2s ease' }}
        >
          {toast.type === 'error' ? '⚠ ' : '✓ '}{toast.msg}
        </div>
      )}

      <div className="page-header">
        <div>
          <h1 className="page-title">{t('recycleBin.title')}</h1>
          <p className="page-subtitle">{t('recycleBin.subtitle30')}</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              className="form-control"
              style={{ paddingLeft: 32, height: 34, fontSize: 13 }}
              placeholder={t('recycleBin.searchByName')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <select
            className="form-control"
            style={{ width: 160, height: 34, fontSize: 13 }}
            value={module}
            onChange={e => setModule(e.target.value)}
          >
            <option value="">{t('recycleBin.allModules')}</option>
            {ALL_MODULES.map(m => <option key={m} value={m}>{MODULE_LABELS[m]}</option>)}
          </select>

          <input
            type="date"
            className="form-control"
            style={{ width: 148, height: 34, fontSize: 13 }}
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
          />

          <span style={{ color: 'var(--text-3)', fontSize: 13, flexShrink: 0 }}>–</span>

          <input
            type="date"
            className="form-control"
            style={{ width: 148, height: 34, fontSize: 13 }}
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
          />

          {hasFilters && (
            <button className="btn btn-sm btn-secondary"
              onClick={() => { setSearch(''); setModule(''); setDateFrom(''); setDateTo(''); }}>
              {t('common.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {selCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderRadius: 'var(--radius)', marginBottom: 14,
          background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 13,
          boxShadow: 'var(--shadow-md)',
        }}>
          <span>{t('recycleBin.itemsSelected', { count: selCount, s: selCount !== 1 ? 's' : '' })}</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-sm"
            style={{ background: 'rgba(255,255,255,.2)', color: '#fff', border: '1px solid rgba(255,255,255,.3)' }}
            onClick={() => setModal({ type: 'bulk-restore' })}
          >
            {t('recycleBin.restoreSelected')}
          </button>
          <button
            className="btn btn-sm"
            style={{ background: 'rgba(255,255,255,.1)', color: '#fff', border: '1px solid rgba(255,255,255,.35)' }}
            onClick={() => setModal({ type: 'bulk-purge' })}
          >
            {t('recycleBin.deletePermTitle')}
          </button>
          <button
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.7)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 2px' }}
            onClick={() => setSelected(new Set())}
          >×</button>
        </div>
      )}

      {error ? (
        <ErrorAlert message={error} onRetry={load} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState message={hasFilters ? t('recycleBin.noItemsFiltered') : t('recycleBin.noItemsEmpty')} />
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40, paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
                    />
                  </th>
                  <SortableTh label={t('recycleBin.name')}       sortKey="label"          currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('recycleBin.module')}     sortKey="module"         currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('recycleBin.deletedAt')}  sortKey="deleted_at"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('recycleBin.expiresCat')} sortKey="days_remaining" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th style={{ textAlign: 'right' }}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedItems.map(item => {
                  const key = `${item.module}:${item.id}`;
                  const isSelected = selected.has(key);
                  return (
                    <tr key={key} style={isSelected ? { background: 'var(--accent-light)' } : {}}>
                      <td style={{ paddingRight: 0 }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(key)}
                          style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
                        />
                      </td>
                      <td className="td-primary">
                        {item.label}
                        <span style={{ color: 'var(--text-3)', fontSize: 12, fontWeight: 400, marginLeft: 6 }}>#{item.id}</span>
                      </td>
                      <td>
                        <ModuleBadge module={item.module} label={item.module_label} />
                      </td>
                      <td>
                        {item.deleted_at
                          ? new Date(item.deleted_at + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                          : '—'}
                      </td>
                      <td>
                        <DaysChip days={item.days_remaining} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => setModal({ type: 'restore', item })}
                          >
                            {t('recycleBin.restore')}
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => setModal({ type: 'purge', item })}
                          >
                            🗑
                          </button>
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
          <div style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            color: 'var(--text-3)',
          }}>
            <span>{t('recycleBin.itemsInBin', { count: items.length })}</span>
            <span>{t('recycleBin.autoRemove')}</span>
          </div>
        </div>
      )}

      {modal?.type === 'restore' && (
        <ConfirmModal
          title={t('recycleBin.restoreItemTitle')}
          description={t('recycleBin.restoreDesc', { label: modal.item.label, module: MODULE_LABELS[modal.item.module] || modal.item.module })}
          onClose={() => setModal(null)}
          onConfirm={() => doRestore(modal.item)}
        />
      )}

      {modal?.type === 'purge' && (
        <ConfirmModal
          title={t('recycleBin.deletePermTitle')}
          danger
          description={t('recycleBin.purgeDesc', { label: modal.item.label })}
          onClose={() => setModal(null)}
          onConfirm={() => doPurge(modal.item)}
        />
      )}

      {modal?.type === 'bulk-restore' && (
        <ConfirmTypedModal
          title={t('recycleBin.restoreSelected')}
          description={t('recycleBin.bulkRestoreDesc', { count: selCount })}
          onClose={() => setModal(null)}
          onConfirm={doBulkRestore}
        />
      )}

      {modal?.type === 'bulk-purge' && (
        <ConfirmTypedModal
          title={t('recycleBin.deletePermTitle')}
          danger
          description={t('recycleBin.bulkPurgeDesc', { count: selCount })}
          onClose={() => setModal(null)}
          onConfirm={doBulkPurge}
        />
      )}
    </div>
  );
}
