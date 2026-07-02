import { useState, useEffect, useMemo } from 'react';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, fmt as fmtUsd } from '../../components/shared';
import { getWarehouseStock } from '../../api/client';

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



export { StockAtWarehouseModal };
