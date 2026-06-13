import { useState } from 'react';
import { useData } from '../hooks/useData';
import { usePersistedState } from '../hooks/usePersistedState';
import { getSuppliers, getSupplier, createSupplier, updateSupplier, archiveSupplier, unarchiveSupplier } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination,
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import Attachments from '../components/Attachments.jsx';
import ImportWizard from '../components/ImportWizard';

const EMPTY = {
  name: '', contact_name: '', phone: '', email: '',
  payment_terms_days: 30, notes: '',
};

export default function Suppliers() {
  const { t, tStatus } = useLocale();
  const { can } = usePermissions();
  const [showArchived, setShowArchived] = usePersistedState('suppliers.showArchived', false);
  const { data: suppliers, loading, error, reload } = useData(
    (s) => getSuppliers(showArchived ? { include_archived: 1 } : {}),
    [showArchived],
  );
  const [modal,      setModal]      = useState(null);
  const [importing,  setImporting]  = useState(false);
  const [form,       setForm]       = useState(EMPTY);
  const [editId,     setEditId]     = useState(null);
  const [deleteId,   setDeleteId]   = useState(null);
  const [restoreId,  setRestoreId]  = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [detail,     setDetail]     = useState(null);
  const [detailLoad, setDetailLoad] = useState(false);
  const [search, setSearch] = usePersistedState('suppliers.search', '');

  const filtered = (suppliers || []).filter(s =>
    [s.name, s.contact_name, s.email, s.phone].join(' ').toLowerCase()
      .includes(search.toLowerCase())
  );

  const { sorted, page, pageSize, totalPages, setPage, setPageSize,
          sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  function openCreate() { setForm(EMPTY); setEditId(null); setModal('form'); }
  function openEdit(s)  { setForm({ ...s, payment_terms_days: s.payment_terms_days ?? 30 }); setEditId(s.id); setModal('form'); }

  async function openDetail(s) {
    setDetailLoad(true); setDetail(null); setModal('detail');
    try {
      const full = await getSupplier(s.id);
      setDetail(full);
    } catch (err) {
      toast(`Could not load supplier: ${err.message}`, 'red');
      setModal(null);
    } finally { setDetailLoad(false); }
  }

  async function handleSave(e) {
    e.preventDefault(); setSaving(true);
    try {
      const payload = {
        name:               form.name.trim(),
        contact_name:       form.contact_name?.trim() || null,
        phone:              form.phone?.trim()        || null,
        email:              form.email?.trim()        || null,
        payment_terms_days: Number(form.payment_terms_days) || 30,
        notes:              form.notes?.trim()        || null,
      };
      if (editId) { await updateSupplier(editId, payload); toast(t('suppliers.supplierUpdated')); }
      else        { await createSupplier(payload);          toast(t('suppliers.supplierCreated')); }
      setModal(null); reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try {
      await archiveSupplier(deleteId);
      toast(t('suppliers.supplierDeleted')); setDeleteId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleUnarchive() {
    try {
      await unarchiveSupplier(restoreId);
      toast(t('suppliers.supplierRestored')); setRestoreId(null); reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const exportData = filtered.map(s => ({
    Name:              s.name,
    'Contact':         s.contact_name  || '',
    Phone:             s.phone         || '',
    Email:             s.email         || '',
    'Payment Terms':   `${s.payment_terms_days ?? 30} days`,
    '# Purchases':     s.purchase_count ?? 0,
    'Total Spend':     s.total_spend   ?? 0,
    Created:           fmtDate(s.created_at),
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('suppliers.title')}</h1>
          <p className="page-subtitle">{t('suppliers.totalSuppliers', { count: suppliers?.length ?? 0 })}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Suppliers" sheetName="Suppliers" />
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>
          <button className="btn btn-primary" onClick={openCreate}>{t('suppliers.addSupplier')}</button>
        </div>
      </div>

      {importing && (
        <ImportWizard entity="suppliers" title={`${t('imports.importBtn')} — ${t('suppliers.title')}`}
          onClose={() => setImporting(false)} onDone={reload} />
      )}

      <div className="card">
        <div className="card-header">
          <div className="search-bar" style={{ margin: 0, flex: 1 }}>
            <div className="search-input-wrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input className="form-control search-input" placeholder={t('suppliers.searchPlaceholder')}
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {search && (
              <button className="btn btn-secondary btn-sm" onClick={() => setSearch('')}>✕ {t('common.clear')}</button>
            )}
          </div>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         filtered.length === 0 ? <EmptyState message={t('suppliers.noSuppliersFound')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('common.name')}            sortKey="name"              currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('suppliers.contact')}      sortKey="contact_name"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('suppliers.phone')}</th>
                  <th>{t('suppliers.email')}</th>
                  <SortableTh label={t('suppliers.paymentTerms')} sortKey="payment_terms_days" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('suppliers.numOrders')}    sortKey="purchase_count"    currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('suppliers.totalSpend')}   sortKey="total_spend"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(s => {
                  const isArchived = !!s.archived_at;
                  return (
                  <tr key={s.id} className={isArchived ? 'row-archived' : undefined}>
                    <td className="td-primary">
                      <button
                        className="btn-link"
                        style={{ fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                        onClick={() => openDetail(s)}
                      >
                        {s.name}
                      </button>
                      {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                    </td>
                    <td>{s.contact_name || '—'}</td>
                    <td>{s.phone  || '—'}</td>
                    <td>{s.email  || '—'}</td>
                    <td>{t('suppliers.paymentTermsDays', { n: s.payment_terms_days ?? 30 })}</td>
                    <td>{s.purchase_count ?? 0}</td>
                    <td className="fw-600">{fmt(s.total_spend ?? 0)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => openDetail(s)}>{t('common.view')}</button>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: '#166534', whiteSpace: 'nowrap' }}
                            onClick={() => setRestoreId(s.id)}>↩️ {t('common.restore')}</button>
                        ) : (
                          <>
                            <button className="btn btn-sm btn-secondary" onClick={() => openEdit(s)}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger"    onClick={() => setDeleteId(s.id)}>{t('common.archive')}</button>
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

      {/* Create / Edit modal */}
      {modal === 'form' && (
        <Modal title={editId ? t('suppliers.editSupplier') : t('suppliers.newSupplier')} onClose={() => setModal(null)}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">{t('suppliers.supplierNameLabel')}</label>
                  <input className="form-control" required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Al Mawarid Hardware" />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('suppliers.contactPerson')}</label>
                  <input className="form-control" value={form.contact_name}
                    onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('suppliers.phone')}</label>
                  <input className="form-control" value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('suppliers.email')}</label>
                  <input className="form-control" type="email" value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('suppliers.paymentTermsDaysLabel')}</label>
                  <input className="form-control" type="number" min="0" step="1"
                    value={form.payment_terms_days}
                    onChange={e => setForm(f => ({ ...f, payment_terms_days: e.target.value }))} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">{t('suppliers.notes')}</label>
                  <input className="form-control" value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('suppliers.createSupplier')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail modal */}
      {modal === 'detail' && (
        <Modal title={detail ? detail.name : t('suppliers.supplierDetail')} onClose={() => setModal(null)} size="modal-lg">
          <div className="modal-body">
            {detailLoad || !detail ? <LoadingSpinner /> : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
                  {[
                    { label: t('suppliers.contact'),      value: detail.contact_name || '—' },
                    { label: t('suppliers.phone'),        value: detail.phone        || '—' },
                    { label: t('suppliers.email'),        value: detail.email        || '—' },
                    { label: t('suppliers.paymentTerms'), value: t('suppliers.paymentTermsDays', { n: detail.payment_terms_days ?? 30 }) },
                    { label: t('suppliers.totalOrders'),  value: detail.purchases?.length ?? 0 },
                    { label: t('suppliers.totalSpend'),   value: fmt(detail.total_spend ?? 0) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'var(--surface)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{label}</div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{value}</div>
                    </div>
                  ))}
                </div>

                {detail.notes && (
                  <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-2)', background: 'var(--surface)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                    {detail.notes}
                  </div>
                )}

                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{t('suppliers.purchaseHistory')}</div>
                {!detail.purchases?.length ? (
                  <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('suppliers.noPurchases')}</p>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>{t('purchases.poNumber')}</th>
                          <th>{t('purchases.product')}</th>
                          <th>{t('common.quantity')}</th>
                          <th>{t('purchases.unitCost')}</th>
                          <th>{t('common.total')}</th>
                          <th>{t('common.status')}</th>
                          <th>{t('common.date')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.purchases.map(p => {
                          const total = (p.quantity * p.unit_cost) + (p.additional_costs || 0);
                          return (
                            <tr key={p.id}>
                              <td className="text-mono">{p.po_number}</td>
                              <td>{p.product_name}</td>
                              <td>{p.quantity}</td>
                              <td>{fmt(p.unit_cost)}</td>
                              <td className="fw-600">{fmt(total)}</td>
                              <td>
                                <span className={`badge badge-${p.status === 'Paid' ? 'green' : p.status === 'Received' ? 'blue' : 'gray'}`}>
                                  {tStatus(p.status)}
                                </span>
                              </td>
                              <td>{fmtDate(p.ordered_at)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                  <Attachments entityType="suppliers" entityId={detail.id} canEdit={can('suppliers', 'edit')} />
                </div>
              </>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => { setModal(null); openEdit(detail); }}>{t('common.edit')}</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.close')}</button>
          </div>
        </Modal>
      )}

      {deleteId && (
        <ConfirmModal
          title={t('common.archive')}
          message={t('suppliers.deleteMsg')}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={handleDelete}
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
