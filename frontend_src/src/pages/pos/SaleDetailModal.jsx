import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, Modal, ConfirmModal, Badge, toast } from '../../components/shared';
import { getPosSale, returnPosSale } from '../../api/client';
import { num } from './pricing';

function SaleDetailModal({ saleId, canReturn, onClose, onReturned }) {
  const { t, fmt, fmtDate } = useLocale();
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  const [confirmReturn, setConfirmReturn] = useState(false);

  useEffect(() => {
    getPosSale(saleId).then(setSale).catch(e => setError(e.message));
  }, [saleId]);

  async function doReturn() {
    try {
      await returnPosSale(saleId);
      toast(t('pos.saleReturned'), 'green');
      onReturned();
    } catch (e) {
      toast(e.message, 'red');
      setConfirmReturn(false);
    }
  }

  return (
    <Modal title={`${t('pos.saleNumber')} ${sale?.invoice_number || ''}`} onClose={onClose}>
      <div className="modal-body">
        {error && <ErrorAlert message={error} />}
        {!sale && !error && <LoadingSpinner />}
        {sale && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
              {sale.client_name || t('pos.walkIn')} · {fmtDate(sale.created_at)} · {sale.cashier_name}
              {' · '}<Badge status={sale.status === 'returned' ? 'Rejected' : 'Paid'} />
            </div>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr><th>{t('pos.customLineName')}</th><th>{t('pos.qty')}</th>
                    <th>{t('pos.price')}</th><th>{t('pos.discount')}</th>
                    <th style={{ textAlign: 'end' }}>{t('pos.total')}</th></tr>
              </thead>
              <tbody>
                {sale.items.map(it => {
                  const gross = Math.max(0, (Number(it.quantity) || 0) * (Number(it.unit_price) || 0)
                                            - (Number(it.discount) || 0));
                  return (
                    <tr key={it.id}>
                      <td>{it.name}</td>
                      <td>{num(it.quantity)}</td>
                      <td>{fmt(it.unit_price)}</td>
                      <td>{Number(it.discount) > 0 ? `−${fmt(it.discount)}` : '—'}</td>
                      <td style={{ textAlign: 'end' }}>{fmt(gross)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('pos.subtotal')}</span><span>{fmt(sale.subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('pos.taxTotal')}</span><span>{fmt(sale.tax_total)}</span>
              </div>
              {sale.discount_total > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green)' }}>
                  <span>{t('pos.savings')}</span><span>−{fmt(sale.discount_total)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{t('pos.total')}</span><span>{fmt(sale.amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)', marginTop: 6 }}>
                <span>{t('pos.cogs')}</span><span>{fmt(sale.cogs_total)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600,
                            color: sale.margin >= 0 ? 'var(--green)' : 'var(--red)' }}>
                <span>{t('pos.margin')}</span><span>{fmt(sale.margin)}</span>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {sale && canReturn && sale.status !== 'returned' && (
          <button className="btn btn-danger" onClick={() => setConfirmReturn(true)}>
            {t('pos.processReturn')}
          </button>
        )}
      </div>
      {confirmReturn && (
        <ConfirmModal
          title={t('pos.processReturn')}
          message={t('pos.returnConfirm')}
          confirmLabel={t('pos.processReturn')}
          confirmClass="btn-danger"
          onCancel={() => setConfirmReturn(false)}
          onConfirm={doReturn}
        />
      )}
    </Modal>
  );
}


export { SaleDetailModal };
