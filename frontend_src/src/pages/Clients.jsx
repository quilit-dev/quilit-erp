import { usePersistedState } from '../hooks/usePersistedState';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerList } from '../hooks/useServerList';
import { getClients, createClient, updateClient, archiveClient, unarchiveClient } from '../api/client';
import { exportReportPDF } from '../utils/exportUtils';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmtDate, fmt, toast, SortableTh, Pagination, NumberInput
} from '../components/shared';
import { CURRENCIES } from './settings/ui';
import { useLocale } from '../hooks/useLocale.jsx';
import ImportWizard from '../components/ImportWizard';
import SearchSelect from '../components/SearchSelect.jsx';

const EMPTY = {
  name: '', company: '', phone: '', email: '', address: '', type: 'private', notes: '',
  // Blank, not 'USD': empty means "whatever the company bills in", which is
  // what the API stores as NULL so changing the company currency does not
  // orphan every customer record.
  financial_id: '', preferred_currency: '', vat_status: 'subject',
  allow_installments: false, default_installment_count: '',
  default_installment_frequency: '',
};

export default function Clients() {
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = usePersistedState('clients.showArchived', false);
  // Only accounts that owe something, biggest first. Remembered, because
  // somebody chasing debts is doing it repeatedly, not once.
  const [owingOnly, setOwingOnly] = usePersistedState('clients.owingOnly', false);
  // Paged, searched and sorted BY THE SERVER. This screen used to download
  // every client and do all three in the browser.
  const list = useServerList(
    (query, s) => getClients(query, s),
    { ...(showArchived ? { archived: 'only' } : {}),
      ...(owingOnly ? { owing: 1 } : {}) },
  );
  const { items: sorted, total, loading, error, reload,
          page, pageSize, totalPages, setPage, setPageSize,
          sortKey, sortDir, requestSort, search, setSearch, PAGE_SIZES } = list;
  const [modal,    setModal]    = useState(null);
  const [importing, setImporting] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [editId,   setEditId]   = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [restoreId, setRestoreId] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const { t } = useLocale();


  function openCreate()  { setForm(EMPTY); setEditId(null); setModal('form'); }
  function openEdit(c)   {
    // A stored row carries NULLs where the form wants empty strings.
    setForm({
      ...EMPTY, ...c,
      financial_id: c.financial_id || '',
      preferred_currency: c.preferred_currency || '',
      vat_status: c.vat_status || 'subject',
      allow_installments: !!c.allow_installments,
      default_installment_count: c.default_installment_count ?? '',
      default_installment_frequency: c.default_installment_frequency || '',
    });
    setEditId(c.id); setModal('form');
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      // '' means unset; the API takes null for that.
      const payload = {
        ...form,
        preferred_currency: form.preferred_currency || null,
        default_installment_frequency: form.default_installment_frequency || null,
        default_installment_count: form.default_installment_count === ''
          ? null : Number(form.default_installment_count),
        allow_installments: !!form.allow_installments,
      };
      if (editId) { await updateClient(editId, payload); toast(t('clients.clientUpdated')); }
      else        { await createClient(payload);       toast(t('clients.clientCreated')); }
      setModal(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleArchive() {
    try {
      await archiveClient(deleteId);
      toast(t('clients.clientArchived'));
      setDeleteId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleUnarchive() {
    try {
      await unarchiveClient(restoreId);
      toast(t('clients.clientRestored'));
      setRestoreId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  // A chase-up sheet: every account that owes, biggest first, with the two
  // figures the balance is made of so the number can be checked rather than
  // taken on trust. Always the OWING set, whatever the screen is filtered to —
  // the button says outstanding, so it prints outstanding.
  //
  // Fetched without a `limit` so the sheet is never silently truncated to the
  // page on screen, and ordered by the server so it matches what the list
  // shows.
  const [pdfBusy, setPdfBusy] = useState(false);

  async function downloadOwingPDF() {
    setPdfBusy(true);
    try {
      const res = await getClients({ owing: 1, sort: 'outstanding', dir: 'desc' });
      const rows = Array.isArray(res) ? res : res.items || [];
      if (!rows.length) { toast(t('clients.owingNone')); return; }
      const owed = rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
      await exportReportPDF({
        title: t('clients.owingTitle'),
        subtitle: t('clients.owingSubtitle', { count: rows.length }),
        filename: `outstanding-${new Date().toISOString().slice(0, 10)}`,
        rows,
        columns: [
          { label: t('clients.name'),        align: 'left',  value: r => r.name },
          { label: t('clients.company'),     align: 'left',  value: r => r.company || '—' },
          { label: t('clients.phone'),       align: 'left',  value: r => r.phone || '—' },
          // Formatted rather than left as bare numbers: the report builder
          // adds separators but no currency symbol, and a chase-up sheet goes
          // to a person who should not have to assume which currency it is in.
          { label: t('clients.totalInvoiced'), align: 'right', value: r => fmt(r.total_invoiced) },
          { label: t('clients.totalPaid'),   align: 'right', value: r => fmt(r.total_paid) },
          { label: t('clients.outstanding'), align: 'right', value: r => fmt(r.outstanding) },
        ],
        totals: { label: t('clients.owingTotal'),
                  columns: [null, null, null, null, null, fmt(owed)] },
      });
    } catch (err) { toast(err.message, 'red'); }
    finally { setPdfBusy(false); }
  }

  // Fetches the whole filtered set (no `limit`), so an export is never
  // silently truncated to the page on screen.
  const fetchExportRows = async () => {
    const all = await getClients({
      ...(showArchived ? { archived: 'only' } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    });
    return (Array.isArray(all) ? all : all.items || []).map(c => ({
      Name: c.name, Company: c.company || '', Type: c.type,
      Phone: c.phone || '', Email: c.email || '', Address: c.address || '',
      Created: fmtDate(c.created_at),
    }));
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('clients.title')}</h1>
          <p className="page-subtitle">{t('clients.totalClients', { count: total })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton fetchData={fetchExportRows} filename="Clients" sheetName="Clients" />
          <button className="btn btn-secondary" onClick={downloadOwingPDF} disabled={pdfBusy}>
            📄 {pdfBusy ? t('common.loading') : t('clients.owingPdf')}
          </button>
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>
          <button className="btn btn-primary" onClick={openCreate}>{t('clients.addClient')}</button>
        </div>
      </div>

      {importing && (
        <ImportWizard entity="clients" title={`${t('imports.importBtn')} — ${t('clients.title')}`}
          onClose={() => setImporting(false)} onDone={reload} />
      )}

      <div className="card">
        <div className="card-header">
          <div className="search-bar" style={{ margin: 0, flex: 1 }}>
            <div className="search-input-wrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input className="form-control search-input" placeholder={t('clients.searchPlaceholder')}
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <label className="archived-toggle">
            <input type="checkbox" checked={owingOnly}
              onChange={e => setOwingOnly(e.target.checked)} />
            {t('clients.owingOnly')}
          </label>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         sorted.length === 0 ? <EmptyState message={t('clients.noClientsFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('clients.name')}    sortKey="name"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.company')} sortKey="company"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.type')}    sortKey="type"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.phone')}   sortKey="phone"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.email')}   sortKey="email"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.outstanding')} sortKey="outstanding" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.created')}  sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(c => {
                  const isArchived = !!c.archived_at;
                  return (
                  <tr key={c.id} className={isArchived ? 'row-archived' : undefined}>
                    <td className="td-primary">
                      {c.name}
                      {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                    </td>
                    <td>{c.company || '—'}</td>
                    <td><span className="badge badge-gray">{c.type}</span></td>
                    <td>{c.phone || '—'}</td>
                    <td>{c.email || '—'}</td>
                    {/* Owed money is the one figure on this row worth
                        looking at, so it is the only one coloured. */}
                    <td style={{ fontWeight: c.outstanding > 0 ? 600 : 400,
                                 color: c.outstanding > 0 ? 'var(--red)' : 'var(--text-3)' }}>
                      {c.outstanding > 0 ? fmt(c.outstanding) : '—'}
                    </td>
                    <td>{fmtDate(c.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary"    onClick={() => navigate(`/clients/${c.id}`)}>{t('common.view')}</button>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: '#166534' }}
                            onClick={() => setRestoreId(c.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                        ) : (
                          <>
                            <button className="btn btn-sm btn-secondary"  onClick={() => openEdit(c)}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger"     onClick={() => setDeleteId(c.id)}>{t('common.archive')}</button>
                          </>
                        )}
                      </div>
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

      {modal === 'form' && (
        <Modal title={editId ? t('clients.editClient') : t('clients.newClient')} onClose={() => setModal(null)}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('clients.name')} *</label>
                  <input className="form-control" required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.company')}</label>
                  <input className="form-control" value={form.company || ''}
                    onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.type')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.type || 'private'}
                    onChange={v => setForm(f => ({ ...f, type: v }))}
                    options={[{ value: 'private', label: t('clients.typePrivate') }, { value: 'corporate', label: t('clients.typeCorporate') }, { value: 'government', label: t('clients.typeGovernment') }]} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.phone')}</label>
                  <input className="form-control" value={form.phone || ''}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.email')}</label>
                  <input type="email" className="form-control" value={form.email || ''}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('clients.address')}</label>
                  <textarea className="form-control" rows={2} value={form.address || ''}
                    onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('common.notes')}</label>
                  <textarea className="form-control" rows={2} value={form.notes || ''}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>

                {/* What the books need, kept apart from the contact details
                    above because it is a different conversation. Same divider
                    the invoice payment panel uses — there is no section-heading
                    class in this stylesheet. */}
                <div className="form-full" style={{ marginTop: 6, paddingTop: 14,
                                                    borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {t('clients.billingHeading')}
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">{t('clients.financialId')}</label>
                  <input className="form-control" value={form.financial_id || ''}
                    onChange={e => setForm(f => ({ ...f, financial_id: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.preferredCurrency')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.preferred_currency || ''}
                    onChange={v => setForm(f => ({ ...f, preferred_currency: v }))}
                    placeholder={t('clients.currencyCompanyDefault')}
                    options={(CURRENCIES).map(c => ({ value: c, label: c }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.vatStatus')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.vat_status || 'subject'}
                    onChange={v => setForm(f => ({ ...f, vat_status: v }))}
                    options={[{ value: 'subject', label: t('clients.vatSubject') }, { value: 'exempt', label: t('clients.vatExempt') }]} />
                  {form.vat_status === 'exempt' && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                      {t('clients.vatExemptHint')}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">{t('clients.installments')}</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                                  fontSize: 13.5, paddingTop: 7 }}>
                    <input type="checkbox" checked={!!form.allow_installments}
                      onChange={e => setForm(f => ({ ...f, allow_installments: e.target.checked }))} />
                    {t('clients.allowInstallments')}
                  </label>
                </div>
                {form.allow_installments && (
                  <>
                    <div className="form-group">
                      <label className="form-label">{t('clients.defaultCount')}</label>
                      <NumberInput className="form-control" min="1" step="1"
                        value={form.default_installment_count}
                        onChange={e => setForm(f => ({ ...f, default_installment_count: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('clients.defaultFrequency')}</label>
                      <SearchSelect
                        className="form-control"
                        value={form.default_installment_frequency || ''}
                        onChange={v => setForm(f => ({ ...f, default_installment_frequency: v }))}
                        placeholder={'—'}
                        options={[{ value: 'monthly', label: t('installments.monthly') }, { value: 'quarterly', label: t('installments.quarterly') }, { value: 'yearly', label: t('installments.yearly') }]} />
                    </div>
                    <div className="form-full" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {t('clients.installmentsHint')}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('clients.createClient')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteId && (
        <ConfirmModal
          message={t('common.archiveConfirm')}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={handleArchive}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {restoreId && (
        <ConfirmModal
          message={t('common.restoreConfirm')}
          confirmLabel={t('common.restore')}
          onConfirm={handleUnarchive}
          onCancel={() => setRestoreId(null)}
        />
      )}
    </div>
  );
}
