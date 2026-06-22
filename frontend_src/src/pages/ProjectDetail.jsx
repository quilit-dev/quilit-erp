import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getProject, getInventory, deductToProject, createExpense, updateExpense, voidExpense, updateProject, getDocumentContent } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, Badge, fmt, fmtDate, toast, Modal, CategoryBadge, NumberInput, SelectOther,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import { useWarehouses } from '../hooks/useWarehouses';
import Attachments from '../components/Attachments.jsx';
import { openSafeHtmlDocument } from '../utils/exportUtils';

const CATEGORIES = ['Labour', 'Materials', 'Equipment', 'Transport', 'Subcontractor', 'Permits', 'Other'];

function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color: `var(--${color})` } : {}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SectionTable({ columns, rows, emptyMsg }) {
  const { t } = useLocale();
  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        {emptyMsg || t('clients.noRecordsFound')}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c.key} className={c.primary ? 'td-primary' : ''}>
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ProjectDetail() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const { id }    = useParams();
  const navigate  = useNavigate();
  const [project,   setProject]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [tab,       setTab]       = useState('overview');

  // Materials / inventory deduction
  const [inventory,    setInventory]    = useState([]);
  const [deductModal,  setDeductModal]  = useState(false);
  const [deductItem,   setDeductItem]   = useState('');
  const [deductQty,    setDeductQty]    = useState('');
  const [deductNote,   setDeductNote]   = useState('');
  const [deductWarehouseId, setDeductWarehouseId] = useState('');
  const [deductSaving, setDeductSaving] = useState(false);
  // Materials are physically pulled FROM a warehouse — defaults to the
  // user's default warehouse so single-warehouse installs see no UI change.
  const { warehouses: accessibleWarehouses, defaultId: defaultWarehouseId } = useWarehouses();
  useEffect(() => {
    if (defaultWarehouseId && !deductWarehouseId) setDeductWarehouseId(String(defaultWarehouseId));
  }, [defaultWarehouseId, deductWarehouseId]);
  const [invSearch,    setInvSearch]    = useState('');

  // Expense add / edit / delete
  const EMPTY_EXPENSE = {
    category: 'Other', description: '', amount: '',
    date: new Date().toISOString().slice(0, 10),
  };
  const [expenseModal,    setExpenseModal]    = useState(false);
  const [expenseEditId,   setExpenseEditId]   = useState(null);
  const [expenseVoidTarget,setExpenseVoidTarget]= useState(null);
  const [expenseVoidReason,setExpenseVoidReason]= useState('');
  const [expenseSaving,   setExpenseSaving]   = useState(false);
  const [expenseForm,     setExpenseForm]     = useState(EMPTY_EXPENSE);

  // Inline estimated-cost edit
  const [editingCost,  setEditingCost]  = useState(false);
  const [costDraft,    setCostDraft]    = useState('');
  const [costSaving,   setCostSaving]   = useState(false);

  const TABS = [
    { key: 'overview',   label: t('projects.overview') },
    { key: 'materials',  label: t('projects.materialsTab') },
    { key: 'quotations', label: t('nav.quotations') },
    { key: 'invoices',   label: t('nav.invoices') },
    { key: 'expenses',   label: t('projects.expensesTab') },
  ];

  useEffect(() => {
    setLoading(true);
    Promise.all([getProject(id), getInventory()])
      .then(([proj, inv]) => { setProject(proj); setInventory(inv); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (tab === 'quotations' || tab === 'invoices') {
      getProject(id).then(setProject).catch(() => {});
    }
  }, [tab, id]);

  async function openDocument(docId) {
    try {
      const doc = await getDocumentContent(docId);
      openSafeHtmlDocument(doc.html_content);
    } catch (e) { toast(e.message, 'red'); }
  }

  function reloadProject() {
    getProject(id).then(setProject).catch(e => setError(e.message));
  }

  function openAddExpense() {
    setExpenseForm(EMPTY_EXPENSE);
    setExpenseEditId(null);
    setExpenseModal(true);
  }

  function openEditExpense(exp) {
    setExpenseForm({
      category:    exp.category    || 'Other',
      description: exp.description || '',
      amount:      exp.amount      || '',
      date:        exp.date        || new Date().toISOString().slice(0, 10),
    });
    setExpenseEditId(exp.id);
    setExpenseModal(true);
  }

  async function handleExpenseSave(e) {
    e.preventDefault();
    setExpenseSaving(true);
    try {
      const payload = {
        ...expenseForm,
        project_id: Number(id),
        amount: Number(expenseForm.amount),
      };
      if (expenseEditId) {
        await updateExpense(expenseEditId, payload);
        toast(t('projects.expenseUpdated'));
      } else {
        await createExpense(payload);
        toast(t('projects.expenseRecorded'));
      }
      setExpenseModal(false);
      setExpenseEditId(null);
      reloadProject();
    } catch (err) { toast(err.message, 'red'); }
    finally { setExpenseSaving(false); }
  }

  async function handleExpenseVoid() {
    try {
      await voidExpense(expenseVoidTarget.id, expenseVoidReason.trim() || null);
      toast(t('projects.expenseVoided'));
      setExpenseVoidTarget(null);
      setExpenseVoidReason('');
      reloadProject();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function handleDeduct(e) {
    e.preventDefault();
    if (!deductItem) return;
    setDeductSaving(true);
    try {
      const res = await deductToProject(Number(deductItem), {
        project_id:   Number(id),
        quantity:     Number(deductQty),
        note:         deductNote.trim() || undefined,
        warehouse_id: deductWarehouseId ? Number(deductWarehouseId) : null,
      });
      toast(t('projects.deductedToast', { qty: deductQty, cost: fmt(res.cost) }));
      setDeductModal(false);
      setDeductItem(''); setDeductQty(''); setDeductNote('');
      reloadProject();
      getInventory().then(setInventory);
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setDeductSaving(false);
    }
  }

  async function handleSaveCost() {
    const val = parseFloat(costDraft);
    if (isNaN(val) || val < 0) return;
    setCostSaving(true);
    try {
      await updateProject(id, {
        name:             project.name,
        client_id:        project.client_id    ?? null,
        location:         project.location     ?? null,
        status:           project.status       ?? 'Inquiry',
        start_date:       project.start_date   ?? null,
        end_date:         project.end_date     ?? null,
        estimated_cost:   val,
        actual_cost:      project.actual_cost  ?? 0,
        expected_revenue: project.expected_revenue ?? 0,
        description:      project.description  ?? null,
      });
      toast(t('projects.costUpdated'));
      setEditingCost(false);
      reloadProject();
    } catch (e) { toast(e.message, 'red'); }
    finally { setCostSaving(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={() => { setError(null); setLoading(true); Promise.all([getProject(id), getInventory()]).then(([proj,inv]) => { setProject(proj); setInventory(inv); }).catch(e => setError(e.message)).finally(() => setLoading(false)); }} />;
  if (!project) return null;

  const { stats } = project;

  const quotDocMap = Object.fromEntries(
    (project.documents || []).filter(d => d.record_type === 'quotation').map(d => [d.record_id, d])
  );
  const invDocMap = Object.fromEntries(
    (project.documents || []).filter(d => d.record_type === 'invoice').map(d => [d.record_id, d])
  );

  const budgetPct   = project.estimated_cost > 0
    ? Math.min(100, Math.round((stats.total_expenses / project.estimated_cost) * 100))
    : 0;
  const budgetColor = budgetPct > 90 ? 'red' : budgetPct > 70 ? 'yellow' : 'green';
  const expRevenue  = project.expected_revenue || 0;
  const expProfit   = stats.expected_profit || 0;
  const marginPct   = stats.margin_pct || 0;

  return (
    <div>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => navigate('/projects')}
        style={{ marginBottom: 12 }}
      >
        {t('projects.backToProjects')}
      </button>

      <div className="page-header">
        <div>
          <h1 className="page-title">{project.name}</h1>
          <p className="page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge status={project.status} />
            {project.client_name && (
              <Link
                to={`/clients/${project.client_id}`}
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 13 }}
              >
                👤 {project.client_name}
              </Link>
            )}
            {project.location && (
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>📍 {project.location}</span>
            )}
            {project.source_quote_number && (
              <span style={{ fontSize: 12, color: 'var(--text-3)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>
                📄 {project.source_quote_number}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* KPI row */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <StatCard label={t('projects.expectedRevenue')} value={fmt(expRevenue)}              color="green" />
        <StatCard label={t('projects.estimatedCost')}   value={fmt(project.estimated_cost)} />
        <StatCard label={t('projects.expProfit')}       value={fmt(expProfit)}              color={expProfit >= 0 ? 'green' : 'red'} sub={expRevenue > 0 ? t('projects.marginPctLabel', { pct: marginPct }) : undefined} />
        <StatCard label={t('projects.totalExpenses')}   value={fmt(stats.total_expenses)}   color={budgetPct > 90 ? 'red' : undefined} sub={project.estimated_cost > 0 ? t('projects.ofBudget', { pct: budgetPct }) : undefined} />
        <StatCard label={t('projects.collected')}       value={fmt(stats.total_paid)}       color="green" />
        <StatCard label={t('projects.outstanding')}     value={fmt(stats.outstanding)}      color={stats.outstanding > 0 ? 'red' : undefined} />
      </div>

      {/* Revenue vs Cost progress bar */}
      {expRevenue > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{t('projects.revenueVsCost')}</span>
            <span style={{ color: expProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {expProfit >= 0 ? '▲' : '▼'} {fmt(Math.abs(expProfit))} {t('projects.expectedProfitLabel')}
            </span>
          </div>
          <div style={{ position: 'relative', background: 'var(--border)', borderRadius: 8, height: 14, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', background: 'var(--green)', opacity: 0.15, borderRadius: 8 }} />
            {expRevenue > 0 && (
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 8,
                width: `${Math.min(100, Math.round((project.estimated_cost / expRevenue) * 100))}%`,
                background: project.estimated_cost <= expRevenue ? 'var(--accent)' : 'var(--red)',
                transition: 'width 0.4s ease',
              }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
            <span>{t('projects.estCostLabel')}: {fmt(project.estimated_cost)}</span>
            <span style={{ fontWeight: 600 }}>{t('projects.marginPctLabel', { pct: marginPct })}</span>
            <span>{t('projects.revenueLabel')}: {fmt(expRevenue)}</span>
          </div>
        </div>
      )}

      {/* Budget progress bar */}
      {project.estimated_cost > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{t('projects.budgetVsActual')}</span>
            <span style={{ color: 'var(--text-3)' }}>{fmt(stats.total_expenses)} / {fmt(project.estimated_cost)}</span>
          </div>
          <div style={{ background: 'var(--border)', borderRadius: 8, height: 10, overflow: 'hidden' }}>
            <div style={{
              width: `${budgetPct}%`, height: '100%', borderRadius: 8,
              background: `var(--${budgetColor})`, transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
            <span>{fmt(0)}</span>
            <span style={{ color: `var(--${budgetColor})`, fontWeight: 600 }}>{t('projects.pctUsed', { pct: budgetPct })}</span>
            <span>{fmt(project.estimated_cost)}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(tb => (
          <button key={tb.key} className={`tab-btn${tab === tb.key ? ' active' : ''}`} onClick={() => setTab(tb.key)}>
            {tb.label}
            {tb.key === 'materials'  && inventory.filter(i => i.quantity > 0).length > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{inventory.filter(i => i.quantity > 0).length}</span>}
            {tb.key === 'quotations' && project.quotations?.length > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{project.quotations.length}</span>}
            {tb.key === 'invoices'   && project.invoices?.length   > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{project.invoices.length}</span>}
            {tb.key === 'expenses'   && project.expenses?.length   > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{project.expenses.length}</span>}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">{t('projects.projectDetailsTitle')}</span></div>
            <div className="card-body">
              {[
                [t('projects.client'),          project.client_name
                  ? <Link to={`/clients/${project.client_id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{project.client_name}</Link>
                  : null],
                [t('projects.status'),          <Badge status={project.status} />],
                [t('projects.location'),        project.location],
                [t('projects.startDate'),       fmtDate(project.start_date)],
                [t('projects.endDate'),         fmtDate(project.end_date)],
                [t('projects.expectedRevenue'), project.expected_revenue > 0 ? <span style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(project.expected_revenue)}</span> : null],
                [t('projects.expProfitLabel'),  project.expected_revenue > 0 ? <span style={{ color: expProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmt(expProfit)} ({marginPct}%)</span> : null],
                [t('projects.sourceQuotation'), project.source_quote_number ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{project.source_quote_number}</span> : null],
                [t('projects.created'),         fmtDate(project.created_at)],
              ].filter(([, v]) => v != null && v !== '').map(([label, val]) => (
                <div key={label} style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 13, alignItems: 'center' }}>
                  <span style={{ minWidth: 110, color: 'var(--text-3)', fontWeight: 500 }}>{label}</span>
                  <span style={{ color: 'var(--text)' }}>{val}</span>
                </div>
              ))}

              {/* Est. Cost — inline editable */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 13, alignItems: 'center' }}>
                <span style={{ minWidth: 110, color: 'var(--text-3)', fontWeight: 500 }}>{t('projects.estCost')}</span>
                {editingCost ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                    <NumberInput
                      className="form-control"
                      style={{ width: 140, padding: '3px 8px', fontSize: 13, height: 30 }}
                      value={costDraft}
                      onChange={e => setCostDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveCost(); if (e.key === 'Escape') setEditingCost(false); }}
                      autoFocus
                      min="0"
                      step="0.01"
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ padding: '3px 10px', fontSize: 12, height: 28 }}
                      onClick={handleSaveCost}
                      disabled={costSaving}
                    >
                      {costSaving ? '…' : t('common.save')}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '3px 8px', fontSize: 12, height: 28 }}
                      onClick={() => setEditingCost(false)}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--text)', fontWeight: project.estimated_cost > 0 ? 400 : 500 }}>
                      {project.estimated_cost > 0 ? fmt(project.estimated_cost) : <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{t('projects.notSet')}</span>}
                    </span>
                    <button
                      className="btn btn-sm btn-secondary btn-icon"
                      style={{ padding: '2px 6px', height: 24, opacity: 0.7 }}
                      title={t('projects.editEstCost')}
                      onClick={() => { setCostDraft(project.estimated_cost > 0 ? String(project.estimated_cost) : ''); setEditingCost(true); }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                  </div>
                )}
              </div>

              {project.description && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 6, fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                  {project.description}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">{t('projects.financialSnapshot')}</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              {[
                { label: t('projects.expectedRevenue'), value: fmt(expRevenue),            color: expRevenue > 0 ? 'green' : undefined },
                { label: t('projects.estCost'),         value: fmt(project.estimated_cost) },
                { label: t('projects.expProfitLabel'),  value: fmt(expProfit),             color: expProfit >= 0 ? 'green' : 'red' },
                { label: t('projects.totalInvoiced'),   value: fmt(stats.total_invoiced),  color: 'blue' },
                { label: t('projects.collected'),       value: fmt(stats.total_paid),      color: 'green' },
                { label: t('projects.outstanding'),     value: fmt(stats.outstanding),     color: stats.outstanding > 0 ? 'red' : 'green' },
                { label: t('projects.totalExpenses'),   value: fmt(stats.total_expenses) },
                { label: t('projects.budgetRemaining'), value: fmt(stats.budget_remaining), color: stats.budget_remaining < 0 ? 'red' : 'green' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-2)' }}>{item.label}</span>
                  <span style={{ fontWeight: 600, color: item.color ? `var(--${item.color})` : 'var(--text)' }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-body">
            <Attachments entityType="projects" entityId={project.id} canEdit={can('projects', 'edit')} />
          </div>
        </div>
        </>
      )}

      {/* Materials — deduct inventory to project */}
      {tab === 'materials' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('projects.useMaterials')}</span>
            <button className="btn btn-sm btn-primary" onClick={() => { setDeductModal(true); setInvSearch(''); }}>
              {t('projects.deductMaterials')}
            </button>
          </div>
          <div style={{ padding: '12px 20px 4px', fontSize: 13, color: 'var(--text-3)' }}>
            {t('projects.deductDesc')}
          </div>

          {/* Searchable inventory table */}
          <div style={{ padding: '10px 20px' }}>
            <input
              className="form-control"
              placeholder={t('projects.searchInventory')}
              value={invSearch}
              onChange={e => setInvSearch(e.target.value)}
              style={{ maxWidth: 320, marginBottom: 10 }}
            />
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('projects.item')}</th>
                  <th>{t('common.category')}</th>
                  <th>{t('projects.inStock')}</th>
                  <th>{t('common.unit')}</th>
                  <th>{t('projects.unitCost')}</th>
                  <th>{t('projects.useBtn')}</th>
                </tr>
              </thead>
              <tbody>
                {inventory
                  .filter(i => !invSearch || i.name.toLowerCase().includes(invSearch.toLowerCase()) || (i.category||'').toLowerCase().includes(invSearch.toLowerCase()))
                  .map(item => (
                  <tr key={item.id} style={{ opacity: item.quantity <= 0 ? 0.45 : 1 }}>
                    <td className="td-primary">{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td style={{ fontWeight: 600, color: item.quantity <= item.min_stock && item.min_stock > 0 ? 'var(--red)' : item.quantity <= 0 ? 'var(--text-3)' : 'var(--text)' }}>
                      {item.quantity}
                    </td>
                    <td>{item.unit}</td>
                    <td>{fmt(item.unit_cost)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={item.quantity <= 0}
                        onClick={() => { setDeductItem(String(item.id)); setDeductQty(''); setDeductNote(''); setDeductModal(true); }}
                      >
                        {t('projects.useBtn')}
                      </button>
                    </td>
                  </tr>
                ))}
                {inventory.filter(i => !invSearch || i.name.toLowerCase().includes(invSearch.toLowerCase())).length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>{t('projects.noInventoryFound')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deduct materials modal */}
      {deductModal && (
        <Modal title={t('projects.deductModalTitle')} onClose={() => setDeductModal(false)}>
          <form onSubmit={handleDeduct}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t('projects.inventoryItemLabel')} *</label>
                <select
                  className="form-control"
                  required
                  value={deductItem}
                  onChange={e => { setDeductItem(e.target.value); setDeductQty(''); }}
                >
                  <option value="">{t('projects.selectItemOption')}</option>
                  {inventory.filter(i => i.quantity > 0).map(i => (
                    <option key={i.id} value={i.id}>
                      {i.name} — {i.quantity} {i.unit} @ {fmt(i.unit_cost)}/{i.unit}
                    </option>
                  ))}
                </select>
              </div>

              {accessibleWarehouses.length > 1 && (
                <div className="form-group">
                  <label className="form-label">{t('warehouses.field')}</label>
                  <select
                    className="form-control"
                    value={deductWarehouseId}
                    onChange={e => setDeductWarehouseId(e.target.value)}
                  >
                    {accessibleWarehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.code} · {w.name}
                        {w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {deductItem && (() => {
                const sel = inventory.find(i => String(i.id) === deductItem);
                const qty = Number(deductQty) || 0;
                const cost = qty * (sel?.unit_cost || 0);
                return (
                  <>
                    <div className="form-group">
                      <label className="form-label">
                        {t('projects.quantityToUse')} *
                        {sel && <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                          {t('projects.maxQty', { n: sel.quantity, unit: sel.unit })}
                        </span>}
                      </label>
                      <NumberInput
                        className="form-control"
                        required
                        min="1"
                        step="1"
                        max={sel?.quantity}
                        value={deductQty}
                        onChange={e => setDeductQty(e.target.value)}
                        placeholder={`e.g. ${sel ? Math.min(10, sel.quantity) : 1}`}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t('projects.noteOptional')}</label>
                      <input
                        className="form-control"
                        value={deductNote}
                        onChange={e => setDeductNote(e.target.value)}
                        placeholder="e.g. Road marking — school zone Phase 1"
                      />
                    </div>
                    {qty > 0 && (
                      <div style={{
                        background: 'var(--blue-light, #eff6ff)', border: '1px solid var(--blue, #3b82f6)',
                        borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--blue-dark, #1d4ed8)'
                      }}>
                        <strong>{t('projects.costTransferred')}</strong> {qty} × {fmt(sel?.unit_cost)} = <strong>{fmt(cost)}</strong>
                        <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 11 }}>
                          {t('projects.recordedAsMaterials')}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setDeductModal(false)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={deductSaving || !deductItem || !deductQty}>
                {deductSaving ? t('projects.processing') : t('projects.confirmDeduction')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Quotations */}
      {tab === 'quotations' && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('nav.quotations')} ({project.quotations?.length ?? 0})</span></div>
          <SectionTable
            emptyMsg={t('projects.noQuotationsLinked')}
            columns={[
              { key: 'quote_number', label: '#',                   primary: true },
              { key: 'status',       label: t('common.status'),    render: q => <Badge status={q.status} /> },
              { key: 'total',        label: t('quotations.total'), render: q => fmt(q.total) },
              { key: 'created_at',   label: t('common.date'),      render: q => fmtDate(q.created_at) },
              { key: 'pdf',          label: '',                     render: q => quotDocMap[q.id]
                  ? <button className="btn btn-sm btn-secondary" onClick={() => openDocument(quotDocMap[q.id].id)}>View PDF</button>
                  : null },
            ]}
            rows={project.quotations}
          />
        </div>
      )}

      {/* Invoices */}
      {tab === 'invoices' && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('nav.invoices')} ({project.invoices?.length ?? 0})</span></div>
          <SectionTable
            emptyMsg={t('projects.noInvoicesLinked')}
            columns={[
              { key: 'invoice_number', label: '#',                  primary: true },
              { key: 'status',         label: t('common.status'),   render: i => <Badge status={i.status} /> },
              { key: 'amount',         label: t('common.amount'),   render: i => fmt(i.amount) },
              { key: 'paid_amount',    label: t('clients.paid'),    render: i => fmt(i.paid_amount) },
              { key: 'due_date',       label: t('clients.due'),     render: i => fmtDate(i.due_date) },
              { key: 'pdf',            label: '',                    render: i => invDocMap[i.id]
                  ? <button className="btn btn-sm btn-secondary" onClick={() => openDocument(invDocMap[i.id].id)}>View PDF</button>
                  : null },
            ]}
            rows={project.invoices}
          />
        </div>
      )}

      {/* Expenses — full CRUD tied to this project */}
      {tab === 'expenses' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('projects.expensesTab')} ({project.expenses?.length ?? 0})</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {stats.total_expenses > 0 && (
                <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                  {t('common.total')}: <strong style={{ color: 'var(--red)' }}>{fmt(stats.total_expenses)}</strong>
                </span>
              )}
              <button className="btn btn-sm btn-primary" onClick={openAddExpense}>
                {t('projects.addExpense')}
              </button>
            </div>
          </div>

          {!project.expenses?.length ? (
            <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
              {t('projects.noExpensesLogged')}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.category')}</th>
                    <th>{t('common.description')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                    <th style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {project.expenses.map(exp => (
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
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{exp.void_reason}</div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: exp.voided_at ? 'var(--text-3)' : 'var(--red)', whiteSpace: 'nowrap', textDecoration: exp.voided_at ? 'line-through' : 'none' }}>
                        {fmt(exp.amount)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!exp.voided_at ? (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm btn-secondary" onClick={() => openEditExpense(exp)}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger" onClick={() => { setExpenseVoidTarget(exp); setExpenseVoidReason(''); }}>{t('expenses.voidBtn')}</button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Footer total */}
              <div style={{
                display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
                padding: '10px 16px', borderTop: '1px solid var(--border)',
                background: 'var(--surface-2)', fontSize: 13,
              }}>
                <span style={{ fontWeight: 700, color: 'var(--red)' }}>
                  {t('common.total')}: {fmt(stats.total_expenses)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add / Edit Expense modal */}
      {expenseModal && (
        <Modal
          title={expenseEditId ? t('projects.editExpenseTitle') : t('projects.addExpenseTitle')}
          onClose={() => { setExpenseModal(false); setExpenseEditId(null); }}
        >
          <form onSubmit={handleExpenseSave}>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('projects.categoryLabel')} *</label>
                  <SelectOther
                    value={expenseForm.category}
                    onChange={v => setExpenseForm(f => ({ ...f, category: v }))}
                    options={CATEGORIES}
                    otherLabel={t('common.addCategoryOption')}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('common.date')}</label>
                  <input type="date" className="form-control" value={expenseForm.date}
                    onChange={e => setExpenseForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('projects.amountLabel')} *</label>
                  <NumberInput className="form-control" required step="0.01" min="0"
                    value={expenseForm.amount}
                    onChange={e => setExpenseForm(f => ({ ...f, amount: e.target.value }))} />
                </div>
                <div className="form-group form-full">
                  <label className="form-label">{t('common.description')}</label>
                  <input className="form-control" placeholder={t('inventory.noteOptional')}
                    value={expenseForm.description}
                    onChange={e => setExpenseForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary"
                onClick={() => { setExpenseModal(false); setExpenseEditId(null); }}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={expenseSaving}>
                {expenseSaving ? t('common.saving') : expenseEditId ? t('projects.saveChanges') : t('projects.recordExpenseBtn')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {expenseVoidTarget && (
        <Modal title={t('expenses.voidBtn')} onClose={() => { setExpenseVoidTarget(null); setExpenseVoidReason(''); }}>
          <div className="modal-body">
            <p style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 14 }}>
              {t('projects.voidExpenseMsg')}
            </p>
            <div className="form-group">
              <input
                className="form-control"
                placeholder={t('expenses.voidReasonPlaceholder')}
                value={expenseVoidReason}
                onChange={e => setExpenseVoidReason(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => { setExpenseVoidTarget(null); setExpenseVoidReason(''); }}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={handleExpenseVoid}>
              {t('expenses.voidBtn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
