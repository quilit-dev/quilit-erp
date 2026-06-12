// ─── Platform operator console (cloud / multi-tenant only) ─────────────────
// The SaaS vendor's control surface: provision new businesses (tenants),
// suspend / re-activate them, and hand the customer their first login.
//
// This page deliberately does NOT use the shared api client: that client
// redirects every 401 to the tenant /login page, but here a 401 simply means
// "operator not signed in" and must render the operator login form instead.
// Operator auth lives on its own cookie (platform_session) — completely
// separate from tenant sessions.
import { useEffect, useState } from 'react';
import { useLocale } from '../hooks/useLocale';
import { LoadingSpinner, toast } from '../components/shared';

async function pfetch(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const PLANS = ['standard', 'pro'];

export default function PlatformConsole() {
  const { t } = useLocale();
  // phase: probing → disabled | login | console
  const [phase, setPhase]       = useState('probing');
  const [operator, setOperator] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await pfetch('GET', '/api/platform/status');
        if (!s.enabled) { setPhase('disabled'); return; }
        try {
          setOperator(await pfetch('GET', '/api/platform/me'));
          setPhase('console');
        } catch {
          setPhase('login');
        }
      } catch {
        setPhase('disabled');
      }
    })();
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{t('platform.title')}</h1>
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('platform.subtitle')}</div>
          </div>
          {phase === 'console' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{operator?.username}</span>
              <button className="btn btn-sm btn-secondary" onClick={async () => {
                try { await pfetch('POST', '/api/platform/logout'); } catch {}
                setOperator(null); setPhase('login');
              }}>{t('platform.logout')}</button>
            </div>
          )}
        </div>

        {phase === 'probing'  && <LoadingSpinner />}
        {phase === 'disabled' && (
          <div className="card" style={{ padding: 24 }}>
            <strong>{t('platform.cloudOnlyTitle')}</strong>
            <p style={{ color: 'var(--text-2)', marginBottom: 0 }}>{t('platform.cloudOnlyBody')}</p>
          </div>
        )}
        {phase === 'login'   && <OperatorLogin onSuccess={(op) => { setOperator(op); setPhase('console'); }} />}
        {phase === 'console' && <TenantManager t={t} />}
      </div>
    </div>
  );
}

function OperatorLogin({ onSuccess }) {
  const { t } = useLocale();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const op = await pfetch('POST', '/api/platform/login', { username, password });
      onSuccess(op);
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <form className="card" style={{ padding: 24, maxWidth: 380 }} onSubmit={submit}>
      <div className="form-group">
        <label className="form-label">{t('platform.operatorUsername')}</label>
        <input className="form-control" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
      </div>
      <div className="form-group">
        <label className="form-label">{t('platform.operatorPassword')}</label>
        <input className="form-control" type="password" value={password} onChange={e => setPassword(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={busy || !username || !password}>
        {busy ? '…' : t('platform.signIn')}
      </button>
    </form>
  );
}

function TenantManager({ t }) {
  const [tenants, setTenants] = useState(null);
  const [creds, setCreds]     = useState(null);   // one-time credentials from the last provision
  const [slug, setSlug]       = useState('');
  const [name, setName]       = useState('');
  const [plan, setPlan]       = useState('standard');
  const [busy, setBusy]       = useState(false);

  async function reload() {
    try { setTenants(await pfetch('GET', '/api/platform/tenants')); }
    catch (err) { toast(err.message, 'red'); }
  }
  useEffect(() => { reload(); }, []);

  async function provision(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await pfetch('POST', '/api/platform/tenants', { slug: slug.trim(), name: name.trim() || null, plan });
      setCreds(res);
      setSlug(''); setName(''); setPlan('standard');
      toast(t('platform.tenantCreated'));
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function setStatus(tenant, action) {
    try {
      await pfetch('POST', `/api/platform/tenants/${tenant.slug}/${action}`);
      toast(action === 'suspend' ? t('platform.tenantSuspended') : t('platform.tenantActivated'));
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  return (
    <>
      {/* One-time credentials banner — shown once after provisioning */}
      {creds?.admin_password && (
        <div className="card" style={{ padding: 18, marginBottom: 16, border: '1px solid var(--accent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <strong>{t('platform.credsTitle', { name: creds.name || creds.slug })}</strong>
              <div style={{ fontFamily: 'var(--font-mono)', margin: '10px 0', fontSize: 14 }}>
                {t('platform.credsUser')}: <b>{creds.admin_username}</b><br />
                {t('platform.credsPass')}: <b>{creds.admin_password}</b>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{t('platform.credsWarning')}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm btn-secondary" onClick={() => {
                navigator.clipboard?.writeText(`${creds.admin_username} / ${creds.admin_password}`);
                toast(t('platform.credsCopied'));
              }}>📋 {t('platform.copy')}</button>
              <button className="btn btn-sm btn-secondary" onClick={() => setCreds(null)}>✕</button>
            </div>
          </div>
        </div>
      )}

      {/* Provision form */}
      <form className="card" style={{ padding: 18, marginBottom: 16 }} onSubmit={provision}>
        <strong style={{ display: 'block', marginBottom: 10 }}>{t('platform.newBusiness')}</strong>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">{t('platform.slug')}</label>
            <input className="form-control" style={{ width: 200 }} value={slug}
              placeholder="beirut_traders"
              onChange={e => setSlug(e.target.value.toLowerCase())} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">{t('platform.businessName')}</label>
            <input className="form-control" style={{ width: 240 }} value={name}
              onChange={e => setName(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">{t('platform.plan')}</label>
            <select className="form-control" style={{ width: 130 }} value={plan} onChange={e => setPlan(e.target.value)}>
              {PLANS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" disabled={busy || !slug.trim()}>
            {busy ? '…' : t('platform.provision')}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>{t('platform.slugHint')}</div>
      </form>

      {/* Tenant table */}
      <div className="card" style={{ padding: 0 }}>
        {tenants === null ? <div style={{ padding: 24 }}><LoadingSpinner /></div> : (
          <table className="table" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th>{t('platform.slug')}</th>
                <th>{t('platform.businessName')}</th>
                <th>{t('platform.plan')}</th>
                <th>{t('platform.status')}</th>
                <th>{t('platform.created')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>
                  {t('platform.noTenants')}
                </td></tr>
              )}
              {tenants.map(tn => (
                <tr key={tn.slug}>
                  <td className="text-mono">{tn.slug}</td>
                  <td>{tn.name || '—'}</td>
                  <td>{tn.plan}</td>
                  <td>
                    <span className={`badge badge-${tn.status === 'active' ? 'green' : 'red'}`}>
                      {tn.status === 'active' ? t('platform.active') : t('platform.suspended')}
                    </span>
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{(tn.created_at || '').slice(0, 10)}</td>
                  <td style={{ textAlign: 'end' }}>
                    {tn.status === 'active' ? (
                      <button className="btn btn-sm btn-secondary" style={{ color: '#92400e' }}
                        onClick={() => setStatus(tn, 'suspend')}>⏸ {t('platform.suspend')}</button>
                    ) : (
                      <button className="btn btn-sm btn-secondary" style={{ color: '#166534' }}
                        onClick={() => setStatus(tn, 'activate')}>▶ {t('platform.activate')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
