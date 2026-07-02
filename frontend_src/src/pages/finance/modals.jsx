import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useMoney, Icon } from '../../components/shared';
import { getReconciliation } from '../../api/client';
import * as XLSX from 'xlsx';

function MonthDrillModal({ month, label, data, loading, onClose }) {
  const { t } = useLocale();
  const money = useMoney();
  const incomeTotal  = (data?.income_records  || []).reduce((s, r) => s + r.amount, 0);
  const expenseTotal = (data?.expense_records || []).reduce((s, r) => s + r.amount, 0);
  const profit = incomeTotal - expenseTotal;

  // Group income by project (or client if no project)
  const incomeByProject = {};
  (data?.income_records || []).forEach(r => {
    const key = r.project_name || r.client_name || t('finance.noProject');
    if (!incomeByProject[key]) incomeByProject[key] = { records: [], total: 0 };
    incomeByProject[key].records.push(r);
    incomeByProject[key].total += r.amount;
  });

  // Group expenses by project
  const expByProject = {};
  (data?.expense_records || []).forEach(r => {
    const key = r.project_name || t('finance.generalNoProject');
    if (!expByProject[key]) expByProject[key] = { records: [], total: 0 };
    expByProject[key].records.push(r);
    expByProject[key].total += r.amount;
  });

  // Reuses the shared .modal-overlay / .modal / .modal-body shell so the
  // scroll lock, sticky header, and responsive sizing all match every
  // other modal in the app. Previously this was a hand-rolled overlay
  // with maxHeight: '88vh' that fought the new modal CSS.
  useScrollLock(true);
  return (
    <div className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {t('finance.detailsSubtitle')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{t('common.loading')}</div>
          ) : !data ? null : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
                {[
                  { label: t('finance.income'), value: incomeTotal, color: '#059669' },
                  { label: t('finance.expenses'), value: expenseTotal, color: '#DC2626' },
                  { label: t('finance.netProfit'), value: profit, color: profit >= 0 ? '#1B4F72' : '#DC2626' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    background: 'var(--surface-2)', borderRadius: 10, padding: '12px 16px',
                    border: '1px solid var(--border)', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color }}>{money(value)}</div>
                  </div>
                ))}
              </div>

              {/* Income section */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
                  {t('finance.income')} — {money(incomeTotal)}
                </div>
                {Object.keys(incomeByProject).length === 0 ? (
                  <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('finance.noIncomeMonth')}</p>
                ) : Object.entries(incomeByProject)
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([proj, { records, total }]) => (
                      <div key={proj} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ background: '#F0FDF4', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: '#065F46' }}>{proj}</span>
                          <span style={{ fontWeight: 700, color: '#059669' }}>{money(total)}</span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <tbody>
                            {records.map((r, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '7px 14px', color: 'var(--text-3)' }}>{r.date?.slice(0, 10)}</td>
                                <td style={{ padding: '7px 8px', fontWeight: 500 }}>{r.invoice_number}</td>
                                <td style={{ padding: '7px 8px', color: 'var(--text-2)' }}>{r.client_name || '—'}</td>
                                <td style={{ padding: '7px 8px', color: 'var(--text-3)', fontSize: 11 }}>{r.method}</td>
                                <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 600, color: '#059669' }}>{money(r.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))
                }
              </div>

              {/* Expenses section */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#DC2626', display: 'inline-block' }} />
                  {t('finance.expenses')} — {money(expenseTotal)}
                </div>
                {Object.keys(expByProject).length === 0 ? (
                  <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('finance.noExpensesMonth')}</p>
                ) : (
                  Object.entries(expByProject)
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([proj, { records, total }]) => (
                      <div key={proj} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ background: '#FFF5F5', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: '#991B1B' }}>{proj}</span>
                          <span style={{ fontWeight: 700, color: '#DC2626' }}>{money(total)}</span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <tbody>
                            {records.map((r, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '7px 14px', color: 'var(--text-3)' }}>{r.date?.slice(0, 10)}</td>
                                <td style={{ padding: '7px 8px', color: 'var(--text-2)' }}>{r.description || '—'}</td>
                                <td style={{ padding: '7px 8px' }}>
                                  <span style={{ fontSize: 10.5, background: '#EFF6FF', color: '#1D4ED8', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>{r.category}</span>
                                </td>
                                <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 600, color: '#DC2626' }}>{money(r.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Export helpers ────────────────────────────────────────────────────────
// CSV was retired — Excel covers the same downstream use cases (Sheets / Excel
// open both), and a single export path keeps the toolbar tidy and the formats
// consistent with the rest of the ERP (every other module exports XLSX).

function exportExcel(sheets, filename) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name));
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// ── Reconciliation Modal ──────────────────────────────────────────────────
// Localized reconciliation label/message. The server sends a `type`, structured
// `params`, and an English `message` fallback. We translate the label and rebuild
// the message from params (money fields formatted via the currency toggle) so the
// modal reads fully in the active language; if a key is missing we fall back to
// the server text rather than showing a raw key.
const _RECON_MONEY_FIELDS = ['stored', 'expected', 'over', 'paid', 'amount', 'debit', 'credit'];

function reconLabel(issue, t, fallback) {
  const key = 'finance.reconIssue.' + issue.type;
  const out = t(key);
  return out === key ? fallback : out;
}

function reconMessage(issue, t, money) {
  if (!issue.params) return issue.message;
  const key = 'finance.reconMsg.' + issue.type;
  const fp = { ...issue.params };
  _RECON_MONEY_FIELDS.forEach(k => { if (fp[k] != null) fp[k] = money(fp[k]); });
  if (fp.state) fp.state = t('finance.reconState.' + fp.state);
  const out = t(key, fp);
  return out === key ? issue.message : out;
}

function ReconciliationModal({ onClose }) {
  const { t } = useLocale();
  const money = useMoney();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try { setData(await getReconciliation()); }
      catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const ISSUE_COLORS = {
    vat_mismatch:      { bg: '#FEF3C7', text: '#92400E', icon: 'alert-triangle', label: 'VAT Mismatch' },
    overpayment:       { bg: '#FEE2E2', text: '#991B1B', icon: 'banknote', label: 'Overpayment' },
    orphaned_payment:  { bg: '#FEE2E2', text: '#991B1B', icon: 'link', label: 'Orphaned Payment' },
    future_expense:    { bg: '#EFF6FF', text: '#1D4ED8', icon: 'calendar', label: 'Future-Dated Expense' },
    unreversed_void:   { bg: '#FEE2E2', text: '#991B1B', icon: 'rotate-ccw', label: 'Unreversed Void' },
    gl_unbalanced:     { bg: '#FEE2E2', text: '#991B1B', icon: 'scale', label: 'Ledger Out of Balance' },
  };

  // Migrated to the shared modal shell — same scroll-lock + sticky-header
  // behaviour as every other dialog.
  useScrollLock(true);
  return (
    <div className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{t('finance.reconcileTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {t('finance.reconcileSubtitle')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{t('finance.runningChecks')}</div>}
          {error && <div style={{ color: 'var(--red)', padding: 12, background: 'var(--red-light)', borderRadius: 8 }}>{error}</div>}
          {data && (
            <>
              {/* Summary row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
                {[
                  { label: t('finance.totalInvoiced'), value: money(data.summary?.total_invoiced || 0), color: '#1B4F72' },
                  { label: t('finance.collected'), value: money(data.summary?.total_collected || 0), color: '#059669' },
                  { label: t('finance.outstanding'), value: money(data.summary?.outstanding || 0), color: '#D97706' },
                  { label: t('finance.totalExpenses'), value: money(data.summary?.total_expenses || 0), color: '#DC2626' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', border: '1px solid var(--border)', textAlign: 'center' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Status banner */}
              <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, background: data.clean ? '#F0FDF4' : '#FFF5F5', border: `1px solid ${data.clean ? '#BBF7D0' : '#FCA5A5'}` }}>
                <span style={{ display: 'inline-flex', color: data.clean ? '#059669' : '#991B1B' }}><Icon name={data.clean ? 'check-circle' : 'alert-triangle'} size={22} /></span>
                <div>
                  <div style={{ fontWeight: 700, color: data.clean ? '#065F46' : '#991B1B', fontSize: 14 }}>
                    {data.clean ? t('finance.booksClean') : t('finance.issuesDetected', { count: data.issue_count })}
                  </div>
                  {!data.clean && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>{t('finance.reviewItems')}</div>}
                </div>
              </div>

              {/* Issues list */}
              {(data.issues || []).map((issue, i) => {
                const style = ISSUE_COLORS[issue.type] || { bg: '#F3F4F6', text: '#374151', icon: 'zap', label: issue.type };
                return (
                  <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `4px solid ${style.text === '#991B1B' ? '#DC2626' : style.text === '#92400E' ? '#D97706' : '#3B82F6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ display: 'inline-flex', color: style.text }}><Icon name={style.icon} size={16} /></span>
                      <span style={{ fontSize: 11, fontWeight: 700, background: style.bg, color: style.text, borderRadius: 4, padding: '1px 6px' }}>{reconLabel(issue, t, style.label)}</span>
                      {issue.invoice_number && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>#{issue.invoice_number}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{reconMessage(issue, t, money)}</div>
                    {issue.detail && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>{issue.detail}</div>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}



export { MonthDrillModal, ReconciliationModal, exportExcel };
