import { useState, useEffect, useRef } from 'react';
import { Badge, fmt, fmtDate } from '../../components/shared';
import { exportReportPDF } from '../../utils/exportUtils.js';
import * as XLSX from 'xlsx';

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
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
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
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', fontFamily: 'inherit', overflow: 'visible', direction: 'ltr' }}>
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

export {
  toISO, getRange, fmtMonth, fmtAbbr, fmtCountAbbr, niceMax, useContainerWidth, CHART_COLORS,
  ChartTooltip, StatCard, LineChart, HBarChart, VBarChart, DonutChart,
  AgingBucketBar, ExportButtons, DateRangeBar,
};
