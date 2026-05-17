import { useState, useEffect, useRef, useCallback } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { getFinanceRangeSummary, getFinanceRangeMonthly, getFinanceRangeDetail, getReconciliation, getFinancePeriods, lockPeriod, unlockPeriod } from '../api/client';
import { LoadingSpinner, ErrorAlert, fmt } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import * as XLSX from 'xlsx';

// ── Date helpers ──────────────────────────────────────────────────────────
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

function fmtAbbr(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
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
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(640);

  if (!data || data.length === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.incomeVsExpenses')} /></div>;

  // Dynamic padding: wider left when numbers are larger
  const allVals = data.flatMap(d => [d.income, d.expenses]);
  const rawMax = Math.max(...allVals, 1);
  const maxV = niceMax(rawMax);
  const yLabelWidth = fmtAbbr(maxV).length * 7 + 10; // ~7px per char
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
                {fmtAbbr(v)}
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
                  <div style={{ color: '#6EE7B7' }}>▲ {t('finance.income')}: {fmtAbbr(d.income)}</div>
                  <div style={{ color: '#FCA5A5' }}>▼ {t('finance.expenses')}: {fmtAbbr(d.expenses)}</div>
                  <div style={{ color: d.profit >= 0 ? '#6EE7B7' : '#FCA5A5', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 3, paddingTop: 3, fontWeight: 700 }}>
                    {d.profit >= 0 ? '▲' : '▼'} {t('finance.profit')}: {fmtAbbr(d.profit)}
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
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(420);

  if (!data || data.length === 0) return <div ref={containerRef}><EmptyChartPlaceholder label={t('finance.monthlyProfit')} /></div>;

  const hasNeg = data.some(d => d.profit < 0);
  const maxPos = Math.max(...data.map(d => d.profit), 0);
  const maxNeg = Math.max(...data.map(d => -d.profit), 0);
  const rawMax = Math.max(maxPos, maxNeg, 1);
  const maxV = niceMax(rawMax);

  const yLabelWidth = fmtAbbr(maxV).length * 7 + 10;
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
                {fmtAbbr(v)}
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
                    {pos ? '▲' : '▼'} {fmtAbbr(d.profit)}
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
              <text x={cx} y={cy + 7} textAnchor="middle" fontSize={Math.max(11, donutSize * 0.08)} fontWeight="800" fill={active.color}>{fmtAbbr(active.total)}</text>
              <text x={cx} y={cy + 21} textAnchor="middle" fontSize={Math.max(8, donutSize * 0.055)} fill="#9CA3AF">{(active.pct * 100).toFixed(1)}%</text>
            </>
          ) : (
            <>
              <text x={cx} y={cy - 7} textAnchor="middle" fontSize={Math.max(9, donutSize * 0.065)} fill="#6B7280">{t('common.total')}</text>
              <text x={cx} y={cy + 10} textAnchor="middle" fontSize={Math.max(12, donutSize * 0.09)} fontWeight="800" fill="#111827">{fmtAbbr(total)}</text>
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
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>{fmtAbbr(s.total)}</span>
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
function KpiCard({ label, value, change, color, icon, sub }) {
  const { t } = useLocale();
  const [hover, setHover] = useState(false);
  const neutral = change === null || change === undefined;
  const isUp = change > 0;

  return (
    <div className="stat-card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', overflow: 'hidden',
        borderTop: `3px solid ${color}`,
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.1)' : 'var(--shadow)',
        transition: 'transform .2s, box-shadow .2s',
        cursor: 'default',
      }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
        <span style={{ fontSize: 20, opacity: hover ? 0.3 : 0.15, transition: 'opacity .2s' }}>{icon}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color, margin: '10px 0 4px', letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>{sub}</div>}
      {!neutral && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
          color: isUp ? '#059669' : '#DC2626',
          background: isUp ? '#ECFDF5' : '#FEF2F2',
          borderRadius: 20, padding: '2px 8px',
        }}>
          {isUp ? '▲' : '▼'} {Math.abs(change)}% {t('finance.vsPrev')}
        </div>
      )}
    </div>
  );
}

// ── Smart Insights Engine ─────────────────────────────────────────────────
// Generates rich, prioritized, actionable insights from financial data.
// 100% offline — pure arithmetic on the data you already have.
function generateInsights(summary, monthly) {
  const insights = [];
  if (!summary) return insights;

  const { income, expenses, profit, margin, by_category, prev } = summary;
  const fmtK = v => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.abs(v).toFixed(0)}`;

  // ── 1. Profit trend vs prior period ──────────────────────────────────
  if (prev?.profit_change != null) {
    const ch = prev.profit_change;
    if (ch > 0) {
      insights.push({
        id: 'profit-up', priority: 1, type: 'positive',
        icon: '📈', category: 'Trend',
        title: `Profit up ${ch}% vs last period`,
        detail: `You made ${fmtK(profit - (prev.profit || 0))} more than the previous period. Keep momentum.`,
        action: null,
      });
    } else {
      insights.push({
        id: 'profit-down', priority: 1, type: 'critical',
        icon: '📉', category: 'Trend',
        title: `Profit down ${Math.abs(ch)}% vs last period`,
        detail: `${fmtK(Math.abs(profit - (prev.profit || 0)))} less than the previous period.`,
        action: 'Review expense categories below to find where costs grew.',
      });
    }
  }

  // ── 2. Revenue trend ─────────────────────────────────────────────────
  if (prev?.income_change != null) {
    const ch = prev.income_change;
    if (ch > 15) {
      insights.push({
        id: 'rev-surge', priority: 2, type: 'positive',
        icon: '🚀', category: 'Revenue',
        title: `Revenue surge: +${ch}%`,
        detail: `Strong growth of ${fmtK(income - (prev.income || 0))} over the prior period.`,
        action: 'Identify what drove the spike — replicate it.',
      });
    } else if (ch < -10) {
      insights.push({
        id: 'rev-drop', priority: 1, type: 'critical',
        icon: '⚠️', category: 'Revenue',
        title: `Revenue dropped ${Math.abs(ch)}%`,
        detail: `Income fell by ${fmtK(Math.abs(income - (prev.income || 0)))} since last period.`,
        action: 'Check for delayed invoices or lost recurring clients.',
      });
    }
  }

  // ── 3. Expense trend ─────────────────────────────────────────────────
  if (prev?.expenses_change != null) {
    const ch = prev.expenses_change;
    if (ch > 20 && income > 0) {
      insights.push({
        id: 'exp-spike', priority: 2, type: 'warning',
        icon: '🧾', category: 'Expenses',
        title: `Expenses jumped ${ch}%`,
        detail: `Costs rose ${fmtK(expenses - (prev.expenses || 0))} vs last period.`,
        action: `Largest category is "${by_category?.[0]?.category}" — review for one-time vs recurring costs.`,
      });
    } else if (ch < -10) {
      insights.push({
        id: 'exp-down', priority: 3, type: 'positive',
        icon: '✂️', category: 'Expenses',
        title: `Expenses cut ${Math.abs(ch)}%`,
        detail: `You saved ${fmtK(Math.abs(expenses - (prev.expenses || 0)))} compared to the prior period.`,
        action: null,
      });
    }
  }

  // ── 4. Profit margin health ───────────────────────────────────────────
  if (income > 0 && margin != null) {
    const m = typeof margin === 'number' ? margin : parseFloat(margin);
    if (m >= 40) {
      insights.push({
        id: 'margin-excellent', priority: 3, type: 'positive',
        icon: '🏆', category: 'Margin',
        title: `${m.toFixed(1)}% margin — excellent`,
        detail: 'You keep more than $0.40 of every dollar earned. Strong financial health.',
        action: null,
      });
    } else if (m >= 20) {
      insights.push({
        id: 'margin-healthy', priority: 4, type: 'neutral',
        icon: '📊', category: 'Margin',
        title: `${m.toFixed(1)}% profit margin`,
        detail: 'Healthy, but room to grow. Cutting your top expense category by 10% could push margin above 25%.',
        action: null,
      });
    } else if (m > 0) {
      insights.push({
        id: 'margin-thin', priority: 2, type: 'warning',
        icon: '⚡', category: 'Margin',
        title: `Thin margin: ${m.toFixed(1)}%`,
        detail: 'Less than $0.20 profit per dollar earned. A small dip in revenue could turn unprofitable.',
        action: 'Focus on either raising rates or cutting the top 2 expense categories.',
      });
    } else {
      insights.push({
        id: 'margin-loss', priority: 1, type: 'critical',
        icon: '🔴', category: 'Margin',
        title: 'Operating at a loss this period',
        detail: `Expenses exceed income by ${fmtK(Math.abs(profit))}.`,
        action: 'Immediate review needed. Are any expenses one-time or avoidable?',
      });
    }
  }

  // ── 5. Expense concentration risk ────────────────────────────────────
  if (by_category?.length > 0 && expenses > 0) {
    const top = by_category[0];
    const topPct = Math.round((top.total / expenses) * 100);
    if (topPct >= 50) {
      insights.push({
        id: 'exp-concentration', priority: 2, type: 'warning',
        icon: '🎯', category: 'Expenses',
        title: `${top.category} is ${topPct}% of all costs`,
        detail: `Heavy concentration in one category creates cost risk. ${fmtK(top.total)} spent here.`,
        action: 'Can any of this be renegotiated, deferred, or split across periods?',
      });
    }
    // Top 2 categories dominance
    if (by_category.length >= 2) {
      const top2 = by_category[0].total + by_category[1].total;
      const top2Pct = Math.round((top2 / expenses) * 100);
      if (top2Pct >= 70 && topPct < 50) {
        insights.push({
          id: 'exp-top2', priority: 3, type: 'neutral',
          icon: '📦', category: 'Expenses',
          title: `Top 2 categories = ${top2Pct}% of spend`,
          detail: `"${by_category[0].category}" and "${by_category[1].category}" dominate your cost structure.`,
          action: 'Diversifying spend or reducing these reduces total risk.',
        });
      }
    }
  }

  // ── 6. Monthly trend analysis ─────────────────────────────────────────
  if (monthly?.length >= 3) {
    const recent = monthly.slice(-3);
    const incomeSlope = recent[2].income - recent[0].income;
    const expenseSlope = recent[2].expenses - recent[0].expenses;

    // Scissors pattern: expenses rising faster than income
    if (expenseSlope > 0 && incomeSlope < expenseSlope && expenses > 0) {
      insights.push({
        id: 'scissors', priority: 2, type: 'warning',
        icon: '✂️', category: 'Trend',
        title: 'Costs growing faster than revenue',
        detail: 'Over the last 3 months, expenses are rising faster than income — a "scissors" pattern that compresses margin.',
        action: 'Freeze non-essential spending until revenue catches up.',
      });
    }

    // Consistent profitability streak
    const streak = (() => {
      let s = 0;
      for (let i = monthly.length - 1; i >= 0; i--) {
        if (monthly[i].profit > 0) s++; else break;
      }
      return s;
    })();
    if (streak >= 3) {
      insights.push({
        id: 'streak', priority: 4, type: 'positive',
        icon: '🔥', category: 'Trend',
        title: `${streak}-month profit streak`,
        detail: `${streak} consecutive profitable months. Consistent execution.`,
        action: null,
      });
    }

    // Best and worst months
    const best = monthly.reduce((a, b) => b.profit > a.profit ? b : a);
    const worst = monthly.reduce((a, b) => b.profit < a.profit ? b : a);
    if (monthly.length >= 2) {
      insights.push({
        id: 'best-month', priority: 5, type: 'positive',
        icon: '🏅', category: 'Performance',
        title: `Best month: ${fmtMonth(best.month)}`,
        detail: `${fmtK(best.profit)} net profit — your peak this period.`,
        action: null,
      });
    }
    if (worst.profit < 0) {
      insights.push({
        id: 'worst-month', priority: 3, type: 'warning',
        icon: '📅', category: 'Performance',
        title: `${fmtMonth(worst.month)} was a loss month`,
        detail: `${fmtK(Math.abs(worst.profit))} deficit. Was this seasonal or a one-time event?`,
        action: null,
      });
    }

    // Income volatility
    const incomes = monthly.map(m => m.income);
    const avgInc = incomes.reduce((a, b) => a + b, 0) / incomes.length;
    const stdInc = Math.sqrt(incomes.reduce((s, v) => s + Math.pow(v - avgInc, 2), 0) / incomes.length);
    const cvInc = avgInc > 0 ? (stdInc / avgInc) * 100 : 0;
    if (cvInc > 40 && monthly.length >= 3) {
      insights.push({
        id: 'volatility', priority: 3, type: 'warning',
        icon: '〰️', category: 'Revenue',
        title: `High revenue volatility (${cvInc.toFixed(0)}% CV)`,
        detail: `Income swings significantly month to month (avg ${fmtK(avgInc)}, std dev ${fmtK(stdInc)}).`,
        action: 'Consider retainer agreements or recurring billing to smooth cash flow.',
      });
    }

    // Break-even proximity
    if (income > 0 && expenses > 0) {
      const safetyBuffer = ((income - expenses) / income) * 100;
      if (safetyBuffer > 0 && safetyBuffer < 15) {
        insights.push({
          id: 'breakeven-close', priority: 2, type: 'warning',
          icon: '⚖️', category: 'Risk',
          title: `Only ${safetyBuffer.toFixed(1)}% from break-even`,
          detail: `A ${safetyBuffer.toFixed(0)}% drop in revenue would wipe out your profit entirely.`,
          action: 'Build a buffer by targeting one new client or cutting the smallest expense categories.',
        });
      }
    }

    // Growth rate (first vs last month)
    if (monthly.length >= 2) {
      const first = monthly[0], last = monthly[monthly.length - 1];
      if (first.income > 0) {
        const growthRate = ((last.income - first.income) / first.income) * 100;
        if (growthRate > 30) {
          insights.push({
            id: 'growth-strong', priority: 3, type: 'positive',
            icon: '📐', category: 'Revenue',
            title: `${growthRate.toFixed(0)}% revenue growth this period`,
            detail: `From ${fmtK(first.income)} to ${fmtK(last.income)} — strong upward trajectory.`,
            action: null,
          });
        }
      }
    }
  }

  // ── 7. Efficiency ratio ───────────────────────────────────────────────
  if (income > 0 && expenses > 0) {
    const efficiencyRatio = (expenses / income) * 100;
    if (efficiencyRatio > 85 && efficiencyRatio <= 100) {
      insights.push({
        id: 'efficiency-poor', priority: 2, type: 'warning',
        icon: '⛽', category: 'Efficiency',
        title: `Spending ${efficiencyRatio.toFixed(0)}¢ to earn $1`,
        detail: `Your expense-to-revenue ratio is high. Very little room for error or unexpected costs.`,
        action: `Target the top expense "${by_category?.[0]?.category}" for a 10–15% reduction first.`,
      });
    } else if (efficiencyRatio <= 60) {
      insights.push({
        id: 'efficiency-great', priority: 5, type: 'positive',
        icon: '⚡', category: 'Efficiency',
        title: `Lean operation: ${efficiencyRatio.toFixed(0)}¢ spent per $1 earned`,
        detail: 'Very efficient cost structure — you retain a large portion of every dollar earned.',
        action: null,
      });
    }
  }

  // Sort by priority (lower = show first), then de-duplicate similar types
  insights.sort((a, b) => a.priority - b.priority);

  // Cap at 6 most valuable insights to avoid overwhelming
  return insights.slice(0, 6);
}

// ── Smart Insights UI Component ───────────────────────────────────────────
const INSIGHT_STYLES = {
  critical: { accent: '#DC2626', soft: '#FEE2E2', text: '#991B1B' },
  warning:  { accent: '#D97706', soft: '#FEF3C7', text: '#92400E' },
  positive: { accent: '#059669', soft: '#D1FAE5', text: '#065F46' },
  neutral:  { accent: '#6B7280', soft: '#F3F4F6', text: '#374151' },
};

function InsightCard({ insight, index }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered]   = useState(false);
  const s = INSIGHT_STYLES[insight.type] || INSIGHT_STYLES.neutral;

  return (
    <div
      onClick={() => insight.action && setExpanded(e => !e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        background: 'var(--surface)',
        border: '1px solid',
        borderColor: hovered ? s.accent : 'var(--border)',
        borderRadius: 12,
        padding: '14px 16px 14px 19px',
        cursor: insight.action ? 'pointer' : 'default',
        overflow: 'hidden',
        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? '0 8px 24px rgba(15,23,42,.10)' : '0 1px 2px rgba(15,23,42,.04)',
        animation: 'fadeSlideUp .35s ease both',
        animationDelay: `${index * 0.05}s`,
      }}
    >
      {/* Severity accent bar */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: s.accent }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, background: s.soft,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, flexShrink: 0,
        }}>
          {insight.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'inline-block', fontSize: 9, fontWeight: 800, letterSpacing: '.6px',
            textTransform: 'uppercase', background: s.soft, color: s.text,
            borderRadius: 5, padding: '2px 7px', marginBottom: 5,
          }}>
            {insight.category}
          </span>

          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', lineHeight: 1.35, marginBottom: 3 }}>
            {insight.title}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0, lineHeight: 1.55 }}>
            {insight.detail}
          </p>

          {insight.action && (
            <>
              <div style={{
                maxHeight: expanded ? 90 : 0,
                marginTop: expanded ? 10 : 0,
                overflow: 'hidden',
                transition: 'max-height .25s ease, margin-top .25s ease',
              }}>
                <div style={{
                  display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.5,
                  color: 'var(--text-2)', background: 'var(--surface-2)',
                  borderRadius: 8, padding: '8px 10px', borderLeft: `2px solid ${s.accent}`,
                }}>
                  <span style={{ flexShrink: 0 }}>💡</span>
                  <span style={{ fontWeight: 600 }}>{insight.action}</span>
                </div>
              </div>
              {!expanded && (
                <div style={{ marginTop: 7, fontSize: 10.5, fontWeight: 700, color: s.accent, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>{t('finance.clickForRec')}</span>
                  <span>→</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SmartInsightsPanel({ insights }) {
  const { t } = useLocale();
  const [collapsed, setCollapsed] = useState(false);
  if (!insights || insights.length === 0) return null;

  const counts = [
    { n: insights.filter(i => i.type === 'critical').length, ...INSIGHT_STYLES.critical },
    { n: insights.filter(i => i.type === 'warning').length,  ...INSIGHT_STYLES.warning },
    { n: insights.filter(i => i.type === 'positive').length, ...INSIGHT_STYLES.positive },
  ].filter(c => c.n > 0);

  return (
    <div className="card fin-card" style={{ animationDelay: '0.6s', marginBottom: 24, overflow: 'hidden', padding: 0 }}>
      {/* Panel header */}
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '16px 20px', cursor: 'pointer', userSelect: 'none',
          background: 'linear-gradient(120deg, var(--surface-2) 0%, var(--surface) 100%)',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11,
            background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 19, flexShrink: 0, boxShadow: '0 4px 12px rgba(99,102,241,.35)',
          }}>
            🧠
          </div>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)', letterSpacing: '.2px' }}>
              {t('finance.smartInsights')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 1 }}>
              {t('finance.insightsSubtitle')}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {counts.map((c, i) => (
            <span key={i} style={{
              fontSize: 11.5, fontWeight: 800, minWidth: 24, textAlign: 'center',
              background: c.soft, color: c.text, borderRadius: 20, padding: '3px 9px',
            }}>
              {c.n}
            </span>
          ))}
          <span style={{
            fontSize: 11, color: 'var(--text-3)', marginLeft: 2,
            transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
            transition: 'transform .2s', display: 'inline-block',
          }}>▼</span>
        </div>
      </div>

      {/* Cards grid */}
      {!collapsed && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 12,
          padding: 18,
        }}>
          {insights.map((ins, i) => (
            <InsightCard key={ins.id} insight={ins} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Month Drill-Down Modal ────────────────────────────────────────────────
function MonthDrillModal({ month, label, data, loading, onClose }) {
  const { t } = useLocale();
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

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 780,
        maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--text)' }}>{label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{t('finance.detailsSubtitle')}</div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
            color: 'var(--text-3)', lineHeight: 1, padding: '2px 6px', borderRadius: 6,
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>
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
                    <div style={{ fontSize: 20, fontWeight: 800, color }}>{fmt(value)}</div>
                  </div>
                ))}
              </div>

              {/* Income section */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
                  {t('finance.income')} — {fmt(incomeTotal)}
                </div>
                {Object.keys(incomeByProject).length === 0 ? (
                  <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('finance.noIncomeMonth')}</p>
                ) : Object.entries(incomeByProject)
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([proj, { records, total }]) => (
                      <div key={proj} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ background: '#F0FDF4', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: '#065F46' }}>{proj}</span>
                          <span style={{ fontWeight: 700, color: '#059669' }}>{fmt(total)}</span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <tbody>
                            {records.map((r, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '7px 14px', color: 'var(--text-3)' }}>{r.date?.slice(0, 10)}</td>
                                <td style={{ padding: '7px 8px', fontWeight: 500 }}>{r.invoice_number}</td>
                                <td style={{ padding: '7px 8px', color: 'var(--text-2)' }}>{r.client_name || '—'}</td>
                                <td style={{ padding: '7px 8px', color: 'var(--text-3)', fontSize: 11 }}>{r.method}</td>
                                <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 600, color: '#059669' }}>{fmt(r.amount)}</td>
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
                  {t('finance.expenses')} — {fmt(expenseTotal)}
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
                          <span style={{ fontWeight: 700, color: '#DC2626' }}>{fmt(total)}</span>
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
                                <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 600, color: '#DC2626' }}>{fmt(r.amount)}</td>
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
function exportCSV(rows, filename) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => `"${r[k] ?? ''}"`).join(','))].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `${filename}.csv`,
  });
  a.click();
}

function exportExcel(sheets, filename) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name));
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// ── Reconciliation Modal ──────────────────────────────────────────────────
function ReconciliationModal({ onClose }) {
  const { t } = useLocale();
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
    vat_mismatch:      { bg: '#FEF3C7', text: '#92400E', icon: '⚠️', label: 'VAT Mismatch' },
    overpayment:       { bg: '#FEE2E2', text: '#991B1B', icon: '💸', label: 'Overpayment' },
    orphaned_payment:  { bg: '#FEE2E2', text: '#991B1B', icon: '🔗', label: 'Orphaned Payment' },
    future_expense:    { bg: '#EFF6FF', text: '#1D4ED8', icon: '📅', label: 'Future-Dated Expense' },
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 700, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.25)', border: '1px solid var(--border)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>{t('finance.reconcileTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{t('finance.reconcileSubtitle')}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-3)' }}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: 20 }}>
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{t('finance.runningChecks')}</div>}
          {error && <div style={{ color: 'var(--red)', padding: 12, background: 'var(--red-light)', borderRadius: 8 }}>{error}</div>}
          {data && (
            <>
              {/* Summary row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
                {[
                  { label: t('finance.totalInvoiced'), value: fmt(data.summary?.total_invoiced || 0), color: '#1B4F72' },
                  { label: t('finance.collected'), value: fmt(data.summary?.total_collected || 0), color: '#059669' },
                  { label: t('finance.outstanding'), value: fmt(data.summary?.outstanding || 0), color: '#D97706' },
                  { label: t('finance.totalExpenses'), value: fmt(data.summary?.total_expenses || 0), color: '#DC2626' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', border: '1px solid var(--border)', textAlign: 'center' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Status banner */}
              <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, background: data.clean ? '#F0FDF4' : '#FFF5F5', border: `1px solid ${data.clean ? '#BBF7D0' : '#FCA5A5'}` }}>
                <span style={{ fontSize: 22 }}>{data.clean ? '✅' : '⚠️'}</span>
                <div>
                  <div style={{ fontWeight: 700, color: data.clean ? '#065F46' : '#991B1B', fontSize: 14 }}>
                    {data.clean ? t('finance.booksClean') : t('finance.issuesDetected', { count: data.issue_count })}
                  </div>
                  {!data.clean && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>{t('finance.reviewItems')}</div>}
                </div>
              </div>

              {/* Issues list */}
              {(data.issues || []).map((issue, i) => {
                const style = ISSUE_COLORS[issue.type] || { bg: '#F3F4F6', text: '#374151', icon: '⚡', label: issue.type };
                return (
                  <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `4px solid ${style.text === '#991B1B' ? '#DC2626' : style.text === '#92400E' ? '#D97706' : '#3B82F6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 16 }}>{style.icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, background: style.bg, color: style.text, borderRadius: 4, padding: '1px 6px' }}>{style.label}</span>
                      {issue.invoice_number && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>#{issue.invoice_number}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{issue.message}</div>
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

// ── Accounting Periods Modal ───────────────────────────────────────────────
function PeriodsModal({ onClose }) {
  const { t } = useLocale();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function load() {
    setLoading(true);
    try { setPeriods(await getFinancePeriods()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function toggle(p) {
    const key = `${p.year}-${p.month}`;
    setWorking(key);
    setActionError(null);
    try {
      if (p.locked) await unlockPeriod(p.year, p.month);
      else          await lockPeriod(p.year, p.month);
      await load();
    } catch (e) { setActionError(e.message); }
    finally { setWorking(null); }
  }

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, width: '100%', maxWidth: 580, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.25)', border: '1px solid var(--border)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>{t('finance.periodsTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{t('finance.periodsSubtitle')}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-3)' }}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: 20 }}>
          {error && <div style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
          {actionError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--red-light)', border: '1px solid #FCA5A5', borderRadius: 8, marginBottom: 14 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 13, color: 'var(--red)', flex: 1 }}>{actionError}</span>
              <button onClick={() => setActionError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--red)', lineHeight: 1 }}>✕</button>
            </div>
          )}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{t('common.loading')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {periods.map(p => {
                const key = `${p.year}-${p.month}`;
                const isWorking = working === key;
                const monthLabel = `${MONTH_NAMES[p.month - 1]} ${p.year}`;
                const isCurrent = (() => { const n = new Date(); return n.getFullYear() === p.year && n.getMonth() + 1 === p.month; })();
                const snap = p.snapshot;
                const fmt2 = v => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                return (
                  <div key={key} style={{ background: 'var(--surface-2)', borderRadius: 10, border: `1px solid ${p.locked ? '#FCA5A5' : 'var(--border)'}`, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px' }}>
                      <span style={{ fontSize: 16 }}>{p.locked ? '🔒' : '🔓'}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {monthLabel}
                          {isCurrent && <span style={{ fontSize: 10, background: '#DBEAFE', color: '#1D4ED8', borderRadius: 4, padding: '1px 6px', marginLeft: 6 }}>{t('finance.currentLabel')}</span>}
                          {p.locked && <span style={{ fontSize: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 4, padding: '1px 6px', marginLeft: 6 }}>{t('finance.lockedLabel')}</span>}
                          {snap && <span style={{ fontSize: 10, background: '#D1FAE5', color: '#065F46', borderRadius: 4, padding: '1px 6px', marginLeft: 6 }}>{t('finance.snapshotSaved')}</span>}
                        </div>
                        {p.locked && p.locked_by && (
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                            {t('finance.lockedBy', { user: p.locked_by, date: p.locked_at?.slice(0, 10) })}
                          </div>
                        )}
                      </div>
                      <button
                        className={`btn btn-sm ${p.locked ? 'btn-secondary' : 'btn-outline'}`}
                        disabled={isWorking}
                        onClick={() => toggle(p)}
                        style={{ minWidth: 76 }}
                      >
                        {isWorking ? '…' : p.locked ? t('finance.unlock') : t('finance.lock')}
                      </button>
                    </div>

                    {/* Snapshot values — shown only when locked and snapshot exists */}
                    {p.locked && snap && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderTop: '1px solid #FCA5A5', background: '#FFF5F5' }}>
                        {[
                          { label: t('finance.income'),   value: snap.income,   color: '#065F46' },
                          { label: t('finance.expenses'), value: snap.expenses, color: '#92400E' },
                          { label: t('finance.profit'),   value: snap.profit,   color: snap.profit >= 0 ? '#065F46' : '#991B1B' },
                        ].map(s => (
                          <div key={s.label} style={{ padding: '8px 14px', textAlign: 'center', borderRight: '1px solid #FCA5A5' }}>
                            <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{s.label}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{fmt2(s.value)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function Finance() {
  const { t } = useLocale();
  const [preset, setPreset] = usePersistedState('finance.preset', 'month');
  const [custom, setCustom] = usePersistedState('finance.custom', { start: '', end: '' });
  const [summary, setSummary] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [hoveredRow, setHoveredRow] = useState(null);
  const [drillMonth, setDrillMonth]   = useState(null);
  const [drillData,  setDrillData]    = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [showRecon, setShowRecon]     = useState(false);
  const [showPeriods, setShowPeriods] = useState(false);

  const range = getRange(preset, custom);

  const load = useCallback(async () => {
    if (preset === 'custom' && (!custom.start || !custom.end)) return;
    setLoading(true); setError(null);
    try {
      const params = { start: range.start, end: range.end, ...(range.prevStart ? { prev_start: range.prevStart, prev_end: range.prevEnd } : {}) };
      const [sumData, monData] = await Promise.all([
        getFinanceRangeSummary(params),
        getFinanceRangeMonthly({ start: range.start, end: range.end }),
      ]);
      setSummary(sumData); setMonthly(monData);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [preset, custom.start, custom.end]);

  useEffect(() => { load(); }, [load]);

  async function openDrill(ym) {
    const [y, mo] = ym.split('-').map(Number);
    const start = `${ym}-01`;
    const lastDay = new Date(y, mo, 0).getDate();
    const end = `${ym}-${String(lastDay).padStart(2, '0')}`;
    setDrillMonth({ ym, label: fmtMonth(ym), start, end });
    setDrillData(null);
    setDrillLoading(true);
    try {
      const data = await getFinanceRangeDetail({ start, end });
      setDrillData(data);
    } catch { /* detail stays null */ }
    finally { setDrillLoading(false); }
  }

  const insights = generateInsights(summary, monthly);
  const margin = summary?.income > 0 ? (summary.profit / summary.income * 100).toFixed(1) : null;
  const prev = summary?.prev || {};

  const handleExportExcel = async () => {
    setExportLoading(true);
    try {
      const detail = await getFinanceRangeDetail({ start: range.start, end: range.end });
      exportExcel([
        { name: 'Monthly Summary', rows: (monthly || []).map(m => ({ Month: m.month, Income: m.income.toFixed(2), Expenses: m.expenses.toFixed(2), Profit: m.profit.toFixed(2), 'Margin %': m.income > 0 ? ((m.profit / m.income) * 100).toFixed(1) : '0.0' })) },
        { name: 'Income', rows: (detail.income_records || []).map(r => ({ Date: r.date?.slice(0, 10), Amount: r.amount, Method: r.method, Invoice: r.invoice_number, Client: r.client_name, Note: r.note || '' })) },
        { name: 'Expenses', rows: (detail.expense_records || []).map(r => ({ Date: r.date, Amount: r.amount, Category: r.category, Description: r.description || '', Project: r.project_name || '' })) },
      ], `Finance_${range.start}_to_${range.end}`);
    } catch (e) { alert('Export failed: ' + e.message); }
    finally { setExportLoading(false); }
  };

  const PRESETS = [
    { key: 'month',   label: t('finance.thisMonth') },
    { key: '3months', label: t('finance.last3Months') },
    { key: 'year',    label: t('finance.thisYear') },
    { key: 'custom',  label: t('finance.custom') },
  ];

  const periodLabel = preset === 'custom'
    ? (custom.start && custom.end ? `${custom.start} → ${custom.end}` : t('finance.customRange'))
    : PRESETS.find(p => p.key === preset)?.label;

  return (
    <div style={{ maxWidth: 1200 }}>
      <style>{`
        @media print { .no-print { display: none !important; } body { background: #fff; } }
        @keyframes fadeSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .fin-card { animation: fadeSlideUp .35s ease both; }
      `}</style>

      {/* Header */}
      <div className="page-header no-print" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{t('finance.title')}</h1>
          <p className="page-subtitle">{periodLabel} · {t('finance.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={() => setShowRecon(true)}>
            🔍 {t('finance.reconcile')}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowPeriods(true)}>
            🔒 {t('finance.periods')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => monthly?.length && exportCSV(monthly.map(m => ({ Month: m.month, Income: m.income.toFixed(2), Expenses: m.expenses.toFixed(2), Profit: m.profit.toFixed(2) })), `Finance_${range.start}_${range.end}`)} disabled={!monthly?.length}>
            ↓ CSV
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleExportExcel} disabled={exportLoading}>
            ↓ {exportLoading ? t('finance.exportingLabel') : t('finance.exportExcel')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            ↓ PDF
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRESETS.map(p => (
          <button key={p.key}
            className={`btn btn-sm ${preset === p.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPreset(p.key)}
            style={{ transition: 'all .15s' }}
          >
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" className="form-control" style={{ width: 148 }} value={custom.start} onChange={e => setCustom(c => ({ ...c, start: e.target.value }))} />
            <span style={{ color: 'var(--text-3)', fontSize: 13 }}>→</span>
            <input type="date" className="form-control" style={{ width: 148 }} value={custom.end} onChange={e => setCustom(c => ({ ...c, end: e.target.value }))} />
          </>
        )}
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading ? <LoadingSpinner /> : (
        <>
          {/* KPI Cards */}
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 24 }}>
            {[
              { label: t('finance.totalIncome'),   value: fmt(summary?.income || 0),   color: '#059669', icon: '💰', change: prev.income_change,   sub: t('finance.incomePeriod') },
              { label: t('finance.totalExpenses'), value: fmt(summary?.expenses || 0), color: '#DC2626', icon: '🧾', change: prev.expenses_change != null ? -prev.expenses_change : null, sub: t('finance.allCosts') },
              { label: t('finance.netProfit'),     value: fmt(summary?.profit || 0),   color: (summary?.profit || 0) >= 0 ? '#1B4F72' : '#DC2626', icon: '📊', change: prev.profit_change, sub: t('finance.incomeMinus') },
              { label: t('finance.profitMargin'),  value: margin !== null ? `${margin}%` : '—', color: '#7C3AED', icon: '🎯', change: prev.margin_change, sub: t('finance.netOverIncome') },
            ].map((kpi, i) => (
              <div key={kpi.label} className="fin-card" style={{ animationDelay: `${i * 0.07}s` }}>
                <KpiCard {...kpi} />
              </div>
            ))}
          </div>

          {/* Charts row 1: Line chart full width */}
          <div className="card fin-card" style={{ animationDelay: '0.35s', marginBottom: 16 }}>
            <div className="card-header">
              <span className="card-title">{t('finance.incomeVsExpenses')}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverForDetails')}</span>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <FinanceLineChart data={monthly} />
            </div>
          </div>

          {/* Charts row 2: Bar + Donut */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div className="card fin-card" style={{ animationDelay: '0.4s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.monthlyProfit')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverForDetails')}</span>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <ProfitBarChart data={monthly} />
              </div>
            </div>
            <div className="card fin-card" style={{ animationDelay: '0.45s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.expenseBreakdown')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverSlices')}</span>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <DonutChart data={summary?.by_category} />
              </div>
            </div>
          </div>

          {/* Monthly table */}
          {monthly?.length > 0 && (
            <div className="card fin-card" style={{ animationDelay: '0.5s', marginBottom: 24 }}>
              <div className="card-header">
                <span className="card-title">{t('finance.monthlyBreakdown')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{monthly.length} {t('finance.months')}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('finance.month')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.income')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.expenses')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.profit')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.margin')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...monthly].reverse().map((m, idx) => {
                      const mgn = m.income > 0 ? ((m.profit / m.income) * 100).toFixed(1) : null;
                      const best = monthly.length > 1 ? monthly.reduce((a, b) => b.profit > a.profit ? b : a) : null;
                      const isBest = best && m.month === best.month;
                      const isH = hoveredRow === idx;
                      return (
                        <tr key={m.month}
                          onMouseEnter={() => setHoveredRow(idx)}
                          onMouseLeave={() => setHoveredRow(null)}
                          onClick={() => openDrill(m.month)}
                          style={{ background: isH ? 'var(--accent-light)' : 'transparent', transition: 'background .15s', cursor: 'pointer' }}
                        >
                          <td className="td-primary" style={{ fontWeight: isBest ? 700 : 500 }}>
                            {fmtMonth(m.month)}
                            {isBest && <span style={{ fontSize: 10, background: '#FEF9C3', color: '#92400E', borderRadius: 4, padding: '1px 5px', marginLeft: 6 }}>{t('finance.bestLabel')}</span>}
                            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6, opacity: isH ? 1 : 0, transition: 'opacity .15s' }}>↗ details</span>
                          </td>
                          <td style={{ textAlign: 'right', color: '#059669', fontWeight: 600 }}>{fmt(m.income)}</td>
                          <td style={{ textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>{fmt(m.expenses)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: m.profit >= 0 ? '#059669' : '#DC2626' }}>{fmt(m.profit)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--text-3)' }}>{mgn !== null ? `${mgn}%` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '2px 8px', background: m.profit >= 0 ? '#ECFDF5' : '#FEF2F2', color: m.profit >= 0 ? '#059669' : '#DC2626' }}>
                              {m.profit >= 0 ? t('finance.profitLabel') : t('finance.lossLabel')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {monthly.length > 1 && (() => {
                    const totI = monthly.reduce((s, m) => s + m.income, 0);
                    const totE = monthly.reduce((s, m) => s + m.expenses, 0);
                    const totP = totI - totE;
                    const totM = totI > 0 ? ((totP / totI) * 100).toFixed(1) : null;
                    return (
                      <tfoot>
                        <tr style={{ background: 'var(--surface-2)' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 12, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.5px', borderTop: '2px solid var(--border)' }}>{t('common.total')}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#059669', borderTop: '2px solid var(--border)' }}>{fmt(totI)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#DC2626', borderTop: '2px solid var(--border)' }}>{fmt(totE)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: totP >= 0 ? '#059669' : '#DC2626', borderTop: '2px solid var(--border)' }}>{fmt(totP)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--text-3)', borderTop: '2px solid var(--border)' }}>{totM !== null ? `${totM}%` : '—'}</td>
                          <td style={{ borderTop: '2px solid var(--border)' }} />
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
            </div>
          )}

          {/* Expense categories */}
          {summary?.by_category?.length > 0 && (
            <div className="card fin-card" style={{ animationDelay: '0.55s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.expensesByCategory')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.total')}: {fmt(summary.expenses)}</span>
              </div>
              <div style={{ padding: '4px 0' }}>
                {summary.by_category.map((c, i) => {
                  const pct = summary.expenses > 0 ? (c.total / summary.expenses) * 100 : 0;
                  return (
                    <div key={c.category} style={{
                      display: 'grid', gridTemplateColumns: '20px 140px 1fr 90px 52px',
                      alignItems: 'center', gap: 12, padding: '11px 20px',
                      borderBottom: i < summary.by_category.length - 1 ? '1px solid var(--border)' : 'none',
                      transition: 'background .15s',
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = '#F9FAFB'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: CHART_COLORS[i % CHART_COLORS.length], display: 'block' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{c.category}</span>
                      <div style={{ background: 'var(--bg)', borderRadius: 99, height: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: CHART_COLORS[i % CHART_COLORS.length], transition: 'width .6s ease' }} />
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--text)', textAlign: 'right', fontWeight: 700 }}>{fmt(c.total)}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'right' }}>{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Smart Insights Panel — placed at the bottom of the module ── */}
          <SmartInsightsPanel insights={insights} />

          {!summary && !loading && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-3)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{t('finance.noDataForPeriod')}</p>
              <p style={{ fontSize: 13 }}>{t('finance.tryDifferentRange')}</p>
            </div>
          )}
        </>
      )}

      {drillMonth && (
        <MonthDrillModal
          month={drillMonth.ym}
          label={drillMonth.label}
          data={drillData}
          loading={drillLoading}
          onClose={() => { setDrillMonth(null); setDrillData(null); }}
        />
      )}
      {showRecon   && <ReconciliationModal onClose={() => setShowRecon(false)} />}
      {showPeriods && <PeriodsModal onClose={() => setShowPeriods(false)} />}
    </div>
  );
}