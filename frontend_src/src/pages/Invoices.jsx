import { useState, useRef, useEffect } from 'react';
import { useData } from '../hooks/useData';
import { useSettings } from '../hooks/useSettings';
import {
  getInvoices, getInvoice, getClients, getProjects, getInventory,
  createInvoice, updateInvoice, voidInvoice, unvoidInvoice,
  addInvoicePayment, deleteInvoicePayment, getCashDrawers,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination,
  DualMoney, ExchangeRateBadge, DisplayCurrencyToggle, WhatsAppShareButton, NumberInput, BranchField} from '../components/shared';
import { exportInvoicePDF, exportInvoiceExcel } from '../utils/exportUtils';
import InventoryCombobox from '../components/InventoryCombobox';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import Attachments from '../components/Attachments.jsx';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useRecordExport } from '../hooks/useRecordExport';
import { useFocusId } from '../hooks/useFocusId';
const METHODS    = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
// `discount` (in functional currency) is opt-in via Settings → "Enable
// per-line discounts". When the toggle is off the field stays 0 and the
// column is hidden — the rest of the form behaves exactly as before.
const EMPTY_ITEM = { name: '', quantity: 1, unit_price: 0, discount: 0, tax_rate_id: null };
const EMPTY_FORM = { quotation_id: '', project_id: '', client_id: '', due_date: '', notes: '', branch_id: '', items: [{ ...EMPTY_ITEM }] };
import { ActionMenu } from './invoices/ActionMenu';

export default function Invoices() {
  const { t, tStatus } = useLocale();
  const { can } = usePermissions();
  // Invoices use Void/Unvoid as their lifecycle, not archive — no in-module
  // "Show archived" view here.
  const { data: invoices, loading, error, reload } = useData((s) => getInvoices({}, s));
  const { data: clients  } = useData((s) => getClients({}, s));
  const { data: projects } = useData((s) => getProjects({}, s));
  const { data: inventory } = useData((s) => getInventory({}, s));
  const { settings, exchangeRate, displayCurrency, taxRates } = useSettings();

  // Global-search deep link (?focus=<id>) → open that invoice's detail.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId != null && invoices?.length) {
      const inv = invoices.find(i => i.id === focusId);
      if (inv) { openPayModal(inv); clearFocus(); }
    }
  }, [focusId, invoices]);   // eslint-disable-line react-hooks/exhaustive-deps

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
  const lineNet = (item) => {
    const gross = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    const disc  = discountEnabled ? (Number(item.discount) || 0) : 0;
    return Math.max(0, gross - disc);
  };
  const lineTaxAmt = (item) => {
    if (!taxEnabled) return 0;
    const r = rateById(item.tax_rate_id);
    return r ? lineNet(item) * (Number(r.rate) || 0) / 100 : 0;
  };

  const [statusFilter, setStatusFilter] = useState('');
  const [search,       setSearch]       = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [projectFilter,setProjectFilter]= useState('');

  const [formModal,     setFormModal]     = useState(false);
  const [form,          setForm]          = useState(EMPTY_FORM);
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

  const q = search.toLowerCase();
  const filtered = (invoices||[]).filter(i => {
    if (statusFilter === 'Overdue') {
      if (!i.is_overdue) return false;
    } else if (statusFilter) {
      if (i.payment_status !== statusFilter) return false;
    }
    if (clientFilter  && String(i.client_id) !== clientFilter) return false;
    if (projectFilter && String(i.project_id) !== projectFilter) return false;
    if (q && ![i.invoice_number, i.quote_number, i.client_name, i.project_name, i.notes]
               .join(' ').toLowerCase().includes(q)) return false;
    return true;
  });

  function openCreate() { setForm(EMPTY_FORM); setEditId(null); setFormModal(true); }

  const { sorted: pagedInvoices, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

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
              discount: i.discount || 0,
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
  const setItemFromInventory = (i, name, price) => setForm(f => ({
    ...f, items: f.items.map((item, x) => x === i
      ? { ...item, name, ...(price !== null ? { unit_price: price } : {}) }
      : item),
  }));
  // Subtotal uses the discounted net per line so the form preview matches
  // what the backend pricing engine computes.
  const invoiceSubtotal  = (form.items || []).reduce((s, i) => s + lineNet(i), 0);
  const invoiceDiscount  = discountEnabled
    ? (form.items || []).reduce((s, i) => s + (Number(i.discount) || 0), 0)
    : 0;
  const invoiceTaxAmt    = (form.items || []).reduce((s, i) => s + lineTaxAmt(i), 0);
  const invoiceTotal     = invoiceSubtotal + invoiceTaxAmt;

  async function handleSave(e) {
    e.preventDefault(); setSaving(true);
    try {
      // Amount = discounted net, matching the backend's _price_items.
      const subtotal = (form.items || []).reduce((s, i) => s + lineNet(i), 0);
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
          discount: discountEnabled ? (Number(i.discount) || 0) : 0,
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


  const exportData = (filtered || []).map(i => ({
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('invoices.title')}</h1>
          <p className="page-subtitle">{t('invoices.totalInvoices', { count: invoices?.length ?? 0 })}</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <ExportButton data={exportData} filename="Invoices" sheetName="Invoices" />
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
          {filtered.length !== (invoices||[]).length && (
            <div style={{fontSize:12,color:'var(--text-3)'}}>
              {t('invoices.showingFiltered', { count: filtered.length, total: (invoices||[]).length })}
            </div>
          )}
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         filtered.length === 0 ? <EmptyState message={t('invoices.noInvoicesFound')} /> : (
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
                  const exporting = exportLoading[inv.id];
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
              totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
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
                             + (discountEnabled ? ' 92px' : '')
                             + (taxEnabled      ? ' 124px' : '')
                             + ' 88px'
                             + (amountsLocked ? '' : ' 34px');
              return <>
              <div style={{ display:'grid', gridTemplateColumns:itemGrid, gap:10, marginBottom:4, alignItems:'center' }}>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', paddingLeft:4 }}>{t('invoices.descriptionCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.qtyCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.unitPriceCol')}</span>
                {discountEnabled && <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('common.discount')}</span>}
                {taxEnabled && <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('common.taxCol')}</span>}
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'right' }}>{t('common.total')}</span>
                {!amountsLocked && <span />}
              </div>

              {(form.items||[]).map((item, i) => {
                // Net per line — qty × price minus discount (when enabled).
                const lineTotal = lineNet(item);
                return (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:itemGrid, gap:10, marginBottom:10, alignItems:'center' }}>
                    {amountsLocked ? (
                      <span style={{ fontSize:13, padding:'6px 4px', color:'var(--text-2)' }}>{item.name || '—'}</span>
                    ) : (
                      <InventoryCombobox
                        value={item.name}
                        inventory={inventory || []}
                        onChange={(name, price) => setItemFromInventory(i, name, price)}
                      />
                    )}
                    <NumberInput className="form-control" placeholder={t('common.quantity')} min="0" step="any"
                      value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
                    <NumberInput className="form-control" placeholder="Unit $" min="0" step="0.01"
                      value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
                    {discountEnabled && (
                      amountsLocked ? (
                        <span style={{ fontSize:13, padding:'6px 4px', color:'var(--text-2)', textAlign:'center' }}>
                          {Number(item.discount || 0).toFixed(2)}
                        </span>
                      ) : (
                        <NumberInput className="form-control"
                          placeholder={t('common.discount')}
                          title={t('common.discount')}
                          min="0" step="0.01"
                          value={item.discount}
                          onChange={e => setItem(i, 'discount', e.target.value)} />
                      )
                    )}
                    {taxEnabled && (
                      amountsLocked ? (
                        <span style={{ fontSize:12, padding:'6px 2px', color:'var(--text-3)', textAlign:'center' }}>
                          {(rateById(item.tax_rate_id)?.rate ?? 0)}%
                        </span>
                      ) : (
                        <select className="form-control" style={{ fontSize:12, padding:'6px 4px' }}
                          value={item.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                          onChange={e => setItem(i, 'tax_rate_id', Number(e.target.value) || null)}>
                          {activeTaxRates.map(r => (
                            <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                          ))}
                        </select>
                      )
                    )}
                    <span style={{ textAlign:'right', fontWeight:600, fontSize:13, color:'var(--text-1)' }}>
                      ${lineTotal.toFixed(2)}
                    </span>
                    {!amountsLocked && (
                      <button type="button" className="btn btn-sm btn-danger"
                        onClick={() => removeItem(i)} disabled={(form.items||[]).length === 1}>✕</button>
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
                        {METHODS.map(m => <option key={m}>{m}</option>)}
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
