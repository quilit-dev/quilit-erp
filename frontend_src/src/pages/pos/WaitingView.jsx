/**
 * Who is waiting for goods they have already paid for.
 *
 * This sits beside the register rather than in Inventory, because the person
 * who needs it is the one who made the promise: they took the money, they gave
 * the customer a date, and they are the one the customer rings. A list of
 * obligations two screens away from the till is a list nobody reads.
 *
 * The distinction the whole screen turns on is between "still waiting" and
 * "ready to collect" — the second is a phone call somebody should make today,
 * and it is the only reason to open this at all. Ready rows sort first.
 */
import { useCallback, useEffect, useState } from 'react';
import { getCommitments, deliverCommitment, cancelCommitment } from '../../api/client';
import { LoadingSpinner, EmptyState, Modal, toast, fmt, fmtDate }
  from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

export function WaitingView({ canEdit }) {
  const { t } = useLocale();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [refund, setRefund] = useState(true);

  const load = useCallback(() => {
    getCommitments()
      .then(r => setRows(Array.isArray(r) ? r : []))
      .catch(e => { toast(e.message, 'red'); setRows([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function hand(row) {
    setBusy(row.id);
    try {
      const r = await deliverCommitment(row.id, {});
      toast(r.outstanding > 0
        ? t('waiting.partlyHanded', { n: r.delivered, left: r.outstanding })
        : t('waiting.handed'));
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(null); }
  }

  async function drop() {
    const row = cancelling;
    setCancelling(null);
    try {
      const r = await cancelCommitment(row.id, { refund });
      toast(refund ? t('waiting.cancelledRefunded', { amt: fmt(r.refunded) })
                   : t('waiting.cancelled'));
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  if (rows === null) return <LoadingSpinner />;
  if (!rows.length) {
    return <EmptyState message={t('waiting.none')} icon="📦" />;
  }

  // Ready first: those are the calls to make today. Then oldest promise first,
  // which is both the fair order and the order they will be filled in.
  const sorted = [...rows].sort((a, b) => (b.ready > 0) - (a.ready > 0));

  return (
    <div className="card">
      <div className="card-header">
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: 0 }}>
          {t('waiting.intro')}
        </p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('common.client')}</th>
              <th>{t('waiting.item')}</th>
              <th className="text-right">{t('waiting.owed')}</th>
              <th className="text-right">{t('waiting.ready')}</th>
              <th className="text-right">{t('waiting.paid')}</th>
              <th>{t('waiting.soldOn')}</th>
              <th>{t('waiting.soldBy')}</th>
              {canEdit && <th>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.id}>
                <td className="td-primary">
                  {r.client_name}
                  {r.client_phone && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                      {r.client_phone}
                    </div>
                  )}
                </td>
                <td>{r.item_name}</td>
                <td className="text-right">{r.outstanding} {r.unit || ''}</td>
                <td className="text-right">
                  {/* The only number on this row that asks for an action. */}
                  {r.ready > 0
                    ? <span className="badge badge-green">{r.ready}</span>
                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td className="text-right">{fmt(r.value)}</td>
                <td>{r.created_at ? fmtDate(r.created_at) : '—'}</td>
                <td>{r.sold_by || '—'}</td>
                {canEdit && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-primary"
                            disabled={r.ready <= 0 || busy === r.id}
                            title={r.ready <= 0 ? t('waiting.notInYet') : undefined}
                            onClick={() => hand(r)}>
                      {busy === r.id ? t('common.saving') : t('waiting.handOver')}
                    </button>
                    <button className="btn btn-sm btn-ghost"
                            style={{ marginInlineStart: 6 }}
                            onClick={() => { setRefund(true); setCancelling(r); }}>
                      {t('common.cancel')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cancelling && (
        <Modal title={t('waiting.cancelTitle')} onClose={() => setCancelling(null)}>
          <div className="modal-body">
            <p style={{ fontSize: 13.5, marginTop: 0 }}>
              {t('waiting.cancelBody', {
                n: cancelling.outstanding, item: cancelling.item_name,
                client: cancelling.client_name })}
            </p>
            {/* The money was never earned, so it is theirs either way. The only
                question is whether it goes back over the counter now or stays
                as credit — a shop that has banked it usually prefers the
                second. */}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
                            fontSize: 13 }}>
              <input type="checkbox" checked={refund}
                     onChange={e => setRefund(e.target.checked)} />
              <span>{t('waiting.refundNow', { amt: fmt(cancelling.value) })}</span>
            </label>
            {cancelling.ready > 0 && (
              <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                {t('waiting.willRelease', { n: cancelling.ready })}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setCancelling(null)}>
              {t('common.close')}
            </button>
            <button className="btn btn-danger" onClick={drop}>
              {t('waiting.confirmCancel')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
