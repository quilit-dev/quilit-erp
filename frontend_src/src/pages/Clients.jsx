import { usePersistedState } from '../hooks/usePersistedState';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { getClients, createClient, updateClient, archiveClient, unarchiveClient } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmtDate, toast, SortableTh, Pagination
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import ImportWizard from '../components/ImportWizard';

const EMPTY = { name: '', company: '', phone: '', email: '', address: '', type: 'private', notes: '' };

export default function Clients() {
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = usePersistedState('clients.showArchived', false);
  const { data: clients, loading, error, reload } = useData(
    (s) => getClients(showArchived ? { include_archived: 1 } : {}, s),
    [showArchived],
  );
  const [modal,    setModal]    = useState(null);
  const [importing, setImporting] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [editId,   setEditId]   = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [restoreId, setRestoreId] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [search, setSearch] = usePersistedState('clients.search', '');
  const { t } = useLocale();

  const filtered = (clients || []).filter(c =>
    [c.name, c.company, c.email, c.phone].join(' ').toLowerCase().includes(search.toLowerCase())
  );

  const { sorted, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  function openCreate()  { setForm(EMPTY); setEditId(null); setModal('form'); }
  function openEdit(c)   { setForm({ ...c }); setEditId(c.id); setModal('form'); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editId) { await updateClient(editId, form); toast(t('clients.clientUpdated')); }
      else        { await createClient(form);          toast(t('clients.clientCreated')); }
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

  const exportData = filtered.map(c => ({
    Name: c.name, Company: c.company || '', Type: c.type,
    Phone: c.phone || '', Email: c.email || '', Address: c.address || '',
    Created: fmtDate(c.created_at),
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('clients.title')}</h1>
          <p className="page-subtitle">{t('clients.totalClients', { count: clients?.length ?? 0 })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Clients" sheetName="Clients" />
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
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         filtered.length === 0 ? <EmptyState message={t('clients.noClientsFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('clients.name')}    sortKey="name"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.company')} sortKey="company"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.type')}    sortKey="type"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.phone')}   sortKey="phone"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('clients.email')}   sortKey="email"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
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
                    <td>{fmtDate(c.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary"    onClick={() => navigate(`/clients/${c.id}`)}>{t('common.view')}</button>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: '#166534' }}
                            onClick={() => setRestoreId(c.id)}>↩️ {t('common.restore')}</button>
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
              totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
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
                  <select className="form-control" value={form.type || 'private'}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    <option value="private">{t('clients.typePrivate')}</option>
                    <option value="corporate">{t('clients.typeCorporate')}</option>
                    <option value="government">{t('clients.typeGovernment')}</option>
                  </select>
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
