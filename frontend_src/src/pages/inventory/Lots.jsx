// Lot/batch traceability: the per-lot trace modal + the lots browser tab.
import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal, toast } from '../../components/shared';
import { getLots, getLot } from '../../api/client';
import { fmtNum, LOT_STATUS_BADGE } from './ui';

function LotTraceModal({ lotId, onClose }) {
  const { t, tCategory } = useLocale();
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
  const { t, tCategory } = useLocale();
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

export { LotTraceModal, LotsBrowser };
