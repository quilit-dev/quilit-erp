import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../hooks/useData';
import { getDashboard, getMonthlyReport, getFinanceRangeSummary } from '../api/client';
import { LoadingSpinner, ErrorAlert, useMoney, useMoneyCompact, DisplayCurrencyToggle } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';

// Resolve a period preset to a {start,end} ISO range. Kept tiny on purpose —
// three presets cover the common SMB needs without a date-picker.
function periodRange(p) {
  const d = new Date();
  const iso = (x) => x.toISOString().slice(0, 10);
  if (p === 'lastMonth') {
    const start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const end   = new Date(d.getFullYear(), d.getMonth(), 0);
    return { start: iso(start), end: iso(end) };
  }
  if (p === 'ytd') {
    return { start: `${d.getFullYear()}-01-01`, end: iso(d) };
  }
  // 'month' (default) → 1st of this month → today
  return { start: `${iso(d).slice(0, 7)}-01`, end: iso(d) };
}

// ── Tiny visualisation primitives ───────────────────────────────────────
// All three are intentionally tiny so the dashboard renders in one frame and
// stays readable on phones. The Sparkline doubles as an inline trend marker
// inside KPI cards; the BarChart is for the multi-month finance view; the
// HealthRing is the single hero gauge.

function Sparkline({ data = [], color = 'var(--accent)', height = 32, width = 80 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const id = color.replace(/[^a-z0-9]/gi, '');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M0,${height} L${pts.join(' L')} L${width},${height} Z`} fill={`url(#sp-${id})`} />
      <path d={`M${pts.join(' L')}`} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BarChart({ data = [], height = 180 }) {
  const [hovered, setHovered] = useState(null);
  const { exchangeRate, displayCurrency } = useSettings();
  const money = useMoney();
  // Stored amounts are USD; scale the axis ticks into the displayed currency so
  // the scale and the (currency-aware) tooltip never disagree. Ticks stay
  // abbreviated (k/M/B) to fit the narrow axis gutter.
  const lbp  = displayCurrency === 'LBP' && exchangeRate?.rate;
  const rate = lbp ? exchangeRate.rate : 1;
  const tick = (v) => {
    const x = (v || 0) * rate;
    const abbr = x >= 1e9 ? `${(x / 1e9).toFixed(1)}B`
               : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M`
               : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k`
               : `${x.toFixed(0)}`;
    return lbp ? abbr : `$${abbr}`;
  };
  if (!data.length) return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 13 }}>No data yet</div>
  );
  const maxVal = Math.max(...data.map(d => Math.max(d.income || 0, d.expenses || 0)), 1);
  const labels = [maxVal, maxVal * 0.5, 0].map(tick);
  return (
    <div style={{ position: 'relative', height: height + 28, paddingBottom: 28 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', color: 'var(--text-3)', fontSize: 10, fontWeight: 600, width: 34 }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
      <div style={{ position: 'absolute', left: 38, right: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
        {[0,1,2].map(i => <div key={i} style={{ height: 1, background: 'var(--border)', opacity: .6 }} />)}
      </div>
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
                  {money(d.income)} / {money(d.expenses)}
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

function HealthRing({ score = 0, t }) {
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

// ── Building blocks ─────────────────────────────────────────────────────

// KPI tile — Workspace direction.
//
// Layout (top to bottom):
//   • Tiny mark icon (mono, restrained) at the top-left + trend or "open"
//     arrow at the top-right
//   • All-caps letter-spaced label, slate
//   • Hero value in Inter 700 with tabular numerals
//   • Optional caption underneath in plain Inter slate
//   • Optional sparkline beneath
//
// The signature touches:
//   1. Soft white surface with a subtle drop shadow — the card floats
//      just enough to read as its own object on the cool light background.
//   2. Hero value uses Inter 700 at 28px with tight tracking — formal,
//      engineered, friendly. Same direction Odoo uses for KPIs.
//   3. Trend indicator is monospace with proper arrow glyphs (▲ / ▼),
//      tabular percentages, no rounded background pill.
//   4. Clickable affordance is a soft arrow on hover + a gentle shadow
//      lift, not the editorial-rail flourish the previous direction used.
function KpiCard({ label, value, sub, icon, accentColor, accentBg, sparkData, trend, onClick, compact = false }) {
  const [hover, setHover] = useState(false);
  const clickable = !!onClick;
  // The icon prop is kept (callers still pass emoji glyphs) but rendered
  // tiny + monochrome as an editorial "section mark" rather than a chunky
  // bubble. Tiles without an icon read as pure type — even better.
  return (
    <div
      className="stat-card"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: clickable ? 'pointer' : 'default',
        padding: compact ? '14px 16px 12px' : undefined,
      }}
    >
      {/* Top row — small mono mark (left) + trend / "open" caret (right) */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 6,
        minHeight: 18,
      }}>
        {icon ? (
          <span style={{
            fontSize: 13, lineHeight: 1,
            color: accentColor || 'var(--text-3)',
            opacity: 0.7,
          }}>{icon}</span>
        ) : <span />}
        {trend != null ? (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0,
            color: trend >= 0 ? 'var(--affirm)' : 'var(--negate)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
          </span>
        ) : clickable && (
          <span style={{
            fontSize: 14, fontWeight: 500,
            color: accentColor || 'var(--accent)',
            opacity: hover ? 1 : 0,
            transition: 'opacity .15s, transform .15s',
            transform: hover ? 'translateX(2px)' : 'none',
          }}>→</span>
        )}
      </div>

      {/* Label — all-caps mono-style eyebrow */}
      <div className="stat-label" style={compact ? { fontSize: 10 } : undefined}>{label}</div>

      {/* Hero value — Inter 700, tight tracking, tabular figures */}
      <div className="stat-value" style={{
        color: accentColor || 'var(--text)',
        fontSize: compact ? 22 : undefined,
        marginTop: 2,
      }}>{value}</div>

      {/* Caption — Inter regular slate. No serif, no italic decoration. */}
      {sub && (
        <div style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          fontWeight: 400,
          color: 'var(--text-2)',
          letterSpacing: -0.005,
          marginTop: 4,
        }}>{sub}</div>
      )}

      {/* Sparkline — same restrained line style as the rest of the system */}
      {sparkData && sparkData.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <Sparkline data={sparkData} color={accentColor || 'var(--accent)'} />
        </div>
      )}
    </div>
  );
}

// Chip for the "needs attention" action bar — a compact pill with an icon, a
// label and a click handler. Severity ('red'|'yellow'|'blue'|'purple') drives
// the colour scheme; everything else is plain visual styling.
// Editorial action chip — a sharp-cornered tag, not a rounded bubble.
// Hairline border + soft semantic tint + monospace count badge. Reads as
// the "stamp on a page" each chip stands for an action queued for
// the operator's attention.
function ActionChip({ icon, label, count, severity = 'yellow', onClick }) {
  const [hover, setHover] = useState(false);
  // Editorial semantic tints — same palette the rest of the system uses.
  const palette = {
    red:    { fg: 'var(--negate)',  bg: 'var(--negate-tint)',  border: 'rgba(142,36,36,0.22)'  },
    yellow: { fg: 'var(--caution)', bg: 'var(--caution-tint)', border: 'rgba(163,122,44,0.24)' },
    blue:   { fg: 'var(--accent)',  bg: 'var(--accent-tint)',  border: 'rgba(31,79,168,0.22)'  },
    purple: { fg: 'var(--purple)',  bg: 'var(--purple-light)', border: 'rgba(94,58,142,0.22)'  },
  }[severity] || { fg: 'var(--text-2)', bg: 'var(--surface-2)', border: 'var(--rule)' };
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '5px 10px',
        background: hover && onClick ? palette.fg : palette.bg,
        color:      hover && onClick ? '#FFFFFF' : palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,                /* sharp document corner */
        fontFamily: 'var(--font-sans)',
        fontSize: 12, fontWeight: 600,
        letterSpacing: -0.005,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background .12s ease, color .12s ease',
      }}
    >
      {icon && (
        <span style={{ fontSize: 13, opacity: 0.85, lineHeight: 1 }}>{icon}</span>
      )}
      <span>{label}</span>
      {count != null && (
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10, fontWeight: 600,
          letterSpacing: 0.04,
          padding: '1px 5px',
          minWidth: 18, height: 16,
          background: hover && onClick ? 'rgba(255,255,255,0.22)' : palette.fg,
          color: hover && onClick ? '#FFFFFF' : '#FFFFFF',
          borderRadius: 2,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{count}</span>
      )}
    </button>
  );
}

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

// Small reusable section heading — uppercase eyebrow, optional right slot.
function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '20px 0 10px' }}>
      <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.8px', margin: 0 }}>{children}</h2>
      {right}
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────

export default function Dashboard() {
  const { data, loading, error, reload } = useData(getDashboard);
  const { data: monthly } = useData(getMonthlyReport);
  const { t, isRTL } = useLocale();
  const money = useMoney();
  const moneyCompact = useMoneyCompact();
  const navigate = useNavigate();

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

  // Permissions — the only safe way to know which sections to render.
  const perm = data.permissions || {};
  const can = {
    finance:      perm.finance      !== false,
    invoices:     perm.invoices     !== false,
    projects:     perm.projects     !== false,
    quotes:       perm.quotes       !== false,
    inventory:    perm.inventory    !== false,
    pos:          perm.pos          === true,
    cash:         perm.cash         === true,
    manufacturing:perm.manufacturing=== true,
    hr:           perm.hr           === true,
    recruitment:  perm.recruitment  === true,
    crm:          perm.crm          === true,
    assets:       perm.assets       === true,
    planning:     perm.planning     === true,
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
    chips.push({ icon: '⏰', severity: 'red',
      label: t('dashboard.overdueAction', { count: overdueCount }),
      count: overdueCount, onClick: () => navigate('/invoices') });
  }
  if (data.my_pending_approvals > 0) {
    chips.push({ icon: '✅', severity: 'purple',
      label: t('dashboard.pendingApprovals') + ' · ' + t('dashboard.waitingOnYou'),
      count: data.my_pending_approvals, onClick: () => navigate('/approvals') });
  }
  if (can.inventory && (data.low_stock_alerts || 0) > 0) {
    chips.push({ icon: '📦', severity: 'red',
      label: t(data.low_stock_alerts > 1 ? 'dashboard.lowStockAlert_plural' : 'dashboard.lowStockAlert', { count: data.low_stock_alerts }),
      onClick: () => navigate('/inventory') });
  }
  if (can.hr && data.hr?.pending_leave > 0) {
    chips.push({ icon: '🌴', severity: 'yellow',
      label: t(data.hr.pending_leave > 1 ? 'dashboard.leaveRequestsPending_plural' : 'dashboard.leaveRequestsPending', { count: data.hr.pending_leave }),
      count: data.hr.pending_leave, onClick: () => navigate('/hr') });
  }
  if (can.cash && data.cash && Math.abs(data.cash.last_variance || 0) > 0.01) {
    chips.push({ icon: '💵', severity: 'yellow',
      label: t('dashboard.cashVariance', { drawer: data.cash.last_drawer || '—' }) + ' · ' + money(data.cash.last_variance),
      onClick: () => navigate('/cash') });
  }
  if (can.manufacturing && data.manufacturing?.due_soon > 0) {
    chips.push({ icon: '🏭', severity: 'yellow',
      label: t(data.manufacturing.due_soon > 1 ? 'dashboard.productionDueSoon_plural' : 'dashboard.productionDueSoon', { count: data.manufacturing.due_soon }),
      onClick: () => navigate('/manufacturing') });
  }
  if (data.unread_announcements > 0) {
    chips.push({ icon: '📣', severity: 'blue',
      label: t(data.unread_announcements > 1 ? 'dashboard.unreadAnnouncementChip_plural' : 'dashboard.unreadAnnouncementChip', { count: data.unread_announcements }),
      count: data.unread_announcements, onClick: () => navigate('/announcements') });
  }

  // Which large sections to render?
  const showPrimaryFinance = can.finance || can.invoices;
  const showOpsToday       = can.pos || can.cash || can.manufacturing || can.hr || can.planning;
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
              <span style={{ fontSize: 13 }}>🔔</span>
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
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 10 }}>
            ⚡ {t('dashboard.needsAttention')}
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
          <span>✅</span>
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
            {can.finance && <KpiCard label={t('dashboard.monthlyRevenue')}  value={moneyCompact(income)}   sub={periodLabel}                          icon="💰" accentColor="var(--green)"  accentBg="var(--green-light)"  sparkData={incSpark}  onClick={() => navigate('/finance')} />}
            {can.finance && <KpiCard label={t('dashboard.monthlyExpenses')} value={moneyCompact(expenses)} sub={t('dashboard.operatingCosts')}          icon="📉" accentColor="var(--red)"    accentBg="var(--red-light)"    sparkData={expSpark}  onClick={() => navigate('/finance')} />}
            {can.finance && <KpiCard label={t('dashboard.netProfit')}       value={moneyCompact(profit)}   sub={t('dashboard.margin', { pct: margin })} icon={profit >= 0 ? '📈' : '⚠️'} accentColor={profit >= 0 ? 'var(--green)' : 'var(--red)'} accentBg={profit >= 0 ? 'var(--green-light)' : 'var(--red-light)'} sparkData={profSpark} onClick={() => navigate('/finance')} />}
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
                value={moneyCompact(data.pos.total || 0)}
                sub={t(data.pos.c === 1 ? 'dashboard.salesCount' : 'dashboard.salesCount_plural', { count: data.pos.c || 0 })}
                icon="🛍️" accentColor="var(--accent)" accentBg="var(--accent-light, var(--surface-2))"
                onClick={() => navigate('/pos')} />
            )}
            {can.cash && data.cash && (
              <KpiCard compact
                label={t('dashboard.cashDrawers')}
                value={`${data.cash.total_drawers}`}
                sub={data.cash.open_sessions > 0
                  ? t(data.cash.open_sessions === 1 ? 'dashboard.drawerOpen' : 'dashboard.drawerOpen_plural', { count: data.cash.open_sessions })
                  : t('dashboard.allClosed')}
                icon="💵"
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
                icon="🏭"
                accentColor={data.manufacturing.due_soon > 0 ? 'var(--yellow)' : 'var(--blue)'}
                accentBg={data.manufacturing.due_soon > 0 ? 'var(--yellow-light)' : 'var(--blue-light)'}
                onClick={() => navigate('/manufacturing')} />
            )}
            {can.hr && data.hr && (
              <KpiCard compact
                label={t('dashboard.onLeaveToday')}
                value={data.hr.on_leave}
                sub={t('dashboard.headcount', { count: data.hr.headcount })}
                icon="🌴" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/hr')} />
            )}
            {can.planning && data.planning && (
              <KpiCard compact
                label={t('dashboard.eventsToday')}
                value={data.planning.events_today}
                sub={data.planning.upcoming_milestones > 0
                  ? t(data.planning.upcoming_milestones === 1 ? 'dashboard.upcomingMilestones' : 'dashboard.upcomingMilestones_plural', { count: data.planning.upcoming_milestones })
                  : ''}
                icon="🗓️" accentColor="var(--blue)" accentBg="var(--blue-light)"
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
                value={moneyCompact(data.crm.pipeline_value)}
                sub={t(data.crm.pipeline_count === 1 ? 'dashboard.openDeals' : 'dashboard.openDeals_plural', { count: data.crm.pipeline_count })}
                icon="💼" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.crm && data.crm && (
              <KpiCard compact
                label={t('dashboard.wonThisMonth')}
                value={moneyCompact(data.crm.won_value)}
                sub={t(data.crm.won_count === 1 ? 'dashboard.openDeals' : 'dashboard.openDeals_plural', { count: data.crm.won_count })}
                icon="🏆" accentColor="var(--green)" accentBg="var(--green-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.crm && data.crm && (
              <KpiCard compact
                label={t('dashboard.newLeads')}
                value={data.crm.new_leads}
                sub={t('dashboard.leadsThisMonth')}
                icon="🎯" accentColor="var(--blue)" accentBg="var(--blue-light)"
                onClick={() => navigate('/crm')} />
            )}
            {can.recruitment && data.recruitment && (
              <KpiCard compact
                label={t('dashboard.openPositions')}
                value={data.recruitment.open_positions}
                sub={t(data.recruitment.active_applicants === 1 ? 'dashboard.activeApplicants' : 'dashboard.activeApplicants_plural', { count: data.recruitment.active_applicants })}
                icon="📢" accentColor="var(--accent)" accentBg="var(--surface-2)"
                onClick={() => navigate('/recruitment')} />
            )}
            {can.assets && data.assets && (
              <KpiCard compact
                label={t('dashboard.fixedAssetsBookValue')}
                value={moneyCompact(data.assets.book_value)}
                sub={t('dashboard.assetsBookValue', { count: data.assets.count })}
                icon="🏛️" accentColor="var(--text-2)" accentBg="var(--surface-2)"
                onClick={() => navigate('/fixed-assets')} />
            )}
            {data.warehouses && (
              /* Warehouse health — count of active locations + a single
                 "needs restock" call-out so the operator can see where to
                 act without filtering through Inventory. */
              <KpiCard compact
                label={t('dashboard.warehouses') || 'Warehouses'}
                value={data.warehouses.active}
                sub={
                  data.warehouses.lowest_low_count > 0
                    ? `⚠ ${data.warehouses.lowest_code}: ${data.warehouses.lowest_low_count} low`
                    : data.warehouses.in_transit > 0
                      ? `${data.warehouses.in_transit} in transit`
                      : t('dashboard.allClear') || 'All clear'
                }
                icon="🏬"
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
                value={moneyCompact(unpaidAmt)}
                sub={t('dashboard.outstanding', { count: data.unpaid_invoices_count ?? 0 })}
                icon="🧾"
                accentColor={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)'}
                accentBg={(data.unpaid_invoices_count ?? 0) > 0 ? 'var(--yellow-light)' : 'var(--green-light)'}
                onClick={() => navigate('/invoices')} />
            )}
            {can.invoices && (
              <KpiCard compact
                label={t('dashboard.overdueInvoices')}
                value={moneyCompact(overdueAmt)}
                sub={t('dashboard.pastDue', { count: overdueCount })}
                icon="⏰"
                accentColor={overdueCount > 0 ? 'var(--red)' : 'var(--green)'}
                accentBg={overdueCount > 0 ? 'var(--red-light)' : 'var(--green-light)'}
                onClick={() => navigate('/invoices')} />
            )}
            {can.projects && (
              <KpiCard compact label={t('dashboard.activeProjects')} value={data.active_projects ?? 0}
                icon="🏗" accentColor="var(--blue)" accentBg="var(--blue-light)"
                onClick={() => navigate('/projects')} />
            )}
            {can.quotes && (
              <KpiCard compact label={t('dashboard.pendingQuotes')} value={data.pending_quotes ?? 0}
                icon="📋" accentColor="var(--purple)" accentBg="var(--purple-light)"
                onClick={() => navigate('/quotations')} />
            )}
            {can.inventory && (
              <KpiCard compact label={t('dashboard.lowStockItems')} value={data.low_stock_alerts ?? 0}
                icon="📦"
                accentColor={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red)' : 'var(--green)'}
                accentBg={(data.low_stock_alerts ?? 0) > 0 ? 'var(--red-light)' : 'var(--green-light)'}
                onClick={() => navigate('/inventory')} />
            )}
            {can.finance && (
              <KpiCard compact label={t('dashboard.profitMargin')} value={`${margin}%`}
                icon="📊"
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
                {can.finance && margin > 20 && <Insight icon="✅" text={t('dashboard.strongMargin', { pct: margin })} color="var(--green)" onClick={() => navigate('/finance')} />}
                {can.finance && margin > 0 && margin <= 20 && <Insight icon="⚠️" text={t('dashboard.thinMargin', { pct: margin })} color="var(--yellow)" onClick={() => navigate('/finance')} />}
                {can.finance && margin < 0 && <Insight icon="🔴" text={t('dashboard.operatingLoss')} color="var(--red)" onClick={() => navigate('/finance')} />}
                {can.invoices && (data.unpaid_invoices_count ?? 0) > 0 && <Insight icon="📬" text={t(data.unpaid_invoices_count > 1 ? 'dashboard.unpaidInvoiceCount_plural' : 'dashboard.unpaidInvoiceCount', { count: data.unpaid_invoices_count })} color="var(--yellow)" onClick={() => navigate('/invoices')} />}
                {can.invoices && overdueCount > 0 && <Insight icon="⏰" text={t('dashboard.overdueAction', { count: overdueCount })} color="var(--red)" onClick={() => navigate('/invoices')} />}
                {can.inventory && (data.low_stock_alerts ?? 0) > 0 && <Insight icon="📦" text={t(data.low_stock_alerts > 1 ? 'dashboard.lowStockAlert_plural' : 'dashboard.lowStockAlert', { count: data.low_stock_alerts })} color="var(--red)" onClick={() => navigate('/inventory')} />}
                {can.projects && (data.active_projects ?? 0) > 0 && <Insight icon="🏗" text={t(data.active_projects > 1 ? 'dashboard.projectsInProgress_plural' : 'dashboard.projectsInProgress', { count: data.active_projects })} color="var(--blue)" onClick={() => navigate('/projects')} />}
                {can.quotes && (data.pending_quotes ?? 0) > 0 && <Insight icon="📋" text={t(data.pending_quotes > 1 ? 'dashboard.quotesAwaiting_plural' : 'dashboard.quotesAwaiting', { count: data.pending_quotes })} color="var(--purple)" onClick={() => navigate('/quotations')} />}
                {margin >= 0 && (data.unpaid_invoices_count ?? 0) === 0 && (data.low_stock_alerts ?? 0) === 0 && <Insight icon="✅" text={t('common.allNominal')} color="var(--green)" />}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Recent activity tables ─────────────────────────────────── */}
      {(can.projects || can.invoices) && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${can.projects && can.invoices ? 2 : 1}, 1fr)`, gap: 16, marginBottom: 16 }}>
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
          <div style={{ fontSize: 48, marginBottom: 16 }}>👋</div>
          <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{t('common.welcomeERP')}</p>
          <p style={{ fontSize: 13 }}>{t('common.dashboardPersonalized')}</p>
        </div>
      )}

      {/* Responsive overrides — collapse the side health-ring/insights to
          full width when viewport drops below ~900px so nothing wraps oddly. */}
      <style>{`
        @media (max-width: 900px) {
          .dash-finance-row, .dash-chart-row { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
