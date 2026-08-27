import { usePersistedState } from '../hooks/usePersistedState';
import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { useSettings } from '../hooks/useSettings';
import {
  getQuotations, getQuotation, getClients, getProjects, getInventory,
  createQuotation, updateQuotation, voidQuotation, unvoidQuotation,
  convertToInvoice, convertToProject, getCRMLeads, promoPreview
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination,
  DualMoney, ExchangeRateBadge, DisplayCurrencyToggle, NumberInput, BranchField,
  Icon} from '../components/shared';
import { SendDocumentButton } from '../components/SendDocument';
import { exportQuotationPDF, exportQuotationExcel } from '../utils/exportUtils';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import Attachments from '../components/Attachments.jsx';
import InventoryCombobox, { salePriceInBase } from '../components/InventoryCombobox';
import { useRecordExport } from '../hooks/useRecordExport';
import { useFocusId } from '../hooks/useFocusId';
import { useServerList } from '../hooks/useServerList';
import SearchSelect from '../components/SearchSelect.jsx';

const STATUSES   = ['Draft', 'Sent', 'Accepted', 'Rejected'];
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
const makeEmpty  = () => ({ client_id: '', lead_id: '', project_id: '', project_name: '', status: 'Draft', notes: '', branch_id: '', items: [{ ...EMPTY_ITEM }] });

const menuItemStyle = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px',
  background: 'none', border: 'none', textAlign: 'start',
  fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};

// Spin the loader arc while an export is running (keyframes live in index.css).
const SPIN = { animation: 'spin .7s linear infinite' };

// ── Per-row action dropdown (Edit / exports / Void / Unvoid) ──────────────
function QuoteActionMenu({ doc, exporting, isVoided, onEdit, onExport, onVoid, onUnvoid }) {
  const { t, lang } = useLocale();
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
          <button
            style={{ ...menuItemStyle, opacity: isVoided ? 0.4 : 1, cursor: isVoided ? 'not-allowed' : 'pointer' }}
            disabled={isVoided}
            onClick={() => { setOpen(false); onEdit(); }}
          >
            <Icon name="pencil" size={14} />
            <span>{t('common.edit')}{isVoided ? ` (${t('invoices.voidedLabel')})` : ''}</span>
          </button>

          {divider}

          <button
            style={{ ...menuItemStyle, color: '#166534', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            disabled={isExporting || isVoided}
            onClick={() => { setOpen(false); onExport('excel'); }}
          >
            {exporting === 'excel'
              ? <><Icon name="loader" size={14} style={SPIN} /><span>{t('common.exporting')}</span></>
              : <><Icon name="file-spreadsheet" size={14} /><span>{t('quotations.exportXls')}</span></>}
          </button>

          {/* Browser-rendered from the HTML/CSS template in exportUtils.js —
              opens the print dialog, where the operator chooses Save as PDF. */}
          <button
            style={{ ...menuItemStyle, color: '#991b1b', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            disabled={isExporting || isVoided}
            onClick={() => { setOpen(false); onExport('pdf'); }}
          >
            {exporting === 'pdf'
              ? <><Icon name="loader" size={14} style={SPIN} /><span>{t('common.exporting')}</span></>
              : <><Icon name="file-text" size={14} /><span>{t('quotations.exportPdf')}</span></>}
          </button>

          {/* No WhatsApp / email entries here — the row's Send button covers
              both channels. See the note in invoices/ActionMenu.jsx. */}

          {divider}

          {isVoided ? (
            <button style={{ ...menuItemStyle, color: '#166534' }} onClick={() => { setOpen(false); onUnvoid(); }}>
              <Icon name="rotate-ccw" size={14} />
              <span>{t('quotations.unvoidQuote')}</span>
            </button>
          ) : (
            <button style={{ ...menuItemStyle, color: '#92400e' }} onClick={() => { setOpen(false); onVoid(); }}>
              <Icon name="ban" size={14} />
              <span>{t('quotations.voidQuote')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Quotations() {
  const { t, tStatus } = useLocale();
  const { can } = usePermissions();
  const navigate = useNavigate();
  // Quotations use Void/Unvoid as their lifecycle, not archive — so there is
  // no in-module "Show archived" view here.
  const [statusFilter, setStatusFilter]   = usePersistedState('quotations.statusFilter', '');
  const [clientFilter, setClientFilter]   = usePersistedState('quotations.clientFilter', '');
  const [projectFilter, setProjectFilter] = usePersistedState('quotations.projectFilter', '');
  const [savedSearch, setSavedSearch]     = usePersistedState('quotations.search', '');

  // Paged, searched and sorted BY THE SERVER; this screen used to fetch every
  // quotation and do all three in the browser.
  const list = useServerList(
    (query, s) => getQuotations(query, s),
    {
      status:     statusFilter  || undefined,
      client_id:  clientFilter  || undefined,
      project_id: projectFilter || undefined,
    },
    { initialSearch: savedSearch },
  );
  const { items: pagedQuotations, total: totalCount, loading, error, reload,
          page, pageSize, totalPages, setPage, setPageSize,
          sortKey, sortDir, requestSort, search, setSearch,
          isFiltered, PAGE_SIZES } = list;
  // Keep remembering the operator's search across sessions, as before.
  useEffect(() => { setSavedSearch(search); }, [search]);
  const { data: clients,  loading: cLoading,  reload: reloadClients }  = useData((s) => getClients({}, s));
  // Quotations can also be addressed to CRM leads — load active (non-archived)
  // leads alongside the client list so the picker covers both.
  const { data: leads,    loading: lLoading,  reload: reloadLeads }    = useData((s) => getCRMLeads({}, s));
  const { data: projects, loading: pLoading, reload: reloadProjects } = useData((s) => getProjects({}, s));
  const { data: inventory } = useData((s) => getInventory({}, s));
  const { settings, exchangeRate, displayCurrency, taxRates } = useSettings();

  // Global-search deep link (?focus=<id>) → open that quotation.
  const [focusId, clearFocus] = useFocusId();
  useEffect(() => {
    if (focusId == null) return;
    // Fetched by id, not looked up in the loaded rows: the list is one page
    // now, so a link from global search or a client's quotation list usually
    // points at a record that is not on it.
    let alive = true;
    getQuotation(focusId)
      .then(q => { if (alive && q) { openEdit(q); clearFocus(); } })
      .catch(() => { /* deleted or not visible to this user — ignore */ });
    return () => { alive = false; };
  }, [focusId]);

  const [modalOpen,    setModalOpen]    = useState(false);
  const [form,         setForm]         = useState(makeEmpty);
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
  const [editId,       setEditId]       = useState(null);
  const [formLoading,  setFormLoading]  = useState(false);
  const [voidQuoteId,  setVoidQuoteId]  = useState(null);
  const [saving,       setSaving]       = useState(false);

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
        branch_id:  full.branch_id ?? '',
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
  // Quotations never filled a price at all — the picked item's price was
  // discarded. Same behaviour as invoices now: fill the sale price, remember the
  // stock link, and let the user override.
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

  const taxEnabled     = settings?.tax_enabled === '1';
  // NOTE: `show_discount_col` is deliberately NOT read here. The discount box
  // is always shown on a quotation because a promotion can reduce a line
  // whether or not manual per-line discounts are switched on, and a reduction
  // the operator cannot see is how a quoted total stops matching the document.
  // The variable used to exist and gated only the grid column, which is what
  // left the row one column short of its children.
  const activeTaxRates = (taxRates || []).filter(r => r.is_active);
  const defaultTaxRate = (taxRates || []).find(r => r.is_default) || null;
  const rateById = (id) =>
    (taxRates || []).find(r => r.id === id) || defaultTaxRate || null;
  // Net per line — qty × price MINUS the per-line discount when enabled,
  // floored at 0 so a typo can't drive a line negative.
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
  const subtotal     = form.items.reduce((s, it, i) => s + lineNet(it, i), 0);
  // Counts promotions too: a reduction the customer receives belongs in the
  // total whether or not manual per-line discounts are switched on.
  const discountTotal = form.items.reduce((s, it, i) => s + effDiscount(it, i), 0);
  const quoteTaxAmt  = form.items.reduce((s, it, i) => s + lineTaxAmt(it, i), 0);
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
        branch_id: form.branch_id || null,
        items: form.items.map(i => ({
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
      };
      if (editId) { await updateQuotation(editId, payload); toast(t('quotations.quotationUpdated')); }
      else        { await createQuotation(payload);          toast(t('quotations.quotationCreated')); }
      closeModal(); reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleVoid() {
    try {
      await voidQuotation(voidQuoteId, 'Voided by user');
      toast(t('quotations.quotationVoided')); setVoidQuoteId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleUnvoid(q) {
    try {
      await unvoidQuotation(q.id);
      toast(t('quotations.quotationRestored')); reload();
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

  const dropdownsReady = !cLoading && !lLoading && !pLoading;

  // Fetches every matching quotation (no `limit`), so an export is never
  // silently truncated to the page on screen.
  const fetchExportRows = async () => {
    const all = await getQuotations({
      status:     statusFilter  || undefined,
      client_id:  clientFilter  || undefined,
      project_id: projectFilter || undefined,
      ...(search.trim() ? { search: search.trim() } : {}),
    });
    return (Array.isArray(all) ? all : all.items || []).map(q => ({
    'Quote #':               q.quote_number,
    'Status':                q.status,
    'Client':                q.client_name  || (q.lead_name ? `${q.lead_name} (lead)` : '—'),
    'Project':               q.project_name || '—',
    'Total excl. VAT (USD)': q.total        || 0,
    ...(taxEnabled ? { 'Total incl. VAT (USD)': q.total_with_tax ?? q.total ?? 0 } : {}),
    'Created':               q.created_at   ? new Date(q.created_at).toLocaleDateString() : '—',
    'Notes':                 q.notes        || '',
    }));
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('quotations.title')}</h1>
          <p className="page-subtitle">{t('quotations.totalQuotations', { count: totalCount })}</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <ExportButton fetchData={fetchExportRows} filename="Quotations" sheetName="Quotations" />
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
            <SearchSelect
              className="form-control"
              style={{width:190}}
              value={clientFilter}
              onChange={v => setClientFilter(v)}
              placeholder={t('common.allClients')}
              options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
            <SearchSelect
              className="form-control"
              style={{width:220}}
              value={projectFilter}
              onChange={v => setProjectFilter(v)}
              placeholder={t('common.allProjects')}
              options={(projects || []).map(p => ({ value: p.id, label: p.name }))} />
            <select className="form-control" style={{width:150}}
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">{t('common.allStatuses')}</option>
              {[...STATUSES, 'Voided'].map(s => <option key={s} value={s}>{tStatus(s)}</option>)}
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
              {t('quotations.showingFiltered', { count: totalCount, total: totalCount })}
            </div>
          )}
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         pagedQuotations.length === 0 ? <EmptyState message={t('quotations.noQuotationsFound')} /> : (
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
                  const isVoided  = q.status === 'Voided' || q.status === 'Cancelled';
                  return (
                    <tr key={q.id}>
                      <td className="td-primary text-mono">{q.quote_number}</td>
                      <td>
                        {q.client_name
                          ? q.client_name
                          : q.lead_name
                            ? <span>{q.lead_name}
                                <span className="badge badge-yellow" style={{ marginInlineStart: 6, fontSize: 10 }}>{t('quotations.leadLabel')}</span>
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
                          {isVoided ? (
                            <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('invoices.voidedLabel')}</span>
                          ) : (
                            <SendDocumentButton entityType="quotation" doc={q} />
                          )}
                          {q.invoice_count === 0 && !isVoided && (
                            <button
                              className="btn btn-sm btn-secondary"
                              style={{ background:'var(--accent)', color:'#fff', whiteSpace:'nowrap' }}
                              onClick={() => setConvertInvoiceId(q)}
                            >
                              {t('quotations.toInvoice')}
                            </button>
                          )}
                          {!q.project_id && !isVoided && (
                            <button className="btn btn-sm btn-secondary" style={{ whiteSpace:'nowrap' }}
                              onClick={() => setConvertProjectId(q)}>
                              {t('quotations.toProject')}
                            </button>
                          )}
                          <QuoteActionMenu
                            doc={q}
                            exporting={exporting}
                            isVoided={isVoided}
                            onEdit={() => openEdit(q)}
                            onExport={(type) => handleExport(q, type)}
                            onVoid={() => setVoidQuoteId(q.id)}
                            onUnvoid={() => handleUnvoid(q)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={totalCount} setPage={setPage} setPageSize={setPageSize} />
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
                    <SearchSelect
                      className="form-control"
                      value={form.client_id}
                      onChange={v => setForm(f => ({ ...f, client_id: v, lead_id: v ? '' : f.lead_id }))}
                      placeholder={t('quotations.selectClientOption')}
                      options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      {t('quotations.leadLabel')}
                      <span style={{ color:'var(--text-3)', marginLeft:6, fontSize:11, fontStyle:'italic' }}>
                        {t('common.insteadOfClient')}
                      </span>
                    </label>
                    <select className="form-control" value={form.lead_id}
                      onChange={e => setForm(f => ({ ...f, lead_id: e.target.value, client_id: e.target.value ? '' : f.client_id }))}>
                      <option value="">{t('quotations.leadNone')}</option>
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
                    <SearchSelect
                      className="form-control"
                      value={form.project_id}
                      onChange={v => setForm(f => ({ ...f, project_id: v, project_name: '' }))}
                      placeholder={t('quotations.noneProject')}
                      options={(projects || []).map(p => ({ value: p.id, label: p.name }))} />
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
                  <BranchField value={form.branch_id}
                    onChange={v => setForm(f => ({ ...f, branch_id: v }))} />
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

                {/* Grid columns: name | qty | price | [disc?] | [tax?] | × */}
                {form.items.map((item, i) => (
                  <div key={i} style={{
                    display: 'grid',
                    gridTemplateColumns:
                      '1fr 78px 96px'
                      // The discount column is ALWAYS reserved, matching
                      // invoices. The input below renders unconditionally —
                      // a promotion reduces what the customer owes whether or
                      // not manual per-line discounts are switched on — so
                      // making the column conditional left five children in a
                      // four-column grid and wrapped the ✕ onto its own row.
                      // `show_discount_col` defaults to "0", so that was the
                      // DEFAULT appearance of this form.
                      + ' 92px'
                      + (taxEnabled      ? ' 124px' : '')
                      + ' 34px',
                    gap: 10, marginBottom: 10, alignItems: 'center',
                  }}>
                    <InventoryCombobox
                      value={item.name}
                      inventory={inventory || []}
                      title={t('lineItem.itemTitle')}
                      placeholder={t('lineItem.itemPh')}
                      onChange={(name, price, meta) => setItemFromInventory(i, name, price, meta)}
                    />
                    <NumberInput className="form-control" placeholder={t('common.quantity')} min="0" step="any"
                      title={t('lineItem.qtyTitle')}
                      value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)} />
                    <NumberInput className="form-control" placeholder={t('lineItem.unitPricePh')} min="0" step="0.01"
                      title={t('lineItem.unitPriceTitle')}
                      value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} />
                    <NumberInput className="form-control"
                      placeholder="%"
                      title={t('lineItem.discountTitle')}
                      min="0" max="100" step="0.01"
                      value={item.discount_auto === false
                        ? item.discount_pct
                        : (promoLines[i]?.discount_pct ?? '')}
                      onChange={e => setItemDiscount(i, e.target.value)} />
                    {taxEnabled && (
                      <select className="form-control" style={{ fontSize:12, padding:'6px 4px' }}
                        title={t('lineItem.taxTitle')}
                        value={item.tax_rate_id ?? (defaultTaxRate?.id ?? '')}
                        onChange={e => setItem(i, 'tax_rate_id', Number(e.target.value) || null)}>
                        {activeTaxRates.map(r => (
                          <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                        ))}
                      </select>
                    )}
                    <button type="button" className="btn btn-sm btn-danger"
                      title={t('lineItem.removeTitle')}
                      onClick={() => removeItem(i)} disabled={form.items.length === 1}>✕</button>
                  </div>
                ))}

                <div style={{ textAlign:'right', marginTop:14, fontSize:13, color:'var(--text-2)' }}>
                  {(quoteTaxAmt > 0 || discountTotal > 0) && (
                    <>
                      <div>{t('common.subtotal')}: {fmt(subtotal)}</div>
                      {discountTotal > 0 && (
                        <div style={{ color: 'var(--affirm)' }}>
                          {t('common.discount')}: −{fmt(discountTotal)}
                        </div>
                      )}
                      {quoteTaxAmt > 0 && <div>{t('common.taxCol')}: {fmt(quoteTaxAmt)}</div>}
                    </>
                  )}
                  <div style={{ fontWeight:700, fontSize:16, color:'var(--text-1)', marginTop: (quoteTaxAmt > 0 || discountTotal > 0) ? 4 : 0 }}>
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

      {voidQuoteId && (
        <ConfirmModal
          message={t('quotations.voidQuoteMessage')}
          confirmLabel={t('quotations.voidQuote')}
          confirmClass="btn-warning"
          onConfirm={handleVoid}
          onCancel={() => setVoidQuoteId(null)}
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
