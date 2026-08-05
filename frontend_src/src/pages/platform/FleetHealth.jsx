// Fleet health — "which customer needs attention?" at a glance.
//
// The API already sorts worst-first and hands back the REASONS a score is not
// 100, so this screen never has to re-derive judgement: it renders the issues
// the server found. Anything the platform cannot genuinely know (per-tenant
// backups, storage under S3) arrives as null and is shown as "—" rather than
// a fabricated figure.
import { useEffect, useState } from 'react';
import { LoadingSpinner } from '../../components/shared';
import { pfetch } from './api';

const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
};

// Score bands drive the colour, so "needs attention" is visible without reading.
function scoreTone(score) {
  if (score >= 90) return { color: 'var(--green)', bg: 'var(--green-light)', label: 'Healthy' };
  if (score >= 70) return { color: 'var(--yellow)', bg: 'var(--yellow-light)', label: 'Watch' };
  return { color: 'var(--red)', bg: 'var(--red-light)', label: 'Needs attention' };
}

function Stat({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

export default function FleetHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => pfetch('GET', '/api/platform/health')
    .then(setData).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <div className="card" style={{ padding: 20, color: 'var(--red)' }}>{error}</div>;
  if (!data) return <LoadingSpinner />;

  const p = data.platform;

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <Stat label="Businesses" value={p.tenant_count} />
        <Stat label="Need attention" value={p.needs_attention}
              tone={p.needs_attention > 0 ? 'var(--red)' : 'var(--green)'} />
        <Stat label="Open error reports" value={p.open_errors}
              tone={p.open_errors > 0 ? 'var(--yellow)' : undefined} />
        <Stat label="Storage backend" value={p.storage_backend?.toUpperCase() || '—'} />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Business health</span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Worst first</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Health</th>
                <th>Users</th>
                <th>Last sign-in</th>
                <th>Modules</th>
                <th style={{ textAlign: 'right' }}>Database</th>
                <th>Errors</th>
                <th>Licence</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>
                  No businesses yet.
                </td></tr>
              )}
              {data.tenants.map(r => {
                const tone = scoreTone(r.health_score);
                const days = r.days_since_login;
                return (
                  <tr key={r.slug}>
                    <td>
                      <div className="td-primary">{r.name || r.slug}</div>
                      <div className="text-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {r.slug}{r.status !== 'active' && ` · ${r.status}`}
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: tone.bg, color: tone.color, fontWeight: 700 }}>
                        {r.health_score}
                      </span>
                      {/* The server says WHY, so the operator knows what to do. */}
                      {r.issues?.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3, maxWidth: 230 }}>
                          {r.issues.join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>{r.users_active ?? '—'}{r.users_total != null && ` / ${r.users_total}`}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {days == null ? <span style={{ color: 'var(--red)' }}>never</span>
                        : days === 0 ? 'today'
                        : `${days}d ago`}
                    </td>
                    <td>{r.module_count ?? <span title="No licence recorded — unrestricted">all</span>}</td>
                    <td style={{ textAlign: 'right' }} className="text-mono">{fmtBytes(r.db_bytes)}</td>
                    <td>
                      {r.urgent_errors > 0
                        ? <span className="badge badge-red">{r.urgent_errors} urgent</span>
                        : r.open_errors > 0
                          ? <span className="badge badge-yellow">{r.open_errors} open</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      <div>{r.plan || '—'}</div>
                      {r.trial_days_left != null && (
                        <div style={{ color: r.trial_days_left < 0 ? 'var(--red)' : 'var(--text-3)' }}>
                          {r.trial_days_left < 0 ? 'trial expired' : `trial ${r.trial_days_left}d`}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stated plainly rather than shown as a zero, which would be a lie. */}
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>
        Per-tenant backups are not tracked — the database is snapshotted as a whole.
        {p.storage_backend === 's3' && ' Document storage is in R2 and is not counted in database size.'}
      </p>
    </div>
  );
}
