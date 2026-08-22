// What this customer has paid, as they paid it.
//
// The ledger stores a payment as one row per invoice it settled, because that
// is what keeps every balance and statement working. Nobody remembers paying
// that way: they handed over one sum. This lists the sums, each with the
// invoices it reached, and lets the slip be printed again — the number is
// issued once by the server, so a reprint is the same receipt on fresh paper
// rather than a second claim on the same money.
import { useState, useEffect } from 'react';
import { listCustomerPayments, issuePaymentVoucher } from '../../api/client';
import { printPaymentVoucher } from '../../utils/receiptVoucher';
import { LoadingSpinner, ErrorAlert, EmptyState, fmt, fmtDate, toast } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

export default function PaymentsTab({ clientId }) {
  const { t, tEnumValue } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    listCustomerPayments(clientId)
      .then(d => { if (alive) setRows(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [clientId]);

  async function print(id) {
    setBusyId(id);
    try {
      const voucher = await issuePaymentVoucher(id);
      await printPaymentVoucher(voucher);
      // The number is allocated on first print; show it from then on.
      setRows(rs => rs.map(r => r.id === id
        ? { ...r, voucher_number: voucher.number } : r));
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <ErrorAlert message={error} />;
  if (!rows) return <LoadingSpinner />;
  if (!rows.length) return <EmptyState message={t('clients.noPayments')} />;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{t('clients.paymentsReceived')}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('clients.movementDate')}</th>
              <th>{t('invoices.methodLabel')}</th>
              <th>{t('clients.appliedTo')}</th>
              <th style={{ textAlign: 'right' }}>{t('common.total')}</th>
              <th>{t('invoices.receiptVoucher')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.id}>
                <td>{fmtDate(p.created_at)}</td>
                <td>
                  {tEnumValue(p.method || '—')}
                  {/* What they actually handed over, when that was not the
                      company currency. */}
                  {p.currency && p.currency !== 'USD' && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      {p.currency} {Number(p.paid_amount || 0).toLocaleString()}
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(p.allocated || []).map(a => (
                      <span key={a.invoice_id} className="badge badge-gray"
                        style={{ fontWeight: 500 }}>
                        {a.invoice_number} {fmt(a.applied)}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(p.amount)}</td>
                <td>
                  <button className="btn btn-sm btn-secondary"
                    onClick={() => print(p.id)} disabled={busyId === p.id}>
                    {busyId === p.id ? t('common.saving')
                      : p.voucher_number || t('invoices.printReceipt')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
