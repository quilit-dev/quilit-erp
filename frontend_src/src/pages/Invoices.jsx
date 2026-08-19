import { useState, useRef, useEffect } from 'react';
import { useData } from '../hooks/useData';
import { useServerList } from '../hooks/useServerList';
import { useSettings } from '../hooks/useSettings';
import {
  getInvoices, getInvoice, getClients, getProjects, getInventory,
  createInvoice, updateInvoice, voidInvoice, unvoidInvoice,
  addInvoicePayment, deleteInvoicePayment, getCashDrawers, promoPreview, issueReceiptVoucher
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination,
  DualMoney, ExchangeRateBadge, DisplayCurrencyToggle, NumberInput, BranchField} from '../components/shared';
import { exportInvoicePDF, exportInvoiceExcel } from '../utils/exportUtils';
import { printReceiptVoucher } from '../utils/receiptVoucher';
import InventoryCombobox, { salePriceInBase } from '../components/InventoryCombobox';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import Attachments from '../components/Attachments.jsx';
import PaymentPlan from './invoices/PaymentPlan.jsx';
import { useRecordExport } from '../hooks/useRecordExport';
import { useFocusId } from '../hooks/useFocusId';
const METHODS    = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
// `discount` (in functional currency) is opt-in via Settings → "Enable
// per-line discounts". When the toggle is off the field stays 0 and the
// column is hidden — the rest of the form behaves exactly as before.

// Live promotion preview for a document form.
//
// The form computes its own running totals, so without this it showed a discount
// of zero while the server was about to apply one — the operator agreed a figure
// with the customer that the saved document then contradicted.
//
// The server prices the lines, using the same helper the save path uses, so the
// preview cannot disagree with what is stored.
function usePromoPreview(items, enabled) {
  const [promo, setPromo] = useState({});   // index -> { discount, promotion_name }

  // Only the fields that can change a promotion decision, so typing a
  // description does not re-price on every keystroke.
  const key = JSON.stringify((items || []).map(i => [
    i.inventory_id ?? null, Number(i.quantity) || 0,
    Number(i.unit_price) || 0, Number(i.discount) || 0,
  ]));

  useEffect(() => {
    if (!enabled) { setPromo({}); return undefined; }
    const lines = JSON.parse(key).map(([inventory_id, quantity, unit_price, discount]) =>
      ({ inventory_id, quantity, unit_price, discount }));
    if (!lines.some(l => l.inventory_id)) { setPromo({}); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      promoPreview(lines)
        .then(r => {
          if (!alive) return;
          const next = {};
          (r?.lines || []).forEach((l, i) => {
            if (l.source === 'promotion' && l.discount > 0) next[i] = l;
          });
          setPromo(next);
        })
        .catch(() => { if (alive) setPromo({}); });   // a preview must never block entry
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, enabled]);

  return promo;
}

// discount starts EMPTY, not 0: an empty box invites the promotion to fill
// it, while a typed 0 is a decision the promotion must not overwrite.
// `discount_auto` stays true until a person edits the field.
const EMPTY_ITEM = { name: '', quantity: 1, unit_price: 0, discount_pct: '',
                     discount_auto: true, inventory_id: null, tax_rate_id: null };
const EMPTY_FORM = { quotation_id: '', project_id: '', client_id: '', due_date: '', notes: '', branch_id: '', items: [{ ...EMPTY_ITEM }] };
import { ActionMenu } from './invoices/ActionMenu';

export default function Invoices() {
  const { t, tStatus, tEnumValue } = useLocale();
  const { can } = usePermissions();
  // Invoices use Void/Unvoid as their lifecycle, not archive — no in-module
  // "Show archived" view here.
  const [statusFilter,  setStatusFilter]  = useState('');
  const [clientFilter,  setClientFilter]  = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  // Paged, searched and sorted BY THE SERVER. This screen used to download
  // every invoice and do all three in the browser — 1,984 ms and 19.8 MB at
  // 40,000 rows, on every open. The filters above travel as query params.
  const list = useServerList(
    (query, s) => getInvoices(query, s),
    {
      status:     statusFilter  || undefined,
      client_id:  clientFilter  || undefined,
      project_id: projectFilter || undefined,
    },
  );
  const { items: pagedInvoices, total, loading, error, reload,
          page, pageSize, totalPages, setPage, setPageSize,
          sortKey, sortDir, requestSort, search, setSearch,
          isFiltered, PAGE_SIZES } = list;
  const { data: clients  } = useData((s) => getClients({}, s));
  const { data: projects } = useData((s) => getProjects({}, s));
  const { data: inventory } = useData((s) => getInventory({}, s));
  const { settings, exchangeRate, displayCurrency, taxRates } = useSettings();

  // Global-search deep link (?focus=<id>) → open that invoice's detail.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId == null) return;
    // Fetched by id rather than looked up in the loaded rows. The list is one
    // page now, so a link from global search or a client's invoice list points
    // at a record that is usually NOT on it — the old lookup simply found
    // nothing and the link silently did nothing.
    let alive = true;
    getInvoice(focusId)
      .then(inv => { if (alive && inv) { openPayModal(inv); clearFocus(); } })
      .catch(() => { /* deleted or not visible to this user — ignore */ });
    return () => { alive = false; };
  }, [focusId]);

  const taxEnabled      = settings?.tax_enabled === '1';
  // Setting → "Enable per-line discounts" drives both the visible column
  // and whether the line discounts roll into the invoice totals.
  const discountEnabled = settings?.show_discount_col === '1';
  const activeTaxRates  = (taxRates || []).filter(r => r.is_active);
  const defaultTaxRate  = (taxRates || []).find(r => r.is_default) || null;
  const rateById = (id) =>
    (taxRates || []).find(r => r.id === id) || defaultTaxRate || null;
  // Per-line net = qty × price − discount (when enabled), floored at 0.
  // Tax on the line uses the discounted net so the customer is taxed on
  // what they actually pay, matching how the backend prices.
  // `i` is the line index, needed to look up the promotion preview for it.
  const lineNet = (item, i) => {
    const gross = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    return Math.max(0, gross - effDiscount(item, i));
  };
  const lineTaxAmt = (item, i) => {
    if (!taxEnabled) return 0;
    const r = rateById(item.tax_rate_id);
    return r ? lineNet(item, i) * (Number(r.rate) || 0) / 100 : 0;
  };


  const [formModal,     setFormModal]     = useState(false);
  const [form,          setForm]          = useState(EMPTY_FORM);
  // What the server WILL apply on save, shown live so the running total the
  // operator quotes matches the document that gets stored.
  const promoLines = usePromoPreview(form.items, true);
  // A promotion reduces what the customer owes whether or not the company uses
  // manual per-line discounts, so its effect is counted even when the discount
  // COLUMN is switched off — an invisible reduction that changes the total is
  // how a document stops adding up.
  // The field is a PERCENTAGE; money is derived from it, exactly as the server
  // does, so the running total matches what gets stored.
  const effDiscountPct = (item, i) => {
    // Touched means a person decided, and their number stands — including 0.
    if (item.discount_auto === false) return Number(item.discount_pct) || 0;
    return Number(promoLines[i]?.discount_pct) || 0;
  };
  const effDiscount = (item, i) => {
    const gross = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    return Math.round(gross * effDiscountPct(item, i)) / 100;
  };
  const [editId,        setEditId]        = useState(null);
  const [editVersion,   setEditVersion]   = useState(null);
  const [amountsLocked, setAmountsLocked] = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [formLoading,   setFormLoading]   = useState(false);

  const [voidId,     setVoidId]     = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding,    setVoiding]    = useState(false);

  const [payModal,   setPayModal]   = useState(null);
  const [payLoading, setPayLoading] = useState(false);
  const [payForm,    setPayForm]    = useState({ amount: '', method: 'Cash', note: '', currency: 'USD', rate: '', cash_drawer_id: '' });
  const [cashDrawers, setCashDrawers] = useState([]);
  useEffect(() => {
    getCashDrawers().then(d => setCashDrawers((d || []).filter(x => x.is_active))).catch(() => {});
  }, []);
  const [paySubmitting, setPaySubmitting] = useState(false);

  const { exportLoading, handleExport } = useRecordExport({
    fetchFull:   getInvoice,
    exportPDF:   exportInvoicePDF,
    exportExcel: exportInvoiceExcel,
    getClients:  () => clients,
    getExportOpts: () => ({ displayCurrency, exchangeRate }),
  });

  // The receipt voucher rides alongside the exports but is not one of them: it
  // needs a number from the server first, and that call is what allocates it.
  const [receiptLoading, setReceiptLoading] = useState({});
  async function handleReceipt(inv) {
    setReceiptLoading(prev => ({ ...prev, [inv.id]: 'receipt' }));
    try {
      const full    = await getInvoice(inv.id);
      const client  = clients.find(c => c.id === full.client_id) || null;
      const voucher = await issueReceiptVoucher(inv.id);
      await printReceiptVoucher({ ...full, client }, voucher,
        { displayCurrency, exchangeRate });
    } catch (err) {
      // The server's refusals say WHY (voided / nothing paid); surface that
      // rather than a generic failure.
      toast(err.message || t('invoices.receiptFailed'), 'red');
    } finally {
      setReceiptLoading(prev => ({ ...prev, [inv.id]: null }));
    }
  }


  function openCreate() { setForm(EMPTY_FORM); setEditId(null); setFormModal(true); }


  async function openEdit(inv) {
    if (inv.voided_at || inv.payment_status === 'Void') {
      toast('Voided invoices cannot be edited.', 'red'); return;
    }
    setEditId(inv.id);
    setFormLoading(true);
    setFormModal(true);
    try {
      const full = await getInvoice(inv.id);
      setEditVersion(full.version ?? null);
      setAmountsLocked(!!full.amounts_locked);
      setForm({
        quotation_id: full.quotation_id || '',
        project_id:   full.project_id   || '',
        client_id:    full.client_id    || '',
        due_date:     full.due_date     || '',
        notes:        full.notes        || '',
        branch_id:    full.branch_id    ?? '',
        items: full.items?.length
          ? full.items.map(i => ({
              name: i.name,
              quantity: i.quantity,
              unit_price: i.unit_price,
              // Older lines stored only money. Derive a percentage so the box
              // has something to show, but see the payload note: an untouched
              // line sends no percentage, so the original amount is preserved
              // exactly rather than recomputed from a rounded figure.
              discount_pct: i.discount_pct != null ? i.discount_pct
                : (Number(i.discount) > 0 && Number(i.quantity) * Number(i.unit_price) > 0
                    ? Math.round(Number(i.discount) / (Number(i.quantity) * Number(i.unit_price)) * 10000) / 100
                    : ''),
              // A discount that came FROM a promotion stays "auto", so re-saving
              // re-derives it and keeps the attribution. A hand-entered one is
              // marked manual, so the promotion cannot overwrite the figure
              // someone agreed with the customer.
              discount_auto: !(Number(i.discount) > 0 && !i.promotion_id),
              // Carried back so re-saving an edited document keeps the stock
              // link — losing it here would drop the promotion on every edit.
              inventory_id: i.inventory_id ?? null,
              tax_rate_id: i.tax_rate_id ?? null,
            }))
          : [{ ...EMPTY_ITEM }],
      });
    } catch (err) {
      toast(`Could not load invoice: ${err.message}`, 'red');
      setFormModal(false);
    } finally { setFormLoading(false); }
  }

  const addItem    = ()              => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }));
  const removeItem = (i)             => setForm(f => ({ ...f, items: f.items.filter((_, x) => x !== i) }));
  const setItem    = (i, field, val) => setForm(f => ({
    ...f, items: f.items.map((item, x) => x === i ? { ...item, [field]: val } : item),
  }));
  // Picking an inventory item fills its SALE price (converted into the document
  // currency) and remembers which stock item it was. The user can still type over
  // the price afterwards — the fill is a starting point, never a lock.
  //
  // A price that cannot be converted confidently is left alone rather than
  // guessed: an LBP figure written into a USD invoice looks like a real number.
  // Editing the discount makes it a human decision. `discount_auto` going
  // false is what lets an explicit 0 survive the server's promotion pass.
  const setItemDiscount = (i, val) => setForm(f => ({
    ...f, items: f.items.map((item, x) =>
      x === i ? { ...item, discount_pct: val, discount_auto: false } : item),
  }));

  const setItemFromInventory = (i, name, price, meta) => setForm(f => ({
    ...f, items: f.items.map((item, x) => {
      if (x !== i) return item;
      const base = salePriceInBase(price, meta?.price_currency, exchangeRate,
                                   settings?.default_currency || 'USD');
      return {
        ...item, name,
        ...(base !== null ? { unit_price: base } : {}),
        inventory_id: meta?.inventory_id ?? null,
      };
    }),
  }));
  // Subtotal uses the discounted net per line so the form preview matches
  // what the backend pricing engine computes.
  const invoiceSubtotal  = (form.items || []).reduce((s, it, i) => s + lineNet(it, i), 0);
  const invoiceDiscount  = discountEnabled
    ? (form.items || []).reduce((s, it, i) => s + effDiscount(it, i), 0)
    : 0;
  const invoiceTaxAmt    = (form.items || []).reduce((s, it, i) => s + lineTaxAmt(it, i), 0);
  const invoiceTotal     = invoiceSubtotal + invoiceTaxAmt;

  async function handleSave(e) {
    e.preventDefault(); setSaving(true);
    try {
      // Amount = discounted net, matching the backend's _price_items.
      const subtotal = (form.items || []).reduce((s, it, i) => s + lineNet(it, i), 0);
      const payload = {
        quotation_id: form.quotation_id ? Number(form.quotation_id) : null,
        project_id:   form.project_id   ? Number(form.project_id)   : null,
        client_id:    form.client_id    ? Number(form.client_id)    : null,
        amount:       subtotal,
        due_date:     form.due_date || null,
        notes:        form.notes    || null,
        branch_id:    form.branch_id || null,
        items:        (form.items || []).map(i => ({
          name: i.name,
          quantity: Number(i.quantity)||0,
          unit_price: Number(i.unit_price)||0,
          // An untouched line sends 0 and lets the server apply the
          // promotion authoritatively; a touched one sends the human's number.
          // Send the PERCENTAGE. The server turns it into the money figure the
          // ledger uses, so the browser never decides what a customer owes.
          discount: 0,
          discount_pct: i.discount_auto === false ? (Number(i.discount_pct) || 0) : null,
          discount_auto: i.discount_auto !== false,
          // The stock link travels with the line so the server can find a
          // promotion for it. Dropping it here would silently disable
          // promotions on every document, with nothing to show why.
          inventory_id: i.inventory_id ?? null,
          tax_rate_id: i.tax_rate_id ?? null,
        })),
        version:      editVersion,
      };
      if (editId) { await updateInvoice(editId, payload); toast(t('invoices.invoiceUpdated')); }
      else        { await createInvoice(payload);          toast(t('invoices.invoiceCreated')); }
      setFormModal(false); reload();
    } catch (err) {
      if (err.message?.includes('409') || err.status === 409) {
        toast('This invoice was modified by another user. Please close and reopen to refresh.', 'red');
      } else {
        toast(err.message, 'red');
      }
    }
    finally { setSaving(false); }
  }

  async function handleVoid() {
    setVoiding(true);
    try {
      await voidInvoice(voidId, voidReason || 'Voided');
      toast(t('invoices.invoiceVoided')); setVoidId(null); setVoidReason(''); reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setVoiding(false); }
  }

  const [unvoidTarget, setUnvoidTarget] = useState(null);

  async function handleUnvoid() {
    try {
      await unvoidInvoice(unvoidTarget.id);
      toast(t('invoices.invoiceRestored')); setUnvoidTarget(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }



  async function openPayModal(inv) {
    setPayLoading(true);
    setPayForm({ amount: '', method: 'Cash', note: '', currency: 'USD', rate: exchangeRate?.rate || '', cash_drawer_id: '' });
    setPayModal(inv);
    try {
      const full = await getInvoice(inv.id);
      setPayModal(full);
    } catch { toast('Could not load payment data', 'red'); }
    finally { setPayLoading(false); }
  }

  async function handleAddPayment(e) {
    e.preventDefault();
    const amt = Number(payForm.amount);
    if (!amt || amt <= 0) { toast('Enter a valid amount', 'red'); return; }
    const currency = payForm.currency === 'LBP' ? 'LBP' : 'USD';
    let exchange_rate = null;
    if (currency === 'LBP') {
      exchange_rate = Number(payForm.rate);
      if (!exchange_rate || exchange_rate <= 0) {
        toast(t('invoices.rateRequired'), 'red'); return;
      }
    }
    if (paySubmitting) return;
    setPaySubmitting(true);
    try {
      const idempotency_key = crypto.randomUUID ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await addInvoicePayment(payModal.id, {
        amount: amt, currency, exchange_rate,
        method: payForm.method, note: payForm.note || null, idempotency_key,
        cash_drawer_id: payForm.method === 'Cash' && payForm.cash_drawer_id
          ? Number(payForm.cash_drawer_id) : null,
      });
      toast(t('invoices.paymentRecorded'));
      setPayForm({ amount: '', method: 'Cash', note: '', currency: 'USD', rate: exchangeRate?.rate || '', cash_drawer_id: '' });
      const full = await getInvoice(payModal.id);
      setPayModal(full);
      reload();
    } catch (err) {
      if (err.message?.includes('409') || err.message?.includes('duplicate')) {
        toast('This payment was already recorded — duplicate submission blocked.', 'red');
      } else {
        toast(err.message, 'red');
      }
    }
    finally { setPaySubmitting(false); }
  }

  const [deletePayId, setDeletePayId] = useState(null);

  async function handleDeletePayment(payId) {
    try {
      await deleteInvoicePayment(payModal.id, payId);
      toast(t('invoices.paymentDeleted'));
      const full = await getInvoice(payModal.id);
      setPayModal(full);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }


  // Fetches every matching invoice (no `limit`), so an export is never
  // silently truncated to the page on screen.
  const fetchExportRows = async () => {
    const all = await getInvoices({
      status:     statusFilter  || undefined,
      client_id:  clientFilter  || undefined,
      project_id: projectFilter || undefined,
      ...(search.trim() ? { search: search.trim() } : {}),
    });
    return (Array.isArray(all) ? all : all.items || []).map(i => ({
    'Invoice #':     i.invoice_number,
    'Quote #':       i.quote_number   || '—',
    'Status':        i.payment_status || 'Unpaid',
    'Client':        i.client_name    || '—',
    'Project':       i.project_name   || '—',
    'Subtotal (USD)': i.subtotal      ?? i.amount ?? 0,
    'VAT (USD)':     i.tax_total      || 0,
    'Amount (USD)':  i.amount         || 0,
    'Paid (USD)':    i.total_paid     || 0,
    'Remaining':     i.remaining      ?? (i.amount - (i.total_paid || 0)),
    'Due Date':      i.due_date       ? new Date(i.due_date).toLocaleDateString() : '—',
      'Created':       i.created_at     ? new Date(i.created_at).toLocaleDateString() : '—',
    }));
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('invoices.title')}</h1>
          <p className="page-subtitle">{t('invoices.totalInvoices', { count: total })}</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <ExportButton fetchData={fetchExportRows} filename="Invoices" sheetName="Invoices" />
          <button className="btn btn-primary" onClick={openCreate}>{t('invoices.addInvoice')}</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{flexDirection:'column',alignItems:'stretch',gap:10}}>
          <div className="search-bar" style={{ margin:0, flexWrap:'wrap' }}>
            <div className="search-input-wrap" style={{flex:'1 1 200px',minWidth:180}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input className="form-control search-input" placeholder={t('invoices.searchPlaceholderFull')}
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="form-control" style={{width:190}}
              value={clientFilter} onChange={e => setClientFilter(e.target.value)}>
              <option value="">{t('common.allClients')}</option>
              {(clients||[]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="form-control" style={{width:220}}
              value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
              <option value="">{t('common.allProjects')}</option>
              {(projects||[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="form-control" style={{width:150}}
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">{t('common.allStatuses')}</option>
              {['Unpaid','Partial','Paid','Overdue','Void'].map(s => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
            {(search||clientFilter||projectFilter||statusFilter) && (
              <button className="btn btn-secondary btn-sm" style={{whiteSpace:'nowrap'}}
                onClick={() => { setSearch(''); setClientFilter(''); setProjectFilter(''); setStatusFilter(''); }}>
                ✕ {t('common.clear')}
              </button>
            )}
          </div>
          {isFiltered && (
            <div style={{fontSize:12,color:'var(--text-3)'}}>
              {t('invoices.showingFiltered', { count: total, total })}
            </div>
          )}
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         pagedInvoices.length === 0 ? <EmptyState message={t('invoices.noInvoicesFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('invoices.invoiceNumber')} sortKey="invoice_number" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.quoteNum')}      sortKey="quote_number"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.client')}        sortKey="client_name"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.project')}       sortKey="project_name"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.amount')}        sortKey="amount"         currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.paidHeader')}    sortKey="total_paid"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.remaining')}     sortKey="remaining"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.status')}          sortKey="payment_status" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('invoices.dueDate')}       sortKey="due_date"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedInvoices.map(inv => {
                  // One spinner slot for both: exporting and receipting are
                  // mutually exclusive on a row, and the menu keys off the value.
                  const exporting = exportLoading[inv.id] || receiptLoading[inv.id];
                  return (
                    <tr key={inv.id}>
                      <td className="td-primary text-mono">{inv.invoice_number}</td>
                      <td className="text-mono" style={{ fontSize:12, color:'var(--text-3)' }}>
                        {inv.quote_number || '—'}
                      </td>
                      <td>{inv.client_name  || '—'}</td>
                      <td>{inv.project_name || '—'}</td>
                      <td className="fw-600">{fmt(inv.amount)}</td>
                      <td className="text-green">{fmt(inv.total_paid || 0)}</td>
                      <td className={(inv.remaining||0) > 0 ? 'text-red fw-600' : 'text-green'}>
                        {fmt(inv.remaining ?? (inv.amount - (inv.total_paid||0)))}
                      </td>
                      <td><Badge status={inv.is_overdue ? 'Overdue' : inv.payment_status} /></td>
                      <td style={{ color: inv.is_overdue ? 'var(--red)' : 'var(--text-2)', fontWeight: inv.is_overdue ? 600 : 400 }}>{fmtDate(inv.due_date)}</td>
                      <td>
                        <ActionMenu
                          inv={inv}
                          exporting={exporting}
                          onEdit={() => openEdit(inv)}
                          onPay={() => openPayModal(inv)}
                          onExport={(fmtType) => handleExport(inv, fmtType)}
                          onReceipt={() => handleReceipt(inv)}
                          onVoid={() => { setVoidId(inv.id); setVoidReason(''); }}
                          onUnvoid={() => setUnvoidTarget(inv)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={total} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>

      {/* Invoice form modal */}
      {formModal && (
        <Modal title={editId ? t('invoices.editInvoice') : t('invoices.newInvoice')} onClose={() => { setFormModal(false); setEditId(null); setForm(EMPTY_FORM); }} size="modal-lg">
          {formLoading ? (
            <div className="modal-body" style={{ textAlign:'center', padding:'40px 0' }}>
              <LoadingSpinner />
              <p style={{ color:'var(--text-3)', fontSize:13, marginTop:8 }}>{t('invoices.loadingInvoice')}</p>
            </div>
          ) : (
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('invoices.clientLabel')}</label>
                  <select className="form-control" value={form.client_id||''}
                    onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}>
                    <option value="">{t('invoices.selectClientOption')}</option>
                    {(clients||[]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('invoices.projectLabel')}</label>
                  <select className="form-control" value={form.project_id||''}
                    onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                    <option value="">{t('invoices.selectProjectOption')}</option>
                    {(projects||[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('invoices.dueDateLabel')}</label>
                  <input type="date" className="form-control" value={form.due_date||''}
                    onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
                <BranchField value={form.branch_id}
                  onChange={v => setForm(f => ({ ...f, branch_id: v }))} />
                <div className="form-group">
                  <label className="form-label">{t('invoices.notesLabel')}</label>
                  <input className="form-control" value={form.notes||''}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>

              <div style={{ borderTop:'1px solid var(--border)', margin:'16px 0' }} />

              {amountsLocked && (
                <div style={{
                  display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
                  background:'#fef3c7', border:'1px solid #f59e0b', borderRadius:8, marginBottom:14,
                }}>
                  <span style={{ fontSize:16 }}>🔒</span>
                  <span style={{ fontSize:13, color:'#92400e', fontWeight:500 }}>
                    {t('invoices.amountsLocked')}
                  </span>
                </div>
              )}

              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <span style={{ fontWeight:600, fontSize:14 }}>{t('common.lineItems')}</span>
                {!amountsLocked && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={addItem}>{t('common.addItem')}</button>
                )}
              </div>

              {(() => {
              // Grid columns: description | qty | price | [disc?] | [tax?] | line total | [×?]
              const itemGrid = '1fr 78px 96px'
                             + ' 92px'
                             + (taxEnabled      ? ' 124px' : '')
                             + ' 88px'
                             + (amountsLocked ? '' : ' 34px');
              return <>
              <div style={{ display:'grid', gridTemplateColumns:itemGrid, gap:10, marginBottom:4, alignItems:'center' }}>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', paddingLeft:4 }}>{t('invoices.descriptionCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.qtyCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.unitPriceCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('common.discount')} %</span>
                {taxEnabled && <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('common.taxCol')}</span>}
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'right' }}>{t('common.total')}</span>
                {!amountsLocked && <span />}
              </div>

              {(form.items||[]).map((item, i) => {
                // Net per line — qty × price minus discount (when enabled).
                const lineTotal = lineNet(item, i);
                const promo = promoLines[i];
                return (
                  <div key={i}>
                  <div style={{ display:'grid', gridTemplateColumns:itemGrid, gap:10,
                                marginBottom: promo ? 2 : 10, alignItems:'center' }}>
                    {amountsLocked ? (
                      <span style={{ fontSize:13, padding:'6px 4px', color:'var(--text-2)' }}>{item.name || '—'}</span>
                    ) : (
                      <InventoryCombobox
                        value={item.name}
                        inventory={inventory || []}
                        title={t('lineItem.itemTitle')}
                        placeholder={t('lineItem.itemPh')}
                        onChange={(name, price, meta) => setItemFromInventory(i, name, price, meta)}
                      />
                    )}
                    <NumberInput className="form-control" placeholder={t('common.quantity')} min="0" step="any"
                      title={t('lineItem.qtyTitle')}
                      value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
                    <NumberInput className="form-control" placeholder={t('lineItem.unitPricePh')} min="0" step="0.01"
                      title={t('lineItem.unitPriceTitle')}
                      value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
                    {(
                      amountsLocked ? (
                        <span style={{ fontSize:13, padding:'6px 4px', color:'var(--text-2)', textAlign:'center' }}>
                          {Number(item.discount || 0).toFixed(2)}
                        </span>
                      ) : (
                        <NumberInput className="form-control"
                          placeholder="%"
                          title={t('lineItem.discountTitle')}
                          min="0" max="100" step="0.01"
                          value={item.discount_auto === false
                            ? item.discount_pct
                            : (promoLines[i]?.discount_pct ?? '')}
                          onChange={e => setItemDiscount(i, e.target.value)} />
                      )
                    )}
                    {taxEnabled && (
                      amountsLocked ? (
                        <span style={{ fontSize:12, padding:'6px 2px', color:'var(--text-3)', textAlign:'center' }}>
                          {(rateById(item.tax_rate_id)?.rate ?? 0)}%
                        </span>
                      ) : (
                        <select className="form-control" style={{ fontSize:12, padding:'6px 4px' }}
                          title={t('lineItem.taxTitle')}
                          value={item.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                          onChange={e => setItem(i, 'tax_rate_id', Number(e.target.value) || null)}>
                          {activeTaxRates.map(r => (
                            <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                          ))}
                        </select>
                      )
                    )}
                    <span title={t('lineItem.lineTotalTitle')}
                      style={{ textAlign:'right', fontWeight:600, fontSize:13, color:'var(--text-1)' }}>
                      ${lineTotal.toFixed(2)}
                    </span>
                    {!amountsLocked && (
                      <button type="button" className="btn btn-sm btn-danger"
                        onClick={() => removeItem(i)} disabled={(form.items||[]).length === 1}>✕</button>
                    )}
                  </div>
                  {/* Name the promotion. A line that is cheaper for no stated
                      reason is unexplainable to the customer who asks. */}
                  {promo && (
                    <div style={{ fontSize:11.5, color:'var(--affirm)', margin:'0 0 10px 2px' }}>
                      🏷 {promo.promotion_name || t('common.discount')}
                      {' · −$'}{Number(promo.discount).toFixed(2)}
                    </div>
                  )}
                  </div>
                );
              })}
              </>;
              })()}

              <div style={{ textAlign:'right', marginTop:14, fontSize:13, color:'var(--text-2)' }}>
                {!amountsLocked && (invoiceTaxAmt > 0 || invoiceDiscount > 0) && (
                  <>
                    <div>{t('common.subtotal')}: ${invoiceSubtotal.toFixed(2)}</div>
                    {invoiceDiscount > 0 && (
                      <div style={{ color: 'var(--affirm)' }}>
                        {t('common.discount')}: −${invoiceDiscount.toFixed(2)}
                      </div>
                    )}
                    {invoiceTaxAmt > 0 && <div>{t('common.taxCol')}: ${invoiceTaxAmt.toFixed(2)}</div>}
                  </>
                )}
                <div style={{ fontWeight:700, fontSize:16, color:'var(--text-1)', marginTop: invoiceTaxAmt > 0 ? 4 : 0 }}>
                  {t('common.total')}: ${invoiceTotal.toFixed(2)}
                </div>
              </div>
              {!amountsLocked && (
                <p style={{ fontSize:12, color:'var(--text-3)', marginTop:8 }}>
                  ℹ️ {t('invoices.amountCalcAuto')}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => { setFormModal(false); setEditId(null); setForm(EMPTY_FORM); }}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('invoices.createInvoice')}
              </button>
            </div>
          </form>
          )}
        </Modal>
      )}

      {/* Payment modal */}
      {payModal && (
        <Modal
          title={t('invoices.paymentsModalTitle', { invoice_number: payModal.invoice_number })}
          onClose={() => setPayModal(null)}
          size="modal-lg"
        >
          <div className="modal-body">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:20 }}>
              {[
                { label: t('invoices.invoiceTotal'),   amount: payModal.amount || 0,     color:'var(--text-1)' },
                { label: t('invoices.totalPaidLabel'), amount: payModal.total_paid || 0, color:'var(--green)' },
                { label: t('invoices.remaining'),      amount: payModal.remaining ?? 0,
                  color: (payModal.remaining??0) > 0 ? 'var(--red)' : 'var(--green)' },
              ].map(s => (
                <div key={s.label} style={{
                  background:'var(--surface-2)', borderRadius:8, padding:'12px 16px', textAlign:'center',
                }}>
                  <div style={{ fontSize:11, color:'var(--text-3)', marginBottom:4 }}>{s.label}</div>
                  <div style={{ fontSize:18, fontWeight:700, color:s.color }}><DualMoney value={s.amount} /></div>
                </div>
              ))}
            </div>

            {payLoading ? <LoadingSpinner /> : (
              <>
                {payModal.items?.length > 0 && (
                  <div style={{ marginBottom:16, border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
                    <div style={{ padding:'8px 12px', background:'var(--surface-2)', fontWeight:600, fontSize:12, color:'var(--text-2)', display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8 }}>
                      <span>{t('invoices.descriptionCol')}</span>
                      <span style={{textAlign:'right'}}>{t('invoices.qtyCol')}</span>
                      <span style={{textAlign:'right'}}>{t('invoices.unitPriceCol')}</span>
                      <span style={{textAlign:'right'}}>{t('common.total')}</span>
                    </div>
                    {payModal.items.map((item, i) => (
                      <div key={i} style={{ padding:'7px 12px', borderTop:'1px solid var(--border)', fontSize:13, display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8, background: i % 2 === 0 ? 'transparent' : 'var(--surface-2,#f9fafb)' }}>
                        <span>{item.name}</span>
                        <span style={{textAlign:'right',color:'var(--text-2)'}}>{item.quantity}</span>
                        <span style={{textAlign:'right',color:'var(--text-2)'}}>${Number(item.unit_price).toFixed(2)}</span>
                        <span style={{textAlign:'right',fontWeight:600}}>${(item.quantity * item.unit_price).toFixed(2)}</span>
                      </div>
                    ))}
                    {(() => {
                      const taxAmt = Number(payModal.tax_total) || 0;
                      const subtotal = Number(payModal.subtotal)
                        || ((payModal.items || []).reduce((s, it) => s + (Number(it.quantity)||0) * (Number(it.unit_price)||0), 0));
                      return taxAmt > 0 ? (
                        <>
                          <div style={{ padding:'6px 12px', borderTop:'1px solid var(--border)', fontSize:12, display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8, color:'var(--text-2)' }}>
                            <span style={{gridColumn:'1/4', textAlign:'right'}}>{t('common.subtotal')}</span>
                            <span style={{textAlign:'right'}}>${subtotal.toFixed(2)}</span>
                          </div>
                          <div style={{ padding:'6px 12px', borderTop:'1px solid var(--border)', fontSize:12, display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8, color:'var(--text-2)' }}>
                            <span style={{gridColumn:'1/4', textAlign:'right'}}>{t('common.taxCol')}</span>
                            <span style={{textAlign:'right', color:'var(--accent)'}}>${taxAmt.toFixed(2)}</span>
                          </div>
                        </>
                      ) : null;
                    })()}
                  </div>
                )}

                {(payModal.remaining ?? 0) > 0.001 && (() => {
                  const payInLbp  = payForm.currency === 'LBP';
                  const rateNum   = Number(payForm.rate);
                  const amtNum    = Number(payForm.amount);
                  const usdEquiv  = payInLbp && rateNum > 0 ? amtNum / rateNum : 0;
                  return (
                  <form onSubmit={handleAddPayment}
                    style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:20, alignItems:'flex-end' }}>
                    {exchangeRate?.rate && (
                      <div className="form-group" style={{ margin:0, width:90 }}>
                        <label className="form-label">{t('invoices.paymentCurrency')}</label>
                        <select className="form-control" value={payForm.currency}
                          onChange={e => setPayForm(f => ({
                            ...f, currency: e.target.value,
                            rate: e.target.value === 'LBP' ? (f.rate || exchangeRate?.rate || '') : f.rate,
                          }))}>
                          <option value="USD">{exchangeRate.base || 'USD'}</option>
                          <option value="LBP">{exchangeRate.secondary || 'LBP'}</option>
                        </select>
                      </div>
                    )}
                    <div className="form-group" style={{ margin:0, flex:'1 1 130px', minWidth:120 }}>
                      <label className="form-label">{t('invoices.paymentAmount')} *</label>
                      <NumberInput className="form-control" min="0.01" step="0.01"
                        required value={payForm.amount}
                        onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                        placeholder={payInLbp ? '' : t('invoices.maxAmount', { amount: fmt(payModal.remaining) })} />
                      {payInLbp && usdEquiv > 0 && (
                        <div style={{ fontSize:11, color:'var(--text-3)', marginTop:3 }}>
                          ≈ {fmt(usdEquiv)}
                        </div>
                      )}
                    </div>
                    {payInLbp && (
                      <div className="form-group" style={{ margin:0, width:140 }}>
                        <label className="form-label">{t('invoices.exchangeRateLabel')} *</label>
                        <NumberInput className="form-control" min="0.01" step="any"
                          required value={payForm.rate}
                          onChange={e => setPayForm(f => ({ ...f, rate: e.target.value }))} />
                      </div>
                    )}
                    <div className="form-group" style={{ margin:0, width:130 }}>
                      <label className="form-label">{t('invoices.methodLabel')}</label>
                      <select className="form-control" value={payForm.method}
                        onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}>
                        {METHODS.map(m => <option key={m} value={m}>{tEnumValue(m)}</option>)}
                      </select>
                    </div>
                    {payForm.method === 'Cash' && cashDrawers.length > 0 && (
                      <div className="form-group" style={{ margin:0, width:150 }}>
                        <label className="form-label">{t('pos.cashDrawer')}</label>
                        <select className="form-control" value={payForm.cash_drawer_id}
                          onChange={e => setPayForm(f => ({ ...f, cash_drawer_id: e.target.value }))}>
                          <option value="">{t('expenses.defaultDrawer')}</option>
                          {cashDrawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="form-group" style={{ margin:0, flex:'1 1 140px', minWidth:120 }}>
                      <label className="form-label">{t('invoices.noteOptional')}</label>
                      <input className="form-control" value={payForm.note}
                        onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))}
                        placeholder={t('invoices.notePlaceholder')} />
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ whiteSpace:'nowrap' }}
                      disabled={paySubmitting}>
                      {paySubmitting ? t('invoices.recording') : t('invoices.recordBtn')}
                    </button>
                  </form>
                  );
                })()}

                <div style={{ fontWeight:600, fontSize:13, marginBottom:8, borderTop:'1px solid var(--border)', paddingTop:16 }}>
                  {t('invoices.paymentHistory')}
                </div>
                {!(payModal.payments?.length) ? (
                  <p style={{ color:'var(--text-3)', fontSize:13 }}>{t('invoices.noPayments')}</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>{t('invoices.paymentAmount')}</th>
                        <th>{t('invoices.paymentMethod')}</th>
                        <th>{t('invoices.paymentNote')}</th>
                        <th>{t('common.date')}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {payModal.payments.map((p, i) => (
                        <tr key={p.id}>
                          <td style={{ color:'var(--text-3)', fontSize:12 }}>
                            {payModal.payments.length - i}
                          </td>
                          <td style={{ fontWeight:600, color:'var(--green)' }}>
                            {p.paid_currency === 'LBP' ? (
                              <>
                                {Number(p.paid_amount ?? 0).toLocaleString('en-US')} LBP
                                <div style={{ fontSize:11, fontWeight:400, color:'var(--text-3)' }}>
                                  = {fmt(p.amount)} @ {Number(p.exchange_rate || 0).toLocaleString('en-US')}
                                </div>
                              </>
                            ) : fmt(p.amount)}
                          </td>
                          <td>{p.method}</td>
                          <td>{p.note || '—'}</td>
                          <td>{fmtDate(p.paid_at)}</td>
                          <td>
                            <button className="btn btn-sm btn-danger"
                              onClick={() => setDeletePayId(p.id)}
                              title="Delete this payment">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {!payModal.voided_at && (
              <PaymentPlan
                invoice={payModal}
                canEdit={can('invoices', 'edit')}
                onChange={async () => { setPayModal(await getInvoice(payModal.id)); }}
              />
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <Attachments entityType="invoices" entityId={payModal.id} canEdit={can('invoices', 'edit')} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setPayModal(null)}>{t('invoices.closeBtn')}</button>
          </div>
        </Modal>
      )}

      {/* Void modal */}
      {voidId && (
        <Modal title={t('invoices.voidInvoiceTitle')} onClose={() => { setVoidId(null); setVoidReason(''); }}>
          <div className="modal-body">
            <div style={{
              display:'flex', gap:10, padding:'12px 14px',
              background:'#fef3c7', border:'1px solid #f59e0b', borderRadius:8, marginBottom:16,
            }}>
              <span style={{ fontSize:18 }}>⚠️</span>
              <span style={{ fontSize:13, color:'#78350f' }}>
                {t('invoices.voidWarning')}
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">{t('invoices.voidReason')}</label>
              <input className="form-control" value={voidReason}
                onChange={e => setVoidReason(e.target.value)} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => { setVoidId(null); setVoidReason(''); }}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={handleVoid} disabled={voiding}>
              {voiding ? t('invoices.voiding') : t('invoices.voidBtn')}
            </button>
          </div>
        </Modal>
      )}

      {deletePayId && (
        <ConfirmModal
          message={t('invoices.deletePaymentMsg')}
          onConfirm={() => { handleDeletePayment(deletePayId); setDeletePayId(null); }}
          onCancel={() => setDeletePayId(null)}
        />
      )}

      {unvoidTarget && (
        <ConfirmModal
          message={t('invoices.unvoidWarning')}
          confirmLabel={t('invoices.unvoidInvoiceTitle')}
          onConfirm={handleUnvoid}
          onCancel={() => setUnvoidTarget(null)}
        />
      )}
    </div>
  );
}
