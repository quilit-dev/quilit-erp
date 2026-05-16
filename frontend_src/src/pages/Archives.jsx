import { useState, useEffect, useCallback } from 'react';
import { getArchives, unarchiveItem } from '../api/client.js';
import {
  LoadingSpinner, ErrorAlert, EmptyState, ConfirmModal, toast, fmtDate,
} from '../components/shared.jsx';

const MODULE_COLORS = {
  clients:    'badge-blue',
  projects:   'badge-green',
  quotations: 'badge-accent',
  invoices:   'badge-blue',
  inventory:  'badge-gray',
  purchases:  'badge-gray',
  suppliers:  'badge-gray',
};

const MODULE_LABELS = {
  clients:    'Clients',
  projects:   'Projects',
  quotations: 'Quotations',
  invoices:   'Invoices',
  inventory:  'Inventory',
  purchases:  'Purchases',
  suppliers:  'Suppliers',
};

export default function Archives() {
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [module,    setModule]    = useState('');
  const [search,    setSearch]    = useState('');
  const [restoreId, setRestoreId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (module) params.module = module;
      if (search) params.search = search;
      const data = await getArchives(params);
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [module, search]);

  useEffect(() => { load(); }, [load]);

  async function handleRestore() {
    if (!restoreId) return;
    try {
      const item = items.find(i => i.id === restoreId.id && i.module === restoreId.module);
      await unarchiveItem(restoreId.module, restoreId.id);
      toast(`"${item?.label || restoreId.id}" restored successfully`);
      setRestoreId(null);
      load();
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  const restoreItem = restoreId ? items.find(i => i.id === restoreId.id && i.module === restoreId.module) : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Archives</h1>
          <p className="page-subtitle">
            {items.length > 0
              ? `${items.length} archived record${items.length !== 1 ? 's' : ''} — restore any item to return it to its module.`
              : 'All archived records — restore any item to return it to its module.'}
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 180 }}>
            <svg
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              className="form-control"
              style={{ paddingLeft: 32, height: 34, fontSize: 13 }}
              placeholder="Search by name…"
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
            <option value="">All modules</option>
            {Object.entries(MODULE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          {(search || module) && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => { setSearch(''); setModule(''); }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading ? <LoadingSpinner /> : items.length === 0 ? (
        <EmptyState
          icon="🗄️"
          message={module
            ? `No archived ${MODULE_LABELS[module] || module} found.`
            : 'Nothing has been archived yet.'}
        />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Name / Reference</th>
                  <th>Archived On</th>
                  <th>Reason</th>
                  <th style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={`${item.module}-${item.id}`}>
                    <td>
                      <span className={`badge ${MODULE_COLORS[item.module] || 'badge-gray'}`}>
                        {MODULE_LABELS[item.module] || item.module}
                      </span>
                    </td>
                    <td className="td-primary">{item.label}</td>
                    <td style={{ fontSize: 13, color: 'var(--text-2)' }}>
                      {item.archived_at ? fmtDate(item.archived_at) : '—'}
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--text-3)' }}>
                      {item.archive_reason || '—'}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setRestoreId({ id: item.id, module: item.module })}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {restoreId && (
        <ConfirmModal
          title="Restore from Archive"
          message={`Restore "${restoreItem?.label || ''}" from ${MODULE_LABELS[restoreId.module] || restoreId.module}? The record will reappear in the main list.${restoreItem?.archive_reason ? ` (Archive reason: ${restoreItem.archive_reason})` : ''}`}
          confirmLabel="Restore"
          confirmClass="btn-primary"
          onConfirm={handleRestore}
          onCancel={() => setRestoreId(null)}
        />
      )}
    </div>
  );
}
