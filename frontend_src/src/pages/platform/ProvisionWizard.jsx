// Business provisioning wizard — Control Center.
//
// Four steps rather than one long form: an operator setting up a customer is
// making decisions in distinct modes (who they are, how they're reached, what
// they bought, how long they have), and a single wall of thirty inputs makes
// it easy to miss one.
//
// The module step is the interesting part. Dependencies are resolved as you
// click: ticking Point of Sale immediately locks Invoices, Inventory, Cash,
// Finance and Clients as required-and-uncheckable, each explaining WHICH
// choice forces it. That makes an invalid licence unrepresentable rather than
// merely discouraged — the backend applies the same closure on save, so the
// two can never disagree.
import { useState } from 'react';
import { ModulePicker, useModuleGraph } from './ModulePicker';

const STEPS = ['Company', 'Access', 'Modules', 'Licence'];

const INDUSTRIES = [
  'Retail', 'Wholesale & Distribution', 'Manufacturing', 'Construction',
  'Professional Services', 'Hospitality', 'Healthcare', 'Education',
  'Logistics', 'Technology', 'Other',
];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'LBP'];
const LANGUAGES  = [{ code: 'en', label: 'English' }, { code: 'ar', label: 'العربية (Arabic)' }];
const PLANS      = ['trial', 'standard', 'professional', 'enterprise'];

export default function ProvisionWizard({ pfetch, onCreated, onCancel }) {
  const [step, setStep]   = useState(0);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    slug: '', name: '', industry: '', language: 'en', currency: 'USD',
    contact_email: '', contact_phone: '', company_address: '', tax_number: '',
    plan: 'trial', max_users: '', trial_ends_at: '', license_expires_at: '', notes: '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Module catalogue, closure and lock reasons — shared with ModuleEditor so
  // the two screens can never disagree about what a selection resolves to.
  const { graph, selected, effective, lockedBy, toggle, error: modErr } =
    useModuleGraph(pfetch);

  const slugOk = /^[a-z0-9_]{2,}$/.test(form.slug.trim());

  async function submit() {
    setBusy(true); setError('');
    try {
      const payload = { ...form, slug: form.slug.trim(), modules: [...selected] };
      // Blank strings would overwrite defaults with empties.
      for (const k of Object.keys(payload)) if (payload[k] === '') delete payload[k];
      if (payload.max_users) payload.max_users = Number(payload.max_users);
      const res = await pfetch('POST', '/api/platform/tenants', payload);
      onCreated(res);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const field = (label, key, opts = {}) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {opts.options ? (
        <select className="form-control" value={form[key]} onChange={e => set(key, e.target.value)}>
          {opts.placeholder && <option value="">{opts.placeholder}</option>}
          {opts.options.map(o => typeof o === 'string'
            ? <option key={o} value={o}>{o}</option>
            : <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      ) : (
        <input className="form-control" type={opts.type || 'text'}
          value={form[key]} placeholder={opts.placeholder || ''}
          onChange={e => set(key, e.target.value)} />
      )}
      {opts.hint && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>{opts.hint}</div>}
    </div>
  );

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="card-title">New business</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {STEPS.map((label, i) => (
            <span key={label} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 12, fontWeight: 600,
              color: i === step ? 'var(--accent)' : i < step ? 'var(--text-2)' : 'var(--text-3)',
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 11,
                background: i <= step ? 'var(--accent)' : 'var(--surface-3)',
                color: i <= step ? '#fff' : 'var(--text-3)',
              }}>{i + 1}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="card-body">
        {(error || modErr) && (
          <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error || modErr}</div>
        )}

        {step === 0 && (
          <div className="form-grid">
            {field('Business name', 'name', { placeholder: 'Acme Trading Ltd' })}
            {field('Industry', 'industry', { options: INDUSTRIES, placeholder: 'Select industry…' })}
            {field('Contact email', 'contact_email', { type: 'email', placeholder: 'ops@acme.example' })}
            {field('Contact phone', 'contact_phone', { placeholder: '+1 555 0100' })}
            {field('Address', 'company_address')}
            {field('Tax / VAT number', 'tax_number')}
          </div>
        )}

        {step === 1 && (
          <div className="form-grid">
            {field('Subdomain', 'slug', {
              placeholder: 'acme',
              hint: form.slug.trim()
                ? `Reachable at ${form.slug.trim()}.quilit.dev`
                : 'Lower-case letters, digits and underscore. Becomes their address.',
            })}
            {field('Language', 'language', { options: LANGUAGES })}
            {field('Currency', 'currency', { options: CURRENCIES })}
            {!slugOk && form.slug && (
              <div className="form-group form-full" style={{ color: 'var(--red)', fontSize: 12 }}>
                Subdomain must be at least 2 characters, lower-case letters, digits or underscore.
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 0, marginBottom: 14 }}>
              Pick what the customer bought. Anything those modules depend on is
              switched on automatically and locked — a licence can never resolve
              to a combination that doesn&apos;t work.
            </p>
            <ModulePicker graph={graph} selected={selected} effective={effective}
              lockedBy={lockedBy} toggle={toggle} />
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              <strong>{selected.size}</strong> selected ·{' '}
              <strong>{effective.size}</strong> licensed after dependencies
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="form-grid">
            {field('Subscription plan', 'plan', { options: PLANS })}
            {field('Licensed users', 'max_users', { type: 'number', placeholder: '10', hint: 'Leave blank for unlimited.' })}
            {field('Trial ends', 'trial_ends_at', { type: 'date', hint: 'Leave blank if this is not a trial.' })}
            {field('Licence expires', 'license_expires_at', { type: 'date', hint: 'Leave blank for perpetual.' })}
            <div className="form-group form-full">
              <label className="form-label">Internal notes</label>
              <textarea className="form-control" rows={3} value={form.notes}
                onChange={e => set('notes', e.target.value)} />
            </div>
          </div>
        )}
      </div>

      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <div style={{ display: 'flex', gap: 8 }}>
          {step > 0 && (
            <button className="btn btn-secondary" onClick={() => setStep(s => s - 1)} disabled={busy}>Back</button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={step === 1 && !slugOk}
              onClick={() => setStep(s => s + 1)}>Continue</button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={busy || !slugOk}>
              {busy ? 'Provisioning…' : 'Create business'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
