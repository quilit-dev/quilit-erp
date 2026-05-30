import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { useSettings } from '../hooks/useSettings';
import {
  getQuotations, getQuotation, getClients, getProjects, getInventory,
  createQuotation, updateQuotation, cancelQuotation, archiveQuotation,
  convertToInvoice, convertToProject, getCRMLeads,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination,
  DualMoney, ExchangeRateBadge, DisplayCurrencyToggle, WhatsAppShareButton,
} from '../components/shared';
import { exportQuotationPDF, exportQuotationExcel } from '../utils/exportUtils';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import Attachments from '../components/Attachments.jsx';
import InventoryCombobox from '../components/InventoryCombobox';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useRecordExport } from '../hooks/useRecordExport';

const STATUSES   = ['Draft', 'Sent', 'Accepted', 'Rejected'];
const EMPTY_ITEM = { name: '', quantity: 1, unit_price: 0, tax_rate_id: null };
const makeEmpty  = () => ({ client_id: '', lead_id: '', project_id: '', project_name: '', status: 'Draft', notes: '', items: [{ ...EMPTY_ITEM }] });

const menuItemStyle = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
  background: 'none', border: 'none', textAlign: 'left',
  fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};

// ── Per-row action dropdown (Edit / exports / Cancel / Archive) ───────────
function QuoteActionMenu({ exporting, onEdit, onExport, onCancel, onArchive }) {
  const { t } = useLocale();
  const [open, setOpen]     = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref    = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropUp(window.innerHeight - rect.bottom < 230);
    }
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const isExporting = !!exporting;
  const divider = <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={btnRef}
        className="btn btn-sm btn-secondary"
        title={t('common.actions')}
        onClick={() => setOpen(o => !o)}
        style={{ padding: '0 8px', letterSpacing: 1, fontWeight: 700 }}
      >
        ⋯
      </button>

      {open && (
        <div style={{
          position: 'fixed',
          left: (() => {
            if (!btnRef.current) return 4;
            const r  = btnRef.current.getBoundingClientRect();
            const mw = 180;
            let left = r.right - mw;
            if (left < 4) left = r.left;
            if (left + mw > window.innerWidth - 4) left = window.innerWidth - mw - 4;
            return Math.max(4, left);
          })(),
          ...(dropUp
            ? { bottom: window.innerHeight - btnRef.current.getBoundingClientRect().top + 4 }
            : { top: btnRef.current.getBoundingClientRect().bottom + 4 }),
          zIndex: 9999,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
          minWidth: 180, padding: '4px 0', whiteSpace: 'nowrap',
        }}>
          <button style={menuItemStyle} onClick={() => { setOpen(false); onEdit(); }}>
            ✏️ {t('common.edit')}
          </button>

          {divider}

          <button
            style={{ ...menuItemStyle, color: '#166534', opacity: isExporting ? 0.5 : 1 }}
            disabled={isExporting}
            onClick={() => { setOpen(false); onExport('excel'); }}
          >
            {exporting === 'excel' ? '⏳ ' + t('common.exporting') : '📊 ' + t('quotations.exportXls')}
          </button>
          <button
            style={{ ...menuItemStyle, color: '#991b1b', opacity: isExporting ? 0.5 : 1 }}
            disabled={isExporting}
            onClick={() => { setOpen(false); onExport('pdf'); }}
          >
            {exporting === 'pdf' ? '⏳ ' + t('common.exporting') : '📄 ' + t('quotations.exportPdf')}
          </button>

          {divider}

          <button style={{ ...menuItemStyle, color: '#92400e' }} onClick={() => { setOpen(false); onCancel(); }}>
            🚫 {t('quotations.cancelQuote')}
          </button>
          <button style={{ ...menuItemStyle, color: 'var(--red)' }} onClick={() => { setOpen(false); onArchive(); }}>
            🗄 {t('common.archive')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Quotations() {
  const { t, tStatus } = useLocale();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { data: quotations, loading, error, reload } = useData(getQuotations);
  const { data: clients,  loading: cLoading,  reload: reloadClients }  = useData(getClients);
  // Quotations can also be addressed to CRM leads — load active (non-archived)
  // leads alongside the client list so the picker covers both.
  const { data: leads,    loading: lLoading,  reload: reloadLeads }    = useData((s) => getCRMLeads({}, s));
  const { data: projects, loading: pLoading, reload: reloadProjects } = useData(getProjects);
  const { data: inventory } = useData(getInventory);
  const { settings, exchangeRate, displayCurrency, taxRates } = useSettings();

  const [modalOpen,    setModalOpen]    = useState(false);
  const [form,         setForm]         = useState(makeEmpty);
  const [editId,       setEditId]       = useState(null);
  const [formLoading,  setFormLoading]  = useState(false);
  const [cancelId,     setCancelId]     = useState(null);
  const [archiveId,    setArchiveId]    = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [statusFilter, setStatusFilter] = usePersistedState('quotations.statusFilter', '');
  const [search, setSearch] = usePersistedState('quotations.search', '');
  const [clientFilter, setClientFilter] = usePersistedState('quotations.clientFilter', '');
  const [projectFilter, setProjectFilter] = usePersistedState('quotations.projectFilter', '');

  const { exportLoading, handleExport } = useRecordExport({
    fetchFull:   getQuotation,
    exportPDF:   exportQuotationPDF,
    exportExcel: exportQuotationExcel,
    getClients:  () => clients,
    getExportOpts: () => ({ displayCurrency, exchangeRate }),
  });

  function openCreate() {
    reloadClients(); reloadLeads(); reloadProjects();
    setForm(makeEmpty()); setEditId(null); setModalOpen(true);
  }

  async function openEdit(q) {
    reloadClients(); reloadLeads(); reloadProjects();
    setEditId(q.id); setFormLoading(true); setModalOpen(true);
    try {
      const full = await getQuotation(q.id);
      setForm({
        client_id:  full.client_id  ?? '',
        lead_id:    full.lead_id    ?? '',
        project_id:   full.project_id   ?? '',
        project_name: full.project_name  || '',
        status:     full.status || 'Draft',
        notes:      full.notes  || '',
        items: full.items?.length
          ? full.items.map(i => ({ name: i.name, quantity: i.quantity,
                                   unit_price: i.unit_price, tax_rate_id: i.tax_rate_id ?? null }))
          : [{ ...EMPTY_ITEM }],
      });
    } catch (err) {
      toast(`Could not load quotation: ${err.message}`, 'red');
      setModalOpen(false);
    } finally { setFormLoading(false); }
  }

  function closeModal() { setModalOpen(false); setEditId(null); setForm(makeEmpty()); }

  const addItem    = ()              => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }));
  const removeItem = (i)             => setForm(f => ({ ...f, items: f.items.filter((_, x) => x !== i) }));
  const setItem    = (i, field, val) => setForm(f => ({
    ...f, items: f.items.map((item, x) => x === i ? { ...item, [field]: val } : item),
  }));
  const setItemFromInventory = (i, name) => setForm(f => ({
    ...f, items: f.items.map((item, x) => x === i ? { ...item, name } : item),
  }));

  const taxEnabled     = settings?.tax_enabled === '1';
  const activeTaxRates = (taxRates || []).filter(r => r.is_active);
  const defaultTaxRate = (taxRates || []).find(r => r.is_default) || null;
  const rateById = (id) =>
    (taxRates || []).find(r => r.id === id) || defaultTaxRate || null;
  const lineTaxAmt = (item) => {
    if (!taxEnabled) return 0;
    const r = rateById(item.tax_rate_id);
    const net = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    return r ? net * (Number(r.rate) || 0) / 100 : 0;
  };
  const subtotal     = form.items.reduce((s, i) => s + (Number(i.quantity)||0) * (Number(i.unit_price)||0), 0);
  const quoteTaxAmt  = form.items.reduce((s, i) => s + lineTaxAmt(i), 0);
  const total        = subtotal + quoteTaxAmt;

  async function handleSave(e) {
    e.preventDefault(); setSaving(true);
    try {
      const payload = {
        client_id:    form.client_id    ? Number(form.client_id)  : null,
        lead_id:      form.lead_id      ? Number(form.lead_id)    : null,
        project_id:   form.project_id   ? Number(form.project_id) : null,
        project_name: (!form.project_id && form.project_name.trim()) ? form.project_name.trim() : null,
        status: form.status, notes: form.notes || null,
        items: form.items.map(i => ({
          name: i.name, quantity: Number(i.quantity)||0, unit_price: Number(i.unit_price)||0,
          tax_rate_id: i.tax_rate_id ?? null,
        })),
      };
      if (editId) { await updateQuotation(editId, payload); toast(t('quotations.quotationUpdated')); }
      else        { await createQuotation(payload);          toast(t('quotations.quotationCreated')); }
      closeModal(); reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleCancel() {
    try {
      await cancelQuotation(cancelId, 'Cancelled by user');
      toast('Quotation cancelled'); setCancelId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleArchive() {
    try {
      await archiveQuotation(archiveId);
      toast('Quotation archived'); setArchiveId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const [convertInvoiceId, setConvertInvoiceId] = useState(null);
  const [convertProjectId, setConvertProjectId] = useState(null);

  async function handleConvertInvoice(q) {
    try {
      const res = await convertToInvoice(q.id);
      toast(`${res.invoice_number} created — go to Invoices to record payments.`);
      setConvertInvoiceId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleConvertProject(q) {
    try {
      const res = await convertToProject(q.id);
      setConvertProjectId(null);
      reload();
      toast(`Project created from ${q.quote_number} — click to view.`);
      if (res.project_id) navigate(`/projects/${res.project_id}`);
    } catch (err) { toast(err.message, 'red'); }
  }

  const q2 = search.toLowerCase();
  const filtered = (quotations || []).filter(q => {
    if (statusFilter  && q.status !== statusFilter) return false;
    if (clientFilter  && String(q.client_id) !== clientFilter) return false;
    if (projectFilter && String(q.project_id) !== projectFilter) return false;
    if (q2 && ![q.quote_number, q.client_name, q.lead_name, q.lead_company,
                q.project_name, q.notes]
                .join(' ').toLowerCase().includes(q2)) return false;
    return true;
  });
  const dropdownsReady = !cLoading && !lLoading && !pLoading;

  const { sorted: pagedQuotations, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  const exportData = (filtered || []).map(q => ({
    'Quote #':               q.quote_number,
    'Status':                q.status,
    'Client':                q.client_name  || (q.lead_name ? `${q.lead_name} (lead)` : '—'),
    'Project':               q.project_name || '—',
    'Total excl. VAT (USD)': q.total        || 0,
    ...(taxEnabled ? { 'Total incl. VAT (USD)': q.total_with_tax ?? q.total ?? 0 } : {}),
    'Created':               q.created_at   ? new Date(q.created_at).toLocaleDateString() : '—',
    'Notes':                 q.notes        || '',
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('quotations.title')}</h1>
          <p className="page-subtitle">{t('quotations.totalQuotations', { count: quotations?.length ?? 0 })}</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <ExportButton data={exportData} filename="Quotations" sheetName="Quotations" />
          <button className="btn btn-primary" onClick={openCreate}>{t('quotations.addQuotation')}</button>
        </div>
      </div>

      {/* Workflow hint banner */}
      <div style={{
        background:'var(--blue-light,#eff6ff)', border:'1px solid var(--blue,#3b82f6)',
        borderRadius:8, padding:'10px 16px', marginBottom:16, fontSize:13,
        color:'var(--blue-dark,#1d4ed8)', display:'flex', alignItems:'center', gap:8,
      }}>
        <span>ℹ️</span>
        <span>{t('quotations.workflowHint')}</span>
      </div>

      <div className="card">
        <div className="card-header" style={{flexDirection:'column',alignItems:'stretch',gap:10}}>
          <div className="search-bar" style={{ margin:0, flexWrap:'wrap' }}>
            <div className="search-input-wrap" style={{flex:'1 1 200px',minWidth:180}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input className="form-control search-input" placeholder={t('quotations.searchPlaceholderFull')}
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
              {STATUSES.map(s => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
            {(search||clientFilter||projectFilter||statusFilter) && (
              <button className="btn btn-secondary btn-sm" style={{whiteSpace:'nowrap'}}
                onClick={() => { setSearch(''); setClientFilter(''); setProjectFilter(''); setStatusFilter(''); }}>
                ✕ {t('common.clear')}
              </button>
            )}
          </div>
          {filtered.length !== (quotations||[]).length && (
            <div style={{fontSize:12,color:'var(--text-3)'}}>
              {t('quotations.showingFiltered', { count: filtered.length, total: (quotations||[]).length })}
            </div>
          )}
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         filtered.length === 0 ? <EmptyState message={t('quotations.noQuotationsFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('quotations.quoteNumber')} sortKey="quote_number"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('quotations.client')}      sortKey="client_name"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('quotations.project')}     sortKey="project_name"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.status')}          sortKey="status"        currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={taxEnabled ? t('quotations.totalExclVAT') : t('common.total')} sortKey="total" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  {taxEnabled && <SortableTh label={t('quotations.totalInclVAT')} sortKey="total_with_tax" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />}
                  <th>{t('quotations.invoiceCol')}</th>
                  <SortableTh label={t('common.created')} sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedQuotations.map(q => {
                  const exporting = exportLoading[q.id];
                  return (
                    <tr key={q.id}>
                      <td className="td-primary text-mono">{q.quote_number}</td>
                      <td>
                        {q.client_name
                          ? q.client_name
                          : q.lead_name
                            ? <span>{q.lead_name}
                                <span className="badge badge-yellow" style={{ marginInlineStart: 6, fontSize: 10 }}>Lead</span>
                                {q.lead_company && (
                                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>{q.lead_company}</span>
                                )}
                              </span>
                            : '—'}
                      </td>
                      <td>
                        {q.project_name
                          ? <span>{q.project_name}{!q.project_id && <span style={{ marginLeft:5, fontSize:10, color:'var(--text-3)', fontStyle:'italic' }}>{t('quotations.pending')}</span>}</span>
                          : '—'}
                      </td>
                      <td><Badge status={q.status} /></td>
                      <td className="fw-600">{fmt(q.total)}</td>
                      {taxEnabled && <td className="fw-600">{fmt(q.total_with_tax ?? q.total)}</td>}
                      <td>
                        {q.invoice_count > 0
                          ? <span className="badge badge-green">{t('quotations.invoicedBadge')}</span>
                          : <span className="badge badge-gray">—</span>}
                      </td>
                      <td>{fmtDate(q.created_at)}</td>
                      <td>
                        <div style={{ display:'flex', gap:6, alignItems:'center', justifyContent:'flex-end' }}>
                          <WhatsAppShareButton
                            phone={q.client_phone || q.lead_phone}
                            message={`Hello${(q.client_name || q.lead_name) ? `, ${q.client_name || q.lead_name}` : ''}, please find our quotation ${q.quote_number} for ${fmt(q.total_with_tax ?? q.total)}. Looking forward to your feedback.`}
                          />
                          {q.invoice_count === 0 && (
                            <button
                              className="btn btn-sm btn-secondary"
                              style={{ background:'var(--accent)', color:'#fff', whiteSpace:'nowrap' }}
                              onClick={() => setConvertInvoiceId(q)}
                            >
                              {t('quotations.toInvoice')}
                            </button>
                          )}
                          {!q.project_id && (
                            <button className="btn btn-sm btn-secondary" style={{ whiteSpace:'nowrap' }}
                              onClick={() => setConvertProjectId(q)}>
                              {t('quotations.toProject')}
                            </button>
                          )}
                          <QuoteActionMenu
                            exporting={exporting}
                            onEdit={() => openEdit(q)}
                            onExport={(type) => handleExport(q, type)}
                            onCancel={() => setCancelId(q.id)}
                            onArchive={() => setArchiveId(q.id)}
                          />
                        </div>
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

      {/* Create / Edit modal */}
      {modalOpen && (
        <Modal title={editId ? t('quotations.editQuotation') : t('quotations.newQuotation')} onClose={closeModal} size="modal-lg">
          {formLoading || !dropdownsReady ? (
            <div className="modal-body">
              <LoadingSpinner />
              <p style={{ textAlign:'center', color:'var(--text-3)', fontSize:13, marginTop:8 }}>
                {formLoading ? t('quotations.loadingQuotation') : t('quotations.loadingDropdowns')}
              </p>
            </div>
          ) : (
            <form onSubmit={handleSave}>
              <div className="modal-body">
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">
                      {t('quotations.clientLabel')}
                      {!(clients||[]).length && <span style={{ color:'var(--yellow)', marginLeft:6, fontSize:12 }}>{t('quotations.noneYet')}</span>}
                    </label>
                    <select className="form-control" value={form.client_id}
                      onChange={e => setForm(f => ({ ...f, client_id: e.target.value, lead_id: e.target.value ? '' : f.lead_id }))}>
                      <option value="">{t('quotations.selectClientOption')}</option>
                      {(clients||[]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      Lead
                      <span style={{ color:'var(--text-3)', marginLeft:6, fontSize:11, fontStyle:'italic' }}>
                        (instead of a client)
                      </span>
                    </label>
                    <select className="form-control" value={form.lead_id}
                      onChange={e => setForm(f => ({ ...f, lead_id: e.target.value, client_id: e.target.value ? '' : f.client_id }))}>
                      <option value="">— None —</option>
                      {(leads||[]).map(l => (
                        <option key={l.id} value={l.id}>
                          {l.name}{l.company ? ` — ${l.company}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      {t('quotations.projectLabel')}
                      {!(projects||[]).length && <span style={{ color:'var(--yellow)', marginLeft:6, fontSize:12 }}>{t('quotations.noneYet')}</span>}
                    </label>
                    <select className="form-control" value={form.project_id}
                      onChange={e => setForm(f => ({ ...f, project_id: e.target.value, project_name: '' }))}>
                      <option value="">{t('quotations.noneProject')}</option>
                      {(projects||[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  {!form.project_id && (
                    <div className="form-group">
                      <label className="form-label">{t('quotations.expectedProjectName')}</label>
                      <input
                        className="form-control"
                        value={form.project_name}
                        onChange={e => setForm(f => ({ ...f, project_name: e.target.value }))}
                      />
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label">{t('quotations.statusLabel')}</label>
                    <select className="form-control" value={form.status}
                      onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                      {STATUSES.map(s => <option key={s} value={s}>{tStatus(s)}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('quotations.notesLabel')}</label>
                    <input className="form-control" value={form.notes}
                      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                  </div>
                </div>

                <div style={{ borderTop:'1px solid var(--border)', margin:'16px 0' }} />
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                  <span style={{ fontWeight:600, fontSize:14 }}>{t('common.lineItems')}</span>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={addItem}>{t('common.addItem')}</button>
                </div>

                {form.items.map((item, i) => (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 78px 96px' + (taxEnabled ? ' 124px' : '') + ' 34px', gap:8, marginBottom:8, alignItems:'center' }}>
                    <InventoryCombobox
                      value={item.name}
                      inventory={inventory || []}
                      onChange={(name) => setItemFromInventory(i, name)}
                    />
                    <input type="number" className="form-control" placeholder={t('common.quantity')} min="0" step="any"
                      value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)} />
                    <input type="number" className="form-control" placeholder="Unit $" min="0" step="0.01"
                      value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} />
                    {taxEnabled && (
                      <select className="form-control" style={{ fontSize:12, padding:'6px 4px' }}
                        value={item.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                        onChange={e => setItem(i, 'tax_rate_id', Number(e.target.value) || null)}>
                        {activeTaxRates.map(r => (
                          <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                        ))}
                      </select>
                    )}
                    <button type="button" className="btn btn-sm btn-danger"
                      onClick={() => removeItem(i)} disabled={form.items.length === 1}>✕</button>
                  </div>
                ))}

                <div style={{ textAlign:'right', marginTop:14, fontSize:13, color:'var(--text-2)' }}>
                  {quoteTaxAmt > 0 && (
                    <>
                      <div>{t('common.subtotal')}: {fmt(subtotal)}</div>
                      <div>{t('common.taxCol')}: {fmt(quoteTaxAmt)}</div>
                    </>
                  )}
                  <div style={{ fontWeight:700, fontSize:16, color:'var(--text-1)', marginTop: quoteTaxAmt > 0 ? 4 : 0 }}>
                    {t('common.total')}: <DualMoney value={total} block={false} />
                  </div>
                </div>
              </div>

              {editId && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                  <Attachments entityType="quotations" entityId={editId} canEdit={can('quotations', 'edit')} />
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? t('common.saving') : editId ? t('common.save') : t('quotations.createQuotation')}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {cancelId && (
        <ConfirmModal
          message="Cancel this quotation? Its status will be set to Cancelled. No invoice can be raised from a cancelled quotation."
          confirmLabel="Cancel Quotation"
          confirmClass="btn-warning"
          onConfirm={handleCancel}
          onCancel={() => setCancelId(null)}
        />
      )}
      {archiveId && (
        <ConfirmModal
          message="Archive this quotation? It will be hidden from the main list. You can restore it from the Archives page."
          confirmLabel="Archive"
          confirmClass="btn-danger"
          onConfirm={handleArchive}
          onCancel={() => setArchiveId(null)}
        />
      )}
      {convertInvoiceId && (
        <ConfirmModal
          message={t('quotations.convertInvoiceConfirm', { quote_number: convertInvoiceId.quote_number })}
          onConfirm={() => handleConvertInvoice(convertInvoiceId)}
          onCancel={() => setConvertInvoiceId(null)}
        />
      )}
      {convertProjectId && (
        <ConfirmModal
          message={`Accept ${convertProjectId.quote_number} and create a linked project${convertProjectId.project_name ? ` "${convertProjectId.project_name}"` : ''}? The quotation total (${fmt(convertProjectId.total)}) will be set as the project's expected revenue.`}
          onConfirm={() => handleConvertProject(convertProjectId)}
          onCancel={() => setConvertProjectId(null)}
        />
      )}
    </div>
  );
}
