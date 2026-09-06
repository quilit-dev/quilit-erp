// Dashboard display primitives: period presets, sparkline/bar charts, the
// health ring, KPI cards, action chips, insights, and section titles.
import { useState } from 'react';
import { useMoney, Icon } from '../../components/shared';
import { useSettings } from '../../hooks/useSettings.jsx';
import { useLocale } from '../../hooks/useLocale.jsx';

// Resolve a period preset to a {start,end} ISO range. Kept tiny on purpose —
// three presets cover the common SMB needs without a date-picker.
export function periodRange(p) {
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

export function Sparkline({ data = [], color = 'var(--accent)', height = 32, width = 80 }) {
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

function chartMonthLabel(value, lang) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4})-(\d{1,2})/);
  if (!match) return raw.slice(0, 3);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA' : 'en-US', {
    month: 'short', timeZone: 'UTC',
  }).format(date);
}

export function BarChart({
  data = [],
  height = 180,
  incomeLabel = 'Revenue',
  expensesLabel = 'Expenses',
  emptyLabel = 'No data yet',
}) {
  const [hovered, setHovered] = useState(null);
  const { exchangeRate, displayCurrency } = useSettings();
  const { lang } = useLocale();
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
  if (!data.length) return <div className="dash-bar-empty" style={{ height }}>{emptyLabel}</div>;

  const rawMax = Math.max(...data.map(d => Math.max(d.income || 0, d.expenses || 0)), 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const normalized = rawMax / magnitude;
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const maxVal = niceFactor * magnitude;
  const levels = [1, 2 / 3, 1 / 3, 0];

  return (
    <div className="dash-bar-chart" style={{ '--dash-chart-height': `${height}px` }}
      role="group" aria-label={`${incomeLabel} / ${expensesLabel}`}>
      <div className="dash-bar-axis" aria-hidden="true">
        {levels.map(level => <span key={level}>{tick(maxVal * level)}</span>)}
      </div>
      <div className="dash-bar-grid" aria-hidden="true">
        {levels.map(level => <span key={level} />)}
      </div>
      <div className="dash-bar-plot">
        {data.map((d, i) => {
          const income = Math.max(0, Number(d.income) || 0);
          const expenses = Math.max(0, Number(d.expenses) || 0);
          const incPct = (income / maxVal) * 100;
          const expPct = (expenses / maxVal) * 100;
          const isHov = hovered === i;
          const month = d.month ? chartMonthLabel(d.month, lang) : `M${i + 1}`;
          return (
            <div key={i} className={`dash-bar-group${isHov ? ' is-active' : ''}`}
              role="group"
              tabIndex="0"
              aria-label={`${month}. ${incomeLabel}: ${money(income)}. ${expensesLabel}: ${money(expenses)}.`}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)} onBlur={() => setHovered(null)}>
              {isHov && (
                <div className="dash-bar-tooltip" role="tooltip">
                  <strong>{month}</strong>
                  <span><i className="is-income" />{incomeLabel}<b>{money(income)}</b></span>
                  <span><i className="is-expense" />{expensesLabel}<b>{money(expenses)}</b></span>
                </div>
              )}
              <div className="dash-bar-pair" aria-hidden="true">
                <span className="dash-bar is-income" style={{ height: `${incPct}%`, minHeight: incPct > 0 ? 4 : 0 }} />
                <span className="dash-bar is-expense" style={{ height: `${expPct}%`, minHeight: expPct > 0 ? 4 : 0 }} />
              </div>
              <span className="dash-bar-month" aria-hidden="true">{month}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HealthRing({ score = 0, t }) {
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
export function KpiCard({ label, value, sub, icon, accentColor, accentBg, sparkData, trend, onClick, compact = false }) {
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
            lineHeight: 1,
            color: accentColor || 'var(--text-3)',
            opacity: 0.85,
          }}><Icon name={icon} size={15} /></span>
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
export function ActionChip({ icon, label, count, severity = 'yellow', onClick }) {
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
        <span style={{ opacity: 0.85, lineHeight: 1, display: 'inline-flex' }}><Icon name={icon} size={13} /></span>
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

export function Insight({ icon, text, color, onClick }) {
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
      <div style={{ width: 20, height: 20, borderRadius: 5, background: color + '20', color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={icon} size={12} /></div>
      <span style={{ color: 'var(--text-2)', flex: 1 }}>{text}</span>
      {clickable && (
        <span style={{ fontSize: 11, color: 'var(--text-3)', opacity: hover ? 1 : 0, transition: 'opacity .15s' }}>→</span>
      )}
    </div>
  );
}

// Small reusable section heading — uppercase eyebrow, optional right slot.
export function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '20px 0 10px' }}>
      <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.8px', margin: 0 }}>{children}</h2>
      {right}
    </div>
  );
}
