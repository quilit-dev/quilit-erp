import { useState, useRef, useEffect } from 'react';
import { useData } from '../hooks/useData';
import { useSettings } from '../hooks/useSettings';
import {
  getInvoices, getInvoice, getClients, getProjects, getInventory,
  createInvoice, updateInvoice, archiveInvoice, voidInvoice,
  addInvoicePayment, deleteInvoicePayment,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination
} from '../components/shared';
import { exportInvoicePDF, exportInvoiceExcel } from '../utils/exportUtils';
import InventoryCombobox from '../components/InventoryCombobox';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useRecordExport } from '../hooks/useRecordExport';

const METHODS    = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
const EMPTY_ITEM = { name: '', quantity: 1, unit_price: 0 };
const EMPTY_FORM = { quotation_id: '', project_id: '', client_id: '', due_date: '', notes: '', items: [{ ...EMPTY_ITEM }] };

// ── Per-row action dropdown ───────────────────────────────────────────────
function ActionMenu({ inv, exporting, onEdit, onPay, onExport, onVoid, onDelete }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 180);
    }
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const isVoided    = inv.payment_status === 'Void' || !!inv.voided_at;
  const isPaid      = inv.payment_status === 'Paid';
  const hasPayments = (inv.total_paid || 0) > 0;
  const isExporting = !!exporting;

  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'flex-end' }}>
      {isVoided ? (
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('invoices.voidedLabel')}</span>
      ) : !isPaid ? (
        <button className="btn btn-sm btn-success" style={{ whiteSpace: 'nowrap' }} onClick={onPay}>
          💵 {t('invoices.recordPayment')}
        </button>
      ) : (
        <button className="btn btn-sm btn-secondary" style={{ whiteSpace: 'nowrap' }} onClick={onPay}>
          {t('invoices.historyBtn')}
        </button>
      )}

      <div ref={ref} style={{ position: 'relative' }}>
        <button
          ref={btnRef}
          className="btn btn-sm btn-secondary"
          title="More actions"
          onClick={() => setOpen(o => !o)}
          style={{ padding: '0 7px', letterSpacing: 1, fontWeight: 700 }}
        >
          ⋯
        </button>

        {open && (
          <div style={{
            position: 'fixed',
            left: (() => {
              if (!btnRef.current) return 4;
              const r   = btnRef.current.getBoundingClientRect();
              const mw  = 178;
              let left  = r.right - mw;     // right-align menu with button
              if (left < 4) left = r.left;  // if off left edge, left-align instead
              if (left + mw > window.innerWidth - 4) left = window.innerWidth - mw - 4; // clamp right
              return Math.max(4, left);
            })(),
            ...(dropUp
              ? { bottom: (() => {
                  if (!btnRef.current) return 0;
                  const r = btnRef.current.getBoundingClientRect();
                  return window.innerHeight - r.top + 4;
                })() }
              : { top: (() => {
                  if (!btnRef.current) return 0;
                  const r = btnRef.current.getBoundingClientRect();
                  return r.bottom + 4;
                })() }
            ),
            zIndex: 9999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
            minWidth: 178, padding: '4px 0', whiteSpace: 'nowrap',
          }}>
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              style={{ ...menuItemStyle, opacity: isVoided ? 0.4 : 1, cursor: isVoided ? 'not-allowed' : 'pointer' }}
              disabled={isVoided}
            >
              ✏️ {t('common.edit')} {isVoided ? `(${t('invoices.voidedLabel')})` : ''}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('excel'); }}
              style={{ ...menuItemStyle, color: '#166534', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'excel' ? '⏳ Exporting…' : '📊 Export XLS'}
            </button>

            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('pdf'); }}
              style={{ ...menuItemStyle, color: '#991b1b', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'pdf' ? '⏳ Exporting…' : '📄 Export PDF'}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            {!isVoided && (
              <button
                onClick={() => { setOpen(false); onVoid(); }}
                style={{ ...menuItemStyle, color: '#92400e' }}
              >
                🚫 {t('invoices.voidInvoiceTitle')}
              </button>
            )}

            {!isVoided && !hasPayments && (
              <button
                onClick={() => { setOpen(false); onDelete(); }}
                style={{ ...menuItemStyle, color: 'var(--red)' }}
              >
                🗄 Archive
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const menuItemStyle = {
  display: 'block', width: '100%', padding: '7px 14px',
  background: 'none', border: 'none', textAlign: 'left',
  fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};

export default function Invoices() {
  const { t, tStatus } = useLocale();
  const { data: invoices, loading, error, reload } = useData(getInvoices);
  const { data: clients  } = useData(getClients);
  const { data: projects } = useData(getProjects);
  const { data: inventory } = useData(getInventory);
  const { settings } = useSettings();

  const taxEnabled = settings?.tax_enabled === '1';
  const taxRate    = parseFloat(settings?.default_tax_rate || '0');

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
  const [payForm,    setPayForm]    = useState({ amount: '', method: 'Cash', note: '' });
  const [paySubmitting, setPaySubmitting] = useState(false);

  const [deleteId, setDeleteId] = useState(null);

  const { exportLoading, handleExport } = useRecordExport({
    fetchFull:   getInvoice,
    exportPDF:   exportInvoicePDF,
    exportExcel: exportInvoiceExcel,
    getClients:  () => clients,
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
        items: full.items?.length
          ? full.items.map(i => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price }))
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
  const invoiceSubtotal = (form.items || []).reduce((s, i) => s + (Number(i.quantity)||0) * (Number(i.unit_price)||0), 0);
  const invoiceTaxAmt   = (taxEnabled && taxRate > 0) ? invoiceSubtotal * (taxRate / 100) : 0;
  const invoiceTotal    = invoiceSubtotal + invoiceTaxAmt;

  async function handleSave(e) {
    e.preventDefault(); setSaving(true);
    try {
      const subtotal = (form.items || []).reduce(
        (s, i) => s + (Number(i.quantity)||0) * (Number(i.unit_price)||0), 0
      );
      const payload = {
        quotation_id: form.quotation_id ? Number(form.quotation_id) : null,
        project_id:   form.project_id   ? Number(form.project_id)   : null,
        client_id:    form.client_id    ? Number(form.client_id)    : null,
        amount:       subtotal,
        due_date:     form.due_date || null,
        notes:        form.notes    || null,
        items:        (form.items || []).map(i => ({
          name: i.name, quantity: Number(i.quantity)||0, unit_price: Number(i.unit_price)||0,
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

  async function handleArchiveInvoice() {
    try {
      await archiveInvoice(deleteId);
      toast('Invoice archived'); setDeleteId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleVoid() {
    setVoiding(true);
    try {
      await voidInvoice(voidId, voidReason || 'Voided');
      toast(t('invoices.invoiceVoided')); setVoidId(null); setVoidReason(''); reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setVoiding(false); }
  }

  async function openPayModal(inv) {
    setPayLoading(true);
    setPayForm({ amount: '', method: 'Cash', note: '' });
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
    if (paySubmitting) return;
    setPaySubmitting(true);
    try {
      const idempotency_key = crypto.randomUUID ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await addInvoicePayment(payModal.id, {
        amount: amt, method: payForm.method, note: payForm.note || null, idempotency_key,
      });
      toast(t('invoices.paymentRecorded'));
      setPayForm({ amount: '', method: 'Cash', note: '' });
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
        <div style={{display:'flex',gap:8}}>
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
                          onDelete={() => setDeleteId(inv.id)}
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

              <div style={{ display:'grid', gridTemplateColumns:'1fr 90px 110px 90px' + (amountsLocked ? '' : ' 34px'), gap:8, marginBottom:4, alignItems:'center' }}>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', paddingLeft:4 }}>{t('invoices.descriptionCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.qtyCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'center' }}>{t('invoices.unitPriceCol')}</span>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textAlign:'right' }}>{t('common.total')}</span>
                {!amountsLocked && <span />}
              </div>

              {(form.items||[]).map((item, i) => {
                const lineTotal = (Number(item.quantity)||0) * (Number(item.unit_price)||0);
                return (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 90px 110px 90px' + (amountsLocked ? '' : ' 34px'), gap:8, marginBottom:8, alignItems:'center' }}>
                    {amountsLocked ? (
                      <span style={{ fontSize:13, padding:'6px 4px', color:'var(--text-2)' }}>{item.name || '—'}</span>
                    ) : (
                      <InventoryCombobox
                        value={item.name}
                        inventory={inventory || []}
                        onChange={(name, price) => setItemFromInventory(i, name, price)}
                      />
                    )}
                    <input type="number" className="form-control" placeholder={t('common.quantity')} min="0" step="any"
                      value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
                    <input type="number" className="form-control" placeholder="Unit $" min="0" step="0.01"
                      value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)}
                      disabled={amountsLocked} style={amountsLocked ? { opacity:0.6 } : {}} />
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

              <div style={{ textAlign:'right', marginTop:14, fontSize:13, color:'var(--text-2)' }}>
                {!amountsLocked && invoiceTaxAmt > 0 && (
                  <>
                    <div>{t('common.subtotal')}: ${invoiceSubtotal.toFixed(2)}</div>
                    <div>{t('common.tax', { rate: taxRate })}: ${invoiceTaxAmt.toFixed(2)}</div>
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
                { label: t('invoices.invoiceTotal'), value: fmt(payModal.amount),          color:'var(--text-1)' },
                { label: t('invoices.totalPaidLabel'), value: fmt(payModal.total_paid || 0), color:'var(--green)' },
                { label: t('invoices.remaining'),     value: fmt(payModal.remaining ?? 0),
                  color: (payModal.remaining??0) > 0 ? 'var(--red)' : 'var(--green)' },
              ].map(s => (
                <div key={s.label} style={{
                  background:'var(--surface-2)', borderRadius:8, padding:'12px 16px', textAlign:'center',
                }}>
                  <div style={{ fontSize:11, color:'var(--text-3)', marginBottom:4 }}>{s.label}</div>
                  <div style={{ fontSize:18, fontWeight:700, color:s.color }}>{s.value}</div>
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
                      const subtotal = (payModal.items || []).reduce((s, it) => s + (Number(it.quantity)||0) * (Number(it.unit_price)||0), 0);
                      const taxAmt   = (taxEnabled && taxRate > 0) ? subtotal * (taxRate / 100) : 0;
                      return taxAmt > 0 ? (
                        <>
                          <div style={{ padding:'6px 12px', borderTop:'1px solid var(--border)', fontSize:12, display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8, color:'var(--text-2)' }}>
                            <span style={{gridColumn:'1/4', textAlign:'right'}}>{t('common.subtotal')}</span>
                            <span style={{textAlign:'right'}}>${subtotal.toFixed(2)}</span>
                          </div>
                          <div style={{ padding:'6px 12px', borderTop:'1px solid var(--border)', fontSize:12, display:'grid', gridTemplateColumns:'1fr 70px 90px 80px', gap:8, color:'var(--text-2)' }}>
                            <span style={{gridColumn:'1/4', textAlign:'right'}}>{t('common.tax', { rate: taxRate })}</span>
                            <span style={{textAlign:'right', color:'var(--accent)'}}>${taxAmt.toFixed(2)}</span>
                          </div>
                        </>
                      ) : null;
                    })()}
                  </div>
                )}

                {(payModal.remaining ?? 0) > 0.001 && (
                  <form onSubmit={handleAddPayment}
                    style={{ display:'grid', gridTemplateColumns:'1fr 1fr 2fr auto', gap:8, marginBottom:20, alignItems:'end' }}>
                    <div className="form-group" style={{ margin:0 }}>
                      <label className="form-label">{t('invoices.paymentAmount')} *</label>
                      <input type="number" className="form-control" min="0.01" step="0.01"
                        required value={payForm.amount}
                        onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                        placeholder={t('invoices.maxAmount', { amount: fmt(payModal.remaining) })} />
                    </div>
                    <div className="form-group" style={{ margin:0 }}>
                      <label className="form-label">{t('invoices.methodLabel')}</label>
                      <select className="form-control" value={payForm.method}
                        onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}>
                        {METHODS.map(m => <option key={m}>{m}</option>)}
                      </select>
                    </div>
                    <div className="form-group" style={{ margin:0 }}>
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
                )}

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
                          <td style={{ fontWeight:600, color:'var(--green)' }}>{fmt(p.amount)}</td>
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

      {deleteId && (
        <ConfirmModal
          message="Archive this invoice? It will be hidden from the main list. Only invoices with no payments can be archived. You can restore it from the Archives page."
          confirmLabel="Archive"
          confirmClass="btn-danger"
          onConfirm={handleArchiveInvoice}
          onCancel={() => setDeleteId(null)}
        />
      )}
      {deletePayId && (
        <ConfirmModal
          message={t('invoices.deletePaymentMsg')}
          onConfirm={() => { handleDeletePayment(deletePayId); setDeletePayId(null); }}
          onCancel={() => setDeletePayId(null)}
        />
      )}
    </div>
  );
}
