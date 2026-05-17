import { useData } from '../hooks/useData';
import { getDashboard, getMonthlyReport } from '../api/client';
import { LoadingSpinner, ErrorAlert, fmt as fmtStatic } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// ── Sparkline ───────────────────────────────────────────────────
function Sparkline({ data = [], color = 'var(--accent)', height = 32, width = 80 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const pathD = `M${pts.join(' L')}`;
  const areaD = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  const id = color.replace(/[^a-z0-9]/gi, '');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#sp-${id})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Bar Chart ────────────────────────────────────────────────────
function BarChart({ data = [], height = 160 }) {
  const [hovered, setHovered] = useState(null);
  if (!data.length) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 13 }}>
      No data yet
    </div>
  );
  const maxVal = Math.max(...data.map(d => Math.max(d.income || 0, d.expenses || 0)), 1);
  const labels = [maxVal, maxVal * 0.5, 0].map(v => v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v.toFixed(0)}`);
  return (
    <div style={{ position: 'relative', height: height + 28, paddingBottom: 28 }}>
      {/* Y-axis */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', color: 'var(--text-3)', fontSize: 10, fontWeight: 600, width: 34 }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
      {/* Grid */}
      <div style={{ position: 'absolute', left: 38, right: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
        {[0,1,2].map(i => <div key={i} style={{ height: 1, background: 'var(--border)', opacity: .6 }} />)}
      </div>
      {/* Bars */}
      <div style={{ position: 'absolute', left: 38, right: 0, top: 0, bottom: 24, display: 'flex', alignItems: 'flex-end', gap: 6 }}>
        {data.map((d, i) => {
          const incPct = ((d.income || 0) / maxVal) * 100;
          const expPct = ((d.expenses || 0) / maxVal) * 100;
          const isHov = hovered === i;
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', position: 'relative' }}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
              {isHov && (
                <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--surface)', fontSize: 10, fontWeight: 600, padding: '4px 8px', borderRadius: 5, whiteSpace: 'nowrap', zIndex: 10, marginBottom: 4 }}>
                  {fmtStatic(d.income)} / {fmtStatic(d.expenses)}
                </div>
              )}
              <div style={{ width: '100%', display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }}>
                <div style={{ flex: 1, height: `${incPct}%`, background: 'var(--green)', borderRadius: '3px 3px 0 0', transition: 'height .5s ease, opacity .2s', opacity: isHov ? 1 : 0.75, minHeight: incPct > 0 ? 3 : 0 }} />
                <div style={{ flex: 1, height: `${expPct}%`, background: 'var(--red)', borderRadius: '3px 3px 0 0', transition: 'height .5s ease, opacity .2s', opacity: isHov ? 1 : 0.6, minHeight: expPct > 0 ? 3 : 0 }} />
              </div>
            </div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div style={{ position: 'absolute', left: 38, right: 0, bottom: 0, display: 'flex', gap: 6 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--text-3)', fontWeight: 600 }}>
            {d.month ? d.month.slice(0, 3) : `M${i+1}`}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon, accentColor, accentBg, sparkData, trend, onClick }) {
  const [hover, setHover] = useState(false);
  const clickable = !!onClick;
  return (
    <div
      className="stat-card"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        '--card-accent': accentColor,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'transform .15s ease, box-shadow .15s ease',
        transform: clickable && hover ? 'translateY(-2px)' : 'none',
        boxShadow: clickable && hover ? '0 8px 22px rgba(15,23,42,.12)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: accentBg || 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
          {icon}
        </div>
        {trend != null ? (
          <span className={trend >= 0 ? 'trend-up' : 'trend-down'}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
        ) : clickable && (
          <span style={{ fontSize: 15, fontWeight: 700, color: accentColor || 'var(--accent)', opacity: hover ? 1 : 0, transition: 'opacity .15s' }}>→</span>
        )}
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: accentColor || 'var(--text)' }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {sparkData && sparkData.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <Sparkline data={sparkData} color={accentColor || 'var(--accent)'} />
        </div>
      )}
    </div>
  );
}

// ── Health ring ──────────────────────────────────────────────────
function HealthRing({ score = 0 }) {
  const { t } = useLocale();
  const r = 38, circ = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score)) / 100;
  const color = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--yellow)' : 'var(--red)';
  const label = score >= 70 ? t('status.Healthy') : score >= 40 ? t('status.Fair') : t('status.At Risk');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width="90" height="90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={`${circ * pct} ${circ * (1 - pct)}`}
          strokeLinecap="round" transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
        <text x="50" y="47" textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--text)" fontFamily="Inter,sans-serif">{score}</text>
        <text x="50" y="63" textAnchor="middle" fontSize="9" fill="var(--text-3)" fontFamily="Inter,sans-serif">/ 100</text>
      </svg>
      <span style={{ fontSize: 12, fontWeight: 700, color }}>{label}</span>
    </div>
  );
}

// ── Insight row ──────────────────────────────────────────────────
function Insight({ icon, text, color, onClick }) {
  const [hover, setHover] = useState(false);
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
        padding: '4px 6px', margin: '0 -6px', borderRadius: 6,
        cursor: clickable ? 'pointer' : 'default',
        background: clickable && hover ? 'var(--surface-3)' : 'transparent',
        transition: 'background .15s',
      }}
    >
      <div style={{ width: 20, height: 20, borderRadius: 5, background: color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>{icon}</div>
      <span style={{ color: 'var(--text-2)', flex: 1 }}>{text}</span>
      {clickable && (
        <span style={{ fontSize: 11, color: 'var(--text-3)', opacity: hover ? 1 : 0, transition: 'opacity .15s' }}>→</span>
      )}
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────
export default function Dashboard() {
  const { data, loading, error, reload } = useData(getDashboard);
  const { data: monthly } = useData(getMonthlyReport);
  const { t, fmt, isRTL } = useLocale();
  const navigate = useNavigate();

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={reload} />;
  if (!data)   return null;

  // Permissions from the permission-aware API response
  const perm = data.permissions || {};
  const canFinance   = perm.finance   !== false;
  const canInvoices  = perm.invoices  !== false;
  const canProjects  = perm.projects  !== false;
  const canQuotes    = perm.quotes    !== false;
  const canInventory = perm.inventory !== false;

  const income   = data.monthly_income   ?? 0;
  const expenses = data.monthly_expenses ?? 0;
  const profit   = (income ?? 0) - (expenses ?? 0);
  const margin   = income > 0 ? Math.round((profit / income) * 100) : 0;
  const unpaidAmt   = data.unpaid_invoices_amount   || 0;
  const overdueAmt  = data.overdue_invoices_amount  || 0;
  const overdueCount = data.overdue_invoices_count  || 0;

  const months    = Array.isArray(monthly) ? monthly.slice(-6) : [];
  const incSpark  = months.map(m => m.income   || 0);
  const expSpark  = months.map(m => m.expenses || 0);
  const profSpark = months.map(m => (m.income || 0) - (m.expenses || 0));

  let healthScore = 50;
  if (canFinance || canInvoices) {
    if (margin > 20) healthScore += 20; else if (margin > 0) healthScore += 10; else if (margin < 0) healthScore -= 15;
    if ((data.unpaid_invoices_count || 0) === 0) healthScore += 10; else if ((data.unpaid_invoices_count || 0) > 5) healthScore -= 10;
    if (overdueCount > 0) healthScore -= Math.min(20, overdueCount * 5);
  }
  if (canInventory && (data.low_stock_alerts || 0) === 0) healthScore += 10;
  if (canProjects  && (data.active_projects  || 0) > 0)   healthScore += 10;
  healthScore = Math.min(100, Math.max(0, healthScore));

  const today = new Date();
  const monthName = today.toLocaleString(isRTL ? 'ar-SA-u-nu-latn' : 'default', { month: 'long', year: 'numeric' });

  return (
    <div style={{ animation: 'fadeIn 0.25s ease' }}>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('dashboard.title')}</h1>
          <p className="page-subtitle">{monthName} · {t('common.realtimeOverview')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--green-light)', color: 'var(--green)', padding: '5px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 2s infinite' }} />
            {t('common.liveData')}
          </div>
        </div>
      </div>

      {/* Primary KPIs — finance/invoice-gated */}
      {(canFinance || canInvoices) && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          {canFinance && <KpiCard label={t('dashboard.monthlyRevenue')}  value={fmt(income)}     sub={t('dashboard.collectedThisMonth')}    icon="💰" accentColor="var(--green)"  accentBg="var(--green-light)"  sparkData={incSpark}  onClick={() => navigate('/finance')} />}
          {canFinance && <KpiCard label={t('dashboard.monthlyExpenses')} value={fmt(expenses)}   sub={t('dashboard.operatingCosts')}          icon="📉" accentColor="var(--red)"    accentBg="var(--red-light)"    sparkData={expSpark}  onClick={() => navigate('/finance')} />}
          {canFinance && <KpiCard label={t('dashboard.netProfit')}       value={fmt(profit)}     sub={t('dashboard.margin', { pct: margin })} icon={profit >= 0 ? '📈' : '⚠️'} accentColor={profit >= 0 ? 'var(--green)' : 'var(--red)'} accentBg={profit >= 0 ? 'var(--green-light)' : 'var(--red-light)'} sparkData={profSpark} onClick={() => navigate('/finance')} />}
          {canInvoices && <KpiCard label={t('dashboard.unpaidInvoices')}  value={fmt(unpaidAmt)}  sub={t('dashboard.outstanding', { count: data.unpaid_invoices_count ?? 0 })} icon="🧾" accentColor={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)'} accentBg={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow-light)' : 'var(--green-light)'} onClick={() => navigate('/invoices')} />}
          {canInvoices && <KpiCard label={t('dashboard.overdueInvoices')} value={fmt(overdueAmt)} sub={t('dashboard.pastDue', { count: overdueCount })} icon="⏰" accentColor={overdueCount > 0 ? 'var(--red)' : 'var(--green)'} accentBg={overdueCount > 0 ? 'var(--red-light)' : 'var(--green-light)'} onClick={() => navigate('/invoices')} />}
        </div>
      )}

      {/* Secondary KPIs */}
      {(canProjects || canQuotes || canInventory || canFinance) && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', marginBottom: 20 }}>
          {canProjects  && <KpiCard label={t('dashboard.activeProjects')} value={data.active_projects  ?? 0} icon="🏗"  accentColor="var(--blue)"   accentBg="var(--blue-light)" onClick={() => navigate('/projects')} />}
          {canQuotes    && <KpiCard label={t('dashboard.pendingQuotes')}  value={data.pending_quotes   ?? 0} icon="📋" accentColor="var(--purple)" accentBg="var(--purple-light)" onClick={() => navigate('/quotations')} />}
          {canInventory && <KpiCard label={t('dashboard.lowStockItems')}  value={data.low_stock_alerts ?? 0} icon="📦" accentColor={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red)' : 'var(--green)'} accentBg={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red-light)' : 'var(--green-light)'} onClick={() => navigate('/inventory')} />}
          {canFinance   && <KpiCard label={t('dashboard.profitMargin')}   value={`${margin}%`}               icon="📊" accentColor={margin > 15 ? 'var(--green)' : margin > 0 ? 'var(--yellow)' : 'var(--red)'} accentBg={margin > 15 ? 'var(--green-light)' : margin > 0 ? 'var(--yellow-light)' : 'var(--red-light)'} onClick={() => navigate('/finance')} />}
        </div>
      )}

      {/* Charts row — only when finance/invoice data available */}
      {(canFinance || canInvoices) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, marginBottom: 16 }}>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">{t('dashboard.revenueVsExpenses')}</div>
                <div className="card-subtitle">{t('dashboard.last6Months')}</div>
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-3)', alignItems: 'center' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--green)', display: 'inline-block' }} /> {t('dashboard.revenue')}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--red)', display: 'inline-block' }} /> {t('dashboard.expenses')}
                </span>
              </div>
            </div>
            <div className="card-body">
              <BarChart
                data={months.map(m => ({ month: m.month, income: m.income || 0, expenses: m.expenses || 0 }))}
                height={180}
              />
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">{t('dashboard.financialHealth')}</div>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
              <HealthRing score={healthScore} />
              <div style={{ width: '100%', background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.6px' }}>{t('dashboard.keyInsights')}</div>
                {canFinance && margin > 20 && <Insight icon="✅" text={t('dashboard.strongMargin', { pct: margin })} color="var(--green)" onClick={() => navigate('/finance')} />}
                {canFinance && margin > 0 && margin <= 20 && <Insight icon="⚠️" text={t('dashboard.thinMargin', { pct: margin })} color="var(--yellow)" onClick={() => navigate('/finance')} />}
                {canFinance && margin < 0 && <Insight icon="🔴" text={t('dashboard.operatingLoss')} color="var(--red)" onClick={() => navigate('/finance')} />}
                {canInvoices && (data.unpaid_invoices_count ?? 0) > 0 && <Insight icon="📬" text={t(data.unpaid_invoices_count > 1 ? 'dashboard.unpaidInvoiceCount_plural' : 'dashboard.unpaidInvoiceCount', { count: data.unpaid_invoices_count })} color="var(--yellow)" onClick={() => navigate('/invoices')} />}
                {canInvoices && overdueCount > 0 && <Insight icon="⏰" text={t('dashboard.overdueAction', { count: overdueCount })} color="var(--red)" onClick={() => navigate('/invoices')} />}
                {canInventory && (data.low_stock_alerts ?? 0) > 0 && <Insight icon="📦" text={t(data.low_stock_alerts > 1 ? 'dashboard.lowStockAlert_plural' : 'dashboard.lowStockAlert', { count: data.low_stock_alerts })} color="var(--red)" onClick={() => navigate('/inventory')} />}
                {canProjects && (data.active_projects ?? 0) > 0 && <Insight icon="🏗" text={t(data.active_projects > 1 ? 'dashboard.projectsInProgress_plural' : 'dashboard.projectsInProgress', { count: data.active_projects })} color="var(--blue)" onClick={() => navigate('/projects')} />}
                {canQuotes && (data.pending_quotes ?? 0) > 0 && <Insight icon="📋" text={t(data.pending_quotes > 1 ? 'dashboard.quotesAwaiting_plural' : 'dashboard.quotesAwaiting', { count: data.pending_quotes })} color="var(--purple)" onClick={() => navigate('/quotations')} />}
                {margin >= 0 && (data.unpaid_invoices_count ?? 0) === 0 && (data.low_stock_alerts ?? 0) === 0 && <Insight icon="✅" text={t('common.allNominal')} color="var(--green)" />}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tables row — only when the user can see the respective modules */}
      {(canProjects || canInvoices) && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${canProjects && canInvoices ? 2 : 1}, 1fr)`, gap: 16 }}>
          {canProjects && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">{t('dashboard.recentProjects')}</span>
                <span onClick={() => navigate('/projects')} style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  {t('common.viewAll')}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('dashboard.project')}</th><th>{t('dashboard.client')}</th><th>{t('common.status')}</th></tr></thead>
                  <tbody>
                    {!(data.recent_projects?.length)
                      ? <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>{t('dashboard.noProjectsYet')}</td></tr>
                      : data.recent_projects.map(p => (
                        <tr key={p.id}
                          onClick={() => navigate(`/projects/${p.id}`)}
                          style={{ cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <td className="td-primary">{p.name}</td>
                          <td>{p.client_name || '—'}</td>
                          <td><span className="badge badge-blue">{p.status}</span></td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canInvoices && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">{t('dashboard.recentInvoices')}</span>
                <span onClick={() => navigate('/invoices')} style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  {t('common.viewAll')}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('dashboard.invoice')}</th><th>{t('dashboard.client')}</th><th>{t('common.status')}</th><th style={{ textAlign: 'right' }}>{t('common.amount')}</th></tr></thead>
                  <tbody>
                    {!(data.recent_invoices?.length)
                      ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>{t('dashboard.noInvoicesYet')}</td></tr>
                      : data.recent_invoices.map(i => {
                        const cls = i.payment_status === 'Paid' ? 'badge-green' : i.payment_status === 'Partial' ? 'badge-yellow' : 'badge-red';
                        return (
                          <tr key={i.id}
                            onClick={() => navigate('/invoices')}
                            style={{ cursor: 'pointer' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <td className="td-mono">{i.invoice_number}</td>
                            <td>{i.client_name || '—'}</td>
                            <td><span className={`badge ${cls}`}>{i.payment_status}</span></td>
                            <td style={{ textAlign: 'right' }} className="td-primary">{fmt(i.amount)}</td>
                          </tr>
                        );
                      })
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state for users with very limited permissions */}
      {!canFinance && !canInvoices && !canProjects && !canQuotes && !canInventory && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-3)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>👋</div>
          <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{t('common.welcomeERP')}</p>
          <p style={{ fontSize: 13 }}>{t('common.dashboardPersonalized')}</p>
        </div>
      )}
    </div>
  );
}
