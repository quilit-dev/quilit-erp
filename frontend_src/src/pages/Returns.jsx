// Returns: every credit note raised to a customer and every debit note raised
// to a supplier, in one place.
//
// A return is started from here (pick the invoice or purchase) or from the
// document itself. Each note can be printed, and voided while nothing has
// built on it --- the server refuses a void once the credit it gave has been
// spent or the goods it put back have been sold again.
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getSalesReturns, getPurchaseReturns, getSalesReturn, getPurchaseReturn,
  voidSalesReturn, voidPurchaseReturn, getInvoices, getPurchases,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, toast, fmt, fmtDate, ExportButton,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import { useFocusId } from '../hooks/useFocusId';
import SearchSelect from '../components/SearchSelect.jsx';
import { SalesReturnModal, PurchaseReturnModal } from '../components/ReturnModals.jsx';
import { printReturnNote } from '../utils/returnNote';

function settledAs(r, kind, t) {
  const parts = [];
  const applied = kind === 'sales' ? r.applied_to_invoice : r.applied_to_purchase;
  if (Number(applied) > 0) parts.push(`${t(kind === 'sales' ? 'returns.offInvoiceShort' : 'returns.offPurchaseShort')} ${fmt(applied)}`);
  if (Number(r.refunded) > 0) parts.push(`${t('returns.refundedShort')} ${fmt(r.refunded)}`);
  if (Number(r.credited) > 0) parts.push(`${t('returns.creditShort')} ${fmt(r.credited)}`);
  return parts.join(' · ') || '—';
}

/** Choose the invoice or purchase a new return is against. */
function PickDocument({ kind, onPick, onClose }) {
  const { t } = useLocale();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        if (kind === 'sales') {
          const d = await getInvoices({ search: q || undefined, limit: 30 });
          const list = Array.isArray(d) ? d : (d.items || []);
          if (alive) setRows(list.filter(i => !i.voided_at));
        } else {
          const d = await getPurchases();
          const list = (Array.isArray(d) ? d : (d.items || []))
            .filter(p => p.received_at && !p.voided_at)
            .filter(p => !q || `${p.po_number} ${p.supplier}`.toLowerCase().includes(q.toLowerCase()));
          if (alive) setRows(list.slice(0, 30));
        }
      } catch (e) { toast(e.message, 'red'); }
      finally { if (alive) setLoading(false); }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, kind]);

  return (
    <Modal title={t(kind === 'sales' ? 'returns.pickInvoice' : 'returns.pickPurchase')} onClose={onClose}>
      <div className="modal-body">
        <input className="form-control" autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder={t(kind === 'sales' ? 'returns.searchInvoice' : 'returns.searchPurchase')} />
        <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 10 }}>
          {loading ? <LoadingSpinner /> : !rows.length ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 8 }}>{t('common.noResults')}</div>
          ) : rows.map(r => (
            <button key={r.id} type="button" className="btn btn-secondary"
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between',
                       marginBottom: 6, textAlign: 'start' }}
              onClick={() => onPick(r.id)}>
              <span>
                <b>{kind === 'sales' ? r.invoice_number : r.po_number}</b>
                {' · '}{kind === 'sales' ? (r.client_name || '—') : r.supplier}
              </span>
              <span>{fmt(kind === 'sales' ? r.amount : (Number(r.subtotal || 0) + Number(r.tax_total || 0) + Number(r.additional_costs || 0)))}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export default function Returns() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const { kind: kindParam } = useParams();
  const navigate = useNavigate();
  const kind = kindParam === 'purchases' ? 'purchases' : 'sales';
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState('');
  const [from, setFrom]       = useState('');
  const [to, setTo]           = useState('');
  const [picking, setPicking] = useState(false);
  const [docId, setDocId]     = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy]       = useState(false);
  const [focusId] = useFocusId();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const params = { search: search || undefined, date_from: from || undefined, date_to: to || undefined };
    (kind === 'sales' ? getSalesReturns(params) : getPurchaseReturns(params))
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [kind, search, from, to]);
  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load]);

  async function print(r) {
    try {
      const note = kind === 'sales' ? await getSalesReturn(r.id) : await getPurchaseReturn(r.id);
      await printReturnNote(note, kind);
    } catch (e) { toast(e.message, 'red'); }
  }

  async function doVoid() {
    setBusy(true);
    try {
      if (kind === 'sales') await voidSalesReturn(voiding.id, voidReason || null);
      else await voidPurchaseReturn(voiding.id, voidReason || null);
      toast(t('returns.voided', { number: voiding.return_number }));
      setVoiding(null); setVoidReason(''); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  const canCreate = can('returns', 'create');
  const canVoid = can('returns', 'delete');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('returns.title')}</h1>
          <p className="page-subtitle">{t('returns.subtitle')}</p>
        </div>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setPicking(true)}>
            {t(kind === 'sales' ? 'returns.newCreditNote' : 'returns.newDebitNote')}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className={`btn btn-sm ${kind === 'sales' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => navigate('/returns/sales')}>{t('returns.creditNotes')}</button>
        <button className={`btn btn-sm ${kind === 'purchases' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => navigate('/returns/purchases')}>{t('returns.debitNotes')}</button>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input className="form-control" style={{ flex: '1 1 220px' }} value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t(kind === 'sales' ? 'returns.searchCredit' : 'returns.searchDebit')} />
        <input type="date" className="form-control" style={{ width: 160 }} value={from}
          onChange={e => setFrom(e.target.value)} aria-label={t('returns.from')} />
        <input type="date" className="form-control" style={{ width: 160 }} value={to}
          onChange={e => setTo(e.target.value)} aria-label={t('returns.to')} />
        <ExportButton
          filename={kind === 'sales' ? 'credit_notes' : 'debit_notes'}
          sheetName={t(kind === 'sales' ? 'returns.creditNotes' : 'returns.debitNotes')}
          data={rows.map(r => ({
            [t('returns.number')]: r.return_number,
            [t('common.date')]: r.return_date,
            [t(kind === 'sales' ? 'returns.invoice' : 'returns.purchase')]:
              kind === 'sales' ? r.invoice_number : r.po_number,
            [t(kind === 'sales' ? 'returns.customer' : 'returns.supplier')]:
              kind === 'sales' ? (r.client_name || '') : r.supplier,
            [t('returns.net')]: Number(r.subtotal || 0),
            [t('returns.vat')]: Number(r.tax_total || 0),
            [t('returns.total')]: Number(r.total || 0),
            [t('returns.settledAs')]: settledAs(r, kind, t),
            [t('returns.reason')]: r.reason || '',
            [t('returns.void')]: r.voided_at ? (r.void_reason || t('returns.void')) : '',
          }))} />
      </div>

      {error ? <ErrorAlert message={error} onRetry={load} />
       : loading ? <LoadingSpinner />
       : !rows.length ? <EmptyState message={t(kind === 'sales' ? 'returns.noCreditNotes' : 'returns.noDebitNotes')} />
       : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('returns.number')}</th>
                <th>{t('common.date')}</th>
                <th>{t(kind === 'sales' ? 'returns.invoice' : 'returns.purchase')}</th>
                <th>{t(kind === 'sales' ? 'returns.customer' : 'returns.supplier')}</th>
                <th style={{ textAlign: 'end' }}>{t('returns.total')}</th>
                <th>{t('returns.settledAs')}</th>
                <th>{t('returns.reason')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ opacity: r.voided_at ? 0.55 : 1,
                                        background: String(focusId) === String(r.id) ? 'var(--accent-light)' : undefined }}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {r.return_number}
                    {r.voided_at && <span className="badge badge-red" style={{ marginInlineStart: 6 }}>{t('returns.void')}</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.return_date)}</td>
                  <td>{kind === 'sales' ? r.invoice_number : r.po_number}</td>
                  <td>{kind === 'sales' ? (r.client_name || t('returns.walkIn')) : r.supplier}</td>
                  <td style={{ textAlign: 'end', fontWeight: 600 }}>{fmt(r.total)}</td>
                  <td style={{ fontSize: 12 }}>{settledAs(r, kind, t)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.reason || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'end' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => print(r)}>{t('returns.print')}</button>
                    {canVoid && !r.voided_at && (
                      <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }}
                        onClick={() => { setVoiding(r); setVoidReason(''); }}>{t('returns.voidBtn')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && (
        <PickDocument kind={kind} onClose={() => setPicking(false)}
          onPick={id => { setPicking(false); setDocId(id); }} />
      )}
      {docId && kind === 'sales' && (
        <SalesReturnModal invoiceId={docId} onClose={() => setDocId(null)} onDone={load} />
      )}
      {docId && kind === 'purchases' && (
        <PurchaseReturnModal purchaseId={docId} onClose={() => setDocId(null)} onDone={load} />
      )}
      {voiding && (
        <Modal title={t('returns.voidTitle', { number: voiding.return_number })} onClose={() => setVoiding(null)}>
          <div className="modal-body">
            <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
              {t(kind === 'sales' ? 'returns.voidExplainSales' : 'returns.voidExplainPurchase')}
            </p>
            <input className="form-control" value={voidReason} onChange={e => setVoidReason(e.target.value)}
              placeholder={t('returns.voidReason')} />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setVoiding(null)} disabled={busy}>{t('common.cancel')}</button>
            <button className="btn btn-danger" onClick={doVoid} disabled={busy}>{t('returns.voidBtn')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
