// Raising a return: a credit note against an invoice, or a debit note against a
// purchase.
//
// The screen shows each line with what was sold, what has already come back
// and what can still come back, and works out as you type how the return will
// be settled --- the part that cancels what is still owed, and the rest, which
// is refunded or kept as credit. The server recomputes every figure; these are
// a preview so the operator sees the consequence before committing to it.
import { useState, useEffect, useMemo } from 'react';
import {
  getInvoiceReturnable, createSalesReturn, getSalesReturn,
  getPurchaseReturnable, createPurchaseReturn, getPurchaseReturn,
} from '../api/client';
import { Modal, NumberInput, LoadingSpinner, ErrorAlert, toast, fmt } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from './SearchSelect.jsx';
import BankField, { useBankAccounts } from './BankField.jsx';
import { printReturnNote } from '../utils/returnNote';

const REFUND_METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card'];
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/** One line's share of net and VAT for `q` units --- the server's rule: the
 *  last units take whatever is left exactly, earlier ones are pro rata. */
function share(line, q) {
  const left = line.quantity - line.returned_quantity;
  if (q >= left - 0.0005) {
    return { net: r2(line.net - line.returned_net), tax: r2(line.tax_amount - line.returned_tax) };
  }
  return { net: r2(line.net * q / line.quantity), tax: r2(line.tax_amount * q / line.quantity) };
}

function Settlement({ kind, rest, settlement, setSettlement, method, setMethod,
                      bank, setBank, canCredit }) {
  const { t, tEnumValue } = useLocale();
  const banks = useBankAccounts();
  if (rest <= 0.005) return null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  padding: 12, marginTop: 12 }}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {t(kind === 'sales' ? 'returns.alreadyPaidSales' : 'returns.alreadyPaidPurchase',
           { amount: fmt(rest) })}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="radio" checked={settlement === 'refund'}
            onChange={() => setSettlement('refund')} />
          {t(kind === 'sales' ? 'returns.refundCustomer' : 'returns.refundFromSupplier')}
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13,
                        opacity: canCredit ? 1 : 0.5 }}>
          <input type="radio" checked={settlement === 'credit'} disabled={!canCredit}
            onChange={() => setSettlement('credit')} />
          {t(kind === 'sales' ? 'returns.keepAsCustomerCredit' : 'returns.keepAsSupplierCredit')}
        </label>
      </div>
      {!canCredit && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
          {t('returns.walkInNoCredit')}
        </div>
      )}
      {settlement === 'refund' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ margin: 0, width: 170 }}>
            <label className="form-label">{t('returns.refundMethod')}</label>
            <SearchSelect className="form-control" value={method}
              onChange={v => setMethod(v)}
              options={REFUND_METHODS.map(m => ({ value: m, label: tEnumValue(m) }))} />
          </div>
          <BankField method={method} value={bank} onChange={setBank}
            accounts={banks} style={{ width: 200 }} compact />
        </div>
      )}
    </div>
  );
}

function Done({ kind, number, id, onClose }) {
  const { t } = useLocale();
  const [printing, setPrinting] = useState(false);
  async function print() {
    setPrinting(true);
    try {
      const note = kind === 'sales' ? await getSalesReturn(id) : await getPurchaseReturn(id);
      await printReturnNote(note, kind);
    } catch (e) { toast(e.message, 'red'); }
    finally { setPrinting(false); }
  }
  return (
    <>
      <div className="modal-body" style={{ textAlign: 'center', padding: '28px 20px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
          {t(kind === 'sales' ? 'returns.creditNoteRaised' : 'returns.debitNoteRaised',
             { number })}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        <button className="btn btn-primary" onClick={print} disabled={printing}>
          {printing ? t('common.loading') : t('returns.print')}
        </button>
      </div>
    </>
  );
}

// ── Customer returns ─────────────────────────────────────────────────────────
export function SalesReturnModal({ invoiceId, onClose, onDone }) {
  const { t } = useLocale();
  const [info, setInfo]   = useState(null);
  const [error, setError] = useState(null);
  const [qty, setQty]     = useState({});
  const [cond, setCond]   = useState({});
  const [reason, setReason] = useState('');
  const [date, setDate]   = useState(today());
  const [settlement, setSettlement] = useState('refund');
  const [method, setMethod] = useState('Cash');
  const [bank, setBank]   = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone]   = useState(null);

  useEffect(() => {
    getInvoiceReturnable(invoiceId).then(setInfo).catch(e => setError(e.message));
  }, [invoiceId]);

  const preview = useMemo(() => {
    if (!info) return null;
    let net = 0, tax = 0;
    for (const l of info.lines) {
      const q = Number(qty[l.invoice_item_id]) || 0;
      if (q <= 0) continue;
      const s = share(l, Math.min(q, l.returnable_quantity));
      net += s.net; tax += s.tax;
    }
    const gross = r2(net + tax);
    const applied = r2(Math.min(gross, info.outstanding));
    return { net: r2(net), tax: r2(tax), gross, applied, rest: r2(gross - applied) };
  }, [info, qty]);

  async function submit(e) {
    e.preventDefault();
    const lines = info.lines
      .filter(l => Number(qty[l.invoice_item_id]) > 0)
      .map(l => ({ invoice_item_id: l.invoice_item_id,
                   quantity: Number(qty[l.invoice_item_id]),
                   condition: l.can_restock ? (cond[l.invoice_item_id] || 'restock') : 'none' }));
    if (!lines.length) { toast(t('returns.chooseLines'), 'red'); return; }
    setSaving(true);
    try {
      const res = await createSalesReturn({
        invoice_id: invoiceId, lines, reason: reason || null, return_date: date,
        settlement: preview.rest > 0.005 ? settlement : null,
        refund_method: settlement === 'refund' ? method : null,
        bank_account_id: settlement === 'refund' && bank ? Number(bank) : null,
      });
      toast(t('returns.creditNoteRaised', { number: res.return_number }));
      setDone(res);
      onDone?.(res);
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={info ? t('returns.returnFromInvoice', { number: info.invoice_number })
                       : t('returns.newCreditNote')}
           onClose={onClose} size="modal-wide">
      {done ? <Done kind="sales" number={done.return_number} id={done.id} onClose={onClose} />
      : error ? <div className="modal-body"><ErrorAlert message={error} /></div>
      : !info ? <div className="modal-body"><LoadingSpinner /></div>
      : (
        <form onSubmit={submit}>
          <div className="modal-body">
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13,
                          color: 'var(--text-2)', marginBottom: 12 }}>
              <span>{t('returns.invoiceTotal')}: <b>{fmt(info.amount)}</b></span>
              <span>{t('returns.paid')}: <b>{fmt(info.paid)}</b></span>
              <span>{t('returns.outstanding')}: <b>{fmt(info.outstanding)}</b></span>
              {info.customer_credit > 0 && (
                <span>{t('returns.customerCredit')}: <b>{fmt(info.customer_credit)}</b></span>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('returns.item')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.sold')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.alreadyReturned')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.unitPrice')}</th>
                    <th style={{ width: 110 }}>{t('returns.returnQty')}</th>
                    <th style={{ width: 150 }}>{t('returns.condition')}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.lines.map(l => {
                    const off = l.returnable_quantity <= 0 || !!l.blocked;
                    return (
                      <tr key={l.invoice_item_id} style={{ opacity: off ? 0.55 : 1 }}>
                        <td>
                          {l.name}
                          {l.blocked && <div style={{ fontSize: 11, color: 'var(--caution-ink)' }}>{l.blocked}</div>}
                        </td>
                        <td style={{ textAlign: 'end' }}>{+l.quantity.toFixed(3)}{l.unit ? ` ${l.unit}` : ''}</td>
                        <td style={{ textAlign: 'end' }}>{+l.returned_quantity.toFixed(3)}</td>
                        <td style={{ textAlign: 'end' }}>{fmt(l.unit_net + l.unit_tax)}</td>
                        <td>
                          <NumberInput className="form-control" min="0" step="any"
                            disabled={off} max={l.returnable_quantity}
                            value={qty[l.invoice_item_id] ?? ''}
                            placeholder={off ? '—' : `≤ ${+l.returnable_quantity.toFixed(3)}`}
                            onChange={e => setQty(s => ({ ...s, [l.invoice_item_id]: e.target.value }))} />
                        </td>
                        <td>
                          {l.can_restock ? (
                            <SearchSelect className="form-control" disabled={off}
                              value={cond[l.invoice_item_id] || 'restock'}
                              onChange={v => setCond(s => ({ ...s, [l.invoice_item_id]: v }))}
                              options={[
                                { value: 'restock', label: t('returns.condRestock') },
                                { value: 'damaged', label: t('returns.condDamaged') },
                              ]} />
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--text-3)' }}
                                  title={t('returns.noStockHint')}>{t('returns.condMoneyOnly')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <div className="form-group" style={{ margin: 0, width: 160 }}>
                <label className="form-label">{t('common.date')}</label>
                <input type="date" className="form-control" value={date} max={today()}
                  onChange={e => setDate(e.target.value)} />
              </div>
              <div className="form-group" style={{ margin: 0, flex: '1 1 240px' }}>
                <label className="form-label">{t('returns.reason')}</label>
                <input className="form-control" value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder={t('returns.reasonPlaceholder')} />
              </div>
            </div>

            {preview.gross > 0 && (
              <div style={{ marginTop: 12, fontSize: 13, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <span>{t('returns.net')}: <b>{fmt(preview.net)}</b></span>
                <span>{t('returns.vat')}: <b>{fmt(preview.tax)}</b></span>
                <span>{t('returns.total')}: <b>{fmt(preview.gross)}</b></span>
                {preview.applied > 0 && (
                  <span>{t('returns.offTheInvoice')}: <b>{fmt(preview.applied)}</b></span>
                )}
              </div>
            )}

            <Settlement kind="sales" rest={preview.rest} settlement={settlement}
              setSettlement={setSettlement} method={method} setMethod={setMethod}
              bank={bank} setBank={setBank} canCredit={!!info.client_id} />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving || !Object.values(qty).some(v => Number(v) > 0)}>
              {saving ? t('common.saving') : t('returns.raiseCreditNote')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Returns to suppliers ─────────────────────────────────────────────────────
export function PurchaseReturnModal({ purchaseId, onClose, onDone }) {
  const { t } = useLocale();
  const [info, setInfo]   = useState(null);
  const [error, setError] = useState(null);
  const [qty, setQty]     = useState({});
  const [reason, setReason] = useState('');
  const [date, setDate]   = useState(today());
  const [settlement, setSettlement] = useState('refund');
  const [method, setMethod] = useState('Cash');
  const [bank, setBank]   = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone]   = useState(null);

  useEffect(() => {
    getPurchaseReturnable(purchaseId).then(setInfo).catch(e => setError(e.message));
  }, [purchaseId]);

  const preview = useMemo(() => {
    if (!info) return null;
    let net = 0, tax = 0;
    for (const l of info.lines) {
      const q = Number(qty[l.purchase_item_id]) || 0;
      if (q <= 0) continue;
      const s = share(l, Math.min(q, l.returnable_quantity));
      net += s.net; tax += s.tax;
    }
    const gross = r2(net + tax);
    const applied = r2(Math.min(gross, info.outstanding));
    return { net: r2(net), tax: r2(tax), gross, applied, rest: r2(gross - applied) };
  }, [info, qty]);

  async function submit(e) {
    e.preventDefault();
    const lines = info.lines
      .filter(l => Number(qty[l.purchase_item_id]) > 0)
      .map(l => ({ purchase_item_id: l.purchase_item_id, quantity: Number(qty[l.purchase_item_id]) }));
    if (!lines.length) { toast(t('returns.chooseLines'), 'red'); return; }
    setSaving(true);
    try {
      const res = await createPurchaseReturn({
        purchase_id: purchaseId, lines, reason: reason || null, return_date: date,
        settlement: preview.rest > 0.005 ? settlement : null,
        refund_method: settlement === 'refund' ? method : null,
        bank_account_id: settlement === 'refund' && bank ? Number(bank) : null,
      });
      toast(t('returns.debitNoteRaised', { number: res.return_number }));
      setDone(res);
      onDone?.(res);
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={info ? t('returns.returnToSupplierTitle', { number: info.po_number })
                       : t('returns.newDebitNote')}
           onClose={onClose} size="modal-wide">
      {done ? <Done kind="purchases" number={done.return_number} id={done.id} onClose={onClose} />
      : error ? <div className="modal-body"><ErrorAlert message={error} /></div>
      : !info ? <div className="modal-body"><LoadingSpinner /></div>
      : !info.received ? (
        <div className="modal-body"><ErrorAlert message={t('returns.notReceived')} /></div>
      ) : (
        <form onSubmit={submit}>
          <div className="modal-body">
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13,
                          color: 'var(--text-2)', marginBottom: 12 }}>
              <span>{t('returns.supplier')}: <b>{info.supplier}</b></span>
              <span>{t('returns.purchaseTotal')}: <b>{fmt(info.amount)}</b></span>
              <span>{t('returns.paid')}: <b>{fmt(info.paid)}</b></span>
              <span>{t('returns.outstanding')}: <b>{fmt(info.outstanding)}</b></span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('returns.item')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.bought')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.alreadyReturned')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.inStock')}</th>
                    <th style={{ textAlign: 'end' }}>{t('returns.unitPrice')}</th>
                    <th style={{ width: 110 }}>{t('returns.returnQty')}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.lines.map(l => {
                    const off = l.returnable_quantity <= 0;
                    return (
                      <tr key={l.purchase_item_id} style={{ opacity: off ? 0.55 : 1 }}>
                        <td>{l.name}</td>
                        <td style={{ textAlign: 'end' }}>{+l.quantity.toFixed(3)}</td>
                        <td style={{ textAlign: 'end' }}>{+l.returned_quantity.toFixed(3)}</td>
                        <td style={{ textAlign: 'end' }}>{l.on_hand == null ? '—' : +Number(l.on_hand).toFixed(3)}</td>
                        <td style={{ textAlign: 'end' }}>{fmt(l.unit_price + l.unit_tax)}</td>
                        <td>
                          <NumberInput className="form-control" min="0" step="any"
                            disabled={off} max={l.returnable_quantity}
                            value={qty[l.purchase_item_id] ?? ''}
                            placeholder={off ? '—' : `≤ ${+l.returnable_quantity.toFixed(3)}`}
                            onChange={e => setQty(s => ({ ...s, [l.purchase_item_id]: e.target.value }))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <div className="form-group" style={{ margin: 0, width: 160 }}>
                <label className="form-label">{t('common.date')}</label>
                <input type="date" className="form-control" value={date} max={today()}
                  onChange={e => setDate(e.target.value)} />
              </div>
              <div className="form-group" style={{ margin: 0, flex: '1 1 240px' }}>
                <label className="form-label">{t('returns.reason')}</label>
                <input className="form-control" value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder={t('returns.reasonPlaceholderSupplier')} />
              </div>
            </div>

            {preview.gross > 0 && (
              <div style={{ marginTop: 12, fontSize: 13, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <span>{t('returns.net')}: <b>{fmt(preview.net)}</b></span>
                <span>{t('returns.vat')}: <b>{fmt(preview.tax)}</b></span>
                <span>{t('returns.total')}: <b>{fmt(preview.gross)}</b></span>
                {preview.applied > 0 && (
                  <span>{t('returns.offWhatWeOwe')}: <b>{fmt(preview.applied)}</b></span>
                )}
              </div>
            )}

            <Settlement kind="purchases" rest={preview.rest} settlement={settlement}
              setSettlement={setSettlement} method={method} setMethod={setMethod}
              bank={bank} setBank={setBank} canCredit />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving || !preview.gross}>
              {saving ? t('common.saving') : t('returns.raiseDebitNote')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
