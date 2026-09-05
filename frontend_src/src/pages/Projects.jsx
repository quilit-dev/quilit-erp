import { usePersistedState } from '../hooks/usePersistedState';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { getProjects, getClients, createProject, updateProject, archiveProject, unarchiveProject } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  Badge, ExportButton, fmt, fmtDate, toast, SortableTh, Pagination, NumberInput} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

// Must match the backend's VALID_STATUSES casing exactly so tStatus() resolves
// each one (e.g. 'In Progress', not 'In progress') and the filter dropdown
// localizes like the status badges do.
const STATUSES = ['Inquiry', 'Quotation Sent', 'Approved', 'In Progress', 'Completed', 'Invoiced'];
const EMPTY = {
  name: '', client_id: '', location: '', status: 'Inquiry',
  start_date: '', end_date: '', estimated_cost: '', actual_cost: '', expected_revenue: '', description: '',
};

export default function Projects() {
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = usePersistedState('projects.showArchived', false);
  const { data: projects, loading, error, reload } = useData(
    (s) => getProjects(showArchived ? { archived: 'only' } : {}, s),
    [showArchived],
  );
  const { data: clients } = useData((s) => getClients({}, s));
  const { t, tStatus } = useLocale();

  const [modal,        setModal]        = useState(null);
  const [form,         setForm]         = useState(EMPTY);
  const [editId,       setEditId]       = useState(null);
  const [restoreId,    setRestoreId]    = useState(null);
  const [archiveId,    setArchiveId]    = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [search, setSearch] = usePersistedState('projects.search', '');
  const [statusFilter, setStatusFilter] = usePersistedState('projects.statusFilter', '');
  const [clientFilter, setClientFilter] = usePersistedState('projects.clientFilter', '');

  const filtered = (projects || []).filter(p => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (clientFilter && String(p.client_id) !== clientFilter) return false;
    const sq = search.toLowerCase();
    if (sq && ![p.name, p.location, p.description, p.client_name]
               .join(' ').toLowerCase().includes(sq)) return false;
    return true;
  });

  function openCreate() { setForm(EMPTY); setEditId(null); setModal('form'); }

  const { sorted: pagedProjects, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  function openEdit(p) {
    setForm({
      name:             p.name,
      client_id:        p.client_id       || '',
      location:         p.location        || '',
      status:           p.status,
      start_date:       p.start_date      || '',
      end_date:         p.end_date        || '',
      estimated_cost:   p.estimated_cost  ?? '',
      actual_cost:      p.actual_cost     ?? '',
      expected_revenue: p.expected_revenue ?? '',
      description:      p.description     || '',
    });
    setEditId(p.id);
    setModal('form');
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id:        form.client_id        ? Number(form.client_id)        : null,
        estimated_cost:   form.estimated_cost   ? Number(form.estimated_cost)   : 0,
        actual_cost:      form.actual_cost      ? Number(form.actual_cost)      : 0,
        expected_revenue: form.expected_revenue ? Number(form.expected_revenue) : 0,
      };
      if (editId) { await updateProject(editId, payload); toast(t('projects.projectUpdated')); }
      else        { await createProject(payload);          toast(t('projects.projectCreated')); }
      setModal(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleArchive() {
    try {
      await archiveProject(archiveId);
      toast(t('projects.projectArchived'));
      setArchiveId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleUnarchiveRow() {
    try {
      await unarchiveProject(restoreId);
      toast(t('projects.projectRestored'));
      setRestoreId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const exportData = filtered.map(p => ({
    Name: p.name, Client: p.client_name || '', Location: p.location || '',
    Status: p.status, Start: fmtDate(p.start_date), End: fmtDate(p.end_date),
    'Est. Cost': p.estimated_cost || 0,
    'Actual Cost': p.actual_cost || 0,
    'Exp. Revenue': p.expected_revenue || 0,
    'Exp. Profit': (p.expected_revenue || 0) - (p.estimated_cost || 0),
    'Source Quote': p.source_quote_number || '',
    Description: p.description || '',
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('projects.title')}</h1>
          <p className="page-subtitle">{t('projects.totalProjects', { count: projects?.length ?? 0 })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Projects" sheetName="Projects" />
          <button className="btn btn-primary" onClick={openCreate}>{t('projects.addProject')}</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{flexDirection:'column',alignItems:'stretch',gap:10}}>
          <div className="search-bar" style={{ margin: 0, flexWrap:'wrap' }}>
            <div className="search-input-wrap" style={{flex:'1 1 200px',minWidth:180}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input className="form-control search-input" placeholder={t('projects.searchPlaceholderFull')}
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
              style={{ width: 180 }}
              value={statusFilter}
              onChange={v => setStatusFilter(v)}
              placeholder={t('common.allStatuses')}
              options={(STATUSES).map(s => ({ value: s, label: tStatus(s) }))} />
            {(search||clientFilter||statusFilter) && (
              <button className="btn btn-secondary btn-sm" style={{whiteSpace:'nowrap'}}
                onClick={() => { setSearch(''); setClientFilter(''); setStatusFilter(''); }}>
                ✕ {t('common.clear')}
              </button>
            )}
            <label className="archived-toggle">
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} />
              {t('common.showArchived')}
            </label>
          </div>
          {filtered.length !== (projects||[]).length && (
            <div style={{fontSize:12,color:'var(--text-3)'}}>
              {t('projects.showingFiltered', { count: filtered.length, total: (projects||[]).length })}
            </div>
          )}
        </div>

        {loading && !filtered.length ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         filtered.length === 0 ? <EmptyState message={t('projects.noProjectsFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('common.name')}                sortKey="name"             currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('projects.client')}            sortKey="client_name"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('common.status')}              sortKey="status"           currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('projects.estimatedCost')}     sortKey="estimated_cost"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('projects.expectedRevenue')}   sortKey="expected_revenue" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th title="Expected Revenue − Estimated Cost">{t('projects.expProfit')}</th>
                  <th>{t('projects.sourceQuote')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedProjects.map(p => {
                  const expProfit = (p.expected_revenue || 0) - (p.estimated_cost || 0);
                  const isArchived = !!p.archived_at;
                  return (
                    <tr key={p.id} className={isArchived ? 'row-archived' : undefined}>
                      <td className="td-primary">
                        {p.name}
                        {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                      </td>
                      <td>{p.client_name || '—'}</td>
                      <td><Badge status={p.status} /></td>
                      <td>{fmt(p.estimated_cost)}</td>
                      <td style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(p.expected_revenue)}</td>
                      <td style={{ color: expProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                        {fmt(expProfit)}
                      </td>
                      <td>
                        {p.source_quote_number
                          ? <span className="badge badge-blue" style={{ fontSize: 11 }}>{p.source_quote_number}</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-sm btn-primary"   onClick={() => navigate(`/projects/${p.id}`)}>{t('common.view')}</button>
                          {isArchived ? (
                            <button className="btn btn-sm btn-secondary" style={{ color: 'var(--affirm-ink)', whiteSpace: 'nowrap' }}
                              onClick={() => setRestoreId(p.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                          ) : (
                            <>
                              {!(p.status === 'Voided' || p.status === 'Cancelled') && (
                                <button className="btn btn-sm btn-secondary" onClick={() => openEdit(p)}>{t('common.edit')}</button>
                              )}
                              <button className="btn btn-sm btn-danger"   onClick={() => setArchiveId(p.id)}>{t('common.archive')}</button>
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
              totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>

      {modal === 'form' && (
        <Modal title={editId ? t('projects.editProject') : t('projects.newProject')} onClose={() => setModal(null)}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group form-full">
                  <label className="form-label">{t('projects.projectNameLabel')}</label>
                  <input className="form-control" required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.client')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.client_id || ''}
                    onChange={v => setForm(f => ({ ...f, client_id: v }))}
                    placeholder={t('projects.selectClientOption')}
                    options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.statusLabel')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.status}
                    onChange={v => setForm(f => ({ ...f, status: v }))}
                    options={(STATUSES).map(s => ({ value: s, label: tStatus(s) }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('projects.locationLabel')}</label>
                  <input className="form-control" value={form.location || ''}
                    onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.startDate')}</label>
                  <input type="date" className="form-control" value={form.start_date || ''}
                    onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.endDate')}</label>
                  <input type="date" className="form-control" value={form.end_date || ''}
                    onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.estimatedCostLabel')}</label>
                  <NumberInput className="form-control" step="0.01" min="0"
                    value={form.estimated_cost || ''}
                    onChange={e => setForm(f => ({ ...f, estimated_cost: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('projects.expectedRevenueLabel')}</label>
                  <NumberInput className="form-control" step="0.01" min="0"
                    value={form.expected_revenue || ''}
                    onChange={e => setForm(f => ({ ...f, expected_revenue: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('projects.description')}</label>
                  <textarea className="form-control" rows={3} value={form.description || ''}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('projects.createProject')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {archiveId && (
        <ConfirmModal
          message={t('common.archiveConfirm')}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={handleArchive}
          onCancel={() => setArchiveId(null)}
        />
      )}
      {restoreId && (
        <ConfirmModal
          message={t('common.restoreConfirm')}
          confirmLabel={t('common.restore')}
          onConfirm={handleUnarchiveRow}
          onCancel={() => setRestoreId(null)}
        />
      )}
    </div>
  );
}
