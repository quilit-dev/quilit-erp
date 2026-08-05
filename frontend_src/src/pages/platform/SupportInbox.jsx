// Support inbox — every customer's problem reports in one queue.
//
// Triage-first: the default view is open reports, newest first, because the
// question an operator arrives with is "what is broken right now?". Filters
// narrow by status, customer, severity and free text; selecting a report opens
// the full technical context the ERP captured automatically.
//
// Reports are never deleted — status moves open → investigating → resolved, so
// the record of what broke for whom survives.
import { useCallback, useEffect, useState } from 'react';
import { LoadingSpinner, toast } from '../../components/shared';
import { pfetch } from './api';

const STATUSES   = ['open', 'investigating', 'resolved'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

const SEV_BADGE = {
  critical: 'badge-red', high: 'badge-red',
  medium:   'badge-yellow', low: 'badge-gray',
};
const STATUS_BADGE = {
  open: 'badge-yellow', investigating: 'badge-blue', resolved: 'badge-green',
};

const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 16) : d.toLocaleString();
};

export default function SupportInbox() {
  const [data, setData]     = useState(null);
  const [error, setError]   = useState(null);
  const [status, setStatus] = useState('open');   // triage-first default
  const [severity, setSeverity] = useState('');
  const [q, setQ]           = useState('');
  const [open, setOpen]     = useState(null);     // the report being triaged
  const [busy, setBusy]     = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status)   params.set('status', status);
    if (severity) params.set('severity', severity);
    if (q.trim()) params.set('q', q.trim());
    try {
      setData(await pfetch('GET', `/api/platform/reports?${params}`));
    } catch (e) { setError(e.message); }
  }, [status, severity, q]);

  useEffect(() => { load(); }, [load]);

  async function patch(id, changes) {
    setBusy(true);
    try {
      const updated = await pfetch('PATCH', `/api/platform/reports/${id}`, changes);
      setOpen(updated);
      await load();
      toast('Report updated');
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  if (error) return <div className="card" style={{ padding: 20, color: 'var(--red)' }}>{error}</div>;
  if (!data) return <LoadingSpinner />;

  const counts = data.counts || {};

  return (
    <div>
      {/* Status tabs double as the queue's badges. */}
      <div className="tabs" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {[['', 'All'], ...STATUSES.map(s => [s, s[0].toUpperCase() + s.slice(1)])].map(([key, label]) => (
          <button key={key || 'all'}
            className={`tab-btn${status === key ? ' active' : ''}`}
            onClick={() => setStatus(key)}>
            {label}
            {key && counts[key] ? ` (${counts[key]})` : ''}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-control" style={{ minWidth: 220, flex: 1 }}
            placeholder="Search title, message, description or user…"
            value={q} onChange={e => setQ(e.target.value)} />
          <select className="form-control" style={{ width: 150 }}
            value={severity} onChange={e => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Reports</span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{data.total} total</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th><th>Business</th><th>Problem</th>
                <th>Severity</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>
                  Nothing here — no reports match this filter.
                </td></tr>
              )}
              {data.items.map(r => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r)}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtWhen(r.created_at)}</td>
                  <td>
                    <div className="td-primary">{r.tenant_name || r.tenant_slug || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.username}</div>
                  </td>
                  <td style={{ maxWidth: 380 }}>{r.title}</td>
                  <td><span className={`badge ${SEV_BADGE[r.severity] || 'badge-gray'}`}>{r.severity}</span></td>
                  <td><span className={`badge ${STATUS_BADGE[r.status] || 'badge-gray'}`}>{r.status}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-secondary">Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <ReportDetail report={open} busy={busy}
          onClose={() => setOpen(null)}
          onPatch={(changes) => patch(open.id, changes)} />
      )}
    </div>
  );
}

// Full technical context, captured by the ERP so the user never had to
// describe it, plus the triage controls.
function ReportDetail({ report: r, busy, onClose, onPatch }) {
  const [notes, setNotes] = useState(r.notes || '');
  const [assignee, setAssignee] = useState(r.assignee || '');

  const Field = ({ label, children, mono }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em',
                    color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
      <div className={mono ? 'text-mono' : undefined}
           style={{ fontSize: mono ? 12 : 13, wordBreak: 'break-word' }}>{children || '—'}</div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <span className="modal-title">{r.title}</span>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Business">{r.tenant_name || r.tenant_slug}</Field>
            <Field label="Reported by">{r.username}</Field>
            <Field label="When">{fmtWhen(r.created_at)}</Field>
            <Field label="Page" mono>{r.page_url}</Field>
          </div>

          {r.description && (
            <div style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 'var(--r-sm)',
                          margin: '6px 0 12px' }}>
              <Field label="What the user was doing">{r.description}</Field>
            </div>
          )}

          <Field label="Error" mono>{r.message}</Field>
          {r.stack && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-2)' }}>Stack trace</summary>
              <pre className="text-mono" style={{
                fontSize: 11, background: 'var(--surface-2)', padding: 10,
                borderRadius: 'var(--r-sm)', overflowX: 'auto', marginTop: 6,
              }}>{r.stack}</pre>
            </details>
          )}
          <Field label="Browser" mono>{r.user_agent}</Field>

          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, marginTop: 6 }}>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Assignee</label>
                <input className="form-control" value={assignee}
                  onChange={e => setAssignee(e.target.value)} placeholder="Who is on it?" />
              </div>
              <div className="form-group">
                <label className="form-label">Severity</label>
                <select className="form-control" value={r.severity}
                  onChange={e => onPatch({ severity: e.target.value })} disabled={busy}>
                  {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-group form-full">
                <label className="form-label">Notes</label>
                <textarea className="form-control" rows={3} value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Findings, workaround, resolution…" />
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {STATUSES.filter(s => s !== r.status).map(s => (
              <button key={s} className="btn btn-sm btn-secondary" disabled={busy}
                onClick={() => onPatch({ status: s })}>
                Mark {s}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => onPatch({ notes, assignee })}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
