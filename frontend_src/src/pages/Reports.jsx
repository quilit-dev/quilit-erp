import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  getReportFinancial, getReportProjects, getReportClients,
  getReportInvoiceAging, getReportExpenses, getReportPipeline, getReportVAT,
  getInventoryByWarehouseReport, getBranchComparison, getBranchContext,
} from '../api/client';
import { LoadingSpinner, ErrorAlert, Badge, fmt, fmtDate } from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePersistedState } from '../hooks/usePersistedState';
import * as XLSX from 'xlsx';
import { exportReportPDF } from '../utils/exportUtils.js';

// ── Date helpers ──────────────────────────────────────────────────────────
function toISO(d) { return d.toISOString().slice(0, 10); }

function getRange(preset, custom) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (preset) {
    case 'month': {
      return { start: toISO(new Date(y, m, 1)), end: toISO(new Date(y, m + 1, 0)) };
    }
    case '3months': {
      return { start: toISO(new Date(y, m - 2, 1)), end: toISO(new Date(y, m + 1, 0)) };
    }
    case 'year': {
      return { start: toISO(new Date(y, 0, 1)), end: toISO(new Date(y, 11, 31)) };
    }
    case 'custom':
      return { start: custom.start, end: custom.end };
    default:
      return getRange('year', custom);
  }
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [y, mo] = ym.split('-');
  return new Date(+y, +mo - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
}

function fmtAbbr(v) {
  const abs = Math.abs(v || 0);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

// Count formatter — plain integer, no currency. Used by charts whose
// valueKey is a count (e.g. "By status" in the Sales Pipeline panel).
// Without this, fmtAbbr would render "1 quote" as "$1" — misleading.
function fmtCountAbbr(v) {
  const abs = Math.abs(v || 0);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

function niceMax(rawMax) {
  if (rawMax <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

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

const CHART_COLORS = [
  '#1B4F72', '#27AE60', '#E67E22', '#8E44AD', '#C0392B',
  '#16A085', '#F39C12', '#2C3E50', '#2E86C1', '#7F8C8D',
];

// ── Tooltip ───────────────────────────────────────────────────────────────
function ChartTooltip({ children, anchorX, anchorY, svgWidth, visible }) {
  if (!visible) return null;
  const flipLeft = anchorX > svgWidth * 0.6;
  return (
    <foreignObject
      x={flipLeft ? anchorX - 152 : anchorX + 10}
      y={Math.max(4, anchorY - 48)}
      width={144} height={90}
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      <div style={{
        background: 'rgba(17,24,39,0.94)', color: '#fff',
        borderRadius: 8, padding: '7px 11px',
        fontSize: 11.5, lineHeight: 1.65,
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

// ── Stat card ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, icon }) {
  return (
    <div className="stat-card">
      <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon && <span style={{ opacity: 0.7 }}>{icon}</span>}
        {label}
      </div>
      <div className="stat-value" style={color ? { color: `var(--${color})` } : {}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── Line Chart (income vs expenses) ───────────────────────────────────────
function LineChart({ data, label1, label2, color1 = '#1B4F72', color2 = '#DC2626', key1 = 'income', key2 = 'expenses' }) {
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(640);

  if (!data || data.length === 0) {
    return (
      <div ref={containerRef} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        {label1} — no data
      </div>
    );
  }

  const allVals = data.flatMap(d => [d[key1] || 0, d[key2] || 0]);
  const rawMax = Math.max(...allVals, 1);
  const maxV = niceMax(rawMax);
  const yLabelWidth = fmtAbbr(maxV).length * 7 + 10;
  const PL = Math.max(52, yLabelWidth), PR = 16, PT = 18, PB = 38;
  const H = data.length <= 6 ? 230 : data.length <= 12 ? 210 : 195;
  const iW = W - PL - PR, iH = H - PT - PB;
  const xStep = iW / Math.max(data.length - 1, 1);
  const yScale = v => iH - (v / maxV) * iH;
  const pts = key => data.map((d, i) => [PL + i * xStep, PT + yScale(d[key] || 0)]);
  const toPath = points => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const pts1 = pts(key1), pts2 = pts(key2);
  const tickCount = H > 220 ? 5 : 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => maxV * (i / (tickCount - 1)));
  const showLabel = i => data.length <= 12 ? true : data.length <= 18 ? i % 2 === 0 : i % 3 === 0;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}
        style={{ display: 'block', fontFamily: 'inherit', overflow: 'visible', cursor: 'crosshair', direction: 'ltr' }}>
        <defs>
          <linearGradient id={`lg1_${key1}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color1} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color1} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`lg2_${key2}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color2} stopOpacity="0.14" />
            <stop offset="100%" stopColor={color2} stopOpacity="0" />
          </linearGradient>
          <clipPath id={`clip_${key1}`}><rect x={PL} y={PT} width={iW} height={iH} /></clipPath>
        </defs>
        {yTicks.map((v, i) => {
          const y = PT + yScale(v);
          return (
            <g key={i}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#E5E7EB" strokeWidth={i === 0 ? 1.5 : 1} strokeDasharray={i === 0 ? '0' : '4,4'} />
              <text x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#9CA3AF">{fmtAbbr(v)}</text>
            </g>
          );
        })}
        {data.map((d, i) => showLabel(i) && (
          <text key={i} x={PL + i * xStep} y={H - 8} textAnchor="middle" fontSize="10"
            fill={hovered === i ? color1 : '#9CA3AF'} fontWeight={hovered === i ? '700' : '400'}>
            {fmtMonth(d.month)}
          </text>
        ))}
        {hovered !== null && (
          <line x1={PL + hovered * xStep} y1={PT} x2={PL + hovered * xStep} y2={PT + iH}
            stroke="#6B7280" strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
        )}
        <g clipPath={`url(#clip_${key1})`}>
          <path d={`${toPath(pts1)} L ${pts1[pts1.length-1][0]} ${PT+iH} L ${PL} ${PT+iH} Z`} fill={`url(#lg1_${key1})`} />
          {key2 && <path d={`${toPath(pts2)} L ${pts2[pts2.length-1][0]} ${PT+iH} L ${PL} ${PT+iH} Z`} fill={`url(#lg2_${key2})`} />}
          <path d={toPath(pts1)} fill="none" stroke={color1} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {key2 && <path d={toPath(pts2)} fill="none" stroke={color2} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5,3" />}
        </g>
        {data.map((d, i) => {
          const ix = pts1[i][0], iy = pts1[i][1];
          const ex = key2 ? pts2[i][0] : ix, ey = key2 ? pts2[i][1] : iy;
          const isH = hovered === i;
          const zoneW = xStep || 20;
          return (
            <g key={i}>
              <circle cx={ix} cy={iy} r={isH ? 5.5 : 3.5} fill={color1} stroke="#fff" strokeWidth="2" />
              {key2 && <circle cx={ex} cy={ey} r={isH ? 4.5 : 3} fill={color2} stroke="#fff" strokeWidth="2" />}
              {isH && (
                <ChartTooltip anchorX={ix} anchorY={Math.min(iy, ey)} svgWidth={W} visible>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{fmtMonth(d.month)}</div>
                  <div style={{ color: '#6EE7B7' }}>{label1}: {fmtAbbr(d[key1] || 0)}</div>
                  {key2 && <div style={{ color: '#FCA5A5' }}>{label2}: {fmtAbbr(d[key2] || 0)}</div>}
                  {d.profit !== undefined && (
                    <div style={{ color: (d.profit || 0) >= 0 ? '#6EE7B7' : '#FCA5A5', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 3, paddingTop: 3, fontWeight: 700 }}>
                      Profit: {fmtAbbr(d.profit || 0)}
                    </div>
                  )}
                </ChartTooltip>
              )}
              <rect x={PL + i * xStep - zoneW / 2} y={PT} width={zoneW} height={iH}
                fill="transparent" style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 2.5, background: color1, borderRadius: 2, display: 'inline-block' }} /> {label1}
        </span>
        {key2 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 20, height: 2, background: color2, borderRadius: 2, display: 'inline-block' }} /> {label2}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Bar Chart (horizontal) ─────────────────────────────────────────────────
function HBarChart({ data, colorFn, labelKey = 'group_name', valueKey = 'total', formatValue = fmtAbbr }) {
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(500);

  if (!data || data.length === 0) return <div ref={containerRef} />;

  const maxVal = Math.max(...data.map(d => d[valueKey] || 0), 1);
  const barH = 22, gap = 6, labelW = 110, PR = 48, PT = 8;
  const H = PT + data.length * (barH + gap) + 8;
  const barAreaW = W - labelW - PR;

  return (
    <div ref={containerRef} style={{ width: '100%', overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', overflow: 'hidden', fontFamily: 'inherit', direction: 'ltr' }}>
        {data.map((d, i) => {
          const y = PT + i * (barH + gap);
          const barW = Math.max(2, (d[valueKey] / maxVal) * barAreaW);
          const color = typeof colorFn === 'function' ? colorFn(i, d) : CHART_COLORS[i % CHART_COLORS.length];
          const isH = hovered === i;
          const label = String(d[labelKey] || '').slice(0, 22);
          const valLabel = `${formatValue(d[valueKey] || 0)}${d.pct !== undefined ? ` (${d.pct}%)` : ''}`;
          const isWide = barW > barAreaW * 0.55;
          const textX = isWide ? labelW + barW - 6 : labelW + barW + 5;
          const textAnchor = isWide ? 'end' : 'start';
          const textColor = isWide ? '#fff' : (isH ? 'var(--text)' : 'var(--text-2)');
          return (
            <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style={{ cursor: 'default' }}>
              <text x={labelW - 6} y={y + barH / 2 + 4} textAnchor="end" fontSize="11"
                fill={isH ? 'var(--text)' : 'var(--text-2)'} fontWeight={isH ? '600' : '400'}>
                {label}
              </text>
              <rect x={labelW} y={y} width={barAreaW} height={barH} fill="var(--bg)" rx={3} />
              <rect x={labelW} y={y} width={barW} height={barH} fill={color} rx={3} opacity={isH ? 1 : 0.82} />
              <text x={textX} y={y + barH / 2 + 4} textAnchor={textAnchor} fontSize="11"
                fill={textColor} fontWeight={isH ? '600' : '400'}>
                {valLabel}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Vertical Bar Chart ─────────────────────────────────────────────────────
function VBarChart({ data, color = '#1B4F72', labelKey = 'month', valueKey = 'value' }) {
  const [hovered, setHovered] = useState(null);
  const [containerRef, W] = useContainerWidth(500);

  if (!data || data.length === 0) return <div ref={containerRef} />;

  const vals = data.map(d => d[valueKey] || 0);
  const maxV = niceMax(Math.max(...vals, 1));
  const PL = 50, PR = 16, PT = 18, PB = 36;
  const H = 200;
  const iW = W - PL - PR, iH = H - PT - PB;
  const barSlot = iW / data.length;
  const barW = Math.min(Math.max(barSlot * 0.6, 6), 50);
  const yScale = v => iH - (v / maxV) * iH;
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => maxV * (i / (tickCount - 1)));
  const showLabel = i => data.length <= 12 ? true : data.length <= 18 ? i % 2 === 0 : i % 3 === 0;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', fontFamily: 'inherit', overflow: 'visible', direction: 'ltr' }}>
        {yTicks.map((v, i) => {
          const y = PT + yScale(v);
          return (
            <g key={i}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#E5E7EB" strokeWidth={i === 0 ? 1.5 : 1} strokeDasharray={i === 0 ? '0' : '4,4'} />
              <text x={PL - 5} y={y + 4} textAnchor="end" fontSize="10" fill="#9CA3AF">{fmtAbbr(v)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const cx = PL + i * barSlot + barSlot / 2;
          const barH = iH - yScale(vals[i]);
          const barY = PT + yScale(vals[i]);
          const isH = hovered === i;
          const lbl = String(d[labelKey] || '');
          return (
            <g key={i}>
              <rect x={cx - barW / 2} y={barY} width={barW} height={Math.max(barH, 1)}
                fill={color} rx={3} opacity={isH ? 1 : 0.78} />
              {showLabel(i) && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize="10"
                  fill={isH ? 'var(--text)' : '#9CA3AF'} fontWeight={isH ? '700' : '400'}>
                  {fmtMonth(lbl) || lbl.slice(0, 8)}
                </text>
              )}
              {isH && (
                <ChartTooltip anchorX={cx} anchorY={barY} svgWidth={W} visible>
                  <div style={{ fontWeight: 700 }}>{fmtMonth(lbl) || lbl}</div>
                  <div style={{ color: '#6EE7B7' }}>{fmtAbbr(vals[i])}</div>
                </ChartTooltip>
              )}
              <rect x={cx - barSlot / 2} y={PT} width={barSlot} height={iH}
                fill="transparent" onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Donut Chart ───────────────────────────────────────────────────────────
function DonutChart({ data, labelKey = 'group_name', valueKey = 'total', size = 200 }) {
  const [hovered, setHovered] = useState(null);
  if (!data || data.length === 0) return null;

  const total = data.reduce((s, d) => s + (d[valueKey] || 0), 0);
  if (total === 0) return null;

  const cx = size / 2, cy = size / 2;
  const R = size * 0.38, r = size * 0.22;

  let startAngle = -Math.PI / 2;
  const slices = data.slice(0, 8).map((d, i) => {
    const angle = (d[valueKey] / total) * 2 * Math.PI;
    const mid = startAngle + angle / 2;
    const slice = { ...d, startAngle, angle, mid, color: CHART_COLORS[i % CHART_COLORS.length] };
    startAngle += angle;
    return slice;
  });

  function arc(sa, a, outer, inner) {
    const ea = sa + a;
    const largeArc = a > Math.PI ? 1 : 0;
    const x1 = cx + outer * Math.cos(sa), y1 = cy + outer * Math.sin(sa);
    const x2 = cx + outer * Math.cos(ea), y2 = cy + outer * Math.sin(ea);
    const x3 = cx + inner * Math.cos(ea), y3 = cy + inner * Math.sin(ea);
    const x4 = cx + inner * Math.cos(sa), y4 = cy + inner * Math.sin(sa);
    return `M ${x1} ${y1} A ${outer} ${outer} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
  }

  const hov = hovered !== null ? slices[hovered] : null;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ display: 'block', overflow: 'visible', direction: 'ltr' }}>
      {slices.map((s, i) => (
        <path key={i} d={arc(s.startAngle, s.angle, hovered === i ? R + 6 : R, r)}
          fill={s.color} opacity={hovered === null || hovered === i ? 1 : 0.65}
          style={{ cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
      ))}
      {hov ? (
        <>
          <text x={cx} y={cy - 8} textAnchor="middle" fontSize="11" fill="var(--text-2)" fontWeight="500">
            {String(hov[labelKey]).slice(0, 14)}
          </text>
          <text x={cx} y={cy + 8} textAnchor="middle" fontSize="13" fill="var(--text)" fontWeight="700">
            {hov.pct !== undefined ? `${hov.pct}%` : fmtAbbr(hov[valueKey])}
          </text>
          <text x={cx} y={cy + 22} textAnchor="middle" fontSize="10" fill="var(--text-3)">
            {fmtAbbr(hov[valueKey])}
          </text>
        </>
      ) : (
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="var(--text-3)">
          hover
        </text>
      )}
    </svg>
  );
}

// ── Aging Bucket Bar ─────────────────────────────────────────────────────────
function AgingBucketBar({ summary }) {
  const grand = Object.values(summary).reduce((s, b) => s + (b.total || 0), 0);
  if (grand === 0) return null;

  const buckets = [
    { key: 'current', label: 'Current', color: '#27AE60' },
    { key: '1_30',    label: '1–30d',   color: '#F39C12' },
    { key: '31_60',   label: '31–60d',  color: '#E67E22' },
    { key: '61_90',   label: '61–90d',  color: '#C0392B' },
    { key: 'over_90', label: '90+d',    color: '#7B241C' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', marginBottom: 10 }}>
        {buckets.map(b => {
          const pct = (summary[b.key]?.total || 0) / grand * 100;
          if (pct < 0.5) return null;
          return (
            <div key={b.key} title={`${b.label}: ${pct.toFixed(1)}%`}
              style={{ width: `${pct}%`, background: b.color, transition: 'width 0.4s' }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11 }}>
        {buckets.map(b => (
          <span key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, display: 'inline-block' }} />
            <span style={{ color: 'var(--text-3)' }}>{b.label}</span>
            <span style={{ fontWeight: 600 }}>{fmt(summary[b.key]?.total || 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Export helpers ─────────────────────────────────────────────────────────
// `columns` shape is shared by both: [{label, value(row), align?}, ...]
// — keep them aligned so each sub-report can hand one array to both exporters.

function exportXLSX(rows, columns, filename) {
  const headers = columns.map(c => c.label);
  const data = rows.map(r => columns.map(c => c.value(r)));
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, filename);
}

// Drop-in dual-format export buttons used by every sub-report panel.
// `pdfTitle` becomes the document title in the printable header; `subtitle`
// is the optional second line (e.g. the active date range).
function ExportButtons({ rows, columns, baseName, pdfTitle, subtitle, meta, totals, t }) {
  const empty = !rows || rows.length === 0;
  function doExcel() {
    if (empty) return;
    exportXLSX(rows, columns, `${baseName}.xlsx`);
  }
  function doPdf() {
    if (empty) return;
    exportReportPDF({
      title:    pdfTitle,
      subtitle: subtitle || '',
      filename: `${baseName}.pdf`,
      columns,
      rows,
      meta,
      totals,
    });
  }
  return (
    <div style={{ display: 'inline-flex', gap: 6 }}>
      <button className="btn btn-sm btn-secondary" onClick={doExcel} disabled={empty}
              title={t('reports.exportExcel')}>
        {t('reports.exportExcel')}
      </button>
      <button className="btn btn-sm btn-secondary" onClick={doPdf} disabled={empty}
              title={t('reports.exportPDF')}>
        {t('reports.exportPDF')}
      </button>
    </div>
  );
}

// ── Date range bar ─────────────────────────────────────────────────────────
function DateRangeBar({ preset, custom, onPreset, onCustom, onApply, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {['month', '3months', 'year', 'custom'].map(p => (
        <button key={p}
          className={`btn btn-sm${preset === p ? ' btn-primary' : ' btn-secondary'}`}
          onClick={() => onPreset(p)}>
          {t(`reports.${p === '3months' ? 'last3Months' : p === 'month' ? 'thisMonth' : p === 'year' ? 'thisYear' : 'custom'}`)}
        </button>
      ))}
      {preset === 'custom' && (
        <>
          <input type="date" className="form-control" style={{ width: 140, fontSize: 12 }}
            value={custom.start} onChange={e => onCustom({ ...custom, start: e.target.value })} />
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('reports.to')}</span>
          <input type="date" className="form-control" style={{ width: 140, fontSize: 12 }}
            value={custom.end} onChange={e => onCustom({ ...custom, end: e.target.value })} />
          <button className="btn btn-sm btn-primary" onClick={onApply}>{t('reports.apply')}</button>
        </>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  REPORT PANELS
// ═══════════════════════════════════════════════════════════════════════════

// ── Financial Summary Panel ────────────────────────────────────────────────
function FinancialReport({ params, t }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportFinancial(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const noData = data.monthly.length === 0;

  const financialCols = [
    { label: 'Month',    value: r => r.month,    align: 'left'  },
    { label: 'Income',   value: r => r.income,   align: 'right' },
    { label: 'Expenses', value: r => r.expenses, align: 'right' },
    { label: 'Profit',   value: r => r.profit,   align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalIncome')}   value={fmt(data.total_income)}   color="green" />
        <StatCard label={t('reports.totalExpenses')} value={fmt(data.total_expenses)} color="red" />
        <StatCard label={t('reports.netProfit')}     value={fmt(data.net_profit)}     color={data.net_profit >= 0 ? 'green' : 'red'}
          sub={data.total_income > 0 ? `${data.margin_pct}% margin` : undefined} />
        <StatCard label={t('reports.totalInvoiced')} value={fmt(data.total_invoiced)} />
        <StatCard label={t('reports.outstanding')}   value={fmt(data.outstanding)}    color={data.outstanding > 0 ? 'red' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.incomeVsExpenses')}</span>
            <ExportButtons
              rows={data.monthly} columns={financialCols}
              baseName="financial_report" pdfTitle={t('reports.financial')} t={t} />

          </div>
          <div className="card-body">
            {noData
              ? <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noData')}</div>
              : <LineChart data={data.monthly} label1={t('reports.income')} label2={t('reports.expenses')} key1="income" key2="expenses" />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.expensesByCategory')}</span></div>
          <div className="card-body" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            {data.by_category.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '20px 0' }}>{t('reports.noData')}</div>
              : <>
                  <DonutChart data={data.by_category} size={180} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <HBarChart data={data.by_category} />
                  </div>
                </>
            }
          </div>
        </div>
      </div>

      {data.monthly.length > 0 && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.monthlyBreakdown')}</span></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('reports.month')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.income')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.expenses')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.profit')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.profitMargin')}</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly.map(row => {
                  const margin = row.income > 0 ? Math.round(row.profit / row.income * 100) : 0;
                  return (
                    <tr key={row.month}>
                      <td className="td-primary">{fmtMonth(row.month)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(row.income)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(row.expenses)}</td>
                      <td style={{ textAlign: 'right', color: row.profit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmt(row.profit)}</td>
                      <td style={{ textAlign: 'right', color: margin >= 0 ? 'var(--green)' : 'var(--red)' }}>{margin}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── VAT Summary Panel (Lebanon) ────────────────────────────────────────────
function VatReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportVAT(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  if (!data.vat_enabled) {
    return (
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-3)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            {t('reports.vatDisabledTitle')}
          </div>
          <div style={{ fontSize: 13 }}>{t('reports.vatDisabledHint')}</div>
        </div>
      </div>
    );
  }

  const payable = data.net_vat >= 0;

  const vatCols = [
    { label: 'Month',      value: r => r.month,      align: 'left'  },
    { label: 'Output VAT', value: r => r.output_vat, align: 'right' },
    { label: 'Input VAT',  value: r => r.input_vat,  align: 'right' },
    { label: 'Net VAT',    value: r => r.net_vat,    align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <StatCard label={t('reports.vatOutput')} value={fmt(data.output.vat)} color="green"
          sub={`${t('reports.vatOnSales')} ${fmt(data.output.gross)}`} />
        <StatCard label={t('reports.vatInput')} value={fmt(data.input.vat)} color="red"
          sub={`${t('reports.vatOnPurchases')} ${fmt(data.input.gross)}`} />
        <StatCard label={payable ? t('reports.vatNetPayable') : t('reports.vatNetReclaim')}
          value={fmt(Math.abs(data.net_vat))} color={payable ? 'red' : 'green'}
          sub={`${t('reports.vatRate')}: ${data.rate}%`} />
      </div>

      <div className="alert alert-blue" style={{ marginBottom: 16, fontSize: 12.5 }}>
        {t('reports.vatEstimateNote')}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.vatMonthly')}</span>
          {data.monthly.length > 0 && (
            <ExportButtons
              rows={data.monthly} columns={vatCols}
              baseName="vat_report" pdfTitle={t('reports.vat') || 'VAT Report'} t={t} />
          )}
        </div>
        {data.monthly.length === 0
          ? <div className="card-body" style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noData')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.month')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatOutput')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatInput')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatNet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.monthly.map(row => (
                    <tr key={row.month}>
                      <td className="td-primary">{fmtMonth(row.month)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(row.output_vat)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(row.input_vat)}</td>
                      <td style={{ textAlign: 'right', color: row.net_vat >= 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{fmt(row.net_vat)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                    <td style={{ padding: '10px 14px' }}>{t('reports.total')}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--green)' }}>{fmt(data.output.vat)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--red)' }}>{fmt(data.input.vat)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: payable ? 'var(--red)' : 'var(--green)' }}>{fmt(data.net_vat)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Project Profitability Panel ────────────────────────────────────────────
function ProjectsReport({ params, t }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportProjects({ ...params, ...(statusFilter ? { status: statusFilter } : {}) }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), statusFilter]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;

  const profitable = data.filter(p => p.profit > 0).length;
  const atLoss     = data.filter(p => p.profit < 0).length;
  const totalRev   = data.reduce((s, p) => s + (p.expected_revenue || 0), 0);
  const totalExp   = data.reduce((s, p) => s + (p.actual_expenses || 0), 0);

  const STATUSES = ['', 'Inquiry', 'Quotation Sent', 'Approved', 'In Progress', 'Completed', 'Invoiced'];

  const projectCols = [
    { label: 'Project',          value: r => r.name,                  align: 'left'  },
    { label: 'Client',           value: r => r.client_name || '',     align: 'left'  },
    { label: 'Status',           value: r => r.status,                align: 'left'  },
    { label: 'Expected Revenue', value: r => r.expected_revenue || 0, align: 'right' },
    { label: 'Estimated Cost',   value: r => r.estimated_cost || 0,   align: 'right' },
    { label: 'Actual Expenses',  value: r => r.actual_expenses || 0,  align: 'right' },
    { label: 'Collected',        value: r => r.collected || 0,        align: 'right' },
    { label: 'Profit',           value: r => r.profit || 0,           align: 'right' },
    { label: 'Margin %',         value: r => r.margin_pct || 0,       align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('common.total')}          value={data.length}       sub={t('nav.projects')} />
        <StatCard label={t('reports.profitableLabel')} value={profitable}      color="green" />
        <StatCard label={t('reports.lossLabel')}     value={atLoss}            color={atLoss > 0 ? 'red' : undefined} />
        <StatCard label={t('reports.expectedRevenue')} value={fmt(totalRev)}   color="green" />
        <StatCard label={t('reports.actualExpenses')} value={fmt(totalExp)}    color="red" />
        <StatCard label={t('reports.projectProfit')} value={fmt(totalRev - totalExp)} color={totalRev - totalExp >= 0 ? 'green' : 'red'} />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.projects')}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="form-control" style={{ width: 160, fontSize: 12 }}
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              {STATUSES.map(s => (
                <option key={s} value={s}>{s || t('reports.allStatuses')}</option>
              ))}
            </select>
            <ExportButtons
              rows={data} columns={projectCols}
              baseName="project_profitability" pdfTitle={t('reports.projectProfit') || 'Project Profitability'} t={t} />
          </div>
        </div>
        {data.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noProjects')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.projectName')}</th>
                    <th>{t('reports.client')}</th>
                    <th>{t('reports.status')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.expectedRevenue')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.actualExpenses')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.collected')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.projectProfit')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.margin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(p => (
                    <tr key={p.id}>
                      <td className="td-primary">
                        <Link to={`/projects/${p.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{p.name}</Link>
                      </td>
                      <td>{p.client_name || '—'}</td>
                      <td><Badge status={p.status} /></td>
                      <td style={{ textAlign: 'right' }}>{fmt(p.expected_revenue)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(p.actual_expenses)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }}>{fmt(p.collected)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: p.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {p.profit >= 0 ? '+' : ''}{fmt(p.profit)}
                      </td>
                      <td style={{ textAlign: 'right', color: p.margin_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {p.margin_pct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Client Revenue Panel ───────────────────────────────────────────────────
function ClientsReport({ params, t }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportClients(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;

  const activeClients = data.filter(c => c.total_paid > 0);
  const totalPaid     = data.reduce((s, c) => s + (c.total_paid || 0), 0);
  const totalOutstanding = data.reduce((s, c) => s + (c.outstanding || 0), 0);
  const top10 = data.slice(0, 10);

  const clientCols = [
    { label: 'Client',         value: r => r.name,             align: 'left'  },
    { label: 'Company',        value: r => r.company || '',    align: 'left'  },
    { label: 'Type',           value: r => r.type || '',       align: 'left'  },
    { label: 'Projects',       value: r => r.project_count,    align: 'right' },
    { label: 'Invoices',       value: r => r.invoice_count,    align: 'right' },
    { label: 'Quotes',         value: r => r.quote_count,      align: 'right' },
    { label: 'Total Invoiced', value: r => r.total_invoiced,   align: 'right' },
    { label: 'Total Paid',     value: r => r.total_paid,       align: 'right' },
    { label: 'Outstanding',    value: r => r.outstanding,      align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('nav.clients')}           value={data.length}           sub={t('common.total')} />
        <StatCard label="Active Clients"             value={activeClients.length}  color="green" />
        <StatCard label={t('reports.totalPaid')}     value={fmt(totalPaid)}        color="green" />
        <StatCard label={t('reports.outstanding')}   value={fmt(totalOutstanding)} color={totalOutstanding > 0 ? 'red' : undefined} />
      </div>

      {top10.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">{t('reports.topByRevenue')}</span></div>
          <div className="card-body">
            <HBarChart data={top10} labelKey="name" valueKey="total_paid" />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.clients')}</span>
          <ExportButtons
            rows={data} columns={clientCols}
            baseName="client_revenue" pdfTitle={t('reports.clientRevenue') || 'Client Revenue'} t={t} />
        </div>
        {data.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noClients')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.clientName')}</th>
                    <th>{t('reports.company')}</th>
                    <th>{t('reports.type')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.projectCount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.invoiceCount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('clients.totalInvoiced')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.totalPaid')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.outstanding')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(c => (
                    <tr key={c.id}>
                      <td className="td-primary">
                        <Link to={`/clients/${c.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{c.name}</Link>
                      </td>
                      <td>{c.company || '—'}</td>
                      <td><span className="badge badge-gray">{c.type || '—'}</span></td>
                      <td style={{ textAlign: 'right' }}>{c.project_count}</td>
                      <td style={{ textAlign: 'right' }}>{c.invoice_count}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(c.total_invoiced)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(c.total_paid)}</td>
                      <td style={{ textAlign: 'right', color: c.outstanding > 0 ? 'var(--red)' : 'var(--text-3)' }}>{fmt(c.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Invoice Aging Panel ────────────────────────────────────────────────────
function AgingReport({ t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    getReportInvoiceAging()
      .then(setData).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const { summary, invoices } = data;
  const totalUnpaid = Object.values(summary).reduce((s, b) => s + (b.total || 0), 0);
  const totalCount  = Object.values(summary).reduce((s, b) => s + (b.count || 0), 0);

  const bucketLabels = {
    current: { label: t('reports.current'),   color: 'green' },
    '1_30':  { label: t('reports.days1_30'),  color: 'yellow' },
    '31_60': { label: t('reports.days31_60'), color: 'orange' },
    '61_90': { label: t('reports.days61_90'), color: 'red' },
    over_90: { label: t('reports.over90'),    color: 'red' },
  };

  const agingCols = [
    { label: 'Invoice #',    value: r => r.invoice_number,    align: 'left'  },
    { label: 'Client',       value: r => r.client_name || '', align: 'left'  },
    { label: 'Project',      value: r => r.project_name || '',align: 'left'  },
    { label: 'Amount',       value: r => r.amount,            align: 'right' },
    { label: 'Paid',         value: r => r.paid_amount,       align: 'right' },
    { label: 'Remaining',    value: r => r.remaining,         align: 'right' },
    { label: 'Due Date',     value: r => r.due_date || '',    align: 'left'  },
    { label: 'Days Overdue', value: r => r.days_overdue,      align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalUnpaid')}  value={fmt(totalUnpaid)} color={totalUnpaid > 0 ? 'red' : undefined} />
        <StatCard label={t('reports.invoiceCount2')} value={totalCount} />
        {Object.entries(bucketLabels).map(([k, { label, color }]) => (
          <StatCard key={k} label={label}
            value={fmt(summary[k]?.total || 0)}
            sub={`${summary[k]?.count || 0} invoice${(summary[k]?.count || 0) !== 1 ? 's' : ''}`}
            color={summary[k]?.total > 0 && k !== 'current' ? color : undefined} />
        ))}
      </div>

      {totalUnpaid > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">{t('reports.agingChart')}</span></div>
          <div className="card-body"><AgingBucketBar summary={summary} /></div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.aging')}</span>
          <ExportButtons
            rows={invoices} columns={agingCols}
            baseName="invoice_aging" pdfTitle={t('reports.aging') || 'Invoice Aging'} t={t} />
        </div>
        {invoices.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--green)', fontSize: 13 }}>{t('reports.noOverdue')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.invoiceNumber')}</th>
                    <th>{t('reports.client')}</th>
                    <th>{t('common.project')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('clients.paid')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.remaining')}</th>
                    <th>{t('reports.dueDate')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.daysOverdue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => {
                    const ov = inv.days_overdue || 0;
                    const ovColor = ov === 0 ? 'var(--green)' : ov <= 30 ? 'var(--yellow)' : ov <= 60 ? 'var(--orange, #e67e22)' : 'var(--red)';
                    return (
                      <tr key={inv.id}>
                        <td className="td-primary">{inv.invoice_number}</td>
                        <td>{inv.client_name || '—'}</td>
                        <td>{inv.project_name || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(inv.amount)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--green)' }}>{fmt(inv.paid_amount)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--red)' }}>{fmt(inv.remaining)}</td>
                        <td style={{ color: ov > 0 ? 'var(--red)' : undefined }}>{fmtDate(inv.due_date)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: ovColor }}>
                          {ov === 0 ? '—' : `+${ov}d`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Expense Analysis Panel ─────────────────────────────────────────────────
function ExpensesReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [groupBy, setGroupBy] = useState('category');
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportExpenses({ ...params, group_by: groupBy }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), groupBy]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const expenseCols = [
    { label: 'Group',   value: r => r.group_name, align: 'left'  },
    { label: 'Amount',  value: r => r.total,      align: 'right' },
    { label: 'Count',   value: r => r.count,      align: 'right' },
    { label: 'Share %', value: r => r.pct,        align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalExpensesLabel')} value={fmt(data.total)}   color="red" />
        <StatCard label={t('common.total')}               value={data.count}        sub="records" />
        <StatCard label={t('reports.avgExpense')}         value={fmt(data.average)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.expenseBreakdown')}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="form-control" style={{ width: 130, fontSize: 12 }}
                value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="category">{t('reports.byCategory')}</option>
                <option value="project">{t('reports.byProject')}</option>
                <option value="month">{t('reports.byMonth')}</option>
              </select>
              <ExportButtons
                rows={data.breakdown} columns={expenseCols}
                baseName="expense_analysis" pdfTitle={t('reports.expenseAnalysis') || 'Expense Analysis'} t={t} />
            </div>
          </div>
          <div className="card-body">
            {data.breakdown.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noExpenses')}</div>
              : groupBy === 'month'
                ? <VBarChart data={data.breakdown} labelKey="group_name" valueKey="total" color="#C0392B" />
                : <HBarChart data={data.breakdown} labelKey="group_name" valueKey="total"
                    colorFn={i => CHART_COLORS[i % CHART_COLORS.length]} />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.expensesByCategory')}</span></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center' }}>
            {data.breakdown.length > 0
              ? <DonutChart data={data.breakdown} size={200} />
              : <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '20px 0' }}>{t('reports.noExpenses')}</div>
            }
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">{t('reports.expensesReport')}</span></div>
        {data.breakdown.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noExpenses')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.groupName')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.amount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.count')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.share')}</th>
                    <th>Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((row, i) => (
                    <tr key={i}>
                      <td className="td-primary">{row.group_name}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontWeight: 600 }}>{fmt(row.total)}</td>
                      <td style={{ textAlign: 'right' }}>{row.count}</td>
                      <td style={{ textAlign: 'right' }}>{row.pct}%</td>
                      <td style={{ paddingRight: 20 }}>
                        <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden', minWidth: 60 }}>
                          <div style={{ width: `${row.pct}%`, height: '100%', background: CHART_COLORS[i % CHART_COLORS.length], borderRadius: 4 }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Sales Pipeline Panel ───────────────────────────────────────────────────
function PipelineReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportPipeline(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const STATUS_COLORS = {
    Draft: '#9CA3AF', Sent: '#2E86C1', Accepted: '#27AE60',
    Rejected: '#C0392B', Invoiced: '#8E44AD',
  };

  const pipelineCols = [
    { label: 'Status', value: r => r.status, align: 'left'  },
    { label: 'Count',  value: r => r.count,  align: 'right' },
    { label: 'Value',  value: r => r.value,  align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalQuotes')}     value={data.total_count}         />
        <StatCard label={t('reports.totalQuoteValue')} value={fmt(data.total_value)}    color="green" />
        <StatCard label={t('reports.convertedQuotes')} value={data.converted_count}     color="green" />
        <StatCard label={t('reports.conversionRate')}  value={`${data.conversion_rate}%`}
          color={data.conversion_rate >= 50 ? 'green' : data.conversion_rate >= 25 ? undefined : 'red'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.byStatusCount')}</span>
            <ExportButtons
              rows={data.by_status} columns={pipelineCols}
              baseName="sales_pipeline" pdfTitle={t('reports.pipeline') || 'Sales Pipeline'} t={t} />
          </div>
          <div className="card-body">
            {data.by_status.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noPipeline')}</div>
              : <HBarChart data={data.by_status} labelKey="status" valueKey="count"
                  formatValue={fmtCountAbbr}
                  colorFn={(i, d) => STATUS_COLORS[d.status] || CHART_COLORS[i % CHART_COLORS.length]} />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.monthlyVolume')}</span></div>
          <div className="card-body">
            {data.monthly.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noPipeline')}</div>
              : <VBarChart data={data.monthly} labelKey="month" valueKey="count" color="#2E86C1" />
            }
          </div>
        </div>
      </div>

      {data.by_status.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">{t('reports.byStatus')} — Value</span></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.status')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.count')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.value')}</th>
                    <th style={{ textAlign: 'right' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_status.map(row => (
                    <tr key={row.status}>
                      <td><Badge status={row.status} /></td>
                      <td style={{ textAlign: 'right' }}>{row.count}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(row.value)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {data.total_count > 0 ? Math.round(row.count / data.total_count * 100) : 0}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {data.top_clients.length > 0 && (
            <div className="card">
              <div className="card-header"><span className="card-title">{t('reports.topClients')}</span></div>
              <div className="card-body">
                <HBarChart data={data.top_clients} labelKey="client_name" valueKey="value" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN REPORTS PAGE
// ═══════════════════════════════════════════════════════════════════════════
// ── Branch comparison (multi-branch) ────────────────────────────────────────
// Super Admin's side-by-side P&L per branch for the selected range. Reuses the
// standard date range. Only mounted when the user can reach >1 branch.
function BranchComparisonReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true); setError(null);
    getBranchComparison(params, ctrl.signal)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false); } });
    return () => ctrl.abort();
  }, [params]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  const rows   = data?.branches || [];
  const totals = data?.totals || { income: 0, expenses: 0, profit: 0, invoiced: 0 };

  return (
    <div className="card">
      <div className="card-body">
        <div className="table-responsive">
          <table className="table">
            <thead>
              <tr>
                <th>{t('nav.branch')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.income')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.expenses')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.profit')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.invoiced')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.name}{r.is_default ? <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('reports.defaultBranch')}</span> : null}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.income)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.expenses)}</td>
                  <td style={{ textAlign: 'end', color: r.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(r.profit)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.invoiced)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)' }}>{t('common.noData') || '—'}</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>{t('reports.total')}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.income)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.expenses)}</td>
                  <td style={{ textAlign: 'end', color: totals.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(totals.profit)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.invoiced)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

export default function Reports() {
  const { t } = useLocale();
  const [activeReport, setActiveReport] = usePersistedState('reports_active', 'financial');
  // Branch comparison tab appears only for global users (superadmin / owner)
  // who can actually see more than one branch.
  const [multiBranch, setMultiBranch] = useState(false);
  useEffect(() => {
    let alive = true;
    getBranchContext()
      .then(d => { if (alive) setMultiBranch(!!(d && d.is_global) && ((d && d.branches) || []).length > 1); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [preset, setPreset]             = usePersistedState('reports_preset', 'year');
  const [custom, setCustom]             = usePersistedState('reports_custom', {
    start: `${new Date().getFullYear()}-01-01`,
    end:   new Date().toISOString().slice(0, 10),
  });
  const [appliedRange, setAppliedRange] = useState(getRange(preset, custom));

  useEffect(() => {
    if (preset !== 'custom') {
      setAppliedRange(getRange(preset, custom));
    }
  }, [preset]);

  function handlePreset(p) {
    setPreset(p);
    if (p !== 'custom') setAppliedRange(getRange(p, custom));
  }

  function handleApply() {
    setAppliedRange(getRange('custom', custom));
  }

  const REPORTS = [
    { key: 'financial',   label: t('reports.financial')      },
    { key: 'projects',    label: t('reports.projects')       },
    { key: 'clients',     label: t('reports.clients')        },
    { key: 'aging',       label: t('reports.aging')          },
    { key: 'expenses',    label: t('reports.expensesReport') },
    { key: 'pipeline',    label: t('reports.pipeline')       },
    { key: 'vat',         label: t('reports.vat')            },
    { key: 'whValuation', label: t('reports.whValuation') || 'Inventory by Warehouse' },
    ...(multiBranch ? [{ key: 'branches', label: t('reports.branchComparison') }] : []),
  ];

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">{t('reports.title')}</h1>
          <p className="page-subtitle">{t('reports.subtitle')}</p>
        </div>
      </div>

      {/* Date range bar */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <DateRangeBar
            preset={preset} custom={custom}
            onPreset={handlePreset} onCustom={setCustom}
            onApply={handleApply} t={t}
          />
        </div>
      </div>

      {/* Tabs — same pattern as ProjectDetail */}
      <div className="tabs">
        {REPORTS.map(r => (
          <button
            key={r.key}
            className={`tab-btn${activeReport === r.key ? ' active' : ''}`}
            onClick={() => setActiveReport(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Report content — full width */}
      {activeReport === 'financial' && <FinancialReport params={appliedRange} t={t} />}
      {activeReport === 'projects'  && <ProjectsReport  params={appliedRange} t={t} />}
      {activeReport === 'clients'   && <ClientsReport   params={appliedRange} t={t} />}
      {activeReport === 'aging'     && <AgingReport      t={t} />}
      {activeReport === 'expenses'  && <ExpensesReport   params={appliedRange} t={t} />}
      {activeReport === 'pipeline'  && <PipelineReport   params={appliedRange} t={t} />}
      {activeReport === 'vat'       && <VatReport        params={appliedRange} t={t} />}
      {activeReport === 'whValuation' && <WarehouseValuationReport t={t} />}
      {activeReport === 'branches'  && <BranchComparisonReport params={appliedRange} t={t} />}
    </div>
  );
}


/**
 * Inventory Valuation by Warehouse — Phase 3 of the multi-warehouse rollout.
 *
 * Per-warehouse rows + a totals row that ties to the GL Inventory account (one
 * company-wide account, deliberate design decision). Plus a "Top 25 SKUs by
 * value" table with the warehouse holding the largest share — answers "what's
 * tying up our capital and where?" in one glance.
 *
 * No date range: this is a point-in-time snapshot. Valuation uses the company-
 * wide `inventory.unit_cost` since per-warehouse costing was deliberately
 * postponed in the design.
 */
function WarehouseValuationReport({ t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getInventoryByWarehouseReport()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)         return <LoadingSpinner />;
  if (error)           return <ErrorAlert message={error} />;
  if (!data)           return null;

  const { warehouses = [], totals = {}, top_skus = [] } = data;
  const TYPE_COLOR = {
    Main:'var(--blue)', Branch:'var(--accent)', Production:'var(--purple)',
    Damaged:'var(--red)', Transit:'var(--yellow)', Returns:'var(--text-3)',
  };
  // Map backend type → localized label. The DB stores canonical English type
  // codes ("Main", "Branch", …) — the UI renders the operator's language.
  const TYPE_LABEL = {
    Main:       t('reports.whTypeMain'),
    Branch:     t('reports.whTypeBranch'),
    Production: t('reports.whTypeProduction'),
    Damaged:    t('reports.whTypeDamaged'),
    Transit:    t('reports.whTypeTransit'),
    Returns:    t('reports.whTypeReturns'),
  };

  // Excel export of the same data the user is looking at — header labels follow
  // the active language so an AR operator gets an Arabic-headed workbook.
  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.json_to_sheet(
      warehouses.map(w => ({
        [t('reports.whCode')]:      w.code,
        [t('reports.whWarehouse')]: w.name,
        [t('reports.whType')]:      TYPE_LABEL[w.type] || w.type,
        [t('reports.whSkus')]:      w.sku_count,
        [t('reports.whQuantity')]:  w.qty_total,
        [t('reports.whValueUsd')]:  w.value,
      }))
    );
    XLSX.utils.book_append_sheet(wb, sheet1, t('reports.whValuation'));
    const sheet2 = XLSX.utils.json_to_sheet(
      top_skus.map(s => ({
        [t('reports.whItem')]:            s.name,
        [t('reports.whCategory')]:        s.category || '',
        [t('reports.whQuantity')]:        s.qty_total,
        [t('reports.whUnitCost')]:        s.unit_cost,
        [t('reports.whValueUsd')]:        s.value,
        [t('reports.whPrimaryLocation')]: s.top_warehouse_code || '',
      }))
    );
    XLSX.utils.book_append_sheet(wb, sheet2, t('reports.whTopTitle'));
    XLSX.writeFile(wb, `Inventory-by-Warehouse-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t('reports.whTitle')}</div>
            <div className="card-subtitle">{t('reports.whSubtitle')}</div>
          </div>
          <button className="btn btn-sm btn-outline" onClick={exportXlsx}>{t('reports.whExport')}</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reports.whCode')}</th><th>{t('reports.whWarehouse')}</th><th>{t('reports.whType')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whSkus')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whQuantity')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whValueUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map(w => (
                <tr key={w.id}>
                  <td className="td-mono">{w.code}</td>
                  <td className="td-primary">
                    {w.name}
                    {w.is_default ? <span className="badge badge-blue" style={{ marginInlineStart: 8 }}>{t('reports.whDefault')}</span> : null}
                  </td>
                  <td>
                    <span className="badge" style={{
                      background: (TYPE_COLOR[w.type] || 'var(--text-3)') + '20',
                      color: TYPE_COLOR[w.type] || 'var(--text-3)',
                      border: `1px solid ${(TYPE_COLOR[w.type] || 'var(--text-3)')}40`,
                    }}>{TYPE_LABEL[w.type] || w.type}</span>
                  </td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{w.sku_count}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(w.qty_total).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }} className="td-primary">{fmt(w.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td colSpan={3} style={{ textAlign: 'right' }}>{t('reports.whTotalGl')}</td>
                <td style={{ textAlign: 'right' }} className="td-mono">{totals.sku_count}</td>
                <td style={{ textAlign: 'right' }} className="td-mono">{Number(totals.qty_total).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="td-primary">{fmt(totals.value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t('reports.whTopTitle')}</div>
            <div className="card-subtitle">{t('reports.whTopSubtitle')}</div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reports.whItem')}</th>
                <th>{t('reports.whCategory')}</th>
                <th>{t('reports.whPrimaryLocation')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whQuantity')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whUnitCost')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whValueUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {top_skus.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>{t('reports.whNoStock')}</td></tr>
              ) : top_skus.map(s => (
                <tr key={s.id}>
                  <td className="td-primary">{s.name}</td>
                  <td>{s.category || '—'}</td>
                  <td className="td-mono">{s.top_warehouse_code || '—'}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(s.qty_total).toLocaleString()} {s.unit || ''}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.unit_cost)}</td>
                  <td style={{ textAlign: 'right' }} className="td-primary">{fmt(s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
