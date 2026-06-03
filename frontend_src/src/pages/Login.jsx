import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getMe } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [showPw, setShowPw]     = useState(false);
  const navigate = useNavigate();
  const { t } = useLocale();
  const { settings } = useSettings();

  // Company name & tagline drive the brand panel on the left. Falls back
  // to "ERP System" when the customer hasn't set their company name yet
  // (a fresh install before the setup wizard runs).
  const companyName = settings?.company_name || 'ERP System';
  const tagline     = settings?.company_address || t('login.brandTagline');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(username, password);
      // Store basic info immediately, then enrich with full permissions from /me
      const base = {
        username: data.username, full_name: data.full_name,
        is_superadmin: data.is_superadmin, role_id: data.role_id,
        role_name: data.role_name, permissions: {},
      };
      localStorage.setItem('user', JSON.stringify(base));
      if (data.must_change_password) {
        navigate('/force-change-password');
        return;
      }
      try {
        const me = await getMe();
        localStorage.setItem('user', JSON.stringify(me));
      } catch { /* keep base info */ }
      // Tell the SettingsProvider to (re)load settings + exchange rate now that
      // a session exists — login is a client-side nav, so it does not remount.
      window.dispatchEvent(new Event('user-updated'));
      navigate('/');
    } catch (err) {
      setError(err.message || t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  }

  // Three value propositions shown beneath the headline. The icons are
  // tiny inline marks (plain SVG strokes) so the brand panel reads as
  // formal product copy rather than a marketing splash.
  const valueProps = [
    { key: 'gl',     title: t('login.valueGl'),     sub: t('login.valueGlSub') },
    { key: 'ops',    title: t('login.valueOps'),    sub: t('login.valueOpsSub') },
    { key: 'people', title: t('login.valuePeople'), sub: t('login.valuePeopleSub') },
  ];

  return (
    <div className="login-page">
      {/* ── Brand panel ───────────────────────────────────────────────
          Plum surface with the product identity, a headline tagline, and
          three short value propositions. Hidden on phones via CSS. */}
      <aside className="login-brand">
        <div className="login-brand-head">
          <div className="login-brand-mark">
            <span className="dot">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </span>
            {companyName}
          </div>
        </div>

        <div className="login-brand-body">
          <div className="login-brand-headline">
            <h2>{t('login.brandHeadline')}</h2>
            <p>{tagline}</p>
          </div>

          <ul className="login-brand-points">
            {valueProps.map(p => (
              <li key={p.key}>
                <span className="login-brand-point-icon" aria-hidden>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </span>
                <div>
                  <div className="login-brand-point-title">{p.title}</div>
                  <div className="login-brand-point-sub">{p.sub}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="login-brand-foot">
          <span className="pip" />
          {t('login.brandFooter')}
        </div>
      </aside>

      {/* ── Form panel ────────────────────────────────────────────── */}
      <div className="login-form-wrap">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-logo-mark">
              <img
                src="/api/settings/logo"
                alt="Logo"
                style={{ height: 26, width: 'auto', maxWidth: 36 }}
                onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
              />
              <span style={{
                display: 'none',
                alignItems: 'center', justifyContent: 'center',
                width: '100%', height: '100%',
                fontFamily: 'var(--font-display)',
                fontSize: 22, fontWeight: 700,
                letterSpacing: '-0.03em',
                color: '#FFFFFF',
              }}>
                {companyName.charAt(0).toUpperCase()}
              </span>
            </div>
            <h1>{t('login.welcomeBack')}</h1>
            <p>{t('login.signInSubtitle')}</p>
          </div>

          {error && (
            <div className="alert alert-red" style={{ marginBottom: 16 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ flexShrink: 0, marginTop: 2 }}>
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">{t('login.username')}</label>
              <div style={{ position: 'relative' }}>
                <div style={{
                  position: 'absolute', insetInlineStart: 12,
                  top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--text-3)', pointerEvents: 'none',
                  display: 'flex', alignItems: 'center',
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </div>
                <input
                  className="form-control"
                  style={{ paddingInlineStart: 38 }}
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={t('login.usernamePlaceholder')}
                  required
                  autoFocus
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">{t('login.password')}</label>
              <div style={{ position: 'relative' }}>
                <div style={{
                  position: 'absolute', insetInlineStart: 12,
                  top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--text-3)', pointerEvents: 'none',
                  display: 'flex', alignItems: 'center',
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0110 0v4"/>
                  </svg>
                </div>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="form-control"
                  style={{ paddingInlineStart: 38, paddingInlineEnd: 40 }}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? t('login.hidePassword') : t('login.showPassword')}
                  style={{
                    position: 'absolute', insetInlineEnd: 8,
                    top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none',
                    cursor: 'pointer', color: 'var(--text-3)',
                    padding: 6, borderRadius: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                  {showPw
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{ marginTop: 4 }}
            >
              {loading ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  {t('login.signingIn')}
                </>
              ) : t('login.signIn')}
            </button>
          </form>

          <div className="login-secure">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.4"
              strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            {t('common.securedEncryption')}
          </div>
        </div>
      </div>
    </div>
  );
}
