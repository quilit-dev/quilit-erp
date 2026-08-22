import { useState, useEffect, useMemo, useCallback } from 'react';
import { getAccounts, createAccount, updateAccount, deleteAccount } from '../../api/client';
import { LoadingSpinner, Modal, ConfirmModal, toast } from '../../components/shared';
import ImportWizard from '../../components/ImportWizard';
import { ACCOUNT_TYPES } from './constants';
import { SortableTh, Pager } from './ui';
import { ChartPicker } from './ChartPicker';

// ── Chart of Accounts ────────────────────────────────────────────────────────
//
// Filter + sort + search + client-side pagination. The Chart of Accounts is
// small (~30 system + customer-added rows) but operators with mature charts
// pin 100+ — pagination caps the visible rows so the table never feels
// unwieldy.
function Accounts({ t, tAccount, tEnumValue, canCreate, canEdit, can }) {
  const [rows,    setRows]    = useState(null);
  const [modal,   setModal]   = useState(null);
  const [importing, setImporting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  // Filters
  const [typeFilter,   setTypeFilter]   = useState('');
  const [activeFilter, setActiveFilter] = useState('active');   // active | inactive | all
  const [search,       setSearch]       = useState('');

  // Sorting (default: code ascending — natural CoA reading order)
  const [sort, setSort] = useState('code');
  const [dir,  setDir]  = useState('asc');

  // Pagination
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(() => getAccounts().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [typeFilter, activeFilter, search, pageSize]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!typeFilter || r.type === typeFilter) &&
      (activeFilter === 'all'
        || (activeFilter === 'active'   && r.is_active)
        || (activeFilter === 'inactive' && !r.is_active)) &&
      (!q
        || (r.code || '').toLowerCase().includes(q)
        || (r.name || '').toLowerCase().includes(q)
        || (r.subtype || '').toLowerCase().includes(q)),
    );
  }, [rows, typeFilter, activeFilter, search]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const av = a[sort] ?? '';
      const bv = b[sort] ?? '';
      // Numeric-ish strings (codes like "1000", "6920") sort naturally with
      // localeCompare's numeric option — no need for a per-column comparator.
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [filtered, sort, dir]);

  const paged = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  function onSort(key) {
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('asc'); }
  }

  if (!rows) return <LoadingSpinner />;

  async function save() {
    try {
      if (modal.id) await updateAccount(modal.id, { name: modal.name, subtype: modal.subtype, description: modal.description, is_active: modal.is_active });
      else await createAccount({ code: modal.code, name: modal.name, type: modal.type, subtype: modal.subtype, description: modal.description });
      toast(`${modal.code || ''} ${modal.name}`.trim()); setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function toggle(a) {
    try { await updateAccount(a.id, { is_active: !a.is_active }); load(); }
    catch (e) { toast(e.message, 'red'); }
  }
  async function doDelete(a) {
    setConfirmDel(null);
    try { await deleteAccount(a.id); toast('Deleted'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="card-title">{t('accounting.accounts')}</span>
          {/* Which chart these accounts belong to — the first thing to know
              when reading them, and the only place to change it. */}
          <div style={{ marginTop: 4 }}>
            <ChartPicker t={t} canEdit={canEdit} onInstalled={load} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-control" style={{ width: 200 }} placeholder={t('common.search') + '…'}
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className="form-control" style={{ width: 150 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">{t('accounting.allTypes')}</option>
            {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{tEnumValue(x)}</option>)}
          </select>
          <select className="form-control" style={{ width: 140 }} value={activeFilter} onChange={e => setActiveFilter(e.target.value)}>
            <option value="active">{t('accounting.activeOnly')}</option>
            <option value="inactive">{t('accounting.inactiveOnly')}</option>
            <option value="all">{t('accounting.allStatuses')}</option>
          </select>
          {canCreate && <button className="btn btn-sm btn-secondary" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>}
          {canCreate && <button className="btn btn-sm btn-primary" onClick={() => setModal({ code: '', name: '', type: 'Expense', subtype: '', description: '' })}>＋ {t('accounting.newAccount')}</button>}
        </div>
      </div>

      {importing && (
        <ImportWizard entity="accounts" title={`${t('imports.importBtn')} — ${t('accounting.accounts')}`}
          onClose={() => setImporting(false)} onDone={load} />
      )}
      <div className="table-wrap">
        <table>
          <thead><tr>
            <SortableTh label={t('accounting.code')}    sortKey="code"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.name')}    sortKey="name"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.type')}    sortKey="type"    sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label={t('accounting.subtype')} sortKey="subtype" sort={sort} dir={dir} onSort={onSort} />
            <th></th><th></th>
          </tr></thead>
          <tbody>
            {paged.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>
                {t('accounting.noAccountsMatch')}
              </td></tr>
            ) : paged.map(a => (
              <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                <td className="text-mono">{a.code}</td>
                <td className="td-primary">{tAccount(a)}{a.is_system ? <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('accounting.systemAccount')}</span> : null}</td>
                <td>{tEnumValue(a.type)}</td>
                <td style={{ color: 'var(--text-3)' }}>{a.subtype || '—'}{a.is_active ? '' : ` · ${t('accounting.inactive')}`}</td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setModal({ ...a })}>{t('common.edit')}</button>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {canEdit && !a.is_system && (
                    <button className="btn btn-sm btn-secondary" onClick={() => toggle(a)}>
                      {a.is_active ? t('accounting.deactivate') : t('accounting.activate')}
                    </button>
                  )}
                  {can('accounting', 'delete') && !a.is_system && (
                    <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }} onClick={() => setConfirmDel(a)}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager page={page} pageSize={pageSize} total={sorted.length}
        onPage={setPage} onSize={setPageSize} t={t} />

      {modal && (
        <Modal title={modal.id ? t('common.edit') : t('accounting.newAccount')} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('accounting.code')}</label>
                <input className="form-control" value={modal.code} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, code: e.target.value }))} placeholder="6950" />
              </div>
              <div className="form-group">
                <label className="form-label">{t('accounting.type')}</label>
                <select className="form-control" value={modal.type} disabled={!!modal.id}
                  onChange={e => setModal(m => ({ ...m, type: e.target.value }))}>
                  {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{tEnumValue(x)}</option>)}
                </select>
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.name')}</label>
                <input className="form-control" value={modal.name}
                  onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
              </div>
              <div className="form-group form-full">
                <label className="form-label">{t('accounting.subtype')}</label>
                <input className="form-control" value={modal.subtype || ''}
                  onChange={e => setModal(m => ({ ...m, subtype: e.target.value }))} placeholder="Operating Expense" />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={!modal.name || (!modal.id && !modal.code)}>{t('common.save')}</button>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmModal title={t('common.delete')} confirmClass="btn-danger" confirmLabel={t('common.delete')}
          message={`${confirmDel.code} — ${confirmDel.name}`}
          onConfirm={() => doDelete(confirmDel)} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

export { Accounts };
