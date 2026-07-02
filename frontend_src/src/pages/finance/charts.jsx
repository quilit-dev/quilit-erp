import { useState, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { DisplayCurrencyToggle, Icon } from '../../components/shared';

function toISO(d) { return d.toISOString().slice(0, 10); }

function getRange(preset, custom) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (preset) {
    case 'month': {
      const s = new Date(y, m, 1), e = new Date(y, m + 1, 0);
      const ps = new Date(y, m - 1, 1), pe = new Date(y, m, 0);
      return { start: toISO(s), end: toISO(e), prevStart: toISO(ps), prevEnd: toISO(pe) };
    }
    case '3months': {
      const s = new Date(y, m - 2, 1), e = new Date(y, m + 1, 0);
      const ps = new Date(y, m - 5, 1), pe = new Date(y, m - 2, 0);
      return { start: toISO(s), end: toISO(e), prevStart: toISO(ps), prevEnd: toISO(pe) };
    }
    case 'year': {
      const s = new Date(y, 0, 1), e = new Date(y, 11, 31);
      const ps = new Date(y - 1, 0, 1), pe = new Date(y - 1, 11, 31);
      return { start: toISO(s), end: toISO(e), prevStart: toISO(ps), prevEnd: toISO(pe) };
    }
    case 'custom':
      return { start: custom.start, end: custom.end, prevStart: null, prevEnd: null };
    default:
      return getRange('month', custom);
  }
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [y, mo] = ym.split('-');
  return new Date(+y, +mo - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
}

const CHART_COLORS = [
  '#1B4F72', '#2E86C1', '#27AE60', '#E67E22', '#8E44AD',
  '#C0392B', '#16A085', '#F39C12', '#2C3E50', '#7F8C8D',
];

// ── Shared chart helpers ──────────────────────────────────────────────────

function useContainerWidth(fallback = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(ref.current);
    setWidth(Math.floor(ref.current.getBoundingClientRect().width) || fallback);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(rawMax) {
  if (rawMax <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

// Abbreviated money for chart axes/tooltips, currency-aware via the page-header
// DisplayCurrencyToggle. Stored amounts are USD; when LBP is selected we scale
// by the manual rate and drop the symbol (the toggle + tooltip convey the unit)
// so the compact k/M/B labels still fit the narrow axis gutters.
function useAbbr() {
  const { exchangeRate, displayCurrency } = useSettings();
  const lbp  = displayCurrency === 'LBP' && exchangeRate?.rate;
  const rate = lbp ? exchangeRate.rate : 1;
  return (v) => {
    const x = (Number(v) || 0) * rate;
    const abs = Math.abs(x);
    const sign = x < 0 ? '-' : '';
    const sym = lbp ? '' : '$';
    if (abs >= 1_000_000_000) return `${sign}${sym}${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000)     return `${sign}${sym}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)         return `${sign}${sym}${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    return `${sign}${sym}${abs.toFixed(0)}`;
  };
}

// Floating HTML tooltip anchored to cursor/point — never clips SVG
function ChartTooltip({ children, anchorX, anchorY, svgWidth, visible }) {
  if (!visible) return null;
  // Flip to left half if anchor is in right 40% of chart
  const flipLeft = anchorX > svgWidth * 0.6;
  return (
    <foreignObject
      x={flipLeft ? anchorX - 148 : anchorX + 8}
      y={Math.max(4, anchorY - 48)}
      width={140} height={80}
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      <div style={{
        background: 'rgba(17,24,39,0.94)', color: '#fff',
        borderRadius: 8, padding: '7px 11px',
        fontSize: 11.5, lineHeight: 1.6,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        width: 'max-content', maxWidth: 160,
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        {children}
      </div>
    </foreignObject>
  );
}

// ── Line Chart ────────────────────────────────────────────────────────────
function FinanceLineChart({ data }) {
  const { t } = useLocale();
  const abbr = useAbbr();
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(640);

  if (!data || data.length === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.incomeVsExpenses')} /></div>;

  // Dynamic padding: wider left when numbers are larger
  const allVals = data.flatMap(d => [d.income, d.expenses]);
  const rawMax = Math.max(...allVals, 1);
  const maxV = niceMax(rawMax);
  const yLabelWidth = abbr(maxV).length * 7 + 10; // ~7px per char
  const PL = Math.max(52, yLabelWidth);
  const PR = 16, PT = 18, PB = 38;
  // Responsive height: taller when fewer points, compact with many
  const H = data.length <= 6 ? 230 : data.length <= 12 ? 210 : 195;
  const iW = W - PL - PR, iH = H - PT - PB;

  const xStep = iW / Math.max(data.length - 1, 1);
  const yScale = v => iH - (v / maxV) * iH;
  const pts = key => data.map((d, i) => [PL + i * xStep, PT + yScale(d[key])]);
  const toPath = points => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const incPts = pts('income'), expPts = pts('expenses');

  // Smart tick count based on height
  const tickCount = H > 220 ? 5 : 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => maxV * (i / (tickCount - 1)));

  // X-label skip logic: skip labels when bars are dense
  const showLabel = (i) => {
    if (data.length <= 12) return true;
    if (data.length <= 18) return i % 2 === 0;
    return i % 3 === 0;
  };

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W} height={H}
        style={{ display: 'block', fontFamily: 'inherit', overflow: 'visible', cursor: 'crosshair' }}
      >
        <defs>
          <linearGradient id="incGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1B4F72" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1B4F72" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="expGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#DC2626" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#DC2626" stopOpacity="0" />
          </linearGradient>
          <clipPath id="chartClip">
            <rect x={PL} y={PT} width={iW} height={iH} />
          </clipPath>
        </defs>

        {/* Grid lines + Y labels */}
        {yTicks.map((v, i) => {
          const y = PT + yScale(v);
          return (
            <g key={i}>
              <line x1={PL} y1={y} x2={W - PR} y2={y}
                stroke="#E5E7EB" strokeWidth={i === 0 ? 1.5 : 1}
                strokeDasharray={i === 0 ? '0' : '4,4'} />
              <text x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#9CA3AF">
                {abbr(v)}
              </text>
            </g>
          );
        })}

        {/* X labels */}
        {data.map((d, i) => showLabel(i) && (
          <text key={i}
            x={PL + i * xStep} y={H - 8}
            textAnchor="middle" fontSize="10"
            fill={hovered === i ? '#1B4F72' : '#9CA3AF'}
            fontWeight={hovered === i ? '700' : '400'}
          >
            {fmtMonth(d.month)}
          </text>
        ))}

        {/* Hover crosshair */}
        {hovered !== null && (
          <line
            x1={PL + hovered * xStep} y1={PT}
            x2={PL + hovered * xStep} y2={PT + iH}
            stroke="#6B7280" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"
          />
        )}

        {/* Area fills — clipped */}
        <g clipPath="url(#chartClip)">
          <path d={`${toPath(incPts)} L ${incPts[incPts.length-1][0]} ${PT+iH} L ${PL} ${PT+iH} Z`} fill="url(#incGrad)" />
          <path d={`${toPath(expPts)} L ${expPts[expPts.length-1][0]} ${PT+iH} L ${PL} ${PT+iH} Z`} fill="url(#expGrad)" />
          <path d={toPath(incPts)} fill="none" stroke="#1B4F72" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          <path d={toPath(expPts)} fill="none" stroke="#DC2626" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5,3" />
        </g>

        {/* Dots + hover zones */}
        {data.map((d, i) => {
          const ix = incPts[i][0], iy = incPts[i][1];
          const ex = expPts[i][0], ey = expPts[i][1];
          const isH = hovered === i;
          const zoneW = xStep || 20;
          return (
            <g key={i}>
              <circle cx={ix} cy={iy} r={isH ? 5.5 : 3.5} fill="#1B4F72" stroke="#fff" strokeWidth="2" />
              <circle cx={ex} cy={ey} r={isH ? 4.5 : 3} fill="#DC2626" stroke="#fff" strokeWidth="2" />
              {isH && (
                <ChartTooltip anchorX={ix} anchorY={Math.min(iy, ey)} svgWidth={W} visible>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{fmtMonth(d.month)}</div>
                  <div style={{ color: '#6EE7B7' }}>▲ {t('finance.income')}: {abbr(d.income)}</div>
                  <div style={{ color: '#FCA5A5' }}>▼ {t('finance.expenses')}: {abbr(d.expenses)}</div>
                  <div style={{ color: d.profit >= 0 ? '#6EE7B7' : '#FCA5A5', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 3, paddingTop: 3, fontWeight: 700 }}>
                    {d.profit >= 0 ? '▲' : '▼'} {t('finance.profit')}: {abbr(d.profit)}
                  </div>
                </ChartTooltip>
              )}
              {/* Invisible hover zone */}
              <rect
                x={PL + i * xStep - zoneW / 2} y={PT}
                width={zoneW} height={iH}
                fill="transparent" style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 2.5, background: '#1B4F72', borderRadius: 2, display: 'inline-block' }} /> {t('finance.income')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 2, background: '#DC2626', borderRadius: 2, display: 'inline-block' }} /> {t('finance.expenses')}
        </span>
      </div>
    </div>
  );
}

// ── Bar Chart ─────────────────────────────────────────────────────────────
function ProfitBarChart({ data }) {
  const { t } = useLocale();
  const abbr = useAbbr();
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(420);

  if (!data || data.length === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.monthlyProfit')} /></div>;

  const hasNeg = data.some(d => d.profit < 0);
  const maxPos = Math.max(...data.map(d => d.profit), 0);
  const maxNeg = Math.max(...data.map(d => -d.profit), 0);
  const rawMax = Math.max(maxPos, maxNeg, 1);
  const maxV = niceMax(rawMax);

  const yLabelWidth = abbr(maxV).length * 7 + 10;
  const PL = Math.max(52, yLabelWidth);
  const PR = 16, PT = 18, PB = 36;
  const H = 210;
  const iW = W - PL - PR, iH = H - PT - PB;

  // Zero line position: center if we have negatives, bottom if all positive
  const zeroY = PT + iH * (hasNeg ? maxV / (2 * maxV) : 1);
  const posH = zeroY - PT;
  const negH = PT + iH - zeroY;

  const barSlot = iW / data.length;
  const barW = Math.min(Math.max(barSlot * 0.55, 6), 48);

  const showLabel = (i) => {
    if (data.length <= 12) return true;
    if (data.length <= 18) return i % 2 === 0;
    return i % 3 === 0;
  };

  // Y ticks: symmetric around zero
  const posTicks = [0.5, 1].map(f => f * maxV);
  const negTicks = hasNeg ? [-0.5, -1].map(f => f * maxV) : [];
  const allTicks = [...negTicks.reverse(), 0, ...posTicks];

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W} height={H}
        style={{ display: 'block', fontFamily: 'inherit', overflow: 'visible' }}
      >
        <defs>
          <clipPath id="barClip">
            <rect x={PL} y={PT} width={iW} height={iH} />
          </clipPath>
        </defs>

        {/* Grid + Y labels */}
        {allTicks.map((v, i) => {
          const y = v >= 0
            ? zeroY - (v / maxV) * posH
            : zeroY + ((-v) / maxV) * negH;
          return (
            <g key={i}>
              <line x1={PL} y1={y} x2={W - PR} y2={y}
                stroke={v === 0 ? '#D1D5DB' : '#E5E7EB'}
                strokeWidth={v === 0 ? 1.5 : 1}
                strokeDasharray={v === 0 ? '0' : '3,3'}
              />
              <text x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#9CA3AF">
                {abbr(v)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        <g clipPath="url(#barClip)">
          {data.map((d, i) => {
            const cx = PL + (i + 0.5) * barSlot;
            const pos = d.profit >= 0;
            const bh = Math.max((Math.abs(d.profit) / maxV) * (pos ? posH : negH), 2);
            const by = pos ? zeroY - bh : zeroY;
            const isH = hovered === i;
            return (
              <rect key={i}
                x={cx - barW / 2} y={by}
                width={barW} height={bh}
                fill={pos ? '#059669' : '#DC2626'}
                rx="3"
                opacity={isH ? 1 : 0.78}
                style={{ transition: 'opacity .15s' }}
              />
            );
          })}
        </g>

        {/* X labels + hover zones + tooltips */}
        {data.map((d, i) => {
          const cx = PL + (i + 0.5) * barSlot;
          const isH = hovered === i;
          const pos = d.profit >= 0;
          const bh = Math.max((Math.abs(d.profit) / maxV) * (pos ? posH : negH), 2);
          const by = pos ? zeroY - bh : zeroY;
          return (
            <g key={i}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer' }}
            >
              {showLabel(i) && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize="10"
                  fill={isH ? '#1B4F72' : '#9CA3AF'}
                  fontWeight={isH ? '700' : '400'}
                >
                  {fmtMonth(d.month)}
                </text>
              )}
              {isH && (
                <ChartTooltip anchorX={cx} anchorY={pos ? by : zeroY} svgWidth={W} visible>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{fmtMonth(d.month)}</div>
                  <div style={{ color: pos ? '#6EE7B7' : '#FCA5A5', fontWeight: 700 }}>
                    {pos ? '▲' : '▼'} {abbr(d.profit)}
                  </div>
                  <div style={{ color: '#9CA3AF', fontSize: 10.5 }}>
                    {d.income > 0 ? `${t('finance.margin')}: ${((d.profit/d.income)*100).toFixed(1)}%` : ''}
                  </div>
                </ChartTooltip>
              )}
              {/* Wide hover zone for easy targeting */}
              <rect x={cx - barSlot / 2} y={PT} width={barSlot} height={iH}
                fill="transparent" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Donut Chart ───────────────────────────────────────────────────────────
function DonutChart({ data }) {
  const { t } = useLocale();
  const abbr = useAbbr();
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(420);

  if (!data || data.length === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.expenseBreakdown')} /></div>;
  const total = data.reduce((s, d) => s + d.total, 0);
  if (total === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.expenses')} /></div>;

  // Responsive: stack vertically on narrow containers
  const stacked = W < 340;
  const donutSize = Math.min(180, stacked ? W - 16 : W * 0.42);
  const cx = donutSize / 2, cy = donutSize / 2;
  const r = donutSize * 0.42, ir = donutSize * 0.24;

  let angle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const pct = d.total / total;
    const startA = angle;
    angle += pct * 2 * Math.PI;
    const endA = angle;
    const [x1, y1] = [cx + r * Math.cos(startA), cy + r * Math.sin(startA)];
    const [x2, y2] = [cx + r * Math.cos(endA), cy + r * Math.sin(endA)];
    const [xi1, yi1] = [cx + ir * Math.cos(startA), cy + ir * Math.sin(startA)];
    const [xi2, yi2] = [cx + ir * Math.cos(endA), cy + ir * Math.sin(endA)];
    const large = pct > 0.5 ? 1 : 0;
    const midA = startA + (endA - startA) / 2;
    const path = `M ${xi1} ${yi1} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${ir} ${ir} 0 ${large} 0 ${xi1} ${yi1} Z`;
    return { ...d, path, color: CHART_COLORS[i % CHART_COLORS.length], pct, midA };
  });

  const active = hovered !== null ? slices[hovered] : null;

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', gap: 20, alignItems: stacked ? 'center' : 'flex-start' }}>
      {/* Donut SVG */}
      <div style={{ flexShrink: 0 }}>
        <svg viewBox={`0 0 ${donutSize} ${donutSize}`} width={donutSize} height={donutSize} style={{ display: 'block', cursor: 'pointer', overflow: 'visible' }}>
          {slices.map((s, i) => {
            const isH = hovered === i;
            // Expand hovered slice outward
            const dx = (isH ? 6 : 0) * Math.cos(s.midA);
            const dy = (isH ? 6 : 0) * Math.sin(s.midA);
            return (
              <path key={i} d={s.path} fill={s.color}
                stroke="#fff" strokeWidth={isH ? 2.5 : 1.5}
                opacity={hovered !== null && !isH ? 0.45 : 0.92}
                transform={isH ? `translate(${dx.toFixed(2)}, ${dy.toFixed(2)})` : ''}
                style={{ transition: 'opacity .2s, transform .2s', cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            );
          })}
          {/* Center label */}
          {active ? (
            <>
              <text x={cx} y={cy - 9} textAnchor="middle" fontSize={Math.max(8, donutSize * 0.055)} fill="#6B7280">{active.category.length > 10 ? active.category.slice(0,10)+'…' : active.category}</text>
              <text x={cx} y={cy + 7} textAnchor="middle" fontSize={Math.max(11, donutSize * 0.08)} fontWeight="800" fill={active.color}>{abbr(active.total)}</text>
              <text x={cx} y={cy + 21} textAnchor="middle" fontSize={Math.max(8, donutSize * 0.055)} fill="#9CA3AF">{(active.pct * 100).toFixed(1)}%</text>
            </>
          ) : (
            <>
              <text x={cx} y={cy - 7} textAnchor="middle" fontSize={Math.max(9, donutSize * 0.065)} fill="#6B7280">{t('common.total')}</text>
              <text x={cx} y={cy + 10} textAnchor="middle" fontSize={Math.max(12, donutSize * 0.09)} fontWeight="800" fill="#111827">{abbr(total)}</text>
            </>
          )}
        </svg>
      </div>

      {/* Legend */}
      <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
        {slices.map((s, i) => (
          <div key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7,
              padding: '5px 8px', borderRadius: 7, cursor: 'pointer',
              background: hovered === i ? 'var(--surface-2)' : 'transparent',
              transition: 'background .15s, opacity .15s',
              opacity: hovered !== null && hovered !== i ? 0.4 : 1,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.category}</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 6, flexShrink: 0 }}>{(s.pct * 100).toFixed(0)}%</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>{abbr(s.total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyChartPlaceholder({ label }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-3)' }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 8px', display: 'block', opacity: 0.4 }}>
        <path d="M3 3v18h18M9 9l4 4 4-4" />
      </svg>
      <p style={{ fontSize: 13 }}>No data for {label}</p>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────
//
// Workspace-aligned tile (matches the Dashboard pattern):
//   • Soft white surface with subtle drop shadow (from .stat-card in
//     index.css). Hover steps the shadow up; no transform lift.
//   • Tiny restrained icon top-left, semantic trend pill top-right.
//   • Uppercase letter-spaced label, then Inter 700 hero value, then a
//     plain Inter slate caption underneath.
//
// `color` is kept as a prop for callers but only tints the hero value —
// the surface, shadow, border and trend semantics all come from the
// Workspace tokens. No more inline borderTop stripe, no more hardcoded
// Material colours.
function KpiCard({ label, value, change, color, icon, sub }) {
  const { t } = useLocale();
  const neutral = change === null || change === undefined;
  const isUp = change > 0;

  return (
    <div className="stat-card" style={{ cursor: 'default' }}>
      {/* Top row — mark + trend */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 6, minHeight: 18,
      }}>
        {icon ? (
          <span style={{
            lineHeight: 1,
            color: color || 'var(--text-3)',
            opacity: 0.7,
          }}><Icon name={icon} size={15} /></span>
        ) : <span />}

        {!neutral && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0,
            color: isUp ? 'var(--affirm)' : 'var(--negate)',
            background: isUp ? 'var(--affirm-tint)' : 'var(--negate-tint)',
            padding: '2px 7px',
            borderRadius: 'var(--r-xs)',
            border: `1px solid ${isUp ? 'rgba(31,163,98,0.22)' : 'rgba(209,69,69,0.22)'}`,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}>
            {isUp ? '▲' : '▼'} {Math.abs(change)}%
            <span style={{
              marginInlineStart: 4, opacity: 0.7, fontWeight: 500,
            }}>
              {t('finance.vsPrev')}
            </span>
          </span>
        )}
      </div>

      {/* Label */}
      <div className="stat-label">{label}</div>

      {/* Hero value — uses .stat-value so it inherits Inter 700 + tabular
          tracking from the Workspace token. The colour prop tints only
          the value glyph; everything else is system-driven. */}
      <div className="stat-value" style={{ color: color || 'var(--text)', marginTop: 2 }}>
        {value}
      </div>

      {/* Caption */}
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
    </div>
  );
}

// ── Smart Insights Engine ─────────────────────────────────────────────────
//
// Generates rich, prioritized, actionable insights from the financial data
// the operator is currently looking at, PLUS the cross-module state that
// affects financial health (period locks, recurring run-rate, cash variance,
// FX exposure, A/R aging, fiscal-year closing). Every branch is defensive —
// missing inputs simply skip that branch instead of crashing the panel.
// 100 % offline arithmetic; no LLM, no third-party call.
//
// `extras` is opaque: each top-level key is optional and matches what the
// Finance page can fetch in parallel after the main P&L loads. The current
// keys are:
//
//   • periods       — /api/finance/periods         (24-month lock window)
//   • recurring     — /api/recurring-expenses      (templates with due_count)
//   • cashRecs      — /api/cash/reconciliations    (recent shift closes)
//   • fxRate        — /api/settings/exchange-rate  (latest rate + age)
//   • overdueAr     — /api/invoices?overdue=true   (open + overdue receivables)
//   • fiscalYears   — /api/accounting/fiscal-years (open / closed status)
//
// `fmtK` is the abbreviated money formatter for insight copy. It's injected by
// the caller (the page passes a currency-aware abbreviator that honours the
// DisplayCurrencyToggle); the default keeps a USD fallback for any caller that
// doesn't pass one.

export {
  toISO, getRange, fmtMonth, CHART_COLORS, useContainerWidth, niceMax, useAbbr,
  ChartTooltip, FinanceLineChart, ProfitBarChart, DonutChart, EmptyChartPlaceholder, KpiCard,
};
