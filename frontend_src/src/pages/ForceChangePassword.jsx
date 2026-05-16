import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forceChangePassword, logout } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

export default function ForceChangePassword() {
  const navigate = useNavigate();
  const { t } = useLocale();
  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [error, setError]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError(t('forceChange.passwordMinLength'));
    if (password !== confirm)  return setError(t('forceChange.passwordsNoMatch'));
    setSubmitting(true);
    try {
      await forceChangePassword(password);
      // Force a clean re-login with the new password
      await logout().catch(() => {});
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      navigate('/login');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 420 }}>

        {/* Warning banner */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'flex-start',
          padding: '12px 16px', marginBottom: 24,
          background: 'var(--yellow-light)', border: '1px solid var(--yellow)', borderRadius: 10,
        }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🔐</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--yellow)' }}>{t('forceChange.required')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
              {t('forceChange.mustSet')}
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 28 }}>
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 4px' }}>{t('forceChange.setNew')}</h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 22px' }}>{t('forceChange.minCharsHint')}</p>

          {error && (
            <div style={{
              padding: '10px 14px', background: 'var(--red-light)', border: '1px solid var(--red)',
              borderRadius: 8, fontSize: 13, color: 'var(--red)', marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">{t('forceChange.newPasswordLabel')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="form-control"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={t('forceChange.minLabel')}
                  autoFocus
                  required
                />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
              {password && (
                <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                  {[
                    { label: t('forceChange.strength8'),     ok: password.length >= 8 },
                    { label: t('forceChange.strengthUpper'), ok: /[A-Z]/.test(password) },
                    { label: t('forceChange.strengthNum'),   ok: /[0-9]/.test(password) },
                  ].map(({ label, ok }) => (
                    <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ height: 3, borderRadius: 2, background: ok ? 'var(--green)' : 'var(--border)', marginBottom: 3 }} />
                      <span style={{ fontSize: 10, color: ok ? 'var(--green)' : 'var(--text-3)' }}>{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">{t('forceChange.confirmPasswordLabel')}</label>
              <input
                type={showPw ? 'text' : 'password'}
                className="form-control"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={t('forceChange.repeatPassword')}
                required
              />
              {confirm && password !== confirm && (
                <p style={{ fontSize: 12, color: 'var(--red)', margin: '4px 0 0' }}>{t('forceChange.passwordsNoMatch')}</p>
              )}
            </div>

            <button
              type="submit"
              className="btn btn-primary w-100"
              disabled={submitting}
              style={{ marginTop: 8, padding: 11, fontSize: 14, fontWeight: 600 }}
            >
              {submitting ? t('forceChange.submitting') : t('forceChange.submitBtn')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
