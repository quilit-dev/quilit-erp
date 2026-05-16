import React, { useState } from 'react';
import { completeSetup } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'EGP', 'LBP', 'JOD'];

export default function Setup() {
  const { t } = useLocale();
  const [step, setStep] = useState(1);

  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [company, setCompany]     = useState('');
  const [email, setEmail]         = useState('');
  const [currency, setCurrency]   = useState('USD');
  const [error, setError]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  function goStep2(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError(t('setup.passwordMinLength'));
    if (password !== confirm) return setError(t('setup.passwordsDoNotMatch'));
    setStep(2);
  }

  async function goStep3(e) {
    e.preventDefault();
    setError('');
    if (!company.trim()) return setError(t('setup.companyRequired'));
    setStep(3);
  }

  async function finish() {
    setSubmitting(true);
    setError('');
    try {
      await completeSetup({ admin_password: password, company_name: company, company_email: email, default_currency: currency });
      window.location.href = '/login';
    } catch (err) {
      setError(err.message);
      setStep(1);
    } finally {
      setSubmitting(false);
    }
  }

  const steps = [
    { s: 1, label: t('setup.step1Label') },
    { s: 2, label: t('setup.step2Label') },
    { s: 3, label: t('setup.step3Label') },
  ];

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 480 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', fontSize: 26,
          }}>⚙️</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0 }}>{t('setup.welcomeTitle')}</h1>
          <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 6 }}>{t('setup.completeSetup')}</p>
        </div>

        {/* Step indicators */}
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 28 }}>
          {steps.map(({ s, label }, i) => (
            <React.Fragment key={s}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700,
                  background: step >= s ? 'var(--accent)' : 'var(--bg-2)',
                  color: step >= s ? '#fff' : 'var(--text-3)',
                  border: step >= s ? 'none' : '1px solid var(--border)',
                  transition: 'all .2s',
                }}>{s}</div>
                <span style={{ fontSize: 11, color: step >= s ? 'var(--accent)' : 'var(--text-3)', marginTop: 6, textAlign: 'center', fontWeight: step === s ? 600 : 400 }}>{label}</span>
              </div>
              {i < 2 && (
                <div style={{
                  height: 2, flex: 1, margin: '14px 6px 0', flexShrink: 0,
                  background: step > s ? 'var(--accent)' : 'var(--border)',
                  transition: 'background .2s',
                }} />
              )}
            </React.Fragment>
          ))}
        </div>

        {error && (
          <div style={{
            padding: '10px 14px', background: 'var(--red-light)', border: '1px solid var(--red)',
            borderRadius: 8, fontSize: 13, color: 'var(--red)', marginBottom: 20,
          }}>
            {error}
          </div>
        )}

        {/* Step 1 — Set admin password */}
        {step === 1 && (
          <form onSubmit={goStep2}>
            <div className="card" style={{ padding: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>{t('setup.setAdminPassword')}</h3>
              <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 20px' }}>
                {t('setup.replaceDefault')}
              </p>
              <div className="form-group">
                <label className="form-label">{t('setup.newPasswordLabel')}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPw ? 'text' : 'password'}
                    className="form-control"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('setup.minCharsHint')}
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
                    {[password.length >= 8, /[A-Z]/.test(password), /[0-9]/.test(password)].map((ok, i) => (
                      <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: ok ? 'var(--green)' : 'var(--border)' }} />
                    ))}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">{t('setup.confirmPasswordLabel')}</label>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="form-control"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder={t('setup.repeatPassword')}
                  required
                />
                {confirm && password !== confirm && (
                  <p style={{ fontSize: 12, color: 'var(--red)', margin: '4px 0 0' }}>{t('setup.passwordsNoMatch')}</p>
                )}
              </div>
              <button type="submit" className="btn btn-primary w-100" style={{ marginTop: 8, padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600 }}>
                {t('setup.continueBtn')}
              </button>
            </div>
          </form>
        )}

        {/* Step 2 — Company info */}
        {step === 2 && (
          <form onSubmit={goStep3}>
            <div className="card" style={{ padding: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>{t('setup.companyInfo')}</h3>
              <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 20px' }}>
                {t('setup.appearsOn')}
              </p>
              <div className="form-group">
                <label className="form-label">{t('setup.companyNameLabel')} <span style={{ color: 'var(--red)' }}>*</span></label>
                <input className="form-control" value={company} onChange={e => setCompany(e.target.value)}
                  placeholder="Acme Corporation" autoFocus required />
              </div>
              <div className="form-group">
                <label className="form-label">{t('setup.companyEmailLabel')} <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.optional')}</span></label>
                <input className="form-control" type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="info@company.com" />
              </div>
              <div className="form-group">
                <label className="form-label">{t('setup.defaultCurrency')}</label>
                <select className="form-control" value={currency} onChange={e => setCurrency(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1, padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setStep(1)}>
                  {t('setup.backBtn')}
                </button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2, padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600 }}>
                  {t('setup.continueBtn')}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Step 3 — Confirm */}
        {step === 3 && (
          <div>
            <div className="card" style={{ padding: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 16px' }}>{t('setup.reviewConfirm')}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  [t('setup.adminPasswordRow'), '••••••••'],
                  [t('setup.companyNameRow'),   company],
                  [t('setup.emailRow'),         email || '—'],
                  [t('setup.currencyRow'),      currency],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-3)' }}>{label}</span>
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>{value}</span>
                  </div>
                ))}
              </div>
              <div style={{
                marginTop: 16, padding: '10px 14px',
                background: 'var(--green-light)', borderRadius: 8, fontSize: 12.5, color: 'var(--green)',
              }}>
                {t('setup.allGood')}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button className="btn btn-secondary" style={{ flex: 1, padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setStep(2)} disabled={submitting}>
                  {t('setup.backBtn')}
                </button>
                <button className="btn btn-primary" style={{ flex: 2, padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600 }} onClick={finish} disabled={submitting}>
                  {submitting ? t('setup.settingUp') : t('setup.launchERP')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
