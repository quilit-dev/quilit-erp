import { useState, useEffect, useRef, useCallback } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import {
  getFinanceRangeSummary, getFinanceRangeMonthly, getFinanceRangeDetail,
  getReconciliation,
  // Extra context for the smart-insights engine — modules added since the
  // original insight set was authored (period locks, FX, cash, recurring,
  // receivables, fiscal years). Each request is optional: a 403 from a
  // module the operator can't view is swallowed and that branch's insights
  // simply don't fire.
  getFinancePeriods,
  getRecurringExpenses,
  getCashReconciliations,
  getExchangeRate,
  getInvoices,
  getFiscalYears,
} from '../api/client';
import { LoadingSpinner, ErrorAlert, useMoney, DisplayCurrencyToggle, ExchangeRateBadge } from '../components/shared';
import { useSettings } from '../hooks/useSettings.jsx';
import { useLocale } from '../hooks/useLocale.jsx';
import { useScrollLock } from '../hooks/useScrollLock';
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
            fontSize: 13, lineHeight: 1,
            color: color || 'var(--text-3)',
            opacity: 0.7,
          }}>{icon}</span>
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
function generateInsights(summary, monthly, extras = {}, fmtK = v => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.abs(v).toFixed(0)}`, t = (k) => k) {
  const insights = [];
  if (!summary) return insights;

  const { income, expenses, profit, margin, by_category, prev } = summary;

  // ── 1. Profit trend vs prior period ──────────────────────────────────
  if (prev?.profit_change != null) {
    const ch = prev.profit_change;
    if (ch > 0) {
      insights.push({
        id: 'profit-up', priority: 1, type: 'positive',
        icon: '📈', category: 'Trend',
        title: t('finance.ins.profitUp.t', { pct: ch }),
        detail: t('finance.ins.profitUp.d', { amt: fmtK(profit - (prev.profit || 0)) }),
        action: null,
      });
    } else {
      insights.push({
        id: 'profit-down', priority: 1, type: 'critical',
        icon: '📉', category: 'Trend',
        title: t('finance.ins.profitDown.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.profitDown.d', { amt: fmtK(Math.abs(profit - (prev.profit || 0))) }),
        action: t('finance.ins.profitDown.a'),
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
        title: t('finance.ins.revSurge.t', { pct: ch }),
        detail: t('finance.ins.revSurge.d', { amt: fmtK(income - (prev.income || 0)) }),
        action: t('finance.ins.revSurge.a'),
      });
    } else if (ch < -10) {
      insights.push({
        id: 'rev-drop', priority: 1, type: 'critical',
        icon: '⚠️', category: 'Revenue',
        title: t('finance.ins.revDrop.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.revDrop.d', { amt: fmtK(Math.abs(income - (prev.income || 0))) }),
        action: t('finance.ins.revDrop.a'),
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
        title: t('finance.ins.expSpike.t', { pct: ch }),
        detail: t('finance.ins.expSpike.d', { amt: fmtK(expenses - (prev.expenses || 0)) }),
        action: t('finance.ins.expSpike.a', { cat: by_category?.[0]?.category }),
      });
    } else if (ch < -10) {
      insights.push({
        id: 'exp-down', priority: 3, type: 'positive',
        icon: '✂️', category: 'Expenses',
        title: t('finance.ins.expDown.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.expDown.d', { amt: fmtK(Math.abs(expenses - (prev.expenses || 0))) }),
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
        title: t('finance.ins.marginExcellent.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginExcellent.d'),
        action: null,
      });
    } else if (m >= 20) {
      insights.push({
        id: 'margin-healthy', priority: 4, type: 'neutral',
        icon: '📊', category: 'Margin',
        title: t('finance.ins.marginHealthy.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginHealthy.d'),
        action: null,
      });
    } else if (m > 0) {
      insights.push({
        id: 'margin-thin', priority: 2, type: 'warning',
        icon: '⚡', category: 'Margin',
        title: t('finance.ins.marginThin.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginThin.d'),
        action: t('finance.ins.marginThin.a'),
      });
    } else {
      insights.push({
        id: 'margin-loss', priority: 1, type: 'critical',
        icon: '🔴', category: 'Margin',
        title: t('finance.ins.marginLoss.t'),
        detail: t('finance.ins.marginLoss.d', { amt: fmtK(Math.abs(profit)) }),
        action: t('finance.ins.marginLoss.a'),
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
        title: t('finance.ins.expConcentration.t', { cat: top.category, pct: topPct }),
        detail: t('finance.ins.expConcentration.d', { amt: fmtK(top.total) }),
        action: t('finance.ins.expConcentration.a'),
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
          title: t('finance.ins.expTop2.t', { pct: top2Pct }),
          detail: t('finance.ins.expTop2.d', { c1: by_category[0].category, c2: by_category[1].category }),
          action: t('finance.ins.expTop2.a'),
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
        title: t('finance.ins.scissors.t'),
        detail: t('finance.ins.scissors.d'),
        action: t('finance.ins.scissors.a'),
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
        title: t('finance.ins.streak.t', { n: streak }),
        detail: t('finance.ins.streak.d', { n: streak }),
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
        title: t('finance.ins.bestMonth.t', { month: fmtMonth(best.month) }),
        detail: t('finance.ins.bestMonth.d', { amt: fmtK(best.profit) }),
        action: null,
      });
    }
    if (worst.profit < 0) {
      insights.push({
        id: 'worst-month', priority: 3, type: 'warning',
        icon: '📅', category: 'Performance',
        title: t('finance.ins.worstMonth.t', { month: fmtMonth(worst.month) }),
        detail: t('finance.ins.worstMonth.d', { amt: fmtK(Math.abs(worst.profit)) }),
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
        title: t('finance.ins.volatility.t', { cv: cvInc.toFixed(0) }),
        detail: t('finance.ins.volatility.d', { avg: fmtK(avgInc), std: fmtK(stdInc) }),
        action: t('finance.ins.volatility.a'),
      });
    }

    // Break-even proximity
    if (income > 0 && expenses > 0) {
      const safetyBuffer = ((income - expenses) / income) * 100;
      if (safetyBuffer > 0 && safetyBuffer < 15) {
        insights.push({
          id: 'breakeven-close', priority: 2, type: 'warning',
          icon: '⚖️', category: 'Risk',
          title: t('finance.ins.breakeven.t', { pct: safetyBuffer.toFixed(1) }),
          detail: t('finance.ins.breakeven.d', { pct: safetyBuffer.toFixed(0) }),
          action: t('finance.ins.breakeven.a'),
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
            title: t('finance.ins.growthStrong.t', { pct: growthRate.toFixed(0) }),
            detail: t('finance.ins.growthStrong.d', { from: fmtK(first.income), to: fmtK(last.income) }),
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
        title: t('finance.ins.efficiencyPoor.t', { cents: efficiencyRatio.toFixed(0) }),
        detail: t('finance.ins.efficiencyPoor.d'),
        action: t('finance.ins.efficiencyPoor.a', { cat: by_category?.[0]?.category }),
      });
    } else if (efficiencyRatio <= 60) {
      insights.push({
        id: 'efficiency-great', priority: 5, type: 'positive',
        icon: '⚡', category: 'Efficiency',
        title: t('finance.ins.efficiencyGreat.t', { cents: efficiencyRatio.toFixed(0) }),
        detail: t('finance.ins.efficiencyGreat.d'),
        action: null,
      });
    }
  }

  // ── 8. Period locking discipline ──────────────────────────────────────
  // A finished month that hasn't been locked is a backdating risk — anyone
  // with edit perms could still post an invoice or expense into it.
  // Closing each completed month within ~10 days is the industry norm.
  if (Array.isArray(extras.periods)) {
    const today = new Date();
    const thisYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const stale = extras.periods.filter(p => {
      if (p.locked) return false;
      if (p.label === thisYM) return false;         // skip current month
      // Lock target: end-of-month + 10 days
      const endOfMonth = new Date(p.year, p.month, 0);
      const daysSince = Math.floor((today - endOfMonth) / 86400000);
      return daysSince > 10;
    });
    if (stale.length >= 1) {
      const last = stale[0];
      insights.push({
        id: 'period-not-locked', priority: 2, type: 'warning',
        icon: '🔒', category: 'Controls',
        title: t('finance.ins.periodNotLocked.t', { n: stale.length }),
        detail: t('finance.ins.periodNotLocked.d', { label: last.label }),
        action: t('finance.ins.periodNotLocked.a'),
      });
    }
  }

  // ── 9. Recurring-expense run-rate vs current spend ────────────────────
  // The recurring book tells us what costs we have committed to going
  // forward — if it's > 60 % of the current period's expense we surface the
  // dependency, and if any template is overdue we nudge to run it.
  if (Array.isArray(extras.recurring) && extras.recurring.length > 0) {
    const active = extras.recurring.filter(r => r.is_active && !r.archived_at);
    // Monthly equivalent of each frequency, so weekly + quarterly + annual
    // all collapse to a single comparable "per month" figure.
    const stepMonths = { weekly: 1 / 4.33, monthly: 1, quarterly: 3, annual: 12 };
    const monthlyRecurring = active.reduce((s, r) => {
      const step = stepMonths[r.frequency] || 1;
      return s + (Number(r.amount) || 0) / step;
    }, 0);
    if (expenses > 0 && monthlyRecurring > 0) {
      const share = (monthlyRecurring / (expenses / Math.max(monthly?.length || 1, 1))) * 100;
      if (share > 60) {
        insights.push({
          id: 'recurring-heavy', priority: 3, type: 'warning',
          icon: '🔁', category: 'Fixed costs',
          title: t('finance.ins.recurringHeavy.t', { pct: Math.min(share, 999).toFixed(0) }),
          detail: t('finance.ins.recurringHeavy.d', { amt: fmtK(monthlyRecurring), n: active.length }),
          action: t('finance.ins.recurringHeavy.a'),
        });
      }
    }
    const overdue = active.filter(r => r.is_overdue);
    if (overdue.length > 0) {
      insights.push({
        id: 'recurring-overdue', priority: 2, type: 'warning',
        icon: '⏰', category: 'Fixed costs',
        title: t('finance.ins.recurringOverdue.t', { n: overdue.length }),
        detail: t('finance.ins.recurringOverdue.d', { names: overdue.slice(0, 2).map(r => r.name).join('", "') }),
        action: t('finance.ins.recurringOverdue.a'),
      });
    }
  }

  // ── 10. Cash drawer variance ──────────────────────────────────────────
  // A recurring shortage points to till-management problems (skimming,
  // missed receipts, sloppy returns) — surface the pattern, not a single
  // bad close. Three or more variant shifts in the last ten closes is the
  // line we draw.
  if (Array.isArray(extras.cashRecs) && extras.cashRecs.length >= 3) {
    const recent = extras.cashRecs.slice(0, 10);
    const offShifts = recent.filter(r => {
      const v = Number(r.variance_usd || r.variance || 0);
      return Math.abs(v) > 0.01;
    });
    const totalShort = offShifts.reduce(
      (s, r) => s + Math.min(0, Number(r.variance_usd || r.variance || 0)), 0,
    );
    if (offShifts.length >= 3 && totalShort < -5) {
      insights.push({
        id: 'cash-variance', priority: 2, type: 'warning',
        icon: '💵', category: 'Cash',
        title: t('finance.ins.cashVariance.t', { off: offShifts.length, total: recent.length }),
        detail: t('finance.ins.cashVariance.d', { amt: fmtK(Math.abs(totalShort)) }),
        action: t('finance.ins.cashVariance.a'),
      });
    }
  }

  // ── 11. FX rate freshness (LBP exposure) ─────────────────────────────
  // Every LBP cash posting books at the latest spot. A rate stale for a
  // week means the books drift from reality on every dual-currency txn,
  // and the trial balance silently absorbs the gap as fictitious profit.
  if (extras.fxRate?.created_at) {
    const age = Math.floor(
      (Date.now() - new Date(extras.fxRate.created_at).getTime()) / 86400000,
    );
    if (age >= 7) {
      insights.push({
        id: 'fx-stale', priority: 2, type: 'warning',
        icon: '💱', category: 'FX',
        title: t('finance.ins.fxStale.t', { age }),
        detail: t('finance.ins.fxStale.d', { rate: Number(extras.fxRate.rate || 0).toLocaleString(), age }),
        action: t('finance.ins.fxStale.a'),
      });
    }
  }

  // ── 12. Open receivables vs revenue ──────────────────────────────────
  // A ballooning A/R book against modest revenue is a collection problem
  // even before any single invoice goes overdue. We compute both: the
  // ratio against current-period income (collection efficiency) AND the
  // count past due date (collection urgency).
  if (Array.isArray(extras.overdueAr)) {
    const open = extras.overdueAr.filter(i =>
      ['Unpaid', 'Partial'].includes(i.status) && !i.voided_at,
    );
    const today = new Date();
    const past = open.filter(i => i.due_date && new Date(i.due_date) < today);
    const outstanding = open.reduce(
      (s, i) => s + (Number(i.amount) - Number(i.paid || 0)), 0,
    );
    if (past.length >= 3) {
      const overdue$ = past.reduce(
        (s, i) => s + (Number(i.amount) - Number(i.paid || 0)), 0,
      );
      insights.push({
        id: 'ar-overdue', priority: 1, type: 'critical',
        icon: '⏳', category: 'Receivables',
        title: t('finance.ins.arOverdue.t', { n: past.length, amt: fmtK(overdue$) }),
        detail: t('finance.ins.arOverdue.d', { date: past
          .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0]
          .due_date?.slice(0, 10) }),
        action: t('finance.ins.arOverdue.a'),
      });
    } else if (income > 0 && outstanding > income * 0.5) {
      insights.push({
        id: 'ar-bloated', priority: 3, type: 'warning',
        icon: '💼', category: 'Receivables',
        title: t('finance.ins.arBloated.t', { pct: Math.round(outstanding / income * 100) }),
        detail: t('finance.ins.arBloated.d', { amt: fmtK(outstanding), income: fmtK(income) }),
        action: t('finance.ins.arBloated.a'),
      });
    }
  }

  // ── 13. Fiscal year close ─────────────────────────────────────────────
  // An open prior-year fiscal year past the first quarter of the next year
  // is a red flag for an auditor — closing posts the year-end entry to
  // Retained Earnings and locks the prior year completely.
  if (Array.isArray(extras.fiscalYears)) {
    const today = new Date();
    const thisYear = today.getFullYear();
    const stalePriorYear = extras.fiscalYears.find(fy =>
      fy.status === 'open' && fy.year < thisYear
      // The first 90 days of the new year are a normal close window —
      // only nag once we're past Q1.
      && today.getMonth() >= 3,
    );
    if (stalePriorYear) {
      insights.push({
        id: 'fy-not-closed', priority: 2, type: 'warning',
        icon: '📚', category: 'Controls',
        title: t('finance.ins.fyNotClosed.t', { year: stalePriorYear.year }),
        detail: t('finance.ins.fyNotClosed.d', { amt: fmtK(stalePriorYear.net_income || 0) }),
        action: t('finance.ins.fyNotClosed.a'),
      });
    }
  }

  // Sort by priority (lower = show first), then de-duplicate similar types
  insights.sort((a, b) => a.priority - b.priority);

  // Cap at 8 most valuable insights — the panel grew with the new module
  // branches; 6 was sometimes hiding genuinely actionable controls items.
  return insights.slice(0, 8);
}

// ── Smart Insights UI Component ───────────────────────────────────────────
// ── Smart Insights — statistical-report visual treatment ──────────────────
// Theme-aware severity tokens. We deliberately use the design system's
// status colours (var(--red)/--yellow/--green) so dark mode just works.
const INSIGHT_STYLES = {
  critical: { tone: 'var(--red)',    soft: 'var(--red-light)',    glow: 'var(--red-glow)'    },
  warning:  { tone: 'var(--yellow)', soft: 'var(--yellow-light)', glow: 'var(--yellow-glow)' },
  positive: { tone: 'var(--green)',  soft: 'var(--green-light)',  glow: 'var(--green-glow)'  },
  neutral:  { tone: 'var(--text-3)', soft: 'var(--surface-3)',    glow: 'transparent'         },
};

// One row in the insight list. Reads as a single statistical observation:
//   • severity dot anchors the eye
//   • category chip + title carry the headline
//   • detail is the explanatory body
//   • recommendation is a labelled inline aside, not a "click to reveal"
function InsightCard({ insight, index }) {
  const { t } = useLocale();
  const s = INSIGHT_STYLES[insight.type] || INSIGHT_STYLES.neutral;

  return (
    <div
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
        animation: 'fadeSlideUp .35s ease both',
        animationDelay: `${index * 0.04}s`,
        transition: 'border-color var(--motion-fast) var(--ease), box-shadow var(--motion-med) var(--ease), transform var(--motion-med) var(--ease)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = s.tone;
        e.currentTarget.style.boxShadow = `0 0 0 1px ${s.glow}, 0 6px 18px rgba(15,23,42,.06)`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.boxShadow   = 'none';
        e.currentTarget.style.transform   = 'none';
      }}
    >
      {/* Severity column — a refined indicator pair: thin vertical rail +
          a small dot at the top. Reads as a "status meter" rather than an
          emoji avatar — the deliberately editorial look. */}
      <div style={{ position: 'relative', width: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: s.tone,
          boxShadow: `0 0 0 3px ${s.soft}`,
        }} />
        <div style={{
          flex: 1, width: 2, marginTop: 6,
          background: `linear-gradient(180deg,${s.soft} 0%,transparent 100%)`,
          borderRadius: 999,
        }} />
      </div>

      {/* Content */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.6px',
            textTransform: 'uppercase', color: s.tone,
          }}>{t('finance.insCat.' + String(insight.category).toLowerCase().replace(/\s+/g, ''))}</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>·</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500 }}>
            {t(`finance.severity_${insight.type}`) || insight.type}
          </span>
        </div>

        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35, marginBottom: 4, letterSpacing: '-0.1px' }}>
          {insight.title}
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, lineHeight: 1.55 }}>
          {insight.detail}
        </p>

        {insight.action && (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            marginTop: 10, paddingTop: 10,
            borderTop: '1px dashed var(--border)',
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '.5px',
              color: s.tone, textTransform: 'uppercase', minWidth: 90, paddingTop: 1,
            }}>
              {t('finance.recommendation') || 'Recommendation'}
            </div>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
              {insight.action}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SmartInsightsPanel({ insights }) {
  const { t } = useLocale();
  if (!insights || insights.length === 0) return null;

  // Sort by severity — critical first, then warning, then positive — so the
  // most actionable items always sit at the top of the column.
  const order = { critical: 0, warning: 1, positive: 2, neutral: 3 };
  const sorted = [...insights].sort((a, b) =>
    (order[a.type] ?? 9) - (order[b.type] ?? 9)
  );

  const tally = {
    critical: insights.filter(i => i.type === 'critical').length,
    warning:  insights.filter(i => i.type === 'warning').length,
    positive: insights.filter(i => i.type === 'positive').length,
  };

  // Tiny summary "stat tiles" at the top of the panel — gives the section
  // an at-a-glance statistical feel before the reader scans the detail.
  const summaryTiles = [
    { label: t('finance.tileCritical') || 'Needs attention', n: tally.critical, ...INSIGHT_STYLES.critical },
    { label: t('finance.tileWarning')  || 'Worth watching',  n: tally.warning,  ...INSIGHT_STYLES.warning  },
    { label: t('finance.tilePositive') || 'Trending well',   n: tally.positive, ...INSIGHT_STYLES.positive },
  ];

  return (
    <div className="card fin-card" style={{
      animationDelay: '0.6s', marginBottom: 24, overflow: 'hidden', padding: 0,
    }}>
      {/* Header — minimal, no emoji avatar. A small pulsing dot signals "live
          analytics" the way modern data dashboards do. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, padding: '16px 20px 14px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            position: 'relative', width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent)', flexShrink: 0,
            boxShadow: '0 0 0 4px var(--accent-light)',
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 13.5, fontWeight: 700, color: 'var(--text)',
              letterSpacing: '-0.1px',
            }}>
              {t('finance.smartInsights')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
              {t('finance.insightsSubtitle')}
            </div>
          </div>
        </div>
        <div style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
          textTransform: 'uppercase', letterSpacing: '.6px',
          whiteSpace: 'nowrap',
        }}>
          {sorted.length} {t('finance.observations') || 'observations'}
        </div>
      </div>

      {/* Summary tiles — three at-a-glance counts. Each tile is uniform
          width and uses tokens so it adapts to dark mode. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12, padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}>
        {summaryTiles.map(t_ => (
          <div key={t_.label} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
              background: t_.tone, opacity: t_.n ? 1 : 0.25,
            }} />
            <div style={{
              fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '.5px',
              paddingLeft: 6,
            }}>{t_.label}</div>
            <div style={{
              fontSize: 18, fontWeight: 700,
              color: t_.n ? t_.tone : 'var(--text-3)',
              letterSpacing: '-0.5px',
              fontFeatureSettings: '"tnum"',
            }}>
              {t_.n}
            </div>
          </div>
        ))}
      </div>

      {/* Insight list — vertical column, single-track. Reads top-to-bottom
          like a published report rather than a wall of equally-weighted
          tiles. Two-column layout kicks in above 720px so wide screens
          surface more at once without losing scannability. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: 10,
        padding: 16,
      }}>
        {sorted.map((ins, i) => (
          <InsightCard key={ins.id} insight={ins} index={i} />
        ))}
      </div>
    </div>
  );
}

// ── Month Drill-Down Modal ────────────────────────────────────────────────
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
    vat_mismatch:      { bg: '#FEF3C7', text: '#92400E', icon: '⚠️', label: 'VAT Mismatch' },
    overpayment:       { bg: '#FEE2E2', text: '#991B1B', icon: '💸', label: 'Overpayment' },
    orphaned_payment:  { bg: '#FEE2E2', text: '#991B1B', icon: '🔗', label: 'Orphaned Payment' },
    future_expense:    { bg: '#EFF6FF', text: '#1D4ED8', icon: '📅', label: 'Future-Dated Expense' },
    unreversed_void:   { bg: '#FEE2E2', text: '#991B1B', icon: '↩️', label: 'Unreversed Void' },
    gl_unbalanced:     { bg: '#FEE2E2', text: '#991B1B', icon: '⚖️', label: 'Ledger Out of Balance' },
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


// ── Main ──────────────────────────────────────────────────────────────────
export default function Finance() {
  const { t } = useLocale();
  const money = useMoney();
  const abbr = useAbbr();
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

  // Cross-module context that feeds the Smart Insights engine. Loaded once
  // per session (the underlying data is permission-gated and largely
  // static across a Finance review). Each request is wrapped to swallow a
  // permission/404 error so a single missing module never blanks the rest.
  const [extras, setExtras] = useState({});

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

  // Fetch the insight-context bundle once on mount. allSettled lets every
  // request fail independently — an operator without `accounting:view` still
  // gets the periods + cash + recurring branches even when fiscal years
  // returns 403. The result is merged into a single object the engine reads.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      getFinancePeriods(),
      getRecurringExpenses(),
      getCashReconciliations({ limit: 10 }),
      getExchangeRate(),
      getInvoices(),
      getFiscalYears(),
    ]).then(results => {
      if (cancelled) return;
      const [periods, recurring, cashRecs, fxRate, invoices, fiscalYears] = results;
      setExtras({
        periods:     periods.status     === 'fulfilled' ? periods.value     : null,
        recurring:   recurring.status   === 'fulfilled' ? recurring.value   : null,
        cashRecs:    cashRecs.status    === 'fulfilled'
                       ? (cashRecs.value?.reconciliations || cashRecs.value || null)
                       : null,
        fxRate:      fxRate.status      === 'fulfilled' ? fxRate.value      : null,
        overdueAr:   invoices.status    === 'fulfilled'
                       ? (Array.isArray(invoices.value) ? invoices.value
                          : (invoices.value?.invoices || invoices.value?.rows || []))
                       : null,
        fiscalYears: fiscalYears.status === 'fulfilled' ? fiscalYears.value : null,
      });
    });
    return () => { cancelled = true; };
  }, []);

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

  const insights = generateInsights(summary, monthly, extras, abbr, t);
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <button className="btn btn-outline btn-sm" onClick={() => setShowRecon(true)}>
            🔍 {t('finance.reconcile')}
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
          {/* KPI tiles — Workspace pattern. Each tile is its own .stat-card
              surface (the previous code double-wrapped it in .fin-card,
              which produced a card-inside-a-card). Colour props point at
              the system's semantic tokens so the tiles inherit the plum +
              affirm + negate palette instead of hardcoded Material hexes. */}
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 24 }}>
            {[
              { label: t('finance.totalIncome'),
                value: money(summary?.income || 0),
                color: 'var(--affirm)',
                icon: '💰',
                change: prev.income_change,
                sub: t('finance.incomePeriod') },
              { label: t('finance.totalExpenses'),
                value: money(summary?.expenses || 0),
                color: 'var(--negate)',
                icon: '🧾',
                change: prev.expenses_change != null ? -prev.expenses_change : null,
                sub: t('finance.allCosts') },
              { label: t('finance.netProfit'),
                value: money(summary?.profit || 0),
                color: (summary?.profit || 0) >= 0 ? 'var(--accent)' : 'var(--negate)',
                icon: '📊',
                change: prev.profit_change,
                sub: t('finance.incomeMinus') },
              { label: t('finance.profitMargin'),
                value: margin !== null ? `${margin}%` : '—',
                color: 'var(--accent)',
                icon: '🎯',
                change: prev.margin_change,
                sub: t('finance.netOverIncome') },
            ].map((kpi, i) => (
              <div key={kpi.label}
                style={{
                  /* fadeSlideUp staggered entrance — keep the per-tile
                     animation delay from the previous layout. */
                  animation: 'fadeSlideUp .35s ease both',
                  animationDelay: `${i * 0.07}s`,
                }}>
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
                          <td style={{ textAlign: 'right', color: '#059669', fontWeight: 600 }}>{money(m.income)}</td>
                          <td style={{ textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>{money(m.expenses)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: m.profit >= 0 ? '#059669' : '#DC2626' }}>{money(m.profit)}</td>
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
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#059669', borderTop: '2px solid var(--border)' }}>{money(totI)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#DC2626', borderTop: '2px solid var(--border)' }}>{money(totE)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: totP >= 0 ? '#059669' : '#DC2626', borderTop: '2px solid var(--border)' }}>{money(totP)}</td>
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
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.total')}: {money(summary.expenses)}</span>
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
                      <span style={{ fontSize: 13, color: 'var(--text)', textAlign: 'right', fontWeight: 700 }}>{money(c.total)}</span>
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
    </div>
  );
}