// Password administration for the Control Center.
//
// Two distinct jobs that look similar but are not:
//
//   ChangeOwnPassword  - the OPERATOR changing their own. Requires the current
//                        password, because holding a console tab must not be
//                        enough to lock the real operator out.
//
//   TenantUserAdmin    - the operator resetting a CUSTOMER's user. No current
//                        password exists to ask for (that is the whole point:
//                        they are locked out). Instead the new password is
//                        shown once, a change is forced at first login, and
//                        the user's live sessions are revoked — so the vendor
//                        never holds a working credential into a customer's
//                        books.
import { useEffect, useState } from 'react';
import { toast } from '../../components/shared';
import { pfetch } from './api';

export function ChangeOwnPassword({ username, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy]       = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 10;
  const ready = current && next.length >= 10 && next === confirm && !busy;

  async function submit() {
    setBusy(true);
    try {
      await pfetch('POST', '/api/platform/me/password',
        { current_password: current, new_password: next });
      toast('Password changed');
      onClose();
    } catch (e) { toast(e.message, 'red'); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header"><span className="modal-title">Change operator password</span></div>
        <div className="modal-body">
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--text-2)' }}>
            Signed in as <strong>{username}</strong>.
          </p>
          <div className="form-group">
            <label className="form-label">Current password</label>
            <input className="form-control" type="password" autoFocus
              value={current} onChange={e => setCurrent(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">New password</label>
            <input className="form-control" type="password"
              value={next} onChange={e => setNext(e.target.value)} />
            {tooShort && <div style={{ fontSize: 12, color: 'var(--red)' }}>At least 10 characters.</div>}
          </div>
          <div className="form-group">
            <label className="form-label">Confirm new password</label>
            <input className="form-control" type="password"
              value={confirm} onChange={e => setConfirm(e.target.value)} />
            {mismatch && <div style={{ fontSize: 12, color: 'var(--red)' }}>Passwords do not match.</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={submit}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TenantUserAdmin({ slug }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);   // one-time credential to show
  const [busy, setBusy] = useState(null);

  const load = () => pfetch('GET', `/api/platform/tenants/${slug}/users`)
    .then(setUsers).catch(e => setError(e.message));
  useEffect(() => { load(); }, [slug]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function reset(username) {
    setBusy(username);
    try {
      const r = await pfetch('POST', `/api/platform/tenants/${slug}/reset-password`, { username });
      setIssued(r);          // shown once — never stored, never retrievable
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(null); }
  }

  if (error) return <div style={{ padding: 14, color: 'var(--red)', fontSize: 13 }}>{error}</div>;
  if (!users) return <div style={{ padding: 14, fontSize: 13, color: 'var(--text-3)' }}>Loading users…</div>;

  return (
    <div style={{ padding: 14 }}>
      {issued && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--accent)' }}>
          <div className="card-body">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              New password for {issued.username} — shown once
            </div>
            <div className="text-mono" style={{ fontSize: 14, userSelect: 'all',
                 background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 'var(--r-sm)' }}>
              {issued.password}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '8px 0 0' }}>
              Hand this to the user now — it is not stored and cannot be shown again.
              They must change it at first login, and their existing sessions were signed out.
            </p>
            <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }}
              onClick={() => { navigator.clipboard?.writeText(issued.password); toast('Copied'); }}>
              Copy
            </button>
          </div>
        </div>
      )}

      <table className="table" style={{ margin: 0 }}>
        <thead><tr><th>User</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {users.length === 0 && (
            <tr><td colSpan={3} style={{ color: 'var(--text-3)' }}>No users.</td></tr>
          )}
          {users.map(u => (
            <tr key={u.id}>
              <td>
                <div className="td-primary">{u.username}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{u.full_name}</div>
              </td>
              <td style={{ fontSize: 12 }}>
                {u.is_active ? 'Active' : <span style={{ color: 'var(--text-3)' }}>Inactive</span>}
                {u.must_change_password ? ' · must change password' : ''}
                <div style={{ color: 'var(--text-3)' }}>
                  {u.last_login ? `last login ${String(u.last_login).slice(0, 16)}` : 'never signed in'}
                </div>
              </td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn btn-sm btn-secondary" disabled={busy === u.username}
                  onClick={() => reset(u.username)}>
                  {busy === u.username ? 'Resetting…' : 'Reset password'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
