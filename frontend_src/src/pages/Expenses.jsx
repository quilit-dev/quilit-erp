import { usePersistedState } from '../hooks/usePersistedState';
import { useState, useMemo } from 'react';
import { useData } from '../hooks/useData';
import { getExpenses, getProjects, createExpense, updateExpense, voidExpense } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal,
  ExportButton, fmt, fmtDate, toast, SortableTh, Pagination
} from '../components/shared';
import { useSortPaginate } from '../hooks/useSortPaginate';
import { useLocale } from '../hooks/useLocale.jsx';

const CATEGORIES = ['Labour', 'Materials', 'Equipment', 'Transport', 'Subcontractor', 'Permits', 'Other'];

const CATEGORY_COLORS = {
  Labour:        { bg: '#EFF6FF', color: '#2563EB' },
  Materials:     { bg: '#ECFDF5', color: '#059669' },
  Equipment:     { bg: '#FFFBEB', color: '#D97706' },
  Transport:     { bg: '#F5F3FF', color: '#7C3AED' },
  Subcontractor: { bg: '#FFF7ED', color: '#EA580C' },
  Permits:       { bg: '#F0FDF4', color: '#16A34A' },
  Other:         { bg: '#F9FAFB', color: '#6B7280' },
};

function CategoryBadge({ category }) {
  const style = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px',
      borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: style.bg, color: style.color,
    }}>
      {category}
    </span>
  );
}

export default function Expenses() {
  const { data: expenses, loading, error, reload } = useData(getExpenses);
  const { data: projects } = useData(getProjects);
  const { t } = useLocale();

  const [catFilter, setCatFilter] = usePersistedState('expenses.catFilter', '');
  const [projFilter, setProjFilter] = usePersistedState('expenses.projFilter', '');
  const [monthFilter, setMonthFilter] = usePersistedState('expenses.monthFilter', '');
  const [search, setSearch] = usePersistedState('expenses.search', '');

  const [modal,      setModal]      = useState(false);
  const [editId,     setEditId]     = useState(null);
  const [voidTarget, setVoidTarget] = useState(null); // { id, category }
  const [voidReason, setVoidReason] = useState('');
  const [saving,     setSaving]     = useState(false);
  const [form, setForm] = useState({
    project_id: '', category: 'Other', description: '',
    amount: '', date: new Date().toISOString().slice(0, 10),
  });

  const EMPTY_FORM = {
    project_id: '', category: 'Other', description: '',
    amount: '', date: new Date().toISOString().slice(0, 10),
  };

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setModal(true); }

  function openEdit(exp) {
    setForm({
      project_id:  exp.project_id ? String(exp.project_id) : '',
      category:    exp.category   || 'Other',
      description: exp.description || '',
      amount:      exp.amount      || '',
      date:        exp.date        || new Date().toISOString().slice(0, 10),
    });
    setEditId(exp.id);
    setModal(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        project_id: form.project_id ? Number(form.project_id) : null,
        amount:     Number(form.amount),
      };
      if (editId) {
        await updateExpense(editId, payload);
        toast(t('expenses.expenseUpdatedMsg'));
      } else {
        await createExpense(payload);
        toast(t('expenses.expenseRecorded'));
      }
      setModal(false);
      setEditId(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleVoid() {
    try {
      await voidExpense(voidTarget.id, voidReason.trim() || null);
      toast(t('expenses.expenseVoided'));
      setVoidTarget(null);
      setVoidReason('');
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const filtered = useMemo(() => {
    return (expenses || []).filter(exp => {
      const matchCat   = !catFilter  || exp.category === catFilter;
      const matchProj  = !projFilter || String(exp.project_id) === projFilter;
      const matchMonth = !monthFilter || (exp.date || '').startsWith(monthFilter);
      const matchSearch = !search
        || (exp.description || '').toLowerCase().includes(search.toLowerCase())
        || (exp.category || '').toLowerCase().includes(search.toLowerCase())
        || (exp.project_name || '').toLowerCase().includes(search.toLowerCase());
      return matchCat && matchProj && matchMonth && matchSearch;
    });
  }, [expenses, catFilter, projFilter, monthFilter, search]);

  const activeFiltered = filtered.filter(e => !e.voided_at);
  const total     = activeFiltered.reduce((s, e) => s + Number(e.amount || 0), 0);
  const avgAmount = activeFiltered.length ? total / activeFiltered.length : 0;

  const { sorted: pagedExpenses, page, pageSize, totalPages, setPage, setPageSize, sortKey, sortDir, requestSort, PAGE_SIZES } = useSortPaginate(filtered);

  const byCategory = useMemo(() => {
    const map = {};
    filtered.filter(e => !e.voided_at).forEach(e => {
      map[e.category] = (map[e.category] || 0) + Number(e.amount || 0);
    });
    return Object.entries(map)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [filtered]);

  const hasFilters = catFilter || projFilter || monthFilter || search;

  const exportData = filtered.map(e => ({
    Date: fmtDate(e.date), Category: e.category,
    Description: e.description || '',
    Project: e.project_name || '', Amount: e.amount,
  }));

  const months = useMemo(() => {
    const set = new Set();
    (expenses || []).forEach(e => { if (e.date) set.add(e.date.slice(0, 7)); });
    return [...set].sort().reverse();
  }, [expenses]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('expenses.title')}</h1>
          <p className="page-subtitle">
            {t('expenses.recordsCount', { count: filtered.length })}
            {hasFilters ? t('expenses.filteredSuffix') : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ExportButton data={exportData} filename="Expenses" sheetName="Expenses" />
          <button className="btn btn-primary" onClick={openAdd}>{t('expenses.addExpense')}</button>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: t('expenses.totalLabel'),   value: fmt(total),     color: 'var(--red)',    sub: t('expenses.entriesCount', { count: filtered.length }) },
          { label: t('expenses.averageLabel'), value: fmt(avgAmount), color: 'var(--text)',   sub: t('expenses.perExpense') },
          { label: t('expenses.topCategory'),  color: 'var(--accent)',
            value: byCategory[0]?.category || '—',
            sub: byCategory[0] ? fmt(byCategory[0].amount) : '—' },
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
          <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input className="form-control" style={{ paddingLeft: 32, height: 34, fontSize: 13 }}
              placeholder={t('expenses.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <select className="form-control" style={{ width: 150, height: 34, fontSize: 13 }}
            value={catFilter} onChange={e => setCatFilter(e.target.value)}>
            <option value="">{t('expenses.allCategories')}</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <select className="form-control" style={{ width: 160, height: 34, fontSize: 13 }}
            value={projFilter} onChange={e => setProjFilter(e.target.value)}>
            <option value="">{t('expenses.allProjects')}</option>
            {(projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select className="form-control" style={{ width: 140, height: 34, fontSize: 13 }}
            value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
            <option value="">{t('expenses.allMonths')}</option>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>

          {hasFilters && (
            <button className="btn btn-sm btn-secondary" onClick={() => {
              setCatFilter(''); setProjFilter(''); setMonthFilter(''); setSearch('');
            }}>
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
          <EmptyState message={hasFilters ? t('expenses.noExpensesFiltered') : t('expenses.noExpensesYet')} />
         ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortableTh label={t('common.date')}        sortKey="date"         currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                    <SortableTh label={t('common.category')}    sortKey="category"     currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                    <SortableTh label={t('common.description')} sortKey="description"  currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                    <SortableTh label={t('common.project')}     sortKey="project_name" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                    <SortableTh label={t('common.amount')}      sortKey="amount"       currentKey={sortKey} currentDir={sortDir} onSort={requestSort} style={{ textAlign: 'right' }} />
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedExpenses.map(exp => (
                    <tr key={exp.id} style={exp.voided_at ? { opacity: 0.5 } : {}}>
                      <td style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{fmtDate(exp.date)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <CategoryBadge category={exp.category} />
                          {exp.voided_at && (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', padding: '2px 7px',
                              borderRadius: 20, fontSize: 11, fontWeight: 600,
                              background: '#F3F4F6', color: '#6B7280',
                            }}>{t('expenses.voidedLabel')}</span>
                          )}
                        </div>
                      </td>
                      <td className="td-primary">
                        {exp.description || <span style={{ color: 'var(--text-3)' }}>—</span>}
                        {exp.void_reason && (
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                            {exp.void_reason}
                          </div>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>{exp.project_name || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: exp.voided_at ? 'var(--text-3)' : 'var(--red)', whiteSpace: 'nowrap', textDecoration: exp.voided_at ? 'line-through' : 'none' }}>
                        {fmt(exp.amount)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!exp.voided_at ? (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm btn-secondary" onClick={() => openEdit(exp)}>
                              {t('common.edit')}
                            </button>
                            <button className="btn btn-sm btn-danger" onClick={() => { setVoidTarget(exp); setVoidReason(''); }}>
                              {t('expenses.voidBtn')}
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={page} totalPages={totalPages} pageSize={pageSize} pageSizes={PAGE_SIZES}
                totalRows={filtered.length} setPage={setPage} setPageSize={setPageSize} />
            </div>

            {/* Footer totals row */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '11px 16px', background: 'var(--surface-2)',
              borderTop: '1px solid var(--border)', fontSize: 13,
            }}>
              <span style={{ color: 'var(--text-3)' }}>
                {t('expenses.footerCount', { count: filtered.length, total: (expenses || []).length })}
              </span>
              <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                {byCategory.slice(0, 3).map(b => (
                  <span key={b.category} style={{ color: 'var(--text-2)', fontSize: 12 }}>
                    <span style={{ color: CATEGORY_COLORS[b.category]?.color || 'var(--text-3)', fontWeight: 600 }}>
                      {b.category}
                    </span>
                    {' '}{fmt(b.amount)}
                  </span>
                ))}
                <span style={{ fontWeight: 700, color: 'var(--red)', fontSize: 14 }}>
                  {t('expenses.totalLabel')}: {fmt(total)}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Add / Edit modal */}
      {modal && (
        <Modal title={editId ? t('expenses.editExpense') : t('expenses.newExpense')} onClose={() => { setModal(false); setEditId(null); }}>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('expenses.categoryLabel')}</label>
                  <select className="form-control" value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.dateLabel')}</label>
                  <input type="date" className="form-control" value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.amountLabel')}</label>
                  <input type="number" className="form-control" required step="0.01" min="0"
                    value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('expenses.projectLabel')}</label>
                  <select className="form-control" value={form.project_id || ''}
                    onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
                    <option value="">{t('expenses.noneProject')}</option>
                    {(projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('expenses.descriptionLabel')}</label>
                  <input className="form-control" value={form.description || ''}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => { setModal(false); setEditId(null); }}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : editId ? t('common.save') : t('expenses.recordExpense')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {voidTarget && (
        <Modal title={t('expenses.voidBtn')} onClose={() => { setVoidTarget(null); setVoidReason(''); }}>
          <div className="modal-body">
            <p style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 14 }}>
              {t('expenses.voidMsg')}
            </p>
            <div className="form-group">
              <input
                className="form-control"
                placeholder={t('expenses.voidReasonPlaceholder')}
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => { setVoidTarget(null); setVoidReason(''); }}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={handleVoid}>
              {t('expenses.voidBtn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
