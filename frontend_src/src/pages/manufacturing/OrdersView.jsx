import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, ExportButton } from '../../components/shared';
import { getProductionOrders } from '../../api/client';
import { num, Money, StatusPill } from './ui';
import { OrderModal } from './OrderModal';
import { OrderDetailModal } from './OrderDetailModal';
import SearchSelect from '../../components/SearchSelect.jsx';

function OrdersView({ canCreate, canEdit, canDelete, boms, refreshKey, bump }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows]   = useState(null);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [schedule, setSchedule] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(() => {
    setError(null);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (schedule) params.sort = 'schedule';
    getProductionOrders(params).then(setRows).catch(e => setError(e.message));
  }, [statusFilter, schedule]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const exportData = (rows || []).map(o => ({
    Order:      o.order_number,
    Product:    o.output_name,
    Quantity:   o.quantity_produced ?? o.quantity,
    Status:     o.status,
    Total_Cost: o.status === 'Completed' ? (o.total_cost || 0) : '',
    Created:    fmtDate(o.created_at),
  }));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {canCreate && (
          <button className="btn btn-primary btn-sm" disabled={boms.filter(b => b.is_active).length === 0}
            onClick={() => setCreating(true)}>{t('manufacturing.newOrder')}</button>
        )}
        <SearchSelect
          className="form-control"
          style={{ width: 170, height: 32, fontSize: 13 }}
          value={statusFilter}
          onChange={v => setStatusFilter(v)}
          placeholder={t('manufacturing.allStatuses')}
          options={(['Draft', 'Confirmed', 'In Progress', 'Completed', 'Cancelled']).map(s => ({ value: s, label: t(`manufacturing.st_${s.replace(/ /g, '')}`) }))} />
        <button className={`btn btn-sm ${schedule ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSchedule(s => !s)} title={t('manufacturing.scheduleHint')}>
          🗓 {t('manufacturing.scheduleView')}
        </button>
        {rows && rows.length > 0 && (
          <div style={{ marginInlineStart: 'auto' }}>
            <ExportButton data={exportData} filename="Production_Orders" sheetName="Orders" />
          </div>
        )}
      </div>
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('manufacturing.noOrders')} icon="🏭" />}
      {rows && rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('manufacturing.orderNumber')}</th>
                  <th>{t('manufacturing.product')}</th>
                  <th>{t('manufacturing.qty')}</th>
                  <th>{t('manufacturing.priority')}</th>
                  <th>{t('manufacturing.dueDate')}</th>
                  <th>{t('manufacturing.status')}</th>
                  <th>{t('manufacturing.totalCost')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(o => {
                  const open = !['Completed', 'Cancelled'].includes(o.status);
                  const overdue = o.due_date && o.due_date < today && open;
                  const prioCls = { Urgent: 'badge-red', High: 'badge-yellow', Low: 'badge-muted' }[o.priority] || 'badge-accent';
                  return (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.order_number}</td>
                    <td>{o.output_name}</td>
                    <td>{num(o.quantity_produced ?? o.quantity)}
                      {o.quantity_completed > 0 && o.quantity_completed < o.quantity && open && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}> ({num(o.quantity_completed)}/{num(o.quantity)})</span>
                      )}
                    </td>
                    <td>{o.priority && o.priority !== 'Normal'
                      ? <span className={`badge ${prioCls}`}>{t(`manufacturing.prio_${o.priority}`)}</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap', color: overdue ? 'var(--red)' : undefined, fontWeight: overdue ? 600 : undefined }}>
                      {o.due_date || '—'}{overdue ? ` ⚠` : ''}
                    </td>
                    <td><StatusPill status={o.status} /></td>
                    <td>{o.status === 'Completed' ? <Money value={o.total_cost} /> : '—'}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDetailId(o.id)}>
                        {t('manufacturing.viewOrder')}
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {creating && (
        <OrderModal boms={boms} onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); bump(); }} />
      )}
      {detailId && (
        <OrderDetailModal orderId={detailId} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)} onChanged={() => { load(); bump(); }} />
      )}
    </div>
  );
}

// ── BOMs view ───────────────────────────────────────────────────────────────

export { OrdersView };
