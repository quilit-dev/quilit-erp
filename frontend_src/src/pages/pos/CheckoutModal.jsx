import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { posCheckout } from '../../api/client';
import { num } from './pricing';

function CheckoutModal({ pricing, clients, drawers, defaultCurrency = 'USD', onClose, onDone }) {
  const { t, fmt, tCategory } = useLocale();
  const { exchangeRate } = useSettings();
  const [clientId, setClientId] = useState('');
  const [method, setMethod] = useState('Cash');
  // Default the tender currency to whatever the register is showing, so a
  // cashier viewing LBP prices lands straight on LBP cash entry.
  const [currency, setCurrency] = useState(defaultCurrency === 'LBP' ? 'LBP' : 'USD');
  const [rate, setRate] = useState(exchangeRate?.rate ? String(exchangeRate.rate) : '');
  const [tendered, setTendered] = useState('');
  // An instalment sale: the customer takes the goods today and pays the rest
  // over the agreed months. Only the deposit is collected at the till.
  const [onPlan, setOnPlan] = useState(false);
  const [deposit, setDeposit] = useState('');
  const [planCount, setPlanCount] = useState('4');
  const [planFreq, setPlanFreq] = useState('monthly');
  const [planStart, setPlanStart] = useState('');
  const [planTouched, setPlanTouched] = useState(false);
  // Whether the cashier has typed in the tender box themselves. Until they
  // do, it follows the deposit on a plan sale: the money handed over at the
  // counter IS the deposit, and making them type the same figure twice is
  // what let the two disagree.
  const [tenderTouched, setTenderTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const _defDrawer = drawers.find(d => d.auto_capture) || drawers[0];
  const [drawerId, setDrawerId] = useState(_defDrawer ? String(_defDrawer.id) : '');

  // The customer's own terms: whether they may buy on credit, and the shape
  // they usually agree to. A customer record without the field (an older
  // payload) is treated as allowed, so nothing silently disappears.
  const customer = clients.find(c => String(c.id) === String(clientId));
  const notApproved = !!customer && customer.allow_installments === 0;

  // Choosing a customer brings their agreed plan shape with it, until the
  // cashier types over it — then their choice wins for the rest of the sale.
  useEffect(() => {
    if (planTouched || !customer) return;
    if (customer.default_installment_count)
      setPlanCount(String(customer.default_installment_count));
    if (customer.default_installment_frequency)
      setPlanFreq(customer.default_installment_frequency);
    // The currency they settle in, when the till supports it. POS takes USD
    // and LBP only, so a customer who prefers EUR is left on the default
    // rather than being defaulted into a currency checkout would refuse.
    if (['USD', 'LBP'].includes(customer.preferred_currency))
      setCurrency(customer.preferred_currency);
  }, [customer, planTouched]);

  const fxRate = parseFloat(rate) || 0;
  const depositNum = parseFloat(deposit) || 0;
  // What the customer hands over now: the whole sale, or the deposit on a plan.
  const dueNow = onPlan ? depositNum : pricing.total;
  const totalInCurrency = currency === 'LBP' ? dueNow * (fxRate || 0) : dueNow;
  const tenderedNum = parseFloat(tendered) || 0;
  const change = method === 'Cash' ? tenderedNum - totalInCurrency : 0;
  const balance = Math.round((pricing.total - dueNow) * 100) / 100;

  // Refused by the server too — checked here so the cashier is told which part
  // is wrong rather than getting a bare 400 with a queue behind them.
  // On a plan the cash handed over is the deposit, so the tender box follows
  // it until the cashier types their own figure — a customer paying a 100
  // deposit with a 300 note is still ordinary change-making.
  useEffect(() => {
    if (tenderTouched || method !== 'Cash') return;
    setTendered(onPlan && totalInCurrency > 0.005
      ? String(Math.round(totalInCurrency * 100) / 100)
      : '');
  }, [onPlan, totalInCurrency, tenderTouched, method]);

  // Cash typed against a plan with no deposit. Nothing is due at the till, so
  // every note of it comes straight back as change: the sale completes, the
  // balance is untouched, and the customer watches their money returned. The
  // server refuses it too — this says which box it belongs in.
  const tenderProblem = (onPlan && method === 'Cash'
      && depositNum <= 0.005 && tenderedNum > 0.005)
    ? t('pos.tenderWithNoDeposit', { amount: fmt(tenderedNum) })
    : null;

  const planProblem = !onPlan ? null
    : !clientId ? t('pos.planNeedsCustomer')
    : notApproved ? t('installments.notApproved')
    : depositNum >= pricing.total ? t('pos.planDepositTooBig')
    : Number(planCount) < 1 ? t('installments.needCount')
    : null;

  async function confirm() {
    if (currency === 'LBP' && fxRate <= 0) { toast(t('pos.exchangeRate'), 'red'); return; }
    if (method === 'Cash' && tenderedNum + 0.01 < totalInCurrency) {
      toast(t('pos.amountTendered'), 'red'); return;
    }
    if (planProblem)   { toast(planProblem, 'red'); return; }
    if (tenderProblem) { toast(tenderProblem, 'red'); return; }
    setBusy(true);
    try {
      const res = await posCheckout({
        client_id: clientId ? Number(clientId) : null,
        items: pricing.items,
        order_discount: pricing.orderDiscount,
        payment_method: method,
        currency,
        exchange_rate: currency === 'LBP' ? fxRate : null,
        amount_tendered: method === 'Cash' ? tenderedNum : totalInCurrency,
        cash_drawer_id: method === 'Cash' && drawerId ? Number(drawerId) : null,
        idempotency_key: crypto.randomUUID(),
        ...(onPlan ? {
          installment_plan: {
            down_payment: depositNum,
            count:        Number(planCount),
            frequency:    planFreq,
            start_date:   planStart || null,
          },
        } : {}),
      });
      // The checkout endpoint returns only totals + ids. Stitch in the
      // presentation data the receipt needs (line items, client name,
      // payment method, amount tendered) so the receipt doesn't have to
      // make a second roundtrip for what we already know.
      const clientName = clientId
        ? (clients.find(c => String(c.id) === String(clientId))?.name || '')
        : '';
      onDone({
        ...res,
        items:           pricing.items,
        client_name:     clientName,
        payment_method:  method,
        currency,
        exchange_rate:   currency === 'LBP' ? fxRate : null,
        amount_tendered: method === 'Cash' ? tenderedNum : totalInCurrency,
      });
    } catch (e) {
      toast(e.message, 'red');
      setBusy(false);
    }
  }

  return (
    <Modal title={t('pos.checkout')} onClose={onClose}>
      <div className="modal-body">
        <table className="table" style={{ fontSize: 13, marginBottom: 12 }}>
          <tbody>
            <tr><td>{t('pos.subtotal')}</td><td style={{ textAlign: 'end' }}>{fmt(pricing.subtotal)}</td></tr>
            <tr><td>{t('pos.taxTotal')}</td><td style={{ textAlign: 'end' }}>{fmt(pricing.taxTotal)}</td></tr>
            {pricing.discountTotal > 0 && (
              <tr><td>{t('pos.savings')}</td>
                  <td style={{ textAlign: 'end', color: 'var(--green)' }}>−{fmt(pricing.discountTotal)}</td></tr>
            )}
            <tr><td><strong>{t('pos.total')}</strong></td>
                <td style={{ textAlign: 'end' }}><strong>{fmt(pricing.total)}</strong></td></tr>
          </tbody>
        </table>
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('pos.customer')}</label>
            <select className="form-control" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">{t('pos.walkIn')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group form-full">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <input type="checkbox" checked={onPlan}
                onChange={e => { setOnPlan(e.target.checked); setTendered(''); }} />
              {t('pos.payByInstalments')}
            </label>
            {onPlan && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                {t('pos.instalmentsHint')}
              </div>
            )}
          </div>
          {onPlan && (
            <>
              <div className="form-group">
                <label className="form-label">{t('installments.deposit')}</label>
                <NumberInput className="form-control" step="0.01" min="0"
                  value={deposit} onChange={e => setDeposit(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('installments.count')}</label>
                <NumberInput className="form-control" step="1" min="1"
                  value={planCount} onChange={e => { setPlanTouched(true); setPlanCount(e.target.value); }} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('installments.frequency')}</label>
                <select className="form-control" value={planFreq}
                  onChange={e => { setPlanTouched(true); setPlanFreq(e.target.value); }}>
                  <option value="monthly">{t('installments.monthly')}</option>
                  <option value="quarterly">{t('installments.quarterly')}</option>
                  <option value="yearly">{t('installments.yearly')}</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t('installments.firstDue')}</label>
                <input type="date" className="form-control" value={planStart}
                  onChange={e => setPlanStart(e.target.value)} />
              </div>
              <div className="form-group form-full">
                {/* The balance is the number the customer will ask about. */}
                <div style={{ display: 'flex', justifyContent: 'space-between',
                              padding: '8px 12px', borderRadius: 6,
                              background: 'var(--bg-2)', fontSize: 13 }}>
                  <span>{t('pos.balanceOwed')}</span>
                  <strong>{fmt(balance)}</strong>
                </div>
                {planProblem && (
                  <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>
                    {planProblem}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="form-group">
            <label className="form-label">{t('pos.paymentMethod')}</label>
            <select className="form-control" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="Cash">{t('pos.cash')}</option>
              <option value="Card">{t('pos.card')}</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pos.currency')}</label>
            <select className="form-control" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="USD">{exchangeRate?.base || 'USD'}</option>
              {exchangeRate?.rate ? <option value="LBP">{exchangeRate.secondary || 'LBP'}</option> : null}
            </select>
          </div>
          {method === 'Cash' && drawers.length > 0 && (
            <div className="form-group form-full">
              <label className="form-label">{t('pos.cashDrawer')}</label>
              <select className="form-control" value={drawerId}
                onChange={e => setDrawerId(e.target.value)}>
                {drawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          {currency === 'LBP' && (
            <div className="form-group form-full">
              <label className="form-label">{t('pos.exchangeRate')}</label>
              <NumberInput className="form-control" step="any" min="0" value={rate}
                onChange={e => setRate(e.target.value)} />
            </div>
          )}
          {method === 'Cash' && (
            <div className="form-group form-full">
              <label className="form-label">
                {t('pos.amountTendered')} ({currency}) — {onPlan ? t('installments.deposit') : t('pos.total')}: {num(totalInCurrency)}
              </label>
              <NumberInput className="form-control" step="any" min="0" value={tendered}
                onChange={e => { setTenderTouched(true); setTendered(e.target.value); }}
                autoFocus />
            </div>
          )}
        </div>
        {tenderProblem && (
          <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8,
                        background: '#fef3c7', border: '1px solid #f59e0b',
                        fontSize: 13, color: '#78350f' }}>
            {tenderProblem}
          </div>
        )}
        {method === 'Cash' && tendered !== '' && !tenderProblem && (
          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600,
                        color: change < 0 ? 'var(--red)' : 'var(--green)' }}>
            {t('pos.change')}: {num(change)} {currency}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !!planProblem || !!tenderProblem} onClick={confirm}>
          {busy ? t('common.saving') : t('pos.completeSale')}
        </button>
      </div>
    </Modal>
  );
}

// ── Custom-line name input with inventory autocomplete ─────────────────────
// A custom line is normally a free-text service entry, but cashiers often
// type the first letters of an *existing* inventory item before remembering
// to add it from the product list. This combobox:
//   • debounces a server-side product search as the user types
//   • lets them pick a match with ↑/↓/Enter (mouse also works)
//   • on pick, mutates the line into a proper inventory-backed line — sets
//     inventory_id, unit_price (sale_price), stock, line_type and keeps the

export { CheckoutModal };
