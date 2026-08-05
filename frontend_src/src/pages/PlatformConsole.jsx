// ─── Platform operator console (cloud / multi-tenant only) ─────────────────
// The SaaS vendor's control surface: provision new businesses (tenants),
// suspend / re-activate them, and hand the customer their first login.
//
// This page deliberately does NOT use the shared api client: that client
// redirects every 401 to the tenant /login page, but here a 401 simply means
// "operator not signed in" and must render the operator login form instead.
// Operator auth lives on its own cookie (platform_session) — completely
// separate from tenant sessions.
import { useEffect, useState, Fragment } from 'react';
import { pfetch } from './platform/api';
import ProvisionWizard from './platform/ProvisionWizard';
import FleetHealth from './platform/FleetHealth';
import BusinessAnalytics from './platform/BusinessAnalytics';
import SupportInbox from './platform/SupportInbox';
import { useLocale } from '../hooks/useLocale';
import { LoadingSpinner, toast } from '../components/shared';


const PLANS = ['standard', 'pro'];

export default function PlatformConsole() {
  const { t } = useLocale();
  // phase: probing → disabled | login | console
  const [phase, setPhase]       = useState('probing');
  const [operator, setOperator] = useState(null);
  const [section, setSection]   = useState('businesses');
  const [insights, setInsights] = useState(null);   // {slug,name} drill-down

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
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
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
        {phase === 'console' && (
          <>
            {/* Section nav — the console is an operations centre, not a
                single screen: provisioning, fleet health and the support
                queue are distinct jobs. */}
            <div className="tabs" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
              {[['businesses', t('platform.navBusinesses')],
                ['health',     t('platform.navHealth')],
                ['inbox',      t('platform.navInbox')]].map(([key, label]) => (
                <button key={key}
                  className={`tab-btn${section === key ? ' active' : ''}`}
                  onClick={() => { setSection(key); setInsights(null); }}>{label}</button>
              ))}
            </div>
            {section === 'businesses' && <TenantManager t={t} />}
            {section === 'health' && (insights
              ? <BusinessAnalytics slug={insights.slug} name={insights.name}
                  onBack={() => setInsights(null)} />
              : <FleetHealth onOpenAnalytics={setInsights} />)}
            {section === 'inbox'      && <SupportInbox />}
          </>
        )}
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
  const [busy, setBusy]       = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(null);   // slug whose domains panel is open

  async function reload() {
    try { setTenants(await pfetch('GET', '/api/platform/tenants')); }
    catch (err) { toast(err.message, 'red'); }
  }
  useEffect(() => { reload(); }, []);

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

      {/* Provisioning — a wizard rather than an inline row: a business now
          carries company, access, licensing and module decisions, which do not
          fit one line and should not be entered as one. */}
      {creating ? (
        <ProvisionWizard
          pfetch={pfetch}
          onCancel={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setCreds(res);
            toast(t('platform.tenantCreated'));
            reload();
          }}
        />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            ＋ {t('platform.newBusiness')}
          </button>
        </div>
      )}

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
                <Fragment key={tn.slug}>
                <tr>
                  <td className="text-mono">{tn.slug}</td>
                  <td>{tn.name || '—'}</td>
                  <td>{tn.plan}</td>
                  <td>
                    <span className={`badge badge-${tn.status === 'active' ? 'green' : 'red'}`}>
                      {tn.status === 'active' ? t('platform.active') : t('platform.suspended')}
                    </span>
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{(tn.created_at || '').slice(0, 10)}</td>
                  <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary"
                      onClick={() => setExpanded(expanded === tn.slug ? null : tn.slug)}>
                      🌐 Domains
                    </button>
                    {' '}
                    {tn.status === 'active' ? (
                      <button className="btn btn-sm btn-secondary" style={{ color: '#92400e' }}
                        onClick={() => setStatus(tn, 'suspend')}>⏸ {t('platform.suspend')}</button>
                    ) : (
                      <button className="btn btn-sm btn-secondary" style={{ color: '#166534' }}
                        onClick={() => setStatus(tn, 'activate')}>▶ {t('platform.activate')}</button>
                    )}
                  </td>
                </tr>
                {expanded === tn.slug && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--surface-2)', padding: 0 }}>
                      <DomainManager slug={tn.slug} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// Per-tenant custom-domain management: attach a domain, show the DNS TXT record
// the client must publish, verify it, and remove. A domain only routes traffic
// (and only gets a TLS cert) once it shows as Verified.
function DomainManager({ slug }) {
  const [domains, setDomains] = useState(null);
  const [input, setInput]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [lastAdded, setLastAdded] = useState(null);   // { txt_name, txt_value } to display

  async function reload() {
    try { setDomains(await pfetch('GET', `/api/platform/tenants/${slug}/domains`)); }
    catch (err) { toast(err.message, 'red'); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [slug]);

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await pfetch('POST', `/api/platform/tenants/${slug}/domains`, { domain: input.trim().toLowerCase() });
      setLastAdded(res);
      setInput('');
      toast('Domain added — publish the DNS TXT record, then Verify.');
      reload();
    } catch (err) { toast(err.message, 'red'); }
    finally { setBusy(false); }
  }

  async function verify(domain) {
    try {
      const res = await pfetch('POST', `/api/platform/domains/${domain}/verify`);
      toast(res.verified ? `Verified ${domain}` : `TXT record not found yet for ${domain}`, res.verified ? 'green' : 'red');
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function remove(domain) {
    try {
      await pfetch('DELETE', `/api/platform/domains/${domain}`);
      toast(`Removed ${domain}`);
      if (lastAdded?.domain === domain) setLastAdded(null);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  return (
    <div style={{ padding: 16 }}>
      <strong style={{ display: 'block', marginBottom: 10 }}>Custom domains for {slug}</strong>

      <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Domain</label>
          <input className="form-control" style={{ width: 280 }} value={input}
            placeholder="erp.clientco.com"
            onChange={e => setInput(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
          {busy ? '…' : 'Add domain'}
        </button>
      </form>

      {lastAdded?.txt_name && (
        <div className="card" style={{ padding: 12, marginBottom: 12, border: '1px solid var(--accent)' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 6 }}>
            Ask the client to publish this DNS record, then click <b>Verify</b>:
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            <div>Type: <b>TXT</b></div>
            <div>Name: <b>{lastAdded.txt_name}</b></div>
            <div>Value: <b>{lastAdded.txt_value}</b></div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            Once verified, point <b>{lastAdded.domain}</b> (CNAME → your app host, or A → your IP). HTTPS is issued automatically on first request.
          </div>
        </div>
      )}

      {domains === null ? <LoadingSpinner /> : domains.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No custom domains yet — this tenant is reachable at its subdomain.</div>
      ) : (
        <table className="table" style={{ margin: 0 }}>
          <thead>
            <tr><th>Domain</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {domains.map(d => (
              <tr key={d.domain}>
                <td className="text-mono">{d.domain}</td>
                <td>
                  <span className={`badge badge-${d.verified ? 'green' : 'yellow'}`}>
                    {d.verified ? 'Verified' : 'Pending DNS'}
                  </span>
                </td>
                <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                  {!d.verified && (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={() => verify(d.domain)}>Verify</button>{' '}
                      <button className="btn btn-sm btn-secondary"
                        onClick={() => setLastAdded({ domain: d.domain, txt_name: `_erp-verify.${d.domain}`, txt_value: d.verify_token })}>
                        Show TXT
                      </button>{' '}
                    </>
                  )}
                  <button className="btn btn-sm btn-secondary" style={{ color: '#b91c1c' }} onClick={() => remove(d.domain)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
