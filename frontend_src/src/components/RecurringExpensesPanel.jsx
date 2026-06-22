import { useState, useMemo } from 'react';
import { useData } from '../hooks/useData';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  fmt, fmtDate, toast, CategoryBadge, EXPENSE_CATEGORIES, SelectOther, NumberInput} from './shared';
import {
  getRecurringExpenses, createRecurringExpense, updateRecurringExpense,
  toggleRecurringExpense, runRecurringExpense, runDueRecurringExpenses,
  archiveRecurringExpense, unarchiveRecurringExpense, getProjects,
} from '../api/client';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annual'];

const EMPTY_FORM = {
  name: '', category: 'Rent', description: '', amount: '',
  frequency: 'monthly', start_date: new Date().toISOString().slice(0, 10),
  end_date: '', project_id: '', payment_method: '', tax_rate_id: null,
};

export default function RecurringExpensesPanel() {
  const [showArchived, setShowArchived] = useState(false);
  const { data: templates, loading, error, reload } =
    useData((s) => getRecurringExpenses({ include_archived: showArchived }, s), [showArchived]);
  const { data: projects } = useData((s) => getProjects({}, s));
  const { t } = useLocale();
  const { settings, taxRates } = useSettings();
  const { can } = usePermissions();
  const taxEnabled     = settings?.tax_enabled === '1';
  const activeTaxRates = (taxRates || []).filter(r => r.is_active);

  const [modal, setModal]     = useState(false);
  const [editId, setEditId]   = useState(null);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [busy, setBusy]       = useState(false);
  const [archiveTarget, setArchive] = useState(null);
  const [restoreTarget, setRestore] = useState(null);

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setModal(true); }

  function openEdit(tpl) {
    setForm({
      name: tpl.name || '', category: tpl.category || 'Other',
      description: tpl.description || '', amount: tpl.amount ?? '',
      frequency: tpl.frequency || 'monthly',
      start_date: tpl.start_date || '', end_date: tpl.end_date || '',
      project_id: tpl.project_id ? String(tpl.project_id) : '',
      payment_method: tpl.payment_method || '',
      tax_rate_id: tpl.tax_rate_id ?? null,
    });
    setEditId(tpl.id);
    setModal(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        amount: Number(form.amount),
        project_id: form.project_id ? Number(form.project_id) : null,
        end_date: form.end_date || null,
        description: form.description || null,
        payment_method: form.payment_method || null,
        tax_rate_id: taxEnabled ? (form.tax_rate_id ?? null) : null,
      };
      if (editId) {
        await updateRecurringExpense(editId, payload);
        toast(t('recurring.updated'));
      } else {
        await createRecurringExpense(payload);
        toast(t('recurring.created'));
      }
      setModal(false); setEditId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleRun(id) {
    setBusy(true);
    try {
      const res = await runRecurringExpense(id);
      toast(res.message, res.generated_count ? 'green' : undefined);
      if (res.locked_stop) toast(t('recurring.lockedStop', { period: res.locked_stop }), 'red');
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function handleRunDue() {
    setBusy(true);
    try {
      const res = await runDueRecurringExpenses();
      toast(res.message, res.total_generated ? 'green' : undefined);
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function handleToggle(id) {
    try {
      const res = await toggleRecurringExpense(id);
      toast(res.message);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleArchive() {
    try {
      await archiveRecurringExpense(archiveTarget.id);
      toast(t('recurring.archived'));
      setArchive(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleRestore() {
    try {
      await unarchiveRecurringExpense(restoreTarget.id);
      toast(t('common.restore'));
      setRestore(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const stats = useMemo(() => {
    const list = templates || [];
    const active = list.filter(r => r.is_active);
    const monthlyEquiv = active.reduce((s, r) => {
      const factor = { weekly: 4.33, monthly: 1, quarterly: 1 / 3, annual: 1 / 12 }[r.frequency] || 1;
      return s + Number(r.amount || 0) * factor;
    }, 0);
    const due = list.reduce((s, r) => s + (r.due_count || 0), 0);
    return { count: list.length, active: active.length, monthlyEquiv, due };
  }, [templates]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('recurring.title')}</h1>
          <p className="page-subtitle">{t('recurring.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
          {can('expenses', 'create') && stats.due > 0 && (
            <button className="btn btn-secondary" disabled={busy} onClick={handleRunDue}>
              {t('recurring.runDue', { count: stats.due })}
            </button>
          )}
          {can('expenses', 'create') && (
            <button className="btn btn-primary" onClick={openAdd}>{t('recurring.addTemplate')}</button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: t('recurring.kpiActive'),  value: `${stats.active} / ${stats.count}`, color: 'var(--text)',   sub: t('recurring.kpiActiveSub') },
          { label: t('recurring.kpiMonthly'), value: fmt(stats.monthlyEquiv),            color: 'var(--red)',    sub: t('recurring.kpiMonthlySub') },
          { label: t('recurring.kpiDue'),     value: stats.due,                          color: stats.due ? 'var(--accent)' : 'var(--text-3)', sub: t('recurring.kpiDueSub') },
        ].map(s => (
          <div key={s.label} className="stat-card" style={{ padding: '14px 18px' }}>
            <div className="stat-label">{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, marginTop: 2 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         !(templates || []).length ? (
          <EmptyState message={t('recurring.noTemplates')} />
         ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('recurring.colName')}</th>
                  <th>{t('common.category')}</th>
                  <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                  <th>{t('recurring.colFrequency')}</th>
                  <th>{t('recurring.colNextRun')}</th>
                  <th>{t('recurring.colStatus')}</th>
                  <th style={{ width: 200 }}></th>
                </tr>
              </thead>
              <tbody>
                {templates.map(r => (
                  <tr key={r.id}
                    className={r.archived_at ? 'row-archived' : ''}
                    style={(!r.is_active && !r.archived_at) ? { opacity: 0.55 } : undefined}>
                    <td className="td-primary">
                      {r.name}
                      {r.archived_at && (
                        <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('common.archivedBadge')}</span>
                      )}
                      {r.project_name && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.project_name}</div>
                      )}
                    </td>
                    <td><CategoryBadge category={r.category} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--red)', whiteSpace: 'nowrap' }}>{fmt(r.amount)}</td>
                    <td style={{ color: 'var(--text-2)' }}>{t(`recurring.freq_${r.frequency}`)}</td>
                    <td style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                      {fmtDate(r.next_run_date)}
                      {r.due_count > 0 && (
                        <span style={{
                          marginInlineStart: 6, padding: '1px 7px', borderRadius: 20,
                          fontSize: 10, fontWeight: 700, background: 'var(--accent-light)', color: 'var(--accent)',
                        }}>{t('recurring.dueBadge', { count: r.due_count })}</span>
                      )}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-flex', padding: '2px 9px', borderRadius: 20,
                        fontSize: 11, fontWeight: 600,
                        background: r.is_active ? '#ECFDF5' : '#F3F4F6',
                        color: r.is_active ? '#059669' : '#6B7280',
                      }}>{r.is_active ? t('recurring.statusActive') : t('recurring.statusPaused')}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {r.archived_at ? (
                          can('expenses', 'edit') && (
                            <button className="btn btn-sm btn-secondary" onClick={() => setRestore(r)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}
                            </button>
                          )
                        ) : (
                          <>
                            {r.is_active && r.due_count > 0 && can('expenses', 'create') && (
                              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleRun(r.id)}>
                                {t('recurring.run')}
                              </button>
                            )}
                            {can('expenses', 'edit') && (
                              <button className="btn btn-sm btn-secondary" onClick={() => handleToggle(r.id)}>
                                {r.is_active ? t('recurring.pause') : t('recurring.resume')}
                              </button>
                            )}
                            {can('expenses', 'edit') && (
                              <button className="btn btn-sm btn-secondary" onClick={() => openEdit(r)}>
                                {t('common.edit')}
                              </button>
                            )}
                            {can('expenses', 'delete') && (
                              <button className="btn btn-sm btn-secondary" onClick={() => setArchive(r)}>
                                {t('common.archive')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
         )}
      </div>

      {modal && (
        <Modal title={editId ? t('recurring.editTemplate') : t('recurring.newTemplate')} onClose={() => { setModal(false); setEditId(null); }}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group form-full">
                  <label className="form-label">{t('recurring.fldName')} *</label>
                  <input className="form-control" required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.category')} *</label>
                  <SelectOther
                    value={form.category}
                    onChange={v => setForm(f => ({ ...f, category: v }))}
                    options={EXPENSE_CATEGORIES}
                    otherLabel={t('common.addCategoryOption')}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.amount')} *</label>
                  <NumberInput className="form-control" required step="0.01" min="0"
                    value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('recurring.fldFrequency')} *</label>
                  <select className="form-control" value={form.frequency}
                    onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}>
                    {FREQUENCIES.map(fr => <option key={fr} value={fr}>{t(`recurring.freq_${fr}`)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('recurring.fldStartDate')} *</label>
                  <input type="date" className="form-control" required value={form.start_date}
                    onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('recurring.fldEndDate')}</label>
                  <input type="date" className="form-control" value={form.end_date}
                    onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.project')}</label>
                  <select className="form-control" value={form.project_id}
                    onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                    <option value="">{t('expenses.noneProject')}</option>
                    {(projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
                  <SelectOther
                    value={form.payment_method || ''}
                    onChange={v => setForm(f => ({ ...f, payment_method: v }))}
                    includeNone
                    options={[
                      { value: 'Cash',          label: t('expenses.methodCash') },
                      { value: 'Bank Transfer', label: t('expenses.methodBank') },
                      { value: 'Cheque',        label: t('expenses.methodCheque') },
                      { value: 'Card',          label: t('expenses.methodCard') },
                    ]}
                    otherLabel={t('expenses.methodOther')}
                  />
                </div>
                {taxEnabled && (
                  <div className="form-group">
                    <label className="form-label">{t('common.taxCol')}</label>
                    <select className="form-control" value={form.tax_rate_id ?? ''}
                      onChange={e => setForm(f => ({ ...f, tax_rate_id: Number(e.target.value) || null }))}>
                      <option value="">{t('expenses.noTax')}</option>
                      {activeTaxRates.map(r => (
                        <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="form-group form-full">
                  <label className="form-label">{t('common.description')}</label>
                  <input className="form-control" value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
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

      {archiveTarget && (
        <ConfirmModal
          title={t('recurring.archiveTitle')}
          message={t('recurring.confirmArchive', { name: archiveTarget.name })}
          confirmClass="btn-danger"
          confirmLabel={t('common.archive')}
          onConfirm={handleArchive}
          onCancel={() => setArchive(null)}
        />
      )}

      {restoreTarget && (
        <ConfirmModal
          title={t('common.restore')}
          message={`${t('common.restoreConfirm')} "${restoreTarget.name}"`}
          confirmClass="btn-primary"
          confirmLabel={t('common.restore')}
          onConfirm={handleRestore}
          onCancel={() => setRestore(null)}
        />
      )}
    </div>
  );
}
