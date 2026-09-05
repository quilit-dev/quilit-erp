import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { getDashboard, getMonthlyReport, getFinanceRangeSummary } from '../api/client';
import { LoadingSpinner, ErrorAlert, useMoney, DisplayCurrencyToggle, Icon } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { useModules } from '../hooks/useModules';

// Display primitives (charts, KPI cards, chips) live in ./dashboard/ui.jsx —
// this file is the page itself.
import {
  periodRange, BarChart, HealthRing, KpiCard,
  ActionChip, Insight, SectionTitle,
} from './dashboard/ui';

// ── Main Dashboard ──────────────────────────────────────────────────────

export default function Dashboard() {
  const { data, loading, error, reload } = useData(getDashboard);
  const { data: monthly } = useData(getMonthlyReport);
  const { t, isRTL } = useLocale();
  const money = useMoney();
  const navigate = useNavigate();
  // Called before the early returns below — hooks cannot be conditional.
  const { has } = useModules();

  // Period selector for the headline finance KPIs. Default 'month' uses the
  // dashboard payload (no extra request); other presets fetch a range summary.
  const [period, setPeriod] = useState('month');
  const [rangeSummary, setRangeSummary] = useState(null);
  useEffect(() => {
    if (period === 'month') { setRangeSummary(null); return; }
    const { start, end } = periodRange(period);
    let cancelled = false;
    getFinanceRangeSummary({ start, end })
      .then(d => { if (!cancelled) setRangeSummary(d); })
      .catch(() => { if (!cancelled) setRangeSummary(null); });
    return () => { cancelled = true; };
  }, [period]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={reload} />;
  if (!data)   return null;

  // A card may render only if BOTH gates pass:
  //   1. the tenant LICENSED the module (has) — what they bought;
  //   2. this user has RBAC view rights (perm) — what they may see.
  // Checking only #2 is why every card used to appear: an admin passes every
  // permission check, so nothing filtered out unlicensed modules.
  const perm = data.permissions || {};
  const can = {
    finance:      has('finance')       && perm.finance      !== false,
    invoices:     has('invoices')      && perm.invoices     !== false,
    projects:     has('projects')      && perm.projects     !== false,
    quotes:       has('quotations')    && perm.quotes       !== false,
    inventory:    has('inventory')     && perm.inventory    !== false,
    pos:          has('pos')           && perm.pos          === true,
    cash:         has('cash')          && perm.cash         === true,
    manufacturing:has('manufacturing') && perm.manufacturing=== true,
    hr:           has('hr')            && perm.hr           === true,
    recruitment:  has('recruitment')   && perm.recruitment  === true,
    crm:          has('crm')           && perm.crm          === true,
    assets:       has('assets')        && perm.assets       === true,
    planning:     has('planning')      && perm.planning     === true,
    // Gated on the licence alone: the dashboard payload carries no
    // `warehouses` permission key, and the card was previously shown
    // whenever the payload happened to include the block.
    warehouses:   has('warehouses'),
  };

  // Financial derivatives — 'month' uses the dashboard payload; other periods
  // use the fetched range summary (falls back to monthly until it loads).
  const usingRange = period !== 'month' && rangeSummary;
  const income    = usingRange ? (rangeSummary.income   ?? 0) : (data.monthly_income   ?? 0);
  const expenses  = usingRange ? (rangeSummary.expenses ?? 0) : (data.monthly_expenses ?? 0);
  const profit    = income - expenses;
  const margin    = income > 0 ? Math.round((profit / income) * 100) : 0;
  const periodLabel = period === 'lastMonth' ? t('dashboard.periodLastMonth')
                    : period === 'ytd'       ? t('dashboard.periodYtd')
                    : t('dashboard.periodThisMonth');
  const unpaidAmt = data.unpaid_invoices_amount  || 0;
  const overdueAmt = data.overdue_invoices_amount || 0;
  const overdueCount = data.overdue_invoices_count || 0;

  // Trend sparklines (6-month chart, padded with zeros so a partial history
  // still renders a curve rather than collapsing to a flat line).
  const months    = Array.isArray(monthly) ? monthly.slice(-6) : [];
  const incSpark  = months.map(m => m.income   || 0);
  const expSpark  = months.map(m => m.expenses || 0);
  const profSpark = months.map(m => (m.income || 0) - (m.expenses || 0));

  // Health score — simple weighted heuristic across whichever signals the
  // current user can actually see. Capped at [0,100].
  let healthScore = 50;
  if (can.finance || can.invoices) {
    if (margin > 20) healthScore += 20;
    else if (margin > 0) healthScore += 10;
    else if (margin < 0) healthScore -= 15;
    if ((data.unpaid_invoices_count || 0) === 0) healthScore += 10;
    else if ((data.unpaid_invoices_count || 0) > 5) healthScore -= 10;
    if (overdueCount > 0) healthScore -= Math.min(20, overdueCount * 5);
  }
  if (can.inventory && (data.low_stock_alerts || 0) === 0) healthScore += 10;
  if (can.projects  && (data.active_projects  || 0) > 0)   healthScore += 10;
  healthScore = Math.min(100, Math.max(0, healthScore));

  // ── Header context ────────────────────────────────────────────────────
  const today = new Date();
  const hour = today.getHours();
  const greeting = hour < 12 ? t('dashboard.goodMorning')
                 : hour < 18 ? t('dashboard.goodAfternoon')
                 : t('dashboard.goodEvening');
  const fullDate = today.toLocaleDateString(isRTL ? 'ar-SA-u-nu-latn' : 'default',
                                            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const firstName = (data.current_user_name || '').split(' ')[0];

  // ── "Needs attention" action chips ────────────────────────────────────
  // Built once so we can render a friendly "all clear" empty state when zero.
  const chips = [];
  if (can.invoices && overdueCount > 0) {
    chips.push({ icon: 'clock', severity: 'red',
      label: t('dashboard.overdueAction', { count: overdueCount }),
      count: overdueCount, onClick: () => navigate('/invoices') });
  }
  if (data.my_pending_approvals > 0) {
    chips.push({ icon: 'check-circle', severity: 'purple',
      label: t('dashboard.pendingApprovals') + ' · ' + t('dashboard.waitingOnYou'),
      count: data.my_pending_approvals, onClick: () => navigate('/approvals') });
  }
  if (can.inventory && (data.low_stock_alerts || 0) > 0) {
    chips.push({ icon: 'package', severity: 'red',
      label: t(data.low_stock_alerts > 1 ? 'dashboard.lowStockAlert_plural' : 'dashboard.lowStockAlert', { count: data.low_stock_alerts }),
      onClick: () => navigate('/inventory') });
  }
  if (can.hr && data.hr?.pending_leave > 0) {
    chips.push({ icon: 'sun', severity: 'yellow',
      label: t(data.hr.pending_leave > 1 ? 'dashboard.leaveRequestsPending_plural' : 'dashboard.leaveRequestsPending', { count: data.hr.pending_leave }),
      count: data.hr.pending_leave, onClick: () => navigate('/hr') });
  }
  if (can.cash && data.cash && Math.abs(data.cash.last_variance || 0) > 0.01) {
    chips.push({ icon: 'banknote', severity: 'yellow',
      label: t('dashboard.cashVariance', { drawer: data.cash.last_drawer || '—' }) + ' · ' + money(data.cash.last_variance),
      onClick: () => navigate('/cash') });
  }
  if (can.manufacturing && data.manufacturing?.due_soon > 0) {
    chips.push({ icon: 'factory', severity: 'yellow',
      label: t(data.manufacturing.due_soon > 1 ? 'dashboard.productionDueSoon_plural' : 'dashboard.productionDueSoon', { count: data.manufacturing.due_soon }),
      onClick: () => navigate('/manufacturing') });
  }
  if (data.unread_announcements > 0) {
    chips.push({ icon: 'megaphone', severity: 'blue',
      label: t(data.unread_announcements > 1 ? 'dashboard.unreadAnnouncementChip_plural' : 'dashboard.unreadAnnouncementChip', { count: data.unread_announcements }),
      count: data.unread_announcements, onClick: () => navigate('/announcements') });
  }

  // Which large sections to render?
  const showPrimaryFinance = can.finance || can.invoices;
  const showOpsToday       = can.pos || can.cash || can.manufacturing || can.hr || can.planning || can.warehouses;
  const showPipeline       = can.crm || can.recruitment;
  const showSecondaryKpis  = can.projects || can.quotes || can.inventory || can.assets || can.finance;
  const noPermissions      = !showPrimaryFinance && !showOpsToday && !showPipeline && !showSecondaryKpis;

  return (
    <div style={{ animation: 'fadeIn 0.25s ease' }}>
      {/* ── Greeting header ────────────────────────────────────────── */}
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <h1 className="page-title">{firstName ? `${greeting}, ${firstName}` : greeting}</h1>
          <p className="page-subtitle">{fullDate} · {t('common.realtimeOverview')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DisplayCurrencyToggle />
          {data.unread_notifications > 0 && (
            <button
              onClick={() => navigate('/notifications')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 11px', borderRadius: 20,
                background: 'var(--surface-2)', color: 'var(--text-2)',
                border: '1px solid var(--border)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Notifications"
            >
              <span style={{ display: 'inline-flex' }}><Icon name="bell" size={13} /></span>
              <span style={{ background: 'var(--red)', color: '#fff', borderRadius: 999, padding: '0 6px', fontSize: 10.5, fontWeight: 700 }}>{data.unread_notifications}</span>
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--green-light)', color: 'var(--green)', padding: '5px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 2s infinite' }} />
            {t('common.liveData')}
          </div>
        </div>
      </div>

      {/* ── Needs attention action bar ──────────────────────────────── */}
      {chips.length > 0 ? (
        <div style={{
          padding: '14px 16px', marginBottom: 16,
          background: 'linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%)',
          border: '1px solid var(--border)', borderRadius: 12,
        }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 10 }}>
            <Icon name="zap" size={12} /> {t('dashboard.needsAttention')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {chips.map((c, i) => <ActionChip key={i} {...c} />)}
          </div>
        </div>
      ) : (showPrimaryFinance || showOpsToday) && (
        <div style={{
          padding: '12px 16px', marginBottom: 16,
          background: 'var(--green-light)', border: '1px solid rgba(16,185,129,.22)',
          color: 'var(--green)', borderRadius: 12, fontSize: 12.5, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Icon name="check-circle" size={15} />
          <span>{t('dashboard.everythingClear')}</span>
        </div>
      )}

      {/* ── Primary KPIs (finance) + Health Ring ───────────────────── */}
      {showPrimaryFinance && can.finance && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 8 }}>
          {[
            ['month',     t('dashboard.periodThisMonth')],
            ['lastMonth', t('dashboard.periodLastMonth')],
            ['ytd',       t('dashboard.periodYtd')],
          ].map(([key, label]) => (
            <button key={key} className={`btn btn-sm ${period === key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setPeriod(key)}>{label}</button>
          ))}
        </div>
      )}
      {showPrimaryFinance && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 16, marginBottom: 4 }}
             className="dash-finance-row">
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 0 }}>
            {can.finance && <KpiCard label={t('dashboard.monthlyRevenue')}  value={money(income)}   sub={periodLabel}                          icon="banknote" accentColor="var(--green)"  accentBg="var(--green-light)"  sparkData={incSpark}  onClick={() => navigate('/finance')} />}
            {can.finance && <KpiCard label={t('dashboard.monthlyExpenses')} value={money(expenses)} sub={t('dashboard.operatingCosts')}          icon="trending-down" accentColor="var(--red)"    accentBg="var(--red-light)"    sparkData={expSpark}  onClick={() => navigate('/finance')} />}
            {can.finance && <KpiCard label={t('dashboard.netProfit')}       value={money(profit)}   sub={t('dashboard.margin', { pct: margin })} icon={profit >= 0 ? 'trending-up' : 'alert-triangle'} accentColor={profit >= 0 ? 'var(--green)' : 'var(--red)'} accentBg={profit >= 0 ? 'var(--green-light)' : 'var(--red-light)'} sparkData={profSpark} onClick={() => navigate('/finance')} />}
          </div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 18, marginBottom: 0 }}>
            <HealthRing score={healthScore} t={t} />
            <div style={{ marginTop: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
              {t('dashboard.financialHealth')}
            </div>
          </div>
        </div>
      )}

      {/* ── Operations Today (POS / Cash / Manufacturing / HR / Planning) */}
      {showOpsToday && (
        <>
          <SectionTitle>{t('dashboard.operationsToday')}</SectionTitle>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px,1fr))', marginBottom: 0 }}>
            {can.pos && data.pos && (
              <KpiCard compact
                label={t('dashboard.posSalesToday')}
                value={money(data.pos.total || 0)}
                sub={t(data.pos.c === 1 ? 'dashboard.salesCount' : 'dashboard.salesCount_plural', { count: data.pos.c || 0 })}
                icon="shopping-bag" accentColor="var(--accent)" accentBg="var(--accent-light, var(--surface-2))"
                onClick={() => navigate('/pos')} />
            )}
            {can.cash && data.cash && (
              <KpiCard compact
                label={t('dashboard.cashDrawers')}
                value={`${data.cash.total_drawers}`}
                sub={data.cash.open_sessions > 0
                  ? t(data.cash.open_sessions === 1 ? 'dashboard.drawerOpen' : 'dashboard.drawerOpen_plural', { count: data.cash.open_sessions })
                  : t('dashboard.allClosed')}
                icon="banknote"
                accentColor={data.cash.open_sessions > 0 ? 'var(--yellow)' : 'var(--green)'}
                accentBg={data.cash.open_sessions > 0 ? 'var(--yellow-light)' : 'var(--green-light)'}
                onClick={() => navigate('/cash')} />
            )}
            {can.manufacturing && data.manufacturing && (
              <KpiCard compact
                label={t('dashboard.inProduction')}
                value={data.manufacturing.in_flight}
                sub={data.manufacturing.due_soon > 0
                  ? t('dashboard.dueThisWeek', { count: data.manufacturing.due_soon })
                  : t(data.manufacturing.in_progress === 1 ? 'dashboard.productionActive' : 'dashboard.productionActive_plural', { count: data.manufacturing.in_progress })}
                icon="factory"
                accentColor={data.manufacturing.due_soon > 0 ? 'var(--yellow)' : 'var(--blue)'}
                accentBg={data.manufacturing.due_soon > 0 ? 'var(--yellow-light)' : 'var(--blue-light)'}
                onClick={() => navigate('/manufacturing')} />
            )}
            {can.hr && data.hr && (
              <KpiCard compact
                label={t('dashboard.onLeaveToday')}
                value={data.hr.on_leave}
                sub={t('dashboard.headcount', { count: data.hr.headcount })}
                icon="sun" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/hr')} />
            )}
            {can.planning && data.planning && (
              <KpiCard compact
                label={t('dashboard.eventsToday')}
                value={data.planning.events_today}
                sub={data.planning.upcoming_milestones > 0
                  ? t(data.planning.upcoming_milestones === 1 ? 'dashboard.upcomingMilestones' : 'dashboard.upcomingMilestones_plural', { count: data.planning.upcoming_milestones })
                  : ''}
                icon="calendar" accentColor="var(--blue)" accentBg="var(--blue-light)"
                onClick={() => navigate('/planning')} />
            )}
          </div>
        </>
      )}

      {/* ── Pipeline & Growth (CRM + Recruitment + Assets) ──────────── */}
      {showPipeline && (
        <>
          <SectionTitle>{t('dashboard.pipelineGrowth')}</SectionTitle>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', marginBottom: 0 }}>
            {can.crm && data.crm && (
              <KpiCard compact
                label={t('dashboard.crmPipeline')}
                value={money(data.crm.pipeline_value)}
                sub={t(data.crm.pipeline_count === 1 ? 'dashboard.openDeals' : 'dashboard.openDeals_plural', { count: data.crm.pipeline_count })}
                icon="briefcase" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.crm && data.crm && (
              <KpiCard compact
                label={t('dashboard.wonThisMonth')}
                value={money(data.crm.won_value)}
                sub={t(data.crm.won_count === 1 ? 'dashboard.openDeals' : 'dashboard.openDeals_plural', { count: data.crm.won_count })}
                icon="award" accentColor="var(--green)" accentBg="var(--green-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.crm && data.crm && (
              <KpiCard compact
                label={t('dashboard.newLeads')}
                value={data.crm.new_leads}
                sub={t('dashboard.leadsThisMonth')}
                icon="target" accentColor="var(--blue)" accentBg="var(--blue-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.recruitment && data.recruitment && (
              <KpiCard compact
                label={t('dashboard.openPositions')}
                value={data.recruitment.open_positions}
                sub={t(data.recruitment.active_applicants === 1 ? 'dashboard.activeApplicants' : 'dashboard.activeApplicants_plural', { count: data.recruitment.active_applicants })}
                icon="megaphone" accentColor="var(--accent)" accentBg="var(--surface-2)"
                onClick={() => navigate('/recruitment')} />
            )}
            {can.assets && data.assets && (
              <KpiCard compact
                label={t('dashboard.fixedAssetsBookValue')}
                value={money(data.assets.book_value)}
                sub={t('dashboard.assetsBookValue', { count: data.assets.count })}
                icon="landmark" accentColor="var(--text-2)" accentBg="var(--surface-2)"
                onClick={() => navigate('/fixed-assets')} />
            )}
            {can.warehouses && data.warehouses && (
              /* Warehouse health — count of active locations + a single
                 "needs restock" call-out so the operator can see where to
                 act without filtering through Inventory. */
              <KpiCard compact
                label={t('dashboard.warehouses') || 'Warehouses'}
                value={data.warehouses.active}
                sub={
                  data.warehouses.lowest_low_count > 0
                    ? `${data.warehouses.lowest_code}: ${data.warehouses.lowest_low_count} low`
                    : data.warehouses.in_transit > 0
                      ? `${data.warehouses.in_transit} in transit`
                      : t('dashboard.allClear') || 'All clear'
                }
                icon="building"
                accentColor={data.warehouses.lowest_low_count > 0 ? 'var(--yellow)' : 'var(--blue)'}
                accentBg={data.warehouses.lowest_low_count > 0 ? 'var(--yellow-light)' : 'var(--blue-light)'}
                onClick={() => navigate('/warehouses')} />
            )}
          </div>
        </>
      )}

      {/* ── Receivables / Projects / Inventory secondary row ────────── */}
      {showSecondaryKpis && (
        <>
          <SectionTitle>{t('common.module') || 'Operations'}</SectionTitle>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px,1fr))', marginBottom: 0 }}>
            {can.invoices && (
              <KpiCard compact
                label={t('dashboard.unpaidInvoices')}
                value={money(unpaidAmt)}
                sub={t('dashboard.outstanding', { count: data.unpaid_invoices_count ?? 0 })}
                icon="receipt"
                accentColor={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)'}
                accentBg={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow-light)' : 'var(--green-light)'}
                /* Land on exactly the set this card counted. Sending the user
                   to an unfiltered list made a correct number look wrong:
                   nothing on the screen they arrived at added up to it. */
                onClick={() => navigate('/invoices?status=Outstanding')} />
            )}
            {can.invoices && (
              <KpiCard compact
                label={t('dashboard.overdueInvoices')}
                value={money(overdueAmt)}
                sub={t('dashboard.pastDue', { count: overdueCount })}
                icon="clock"
                accentColor={overdueCount > 0 ? 'var(--red)' : 'var(--green)'}
                accentBg={overdueCount > 0 ? 'var(--red-light)' : 'var(--green-light)'}
                onClick={() => navigate('/invoices')} />
            )}
            {can.projects && (
              <KpiCard compact label={t('dashboard.activeProjects')} value={data.active_projects ?? 0}
                icon="building" accentColor="var(--blue)" accentBg="var(--blue-light)"
                onClick={() => navigate('/projects')} />
            )}
            {can.quotes && (
              <KpiCard compact label={t('dashboard.pendingQuotes')} value={data.pending_quotes ?? 0}
                icon="clipboard" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/quotations')} />
            )}
            {can.inventory && (
              <KpiCard compact label={t('dashboard.lowStockItems')} value={data.low_stock_alerts ?? 0}
                icon="package"
                accentColor={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red)' : 'var(--green)'}
                accentBg={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red-light)' : 'var(--green-light)'}
                onClick={() => navigate('/inventory')} />
            )}
            {can.finance && (
              <KpiCard compact label={t('dashboard.profitMargin')} value={`${margin}%`}
                icon="bar-chart"
                accentColor={margin > 15 ? 'var(--green)' : margin > 0 ? 'var(--yellow)' : 'var(--red)'}
                accentBg={margin > 15 ? 'var(--green-light)' : margin > 0 ? 'var(--yellow-light)' : 'var(--red-light)'}
                onClick={() => navigate('/finance')} />
            )}
          </div>
        </>
      )}

      {/* ── Charts row: Revenue/expenses bar chart + Insights ───────── */}
      {showPrimaryFinance && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, marginTop: 20, marginBottom: 16 }}
             className="dash-chart-row">
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
              <BarChart data={months.map(m => ({ month: m.month, income: m.income || 0, expenses: m.expenses || 0 }))} height={180} />
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">{t('dashboard.keyInsights')}</div></div>
            <div className="card-body">
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)' }}>
                {can.finance && margin > 20 && <Insight icon="check-circle" text={t('dashboard.strongMargin', { pct: margin })} color="var(--green)" onClick={() => navigate('/finance')} />}
                {can.finance && margin > 0 && margin <= 20 && <Insight icon="alert-triangle" text={t('dashboard.thinMargin', { pct: margin })} color="var(--yellow)" onClick={() => navigate('/finance')} />}
                {can.finance && margin < 0 && <Insight icon="alert-circle" text={t('dashboard.operatingLoss')} color="var(--red)" onClick={() => navigate('/finance')} />}
                {can.invoices && (data.unpaid_invoices_count ?? 0) > 0 && <Insight icon="mail" text={t(data.unpaid_invoices_count > 1 ? 'dashboard.unpaidInvoiceCount_plural' : 'dashboard.unpaidInvoiceCount', { count: data.unpaid_invoices_count })} color="var(--yellow)" onClick={() => navigate('/invoices?status=Outstanding')} />}
                {can.invoices && overdueCount > 0 && <Insight icon="clock" text={t('dashboard.overdueAction', { count: overdueCount })} color="var(--red)" onClick={() => navigate('/invoices')} />}
                {can.inventory && (data.low_stock_alerts ?? 0) > 0 && <Insight icon="package" text={t(data.low_stock_alerts > 1 ? 'dashboard.lowStockAlert_plural' : 'dashboard.lowStockAlert', { count: data.low_stock_alerts })} color="var(--red)" onClick={() => navigate('/inventory')} />}
                {can.projects && (data.active_projects ?? 0) > 0 && <Insight icon="building" text={t(data.active_projects > 1 ? 'dashboard.projectsInProgress_plural' : 'dashboard.projectsInProgress', { count: data.active_projects })} color="var(--blue)" onClick={() => navigate('/projects')} />}
                {can.quotes && (data.pending_quotes ?? 0) > 0 && <Insight icon="clipboard" text={t(data.pending_quotes > 1 ? 'dashboard.quotesAwaiting_plural' : 'dashboard.quotesAwaiting', { count: data.pending_quotes })} color="var(--purple)" onClick={() => navigate('/quotations')} />}
                {margin >= 0 && (data.unpaid_invoices_count ?? 0) === 0 && (data.low_stock_alerts ?? 0) === 0 && <Insight icon="check-circle" text={t('common.allNominal')} color="var(--green)" />}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Recent activity tables ─────────────────────────────────── */}
      {(can.projects || can.invoices) && (
        <div className="dash-activity-row" style={{ display: 'grid', gridTemplateColumns: `repeat(${can.projects && can.invoices ? 2 : 1}, 1fr)`, gap: 16, marginBottom: 16 }}>
          {can.projects && (
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
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
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

          {can.invoices && (
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
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <td className="td-mono">{i.invoice_number}</td>
                            <td>{i.client_name || '—'}</td>
                            <td><span className={`badge ${cls}`}>{i.payment_status}</span></td>
                            <td style={{ textAlign: 'right' }} className="td-primary">{money(i.amount)}</td>
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

      {/* ── Upcoming agenda (planning events next 7 days) ──────────── */}
      {can.planning && Array.isArray(data.upcoming_events) && data.upcoming_events.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <div>
              <div className="card-title">{t('dashboard.upcomingAgenda')}</div>
              <div className="card-subtitle">{t('dashboard.nextSevenDays')}</div>
            </div>
            <span onClick={() => navigate('/planning')} style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              {t('common.viewAll')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.upcoming_events.map(ev => {
              const d = new Date(ev.start_date + 'T00:00:00');
              const dayLabel = d.toLocaleDateString(isRTL ? 'ar-SA-u-nu-latn' : 'default', { weekday: 'short', month: 'short', day: 'numeric' });
              const timeLabel = ev.all_day ? t('dashboard.allDay') : (ev.start_time || '');
              return (
                <div key={ev.id}
                  onClick={() => navigate('/planning')}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', background: 'var(--surface-2)', border: '1px solid var(--border)', transition: 'transform .12s ease' }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'translateX(2px)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'translateX(0)'}>
                  <div style={{ width: 4, height: 38, borderRadius: 4, background: ev.color || 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{dayLabel}{timeLabel ? ` · ${timeLabel}` : ''}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Empty state for users with very limited permissions ───── */}
      {noPermissions && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-3)' }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', color: 'var(--text-3)' }}><Icon name="layout-dashboard" size={44} strokeWidth={1.5} /></div>
          <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{t('common.welcomeERP')}</p>
          <p style={{ fontSize: 13 }}>{t('common.dashboardPersonalized')}</p>
        </div>
      )}

      {/* Responsive overrides — collapse the side health-ring/insights to
          full width when viewport drops below ~900px so nothing wraps oddly. */}
      <style>{`
        @media (max-width: 900px) {
          .dash-finance-row, .dash-chart-row, .dash-activity-row { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
