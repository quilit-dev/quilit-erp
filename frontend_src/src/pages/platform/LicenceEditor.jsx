// Renew, extend and re-plan an EXISTING business.
//
// Everything here could already be set at provisioning and then never again:
// the wizard wrote plan, seats, trial end and licence expiry, the console
// displayed the plan, and the only thing that ever called PUT /tenants/{slug}
// was the module editor. So taking a renewal meant editing the database by
// hand — the one routine commercial act the operator console could not do.
//
// The dates are the whole point, so they lead. Renewing is one button, because
// "+1 year from today" is what an operator actually does and making them
// compute a date invites a typo that suspends a paying customer.
import { useState } from 'react';
import { toast } from '../../components/shared';
import { pfetch } from './api';
import SearchSelect from '../../components/SearchSelect.jsx';

const PLANS = ['trial', 'standard', 'professional', 'enterprise'];

// LOCAL calendar date, not toISOString(). The dates here are calendar days,
// and toISOString() converts to UTC first — so east of UTC a renewal computed
// at local midnight lands a day EARLY, which is a day of access the customer
// paid for.
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** today + n months, clamped so 31 Jan + 1 month lands on 28/29 Feb. */
function addMonths(from, n) {
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

/** Days until `isoDate`; negative once it has passed. */
export function daysUntil(isoDate) {
  if (!isoDate) return null;
  const then = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((then - today) / 86400000);
}

/** The one line an operator needs: is this customer paid up? */
export function licenceState(tenant, graceDays = 7) {
  const trial = daysUntil(tenant.trial_ends_at);
  const lic   = daysUntil(tenant.license_expires_at);
  // Whichever ends sooner governs — a licence is not much use inside a trial
  // that has already lapsed.
  const cands = [
    trial != null ? { kind: 'trial',   days: trial } : null,
    lic   != null ? { kind: 'licence', days: lic   } : null,
  ].filter(Boolean);
  if (!cands.length) return { tone: 'none', label: 'Perpetual', days: null, kind: null };

  const soonest = cands.reduce((a, b) => (a.days <= b.days ? a : b));
  const { days, kind } = soonest;
  if (days < -graceDays) return { tone: 'red',    label: `${kind} expired`, days, kind };
  if (days < 0)          return { tone: 'orange', label: `in grace (${-days}d)`, days, kind };
  if (days <= 30)        return { tone: 'yellow', label: `${days}d left`, days, kind };
  return { tone: 'green', label: `${days}d left`, days, kind };
}

export default function LicenceEditor({ tenant, onClose, onSaved }) {
  const [form, setForm] = useState({
    plan:               tenant.plan || 'standard',
    max_users:          tenant.max_users ?? '',
    trial_ends_at:      tenant.trial_ends_at || '',
    license_expires_at: tenant.license_expires_at || '',
    notes:              tenant.notes || '',
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const state = licenceState({ ...tenant, ...form });

  // Extend from whichever is later: today, or the date already on file. So
  // renewing early ADDS to the remaining term instead of quietly shortening it.
  function extend(months) {
    const current = form.license_expires_at ? new Date(`${form.license_expires_at}T00:00:00`) : null;
    const base = current && current > new Date() ? current : new Date();
    setForm(f => ({ ...f, license_expires_at: iso(addMonths(base, months)) }));
  }

  async function save() {
    setBusy(true);
    try {
      // Blank a date by sending null, not "" — the backend skips None, so an
      // empty string would be stored and then compared as a date.
      const payload = {
        plan: form.plan,
        max_users: form.max_users === '' ? null : Number(form.max_users),
        trial_ends_at: form.trial_ends_at || null,
        license_expires_at: form.license_expires_at || null,
        notes: form.notes || null,
      };
      await pfetch('PUT', `/api/platform/tenants/${tenant.slug}`, payload);
      toast('Licence updated');
      onSaved?.();
      onClose();
    } catch (e) {
      toast(e.message, 'red');
      setBusy(false);
    }
  }

  const field = (label, key, props = {}) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {props.options
        ? (
          <SearchSelect
            className="form-control"
            value={form[key]}
            onChange={v => set(key)(v)}
            options={(props.options).map(o => ({ value: o, label: o }))} />
        ) : (
          <input className="form-control" type={props.type || 'text'} value={form[key]}
            placeholder={props.placeholder}
            onChange={e => set(key)(e.target.value)} />
        )}
      {props.hint && (
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>{props.hint}</div>
      )}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 620 }}>
        <div className="modal-header">
          <span className="modal-title">Licence — {tenant.name || tenant.slug}</span>
        </div>

        <div className="modal-body">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <span className={`badge badge-${state.tone === 'none' ? 'gray' : state.tone}`}>
              {state.label}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
              {tenant.status === 'suspended'
                ? 'This business is suspended — renewing does not reactivate it; use Activate afterwards.'
                : 'Expiry suspends the business after the grace period. Data is kept either way.'}
            </span>
          </div>

          {field('Subscription plan', 'plan', { options: PLANS })}
          {field('Licensed users', 'max_users',
                 { type: 'number', placeholder: 'blank = unlimited',
                   hint: 'Concurrent sign-ins. When every seat is taken the '
                         + 'next person is refused until someone signs out or '
                         + 'goes idle. Admins are never blocked. Blank or 0 = '
                         + 'unlimited.' })}
          {field('Trial ends', 'trial_ends_at',
                 { type: 'date', hint: 'Blank if this is not a trial.' })}
          {field('Licence expires', 'license_expires_at',
                 { type: 'date', hint: 'Blank for a perpetual licence.' })}

          {/* A normal .form-group: label above, controls below. The first
              version put the label and buttons in one flex row and pulled it up
              with a negative top margin to fight .modal-body's 12px owl rule —
              which stacked the buttons over the label instead. */}
          <div className="form-group">
            <label className="form-label">Renew</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => extend(1)}>+1 month</button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => extend(3)}>+3 months</button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => extend(12)}>+1 year</button>
              <button type="button" className="btn btn-sm btn-secondary"
                onClick={() => setForm(f => ({ ...f, license_expires_at: '' }))}>Perpetual</button>
            </div>
          </div>

          {field('Notes', 'notes', { placeholder: 'PO number, renewal terms…' })}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save licence'}
          </button>
        </div>
      </div>
    </div>
  );
}
