import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getMe } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [showPw, setShowPw]     = useState(false);
  const navigate = useNavigate();
  const { t } = useLocale();

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
      navigate('/');
    } catch (err) {
      setError(err.message || t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-mark">
            <img
              src="/api/settings/logo"
              alt="Logo"
              style={{ height: 28, width: 'auto' }}
              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
            />
            <span style={{ display: 'none', fontSize: 22, fontWeight: 900, color: '#fff' }}>E</span>
          </div>
          <h1>{t('login.welcomeBack')}</h1>
          <p>{t('login.signInSubtitle')}</p>
        </div>

        {error && (
          <div className="alert alert-red" style={{ marginBottom: 16 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{t('login.username')}</label>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <input
                className="form-control"
                style={{ paddingLeft: 34 }}
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                required
                autoFocus
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('login.password')}</label>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
              </div>
              <input
                type={showPw ? 'text' : 'password'}
                className="form-control"
                style={{ paddingLeft: 34, paddingRight: 38 }}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 2 }}
              >
                {showPw
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary w-100"
            disabled={loading}
            style={{ marginTop: 8, padding: '10px', fontSize: 13.5, fontWeight: 600 }}
          >
            {loading ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                {t('login.signingIn')}
              </>
            ) : t('login.signIn')}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--text-3)', marginTop: 20 }}>
          {t('common.securedEncryption')}
        </p>
      </div>
    </div>
  );
}
