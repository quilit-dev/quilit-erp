import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, Modal, ConfirmModal, toast } from '../../components/shared';
import { getProductionOrder, confirmProductionOrder, startProductionOrder, cancelProductionOrder, archiveProductionOrder } from '../../api/client';
import { num, Money, StatusPill, TypeTag } from './ui';
import { CompleteModal } from './CompleteModal';

function OrderDetailModal({ orderId, canEdit, canDelete, onClose, onChanged }) {
  const { t, fmtDate } = useLocale();
  const [order, setOrder]   = useState(null);
  const [error, setError]   = useState(null);
  const [confirm, setConfirm] = useState(null);   // 'cancel' | null
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy]     = useState(false);

  const load = useCallback(() => {
    setError(null);
    getProductionOrder(orderId).then(setOrder).catch(e => setError(e.message));
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  async function act(fn, okMsg) {
    setBusy(true);
    try { await fn(); toast(okMsg, 'green'); setConfirm(null); load(); onChanged(); }
    catch (e) { toast(e.message, 'red'); setConfirm(null); }
    finally { setBusy(false); }
  }

  const status = order?.status;
  const isCompleted = status === 'Completed';

  return (
    <Modal title={order ? order.order_number : t('manufacturing.title')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!order && !error && <LoadingSpinner />}
        {order && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
              <StatusPill status={order.status} />
              <span>{order.output_name} <TypeTag type={order.output_product_type} /></span>
              <span style={{ color: 'var(--text-3)' }}>· {t('manufacturing.bomVersion', { v: order.bom_version || 1 })}</span>
              <span style={{ color: 'var(--text-3)' }}>· {fmtDate(order.created_at)}</span>
            </div>

            {order.notes && (
              <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>{order.notes}</p>
            )}

            {!isCompleted && status !== 'Cancelled' && (
              <div className={`alert alert-${order.can_build ? 'green' : 'red'}`} style={{ marginBottom: 10 }}>
                {order.can_build ? t('manufacturing.canBuild') : t('manufacturing.cannotBuild')}
              </div>
            )}

            <h4 style={{ margin: '4px 0 6px', fontSize: 14 }}>
              {isCompleted ? t('manufacturing.materialsUsed') : t('manufacturing.materialsPlan')}
            </h4>
            <div className="table-wrap">
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>{t('manufacturing.component')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.planned')}</th>
                    {!isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.onHand')}</th>}
                    {!isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.reserved')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.consumed')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.variance')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.scrapped')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.lineCost')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {order.items.map(it => (
                    <tr key={it.id}>
                      <td>
                        {it.name}
                        {it.scrap_pct > 0 && (
                          <span style={{ fontSize: 11, color: 'var(--text-3)', marginInlineStart: 6 }}>
                            +{num(it.scrap_pct)}% {t('manufacturing.scrap')}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'end' }}>{num(it.quantity_required)}</td>
                      {!isCompleted && (
                        <td style={{ textAlign: 'end', color: it.short ? 'var(--red)' : undefined }}>
                          {it.on_hand == null ? '—' : num(it.on_hand)}
                          {it.short && <span className="badge badge-red" style={{ marginInlineStart: 6 }}>{t('manufacturing.shortBadge')}</span>}
                        </td>
                      )}
                      {!isCompleted && <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(it.reserved)}</td>}
                      {isCompleted && <td style={{ textAlign: 'end' }}>{num(it.quantity_consumed)}</td>}
                      {isCompleted && (
                        <td style={{ textAlign: 'end',
                          color: it.variance > 0 ? 'var(--red)' : it.variance < 0 ? 'var(--green)' : 'var(--text-3)' }}>
                          {it.variance == null ? '—' : (it.variance > 0 ? '+' : '') + num(it.variance)}
                        </td>
                      )}
                      {isCompleted && <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(it.quantity_scrapped)}</td>}
                      {isCompleted && <td style={{ textAlign: 'end' }}><Money value={it.line_cost} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span>
                <Money value={order.materials_cost} />
              </div>
              {/* Per-resource overhead breakdown (with frozen hours) when present. */}
              {(order.resources || []).filter(r => r.cost > 0).map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                  <span>{r.name}{r.hours ? ` · ${num(r.hours)}h` : ''}</span><Money value={r.cost} />
                </div>
              ))}
              {order.labor_cost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                  <span>{t('manufacturing.laborCost')}</span><Money value={order.labor_cost} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}{order.production_hours ? ` · ${num(order.production_hours)}h` : ''}</span>
                <Money value={order.overhead_cost} />
              </div>
              {isCompleted && order.scrap_cost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--red)' }}>
                  <span>{t('manufacturing.scrapCost')}</span><Money value={order.scrap_cost} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.totalCost')}</span><Money value={order.total_cost} />
              </div>
              {isCompleted && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                    <span>{t('manufacturing.unitCost')}</span>
                    <span><Money value={order.unit_cost} /> {t('manufacturing.perUnit')}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                    <span>{t('manufacturing.outputPlannedVsActual')}</span>
                    <span>{num(order.quantity)} → {num(order.quantity_produced)}
                      {order.output_variance != null && order.output_variance !== 0 && (
                        <span style={{ color: order.output_variance < 0 ? 'var(--red)' : 'var(--green)', marginInlineStart: 4 }}>
                          ({order.output_variance > 0 ? '+' : ''}{num(order.output_variance)})
                        </span>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>

            {((order.produced_lots && order.produced_lots.length > 0) ||
              (order.consumed_lots && order.consumed_lots.length > 0)) && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.lots')}</h4>
                {order.produced_lots && order.produced_lots.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>{t('manufacturing.producedLots')}</div>
                    {order.produced_lots.map(l => (
                      <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                        <span className="text-mono">{l.lot_number}</span>
                        <span style={{ color: 'var(--text-2)' }}>
                          {num(l.original_quantity)}{l.expiry_date ? ` · ${t('manufacturing.exp')} ${l.expiry_date}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {order.consumed_lots && order.consumed_lots.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>{t('manufacturing.consumedLots')}</div>
                    <table className="table" style={{ fontSize: 12 }}><tbody>
                      {order.consumed_lots.map((l, i) => (
                        <tr key={i}>
                          <td>{l.item_name}</td>
                          <td className="text-mono">{l.lot_number}</td>
                          <td style={{ textAlign: 'end' }}>{num(l.quantity)}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                )}
              </>
            )}

            {order.movements && order.movements.length > 0 && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.stockMovements')}</h4>
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>
                    {order.movements.map(m => (
                      <tr key={m.id}>
                        <td>{m.item_name}</td>
                        <td style={{ color: 'var(--text-3)' }}>{m.note}</td>
                        <td style={{ textAlign: 'end', fontWeight: 600,
                          color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {m.delta >= 0 ? '+' : ''}{num(m.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {order.cancel_reason && status === 'Cancelled' && (
              <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>
                {t('manufacturing.cancelledReason', { reason: order.cancel_reason })}
              </p>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {order && canEdit && status === 'Draft' && (
          <button className="btn btn-primary" disabled={busy}
            onClick={() => act(() => confirmProductionOrder(order.id), t('manufacturing.orderConfirmed'))}>
            {t('manufacturing.confirm')}
          </button>
        )}
        {order && canEdit && status === 'Confirmed' && (
          <button className="btn btn-primary" disabled={busy}
            onClick={() => act(() => startProductionOrder(order.id), t('manufacturing.orderStarted'))}>
            {t('manufacturing.start')}
          </button>
        )}
        {order && canEdit && status === 'In Progress' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setCompleting(true)}>
            {t('manufacturing.complete')}
          </button>
        )}
        {order && canEdit && ['Draft', 'Confirmed', 'In Progress'].includes(status) && (
          <button className="btn btn-secondary btn-danger" disabled={busy} onClick={() => setConfirm('cancel')}>
            {t('manufacturing.cancel')}
          </button>
        )}
        {order && canDelete && (status === 'Completed' || status === 'Cancelled') && (
          <button className="btn btn-secondary" disabled={busy}
            onClick={() => act(() => archiveProductionOrder(order.id), t('manufacturing.archived'))}>
            {t('manufacturing.archive')}
          </button>
        )}
      </div>
      {completing && order && (
        <CompleteModal order={order} onClose={() => setCompleting(false)}
          onDone={() => { setCompleting(false); load(); onChanged(); }} />
      )}
      {confirm === 'cancel' && (
        <ConfirmModal title={t('manufacturing.cancel')} message={t('manufacturing.cancelConfirm')}
          confirmLabel={t('manufacturing.cancel')} confirmClass="btn-danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => act(() => cancelProductionOrder(order.id, null), t('manufacturing.orderCancelled'))} />
      )}
    </Modal>
  );
}

// ── Orders view ─────────────────────────────────────────────────────────────

export { OrderDetailModal };
