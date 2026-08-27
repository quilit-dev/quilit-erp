import { useState, useMemo } from 'react';
import { useData } from '../hooks/useData';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';
import BankField, { useBankAccounts } from '../components/BankField.jsx';
import { useCategories } from '../hooks/useCategories';
import { usePermissions } from '../hooks/usePermissions.js';
import Attachments from '../components/Attachments.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination, NumberInput} from '../components/shared';
import {
  getAssets, getAssetsSummary, getAsset, createAsset, updateAsset,
  depreciateAsset, runDepreciation, disposeAsset, archiveAsset, getSuppliers,
} from '../api/client';

const STATUS_STYLES = {
  Active:               { bg: '#ECFDF5', color: '#059669' },
  'Fully Depreciated':  { bg: '#EFF6FF', color: '#2563EB' },
  Disposed:             { bg: '#F3F4F6', color: '#6B7280' },
  'Pending Approval':   { bg: '#FFFBEB', color: '#D97706' },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.Disposed;
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: s.bg, color: s.color,
    }}>{status}</span>
  );
}

const currentPeriod = () => new Date().toISOString().slice(0, 7);

const EMPTY_FORM = {
  name: '', category: '', description: '',
  acquisition_cost: '', acquisition_date: new Date().toISOString().slice(0, 10),
  in_service_date: new Date().toISOString().slice(0, 10),
  depreciation_method: 'straight_line', useful_life_months: 36,
  salvage_value: '0', supplier_id: '',
  // How it was bought. An asset the business already owned when the ERP
  // arrived posts nothing — booking a purchase from three years ago would
  // invent a cash movement that never happened.
  is_opening_balance: false, on_credit: false,
  payment_method: 'Bank Transfer', bank_account_id: '',
};

export default function FixedAssets() {
  const { data: assets, loading, error, reload } = useData(getAssets);
  const { data: summary, reload: reloadSummary } = useData(getAssetsSummary);
  const { data: suppliers } = useData(getSuppliers);
  const { t, tCategory } = useLocale();
  const assetCats = useCategories('asset');
  const catOptions = assetCats;
  const { can } = usePermissions();

  const [search, setSearch]         = usePersistedState('assets.search', '');
  const [statusFilter, setStatus]   = usePersistedState('assets.status', '');

  const [modal, setModal]           = useState(false);
  const [editId, setEditId]         = useState(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [saving, setSaving]         = useState(false);

  const [detail, setDetail]         = useState(null);   // full asset with ledger
  const [disposeTarget, setDispose] = useState(null);
  const [disposeForm, setDisposeForm] = useState({
    disposal_date: '', disposal_proceeds: '', disposal_reason: '',
    payment_method: 'Bank Transfer', bank_account_id: '', vat_amount: '',
  });
  const bankAccounts = useBankAccounts();
  const [archiveTarget, setArchive] = useState(null);
  const [runModal, setRunModal]     = useState(false);
  const [runPeriod, setRunPeriod]   = useState(currentPeriod());
  const [busy, setBusy]             = useState(false);

  function refresh() { reload(); reloadSummary(); }

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setModal(true); }

  function openEdit(a) {
    setForm({
      name: a.name || '', category: a.category || '', description: a.description || '',
      acquisition_cost: a.acquisition_cost ?? '',
      acquisition_date: a.acquisition_date || '',
      in_service_date: a.in_service_date || '',
      depreciation_method: a.depreciation_method || 'straight_line',
      useful_life_months: a.useful_life_months ?? 0,
      salvage_value: a.salvage_value ?? '0',
      supplier_id: a.supplier_id ? String(a.supplier_id) : '',
    });
    setEditId(a.id);
    setModal(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        acquisition_cost:   Number(form.acquisition_cost),
        salvage_value:      Number(form.salvage_value || 0),
        useful_life_months: Number(form.useful_life_months || 0),
        supplier_id:        form.supplier_id ? Number(form.supplier_id) : null,
        in_service_date:    form.in_service_date || null,
        description:        form.description || null,
        category:           form.category || null,
        is_opening_balance: !!form.is_opening_balance,
        on_credit:          !!form.on_credit,
        payment_method:     form.is_opening_balance || form.on_credit
                              ? null : form.payment_method,
        bank_account_id:    form.bank_account_id
                              ? Number(form.bank_account_id) : null,
      };
      if (editId) {
        await updateAsset(editId, payload);
        toast(t('assets.assetUpdated'));
      } else {
        await createAsset(payload);
        toast(t('assets.assetCreated'));
      }
      setModal(false); setEditId(null);
      refresh();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function openDetail(id) {
    try { setDetail(await getAsset(id)); }
    catch (err) { toast(err.message, 'red'); }
  }

  async function handlePostDepreciation(id) {
    setBusy(true);
    try {
      const res = await depreciateAsset(id, { period: currentPeriod() });
      toast(res.message, res.period_count ? 'green' : undefined);
      if (res.locked_stop) toast(t('assets.lockedStop', { period: res.locked_stop }), 'red');
      setDetail(await getAsset(id));
      refresh();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function handleRunDepreciation() {
    setBusy(true);
    try {
      const res = await runDepreciation({ period: runPeriod });
      toast(res.message, res.total_periods ? 'green' : undefined);
      const locked = (res.results || []).filter(r => r.locked_stop);
      if (locked.length) toast(t('assets.lockedStopBulk', { count: locked.length }), 'red');
      setRunModal(false);
      refresh();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function handleDispose(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await disposeAsset(disposeTarget.id, {
        disposal_date: disposeForm.disposal_date || null,
        disposal_proceeds: Number(disposeForm.disposal_proceeds || 0),
        disposal_reason: disposeForm.disposal_reason || null,
        payment_method: disposeForm.payment_method || null,
        bank_account_id: disposeForm.bank_account_id
          ? Number(disposeForm.bank_account_id) : null,
        vat_amount: Number(disposeForm.vat_amount || 0),
      });
      toast(t('assets.disposedMsg', { gain: fmt(res.gain_loss) }), 'green');
      setDispose(null);
      refresh();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function handleArchive() {
    try {
      await archiveAsset(archiveTarget.id);
      toast(t('assets.assetArchived'));
      setArchive(null);
      refresh();
    } catch (err) { toast(err.message, 'red'); }
  }

  const filtered = useMemo(() => (assets || []).filter(a => {
    const matchStatus = !statusFilter || a.status === statusFilter;
    const q = search.toLowerCase();
    const matchSearch = !q
      || (a.name || '').toLowerCase().includes(q)
      || (a.asset_code || '').toLowerCase().includes(q)
      || (a.category || '').toLowerCase().includes(q);
    return matchStatus && matchSearch;
  }), [assets, statusFilter, search]);

  const { sorted, page, pageSize, totalPages, setPage, setPageSize,
          sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  const exportData = filtered.map(a => ({
    Code: a.asset_code, Name: a.name, Category: a.category || '',
    Cost: a.acquisition_cost, 'Salvage Value': a.salvage_value || 0,
    'Useful Life (months)': a.useful_life_months || '',
    Method: a.depreciation_method || '',
    Depreciation: a.accumulated_depreciation,
    'Book Value': a.book_value, Status: a.status,
    'Acquired': fmtDate(a.acquisition_date),
    'In Service': fmtDate(a.in_service_date),
  }));

  const hasFilters = search || statusFilter;

  const kpis = summary || {};

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('assets.title')}</h1>
          <p className="page-subtitle">{t('assets.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="FixedAssets" sheetName="Assets" />
          {can('assets', 'edit') && (
            <button className="btn btn-secondary" onClick={() => { setRunPeriod(currentPeriod()); setRunModal(true); }}>
              {t('assets.runDepreciation')}
            </button>
          )}
          {can('assets', 'create') && (
            <button className="btn btn-primary" onClick={openAdd}>{t('assets.addAsset')}</button>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: t('assets.kpiTotalCost'),   value: fmt(kpis.total_cost),                color: 'var(--text)',   sub: t('assets.kpiAssetCount', { count: kpis.count_active || 0 }) },
          { label: t('assets.kpiAccumulated'), value: fmt(kpis.accumulated_depreciation),  color: 'var(--red)',    sub: t('assets.kpiRunRateSub', { amount: fmt(kpis.monthly_run_rate) }) },
          { label: t('assets.kpiBookValue'),   value: fmt(kpis.net_book_value),            color: 'var(--green)',  sub: t('assets.kpiBookValueSub') },
          { label: t('assets.kpiStatusMix'),   value: `${kpis.count_active || 0} / ${kpis.count_fully_depreciated || 0} / ${kpis.count_disposed || 0}`, color: 'var(--accent)', sub: t('assets.kpiStatusMixSub') },
        ].map(s => (
          <div key={s.label} className="stat-card" style={{ padding: '14px 18px' }}>
            <div className="stat-label">{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, marginTop: 2 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-control" style={{ flex: '1 1 200px', minWidth: 160, height: 34, fontSize: 13 }}
            placeholder={t('assets.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
          <SearchSelect
            className="form-control"
            style={{ width: 180, height: 34, fontSize: 13 }}
            value={statusFilter}
            onChange={v => setStatus(v)}
            placeholder={t('assets.allStatuses')}
            options={[{ value: 'Active', label: t('assets.statusActive') }, { value: 'Fully Depreciated', label: t('assets.statusFull') }, { value: 'Disposed', label: t('assets.statusDisposed') }]} />
          {hasFilters && (
            <button className="btn btn-sm btn-secondary" onClick={() => { setSearch(''); setStatus(''); }}>
              {t('common.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card">
        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         !filtered.length ? (
          <EmptyState message={hasFilters ? t('assets.noAssetsFiltered') : t('assets.noAssets')} />
         ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label={t('assets.colCode')}    sortKey="asset_code"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('assets.colName')}    sortKey="name"        currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('assets.colCategory')} sortKey="category"   currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortableTh label={t('assets.colCost')}    sortKey="acquisition_cost"        currentKey={sortKey} currentDir={sortDir} onSort={requestSort} style={{ textAlign: 'right' }} />
                  <SortableTh label={t('assets.colDepreciation')} sortKey="accumulated_depreciation" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} style={{ textAlign: 'right' }} />
                  <SortableTh label={t('assets.colBookValue')} sortKey="book_value"            currentKey={sortKey} currentDir={sortDir} onSort={requestSort} style={{ textAlign: 'right' }} />
                  <SortableTh label={t('assets.colStatus')}  sortKey="status"      currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(a.id)}>
                    <td style={{ color: 'var(--text-2)', fontFamily: 'monospace', fontSize: 12 }}>{a.asset_code}</td>
                    <td className="td-primary">{a.name}</td>
                    <td style={{ color: 'var(--text-2)' }}>{a.category ? tCategory(a.category) : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(a.acquisition_cost)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--red)' }}>{fmt(a.accumulated_depreciation)}</span>
                      {a.depreciable_base > 0 && (
                        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{a.depreciation_pct}%</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(a.book_value)}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td style={{ textAlign: 'right', color: 'var(--text-3)' }}
                        onClick={e => e.stopPropagation()}>
                      <button className="btn btn-sm btn-secondary" onClick={() => openDetail(a.id)}>
                        {t('common.view')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
              totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
          </div>
        )}
      </div>

      {/* Add / Edit modal */}
      {modal && (
        <Modal title={editId ? t('assets.editAsset') : t('assets.newAsset')} onClose={() => { setModal(false); setEditId(null); }}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group form-full">
                  <label className="form-label">{t('assets.fldName')} *</label>
                  <input className="form-control" required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldCategory')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.category}
                    onChange={v => setForm(f => ({ ...f, category: v }))}
                    placeholder={'—'}
                    options={(catOptions).map(c => ({ value: c, label: tCategory(c) }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldSupplier')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.supplier_id}
                    onChange={v => setForm(f => ({ ...f, supplier_id: v }))}
                    placeholder={'—'}
                    options={((suppliers || [])).map(s => ({ value: s.id, label: s.name }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldCost')} *</label>
                  <NumberInput className="form-control" required step="0.01" min="0"
                    value={form.acquisition_cost}
                    onChange={e => setForm(f => ({ ...f, acquisition_cost: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldSalvage')}</label>
                  <NumberInput className="form-control" step="0.01" min="0"
                    value={form.salvage_value}
                    onChange={e => setForm(f => ({ ...f, salvage_value: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldAcqDate')} *</label>
                  <input type="date" className="form-control" required value={form.acquisition_date}
                    onChange={e => setForm(f => ({ ...f, acquisition_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldServiceDate')}</label>
                  <input type="date" className="form-control" value={form.in_service_date}
                    onChange={e => setForm(f => ({ ...f, in_service_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldMethod')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.depreciation_method}
                    onChange={v => setForm(f => ({ ...f, depreciation_method: v }))}
                    options={[{ value: 'straight_line', label: t('assets.methodStraight') }, { value: 'none', label: t('assets.methodNone') }]} />
                </div>
                {form.depreciation_method === 'straight_line' && (
                  <div className="form-group">
                    <label className="form-label">{t('assets.fldLife')} *</label>
                    <NumberInput className="form-control" required min="1" step="1"
                      value={form.useful_life_months}
                      onChange={e => setForm(f => ({ ...f, useful_life_months: e.target.value }))} />
                  </div>
                )}
                {/* How it was paid for. Hidden while editing: an asset's
                    financial basis is frozen once it has depreciated, and the
                    entry that bought it is already posted. */}
                {!editId && (
                  <div className="form-group form-full">
                    <label style={{ display: 'flex', alignItems: 'center',
                                    gap: 8, fontSize: 13.5 }}>
                      <input type="checkbox" checked={form.is_opening_balance}
                        onChange={e => setForm(f => ({
                          ...f, is_opening_balance: e.target.checked }))} />
                      {t('assets.alreadyOwned')}
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--text-3)',
                                  marginTop: 3 }}>
                      {t('assets.alreadyOwnedHint')}
                    </div>
                  </div>
                )}
                {!editId && !form.is_opening_balance && (
                  <div className="form-group form-full">
                    <label style={{ display: 'flex', alignItems: 'center',
                                    gap: 8, fontSize: 13.5 }}>
                      <input type="checkbox" checked={form.on_credit}
                        onChange={e => setForm(f => ({
                          ...f, on_credit: e.target.checked }))} />
                      {t('assets.onCredit')}
                    </label>
                  </div>
                )}
                {!editId && !form.is_opening_balance && !form.on_credit && (
                  <div className="form-group">
                    <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
                    <SearchSelect
                      className="form-control"
                      value={form.payment_method}
                      onChange={v => setForm(f => ({
                        ...f, payment_method: v,
                        bank_account_id: '' }))}
                      options={(['Cash', 'Bank Transfer', 'Cheque', 'Card']).map(m => ({ value: m, label: m }))} />
                  </div>
                )}
                {!editId && !form.is_opening_balance && !form.on_credit && (
                  <BankField method={form.payment_method}
                    value={form.bank_account_id}
                    onChange={v => setForm(f => ({ ...f, bank_account_id: v }))}
                    accounts={bankAccounts} />
                )}
                <div className="form-group form-full">
                  <label className="form-label">{t('assets.fldDescription')}</label>
                  <input className="form-control" value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
              {form.depreciation_method === 'straight_line' && Number(form.acquisition_cost) > 0 && Number(form.useful_life_months) > 0 && (
                <div style={{ marginTop: 12, padding: '9px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, color: 'var(--text-2)' }}>
                  {t('assets.monthlyChargeHint', {
                    amount: fmt((Number(form.acquisition_cost) - Number(form.salvage_value || 0)) / Number(form.useful_life_months)),
                  })}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => { setModal(false); setEditId(null); }}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('common.create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail / depreciation ledger modal */}
      {detail && (
        <Modal title={`${detail.asset_code} — ${detail.name}`} size="modal-lg" onClose={() => setDetail(null)}>
          <div className="modal-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
              {[
                { l: t('assets.colCost'), v: fmt(detail.acquisition_cost) },
                { l: t('assets.colDepreciation'), v: fmt(detail.accumulated_depreciation) },
                { l: t('assets.colBookValue'), v: fmt(detail.book_value) },
                { l: t('assets.monthlyCharge'), v: fmt(detail.monthly_depreciation) },
              ].map(s => (
                <div key={s.l} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '9px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.l}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{s.v}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
              <span><strong>{t('assets.colStatus')}:</strong> <StatusBadge status={detail.status} /></span>
              <span><strong>{t('assets.fldAcqDate')}:</strong> {fmtDate(detail.acquisition_date)}</span>
              <span><strong>{t('assets.fldServiceDate')}:</strong> {fmtDate(detail.in_service_date)}</span>
              {detail.useful_life_months > 0 && <span><strong>{t('assets.fldLife')}:</strong> {detail.useful_life_months}</span>}
              {detail.last_depreciated_period && <span><strong>{t('assets.lastPeriod')}:</strong> {detail.last_depreciated_period}</span>}
            </div>

            {detail.status === 'Disposed' && (
              <div style={{ padding: '9px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
                {t('assets.disposedOn', { date: fmtDate(detail.disposal_date) })} · {t('assets.proceeds')}: {fmt(detail.disposal_proceeds)}
                {detail.disposal_reason && ` · ${detail.disposal_reason}`}
              </div>
            )}

            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('assets.depreciationLedger')}</div>
            {(detail.depreciation_ledger || []).length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('assets.noDepreciation')}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('assets.period')}</th>
                      <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                      <th style={{ textAlign: 'right' }}>{t('assets.accumulatedAfter')}</th>
                      <th style={{ textAlign: 'right' }}>{t('assets.colBookValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.depreciation_ledger.map(r => (
                      <tr key={r.id}>
                        <td>{r.period}</td>
                        <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(r.amount)}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(r.accumulated_after)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.book_value_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <Attachments entityType="assets" entityId={detail.id} canEdit={can('assets', 'edit')} />
            </div>
          </div>
          <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {detail.status !== 'Disposed' && can('assets', 'edit') && (
                <button className="btn btn-secondary" onClick={() => { const a = detail; setDetail(null); openEdit(a); }}>
                  {t('common.edit')}
                </button>
              )}
              {/* Fully depreciated too — that is exactly when a truck goes
                  for scrap, and the button used to disappear at the moment it
                  was most needed. */}
              {['Active', 'Fully Depreciated'].includes(detail.status)
                && can('assets', 'edit') && (
                <button className="btn btn-danger" onClick={() => {
                  setDispose(detail);
                  setDisposeForm({
                    disposal_date: new Date().toISOString().slice(0, 10),
                    disposal_proceeds: '', disposal_reason: '',
                    payment_method: 'Bank Transfer', bank_account_id: '',
                    vat_amount: '',
                  });
                  setDetail(null);
                }}>{t('assets.dispose')}</button>
              )}
              {can('assets', 'delete') && (
                <button className="btn btn-secondary" onClick={() => { const a = detail; setDetail(null); setArchive(a); }}>
                  {t('common.archive')}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {detail.status === 'Active' && detail.depreciation_method === 'straight_line' && can('assets', 'edit') && (
                <button className="btn btn-primary" disabled={busy}
                  onClick={() => handlePostDepreciation(detail.id)}>
                  {busy ? t('common.saving') : t('assets.postDepreciation')}
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setDetail(null)}>{t('common.close')}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Run depreciation modal */}
      {runModal && (
        <Modal title={t('assets.runDepreciationTitle')} onClose={() => setRunModal(false)}>
          <div className="modal-body">
            <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
              {t('assets.runDepreciationHint')}
            </p>
            <div className="form-group">
              <label className="form-label">{t('assets.upToPeriod')}</label>
              <input type="month" className="form-control" value={runPeriod}
                onChange={e => setRunPeriod(e.target.value)} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setRunModal(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={busy} onClick={handleRunDepreciation}>
              {busy ? t('common.saving') : t('assets.runDepreciation')}
            </button>
          </div>
        </Modal>
      )}

      {/* Dispose modal */}
      {disposeTarget && (
        <Modal title={t('assets.disposeTitle')} onClose={() => setDispose(null)}>
          <form onSubmit={handleDispose}>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
                {t('assets.disposeHint', { name: disposeTarget.name, book: fmt(disposeTarget.book_value) })}
              </p>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('assets.fldDisposalDate')}</label>
                  <input type="date" className="form-control" value={disposeForm.disposal_date}
                    onChange={e => setDisposeForm(f => ({ ...f, disposal_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('assets.fldProceeds')}</label>
                  <NumberInput className="form-control" step="0.01" min="0"
                    value={disposeForm.disposal_proceeds}
                    onChange={e => setDisposeForm(f => ({ ...f, disposal_proceeds: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
                  <SearchSelect
                    className="form-control"
                    value={disposeForm.payment_method}
                    onChange={v => setDisposeForm(f => ({
                      ...f, payment_method: v, bank_account_id: '' }))}
                    options={(['Cash', 'Bank Transfer', 'Cheque', 'Card']).map(m => ({ value: m, label: m }))} />
                </div>
                <BankField method={disposeForm.payment_method}
                  value={disposeForm.bank_account_id}
                  onChange={v => setDisposeForm(f => ({ ...f, bank_account_id: v }))}
                  accounts={bankAccounts} />
                <div className="form-group">
                  {/* Selling a business asset is normally a taxable supply.
                      Tax collected on the state's behalf is not a gain, and
                      leaving it in overstates the profit by exactly the VAT. */}
                  <label className="form-label">{t('assets.fldVat')}</label>
                  <NumberInput className="form-control" step="0.01" min="0"
                    value={disposeForm.vat_amount}
                    onChange={e => setDisposeForm(f => ({ ...f, vat_amount: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('assets.fldDisposalReason')}</label>
                  <input className="form-control" value={disposeForm.disposal_reason}
                    onChange={e => setDisposeForm(f => ({ ...f, disposal_reason: e.target.value }))} />
                </div>
              </div>

              {/* What it is about to post, before the operator commits. The
                  gain used to be shown only AFTERWARDS, in a toast, and was
                  never in the books at all. */}
              {(() => {
                const book = Number(disposeTarget.book_value) || 0;
                const gross = Number(disposeForm.disposal_proceeds) || 0;
                const vat = Number(disposeForm.vat_amount) || 0;
                const net = gross - vat;
                const gainLoss = Math.round((net - book) * 100) / 100;
                return (
                  <div style={{ marginTop: 14, padding: '10px 12px',
                                background: 'var(--surface-2)', borderRadius: 8,
                                fontSize: 12, color: 'var(--text-2)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {t('assets.willPost')}
                    </div>
                    <div>{t('assets.postCostOut', { amount: fmt(disposeTarget.acquisition_cost) })}</div>
                    <div>{t('assets.postDepCleared', { amount: fmt(disposeTarget.accumulated_depreciation) })}</div>
                    {gross > 0 && <div>{t('assets.postProceeds', { amount: fmt(gross) })}</div>}
                    {vat > 0 && <div>{t('assets.postVat', { amount: fmt(vat) })}</div>}
                    <div style={{ fontWeight: 700, marginTop: 4,
                                  color: gainLoss < 0 ? 'var(--red)' : 'var(--green)' }}>
                      {gainLoss < 0
                        ? t('assets.postLoss', { amount: fmt(Math.abs(gainLoss)) })
                        : t('assets.postGain', { amount: fmt(gainLoss) })}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>
                      {t('assets.postCatchUpHint')}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setDispose(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-danger" disabled={busy}>
                {busy ? t('common.saving') : t('assets.dispose')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {archiveTarget && (
        <ConfirmModal
          title={t('assets.archive')}
          message={t('assets.confirmArchive', { name: archiveTarget.name })}
          confirmClass="btn-danger"
          confirmLabel={t('common.archive')}
          onConfirm={handleArchive}
          onCancel={() => setArchive(null)}
        />
      )}
    </div>
  );
}
