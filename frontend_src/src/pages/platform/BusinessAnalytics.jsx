// Per-business analytics — how a customer actually uses Quilit.
//
// Charts are plain inline SVG rather than a library: these are small trend
// sparks, and pulling a charting dependency into the operator console to draw
// a dozen bars would cost more than it returns.
//
// Signals the platform does not instrument arrive under `not_measured` and are
// stated as such. A chart that invents a flat line reads as "no activity",
// which is a different and misleading claim.
import { useEffect, useState } from 'react';
import { LoadingSpinner } from '../../components/shared';
import { pfetch } from './api';

const money = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

// Bar series scaled to its own max — these compare a metric against itself
// over time, never against another metric.
function Bars({ data, valueKey, labelKey, height = 54, color = 'var(--accent)' }) {
  if (!data?.length) {
    return <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '14px 0' }}>No activity recorded.</div>;
  }
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height }}>
        {data.map((d, i) => {
          const v = Number(d[valueKey]) || 0;
          return (
            <div key={i}
              title={`${d[labelKey]}: ${v}`}
              style={{
                flex: 1, minWidth: 3,
                height: `${Math.max(2, (v / max) * 100)}%`,
                background: color, borderRadius: '2px 2px 0 0', opacity: v ? 1 : 0.25,
              }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
        <span>{data[0]?.[labelKey]}</span>
        <span>{data[data.length - 1]?.[labelKey]}</span>
      </div>
    </div>
  );
}

const fmtMB = (n) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);

// A series that is empty because nothing has happened yet is NOT the same as a
// metric we do not collect. Saying so prevents "no data" reading as "broken".
function Pending({ what }) {
  return (
    <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '10px 0' }}>
      No {what} recorded yet — collection starts on first use and is written
      about once a minute.
    </div>
  );
}

function Panel({ title, hint, children }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span className="card-title">{title}</span>
        {hint && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{hint}</span>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

export default function BusinessAnalytics({ slug, name, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    pfetch('GET', `/api/platform/tenants/${slug}/analytics`)
      .then(setD).catch(e => setError(e.message));
  }, [slug]);

  if (error) return <div className="card" style={{ padding: 20, color: 'var(--red)' }}>{error}</div>;
  if (!d) return <LoadingSpinner />;

  const t = d.totals || {};
  const revenue = d.revenue_trend || [];
  const totalCollected = revenue.reduce((s, r) => s + Number(r.collected || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button className="btn btn-sm btn-secondary" onClick={onBack}>← Back</button>
        <div>
          <div style={{ fontWeight: 700 }}>{name || slug}</div>
          <div className="text-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{slug}</div>
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-label">Users</div>
          <div className="stat-value">{t.users_active ?? '—'}<span style={{ fontSize: 13, color: 'var(--text-3)' }}> / {t.users_total ?? '—'}</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Collected (12 mo)</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>{money(totalCollected)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Recorded actions</div>
          <div className="stat-value">{(t.events_total ?? 0).toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Error reports</div>
          <div className="stat-value" style={{ color: d.errors.urgent ? 'var(--red)' : undefined }}>
            {d.errors.total}
          </div>
        </div>
      </div>

      <Panel title="Daily activity" hint="last 30 days · audited actions">
        <Bars data={d.daily_activity} valueKey="events" labelKey="day" />
      </Panel>

      <Panel title="Sign-ins" hint="last 30 days">
        <Bars data={d.login_activity} valueKey="sessions" labelKey="day" color="var(--blue)" />
      </Panel>

      <Panel title="Revenue collected" hint="by month · from invoice payments">
        <Bars data={revenue} valueKey="collected" labelKey="month" color="var(--green)" height={64} />
        {revenue.length > 0 && (
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
            <span>Latest: <strong>{money(revenue[revenue.length - 1]?.collected)}</strong></span>
            <span>{revenue[revenue.length - 1]?.payments} payment(s)</span>
          </div>
        )}
      </Panel>

      {/* The most actionable panel: licensed-but-unused is a sales or support
          conversation, and this is the only place it is visible. */}
      <Panel title="Module usage" hint="last 90 days · what they actually touch">
        {d.module_usage?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Module</th><th style={{ textAlign: 'right' }}>Actions</th><th>Last used</th></tr></thead>
              <tbody>
                {d.module_usage.map(m => (
                  <tr key={m.module}>
                    <td className="td-primary">{m.module}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.events).toLocaleString()}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{String(m.last_used || '').slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div style={{ color: 'var(--text-3)', fontSize: 12 }}>No module activity in the last 90 days.</div>}
      </Panel>

      <Panel title="API requests" hint="last 30 days · per day">
        {d.api_usage?.length ? (
          <>
            <Bars data={d.api_usage} valueKey="requests" labelKey="day" color="var(--accent)" />
            <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
              <span>Total: <strong>{d.api_usage.reduce((a, r) => a + Number(r.requests || 0), 0).toLocaleString()}</strong></span>
              <span>Server errors: <strong style={{ color: d.api_usage.some(r => r.server_errors > 0) ? 'var(--red)' : undefined }}>
                {d.api_usage.reduce((a, r) => a + Number(r.server_errors || 0), 0)}</strong></span>
              <span>Slowest day: <strong>{Math.max(...d.api_usage.map(r => Number(r.max_ms || 0))).toFixed(0)} ms</strong></span>
            </div>
          </>
        ) : <Pending what="request volume" />}
      </Panel>

      {/* Average is total/requests; max is the worst single call that day.
          Together they answer "is this customer's ERP slow?" without the
          machinery a percentile would need. */}
      <Panel title="Response time" hint="average ms per day">
        {d.api_usage?.length
          ? <Bars data={d.api_usage} valueKey="avg_ms" labelKey="day" color="var(--yellow)" />
          : <Pending what="latency" />}
      </Panel>

      <Panel title="Storage growth" hint="database size · one snapshot per day">
        {d.storage_growth?.length
          ? <>
              <Bars data={d.storage_growth} valueKey="db_bytes" labelKey="day" color="var(--blue)" />
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
                Latest: <strong>{fmtMB(d.storage_growth[d.storage_growth.length - 1]?.db_bytes)}</strong>
              </div>
            </>
          : <Pending what="storage history" />}
      </Panel>

      <Panel title="User growth" hint="accounts added per month">
        <Bars data={d.user_growth} valueKey="added" labelKey="month" color="var(--purple)" />
      </Panel>

      {/* Only rendered when something genuinely is not measured. */}
      {Object.keys(d.not_measured || {}).length > 0 && <div className="card">
        <div className="card-body">
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <strong style={{ color: 'var(--text-2)' }}>Not measured yet</strong>
            <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
              {Object.entries(d.not_measured || {}).map(([k, why]) => (
                <li key={k}><code>{k}</code> — {why}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>}
    </div>
  );
}
