import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, Badge, ExportButton } from '../../components/shared';
import { getPosSales } from '../../api/client';
import { SaleDetailModal } from './SaleDetailModal';

function HistoryView({ canReturn }) {
  const { t, fmt, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getPosSales().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!rows) return <LoadingSpinner />;
  if (rows.length === 0) return <EmptyState message={t('pos.noSales')} />;

  // Flat shape — keys become Excel column headers when XLSX.json_to_sheet
  // serialises this. Use the same column order the table uses.
  const exportData = rows.map(s => ({
    Sale:          s.invoice_number,
    Customer:      s.client_name || 'Walk-in',
    Cashier:       s.cashier_name || '',
    Payment:       s.payment_method || '',
    Total_USD:     s.total_usd || 0,
    Total_LBP:     s.total_lbp || 0,
    Discount:      s.discount_total || 0,
    COGS:          s.cogs_total || 0,
    Status:        s.status === 'returned' ? 'Returned' : 'Paid',
    Date:          fmtDate(s.created_at),
  }));

  return (
    <div className="card">
      {openId && (
        <SaleDetailModal
          saleId={openId} canReturn={canReturn}
          onClose={() => setOpenId(null)}
          onReturned={() => { setOpenId(null); load(); }}
        />
      )}
      <div className="card-header" style={{ justifyContent: 'flex-end' }}>
        <ExportButton data={exportData} filename="POS_Sales" sheetName="Sales" />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('pos.saleNumber')}</th>
            <th>{t('pos.customer')}</th>
            <th>{t('pos.cashier')}</th>
            <th>{t('pos.paymentMethod')}</th>
            <th>{t('pos.total')}</th>
            <th>{t('pos.status')}</th>
            <th>{t('common.date')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td>{s.invoice_number}</td>
              <td>{s.client_name || t('pos.walkIn')}</td>
              <td>{s.cashier_name}</td>
              <td>{s.payment_method}</td>
              <td>{fmt(s.total_usd)}</td>
              <td><Badge status={s.status === 'returned' ? 'Rejected' : 'Paid'} /></td>
              <td>{fmtDate(s.created_at)}</td>
              <td>
                <button className="btn btn-secondary btn-sm" onClick={() => setOpenId(s.id)}>
                  {t('pos.viewSale')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export { HistoryView };
