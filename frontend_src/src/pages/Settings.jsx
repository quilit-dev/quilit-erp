import { useState, useEffect, useRef } from 'react';
import { api as API, getBackupStatus, runBackupNow, runIntegrityCheck, restoreBackup } from '../api/client';
import { useSettings } from '../hooks/useSettings.jsx';
import { useLocale } from '../hooks/useLocale.jsx';

const Section = ({ title, icon, children }) => (
  <div className="card" style={{ marginBottom: 24, overflow: 'hidden' }}>
    <div className="card-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <h3 className="card-title" style={{ fontSize: 15 }}>{title}</h3>
      </div>
    </div>
    <div className="card-body">{children}</div>
  </div>
);

const Field = ({ label, hint, children }) => (
  <div className="form-group">
    <label className="form-label">
      {label}
      {hint && (
        <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
          {hint}
        </span>
      )}
    </label>
    {children}
  </div>
);

const Input = ({ value, onChange, type = 'text', placeholder, disabled }) => (
  <input
    type={type}
    value={value}
    onChange={e => !disabled && onChange(e.target.value)}
    placeholder={placeholder}
    className="form-control"
    disabled={disabled}
    style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
  />
);

const Toggle = ({ label, checked, onChange, disabled }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', opacity: disabled ? 0.6 : 1 }}>
    <div
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 12,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        position: 'relative', transition: 'background 0.2s',
        flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </div>
    <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{label}</span>
  </label>
);

const CURRENCIES = ['USD', 'EUR', 'GBP', 'LBP', 'AED', 'SAR', 'EGP', 'JOD'];

export default function Settings() {
  const { t } = useLocale();
  let _u = {};
  try { _u = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
  const isAdmin = Boolean(_u.is_superadmin);

  const [form, setForm]       = useState(null);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoFile, setLogoFile]       = useState(null);
  const fileRef = useRef();
  const [backupStatus, setBackupStatus]           = useState(null);
  const [runningBackup, setRunningBackup]         = useState(false);
  const [integrityResult, setIntegrityResult]     = useState(null);
  const [checkingIntegrity, setCheckingIntegrity] = useState(false);
  const [restoreFile, setRestoreFile]             = useState(null);
  const [restoring, setRestoring]                 = useState(false);
  const [confirmRestore, setConfirmRestore]       = useState(false);
  const restoreRef = useRef();
  const { reload: reloadSettings } = useSettings();

  useEffect(() => {
    API.get('/api/settings/').then(data => {
      setForm(data);
      setLogoPreview(`/logo.png?_=${Date.now()}`);
    }).catch((err) => setMsg({ type: 'err', text: t('settings.failedLoad') + ': ' + (err.message || '') }));
    getBackupStatus().then(setBackupStatus).catch(() => {});
  }, []);

  function set(key) { return val => setForm(f => ({ ...f, [key]: val })); }
  function bool(key) { return val => setForm(f => ({ ...f, [key]: val ? '1' : '0' })); }
  function isOn(key) { return form[key] === '1' || form[key] === 1 || form[key] === true; }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      await API.put('/api/settings/', form);
      if (logoFile) {
        const fd = new FormData();
        fd.append('file', logoFile);
        await fetch('/api/settings/logo', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: fd,
        });
      }
      setMsg({ type: 'ok', text: t('settings.savedMsg') });
      setLogoFile(null);
      setLogoPreview(`/logo.png?_=${Date.now()}`);
      reloadSettings();
    } catch {
      setMsg({ type: 'err', text: t('settings.failedSave') });
    } finally { setSaving(false); }
  }

  async function handleRunBackup() {
    setRunningBackup(true);
    try {
      await runBackupNow();
      const status = await getBackupStatus();
      setBackupStatus(status);
      setMsg({ type: 'ok', text: t('settings.backupSuccess') });
    } catch (err) {
      setMsg({ type: 'err', text: t('settings.backupFailed') + ': ' + (err.message || '') });
    } finally { setRunningBackup(false); }
  }

  async function handleRestore() {
    if (!restoreFile) return;
    setRestoring(true); setConfirmRestore(false); setMsg(null);
    try {
      const result = await restoreBackup(restoreFile);
      setMsg({ type: 'ok', text: result.message || t('settings.restoreSuccess') });
      setRestoreFile(null);
    } catch (err) {
      setMsg({ type: 'err', text: t('settings.restoreFailed') + ': ' + err.message });
    } finally { setRestoring(false); }
  }

  async function handleIntegrityCheck() {
    setCheckingIntegrity(true); setIntegrityResult(null);
    try {
      const result = await runIntegrityCheck();
      setIntegrityResult(result);
    } catch (err) {
      setIntegrityResult({ ok: false, error: err.message });
    } finally { setCheckingIntegrity(false); }
  }

  if (!form) return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      {msg ? (
        <div className={`alert alert-${msg.type === 'ok' ? 'green' : 'red'}`}>
          {msg.type === 'ok' ? '✓ ' : '✕ '}{msg.text}
        </div>
      ) : (
        <div className="empty-state"><p>{t('common.loading')}</p></div>
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title">⚙️ {t('settings.title')}</h2>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      {!isAdmin && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: 'var(--yellow-light)', border: '1px solid var(--yellow)', borderRadius: 8, marginBottom: 20 }}>
          <span style={{ fontSize: 16 }}>👁</span>
          <span style={{ fontSize: 13, color: 'var(--yellow)', fontWeight: 500 }}>{t('settings.viewOnly')}</span>
        </div>
      )}

      {form && (<>
        {msg && (
          <div className={`alert alert-${msg.type === 'ok' ? 'green' : 'red'}`} style={{ marginBottom: 20 }}>
            {msg.type === 'ok' ? '✓ ' : '✕ '}{msg.text}
          </div>
        )}

        {/* 1. Company Settings */}
        <Section title={t('settings.companySectionTitle')} icon="🏢">
          <div className="form-grid">
            <Field label={t('settings.companyName')}>
              <Input disabled={!isAdmin} value={form.company_name || ''} onChange={set('company_name')} placeholder="My Company Ltd." />
            </Field>
            <Field label={t('settings.tagline')} hint={t('common.optional')}>
              <Input disabled={!isAdmin} value={form.company_tagline || ''} onChange={set('company_tagline')} />
            </Field>
          </div>
          <Field label={t('settings.logo')} hint="PNG / JPG">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              {logoPreview && (
                <img src={logoPreview} alt="Logo"
                  style={{ height: 48, maxWidth: 120, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--border)' }}
                  onError={e => { e.target.style.display = 'none'; }} />
              )}
              {isAdmin && (
                <>
                  <button onClick={() => fileRef.current.click()} className="btn btn-secondary" style={{ borderStyle: 'dashed' }}>
                    {logoFile ? `📎 ${logoFile.name}` : t('settings.uploadLogo')}
                  </button>
                  <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files[0]; if (!f) return; setLogoFile(f); setLogoPreview(URL.createObjectURL(f)); }} />
                </>
              )}
            </div>
          </Field>
          <div className="form-grid">
            <Field label={t('settings.streetAddress')}>
              <Input disabled={!isAdmin} value={form.company_address || ''} onChange={set('company_address')} />
            </Field>
            <Field label={t('settings.city')}>
              <Input disabled={!isAdmin} value={form.company_city || ''} onChange={set('company_city')} />
            </Field>
            <Field label={t('settings.country')}>
              <Input disabled={!isAdmin} value={form.company_country || ''} onChange={set('company_country')} />
            </Field>
            <Field label={t('settings.phone')}>
              <Input disabled={!isAdmin} value={form.company_phone || ''} onChange={set('company_phone')} />
            </Field>
            <Field label={t('settings.email')}>
              <Input disabled={!isAdmin} value={form.company_email || ''} onChange={set('company_email')} />
            </Field>
            <Field label={t('settings.website')} hint={t('common.optional')}>
              <Input disabled={!isAdmin} value={form.company_website || ''} onChange={set('company_website')} />
            </Field>
            <Field label={t('settings.taxVatNumber')} hint={t('common.optional')}>
              <Input disabled={!isAdmin} value={form.company_tax_number || ''} onChange={set('company_tax_number')} />
            </Field>
            <Field label={t('settings.registrationNumber')} hint={t('common.optional')}>
              <Input disabled={!isAdmin} value={form.company_reg_number || ''} onChange={set('company_reg_number')} />
            </Field>
          </div>
          <Field label={t('settings.defaultCurrency')}>
            <select value={form.default_currency} onChange={e => isAdmin && set('default_currency')(e.target.value)}
              className="form-control" style={{ minWidth: 140, width: 'auto', opacity: isAdmin ? 1 : 0.6, cursor: isAdmin ? 'auto' : 'not-allowed' }}
              disabled={!isAdmin}>
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </Section>

        {/* 2. Bank Details */}
        <Section title={t('settings.bankDetails')} icon="🏦">
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            {t('settings.bankHint')}
          </p>
          <div className="form-grid">
            <Field label={t('settings.bankName')}>
              <Input disabled={!isAdmin} value={form.bank_name || ''} onChange={set('bank_name')} />
            </Field>
            <Field label={t('settings.accountNumber')}>
              <Input disabled={!isAdmin} value={form.bank_account || ''} onChange={set('bank_account')} />
            </Field>
            <Field label="IBAN">
              <Input disabled={!isAdmin} value={form.bank_iban || ''} onChange={set('bank_iban')} />
            </Field>
            <Field label={t('settings.swift')}>
              <Input disabled={!isAdmin} value={form.bank_swift || ''} onChange={set('bank_swift')} />
            </Field>
          </div>
        </Section>

        {/* 3. Financial Settings */}
        <Section title={t('settings.financialSettings')} icon="💰">
          <div className="form-grid">
            <Field label={t('settings.invoicePrefix')}>
              <Input disabled={!isAdmin} value={form.invoice_prefix || ''} onChange={set('invoice_prefix')} placeholder="INV-" />
            </Field>
            <Field label={t('settings.quotationPrefix')}>
              <Input disabled={!isAdmin} value={form.quotation_prefix || ''} onChange={set('quotation_prefix')} placeholder="QTN-" />
            </Field>
            <Field label={t('settings.defaultPaymentTerms')} hint={t('common.days')}>
              <Input disabled={!isAdmin} value={form.payment_terms_days || ''} onChange={set('payment_terms_days')} type="number" placeholder="15" />
            </Field>
            <Field label={t('settings.defaultTaxRate')} hint="%">
              <Input disabled={!isAdmin} value={form.default_tax_rate || ''} onChange={set('default_tax_rate')} type="number" placeholder="0" />
            </Field>
          </div>
          <Toggle disabled={!isAdmin} label={t('settings.enableTax')} checked={isOn('tax_enabled')} onChange={bool('tax_enabled')} />
        </Section>

        {/* 4. Document Settings */}
        <Section title={t('settings.documentSettings')} icon="📄">
          <Field label={t('settings.footerText')}>
            <Input disabled={!isAdmin} value={form.footer_text || ''} onChange={set('footer_text')} />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
            <Toggle disabled={!isAdmin} label={t('settings.showDiscountCol')} checked={isOn('show_discount_col')} onChange={bool('show_discount_col')} />
            <Toggle disabled={!isAdmin} label={t('settings.showTaxCol')} checked={isOn('show_tax_col')} onChange={bool('show_tax_col')} />
          </div>
        </Section>

        {/* 5. Backup & Integrity — admin only */}
        {isAdmin && <Section title={t('settings.backupIntegrity')} icon="🗄️">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button onClick={handleRunBackup} disabled={runningBackup} className="btn btn-primary">
              {runningBackup ? `⏳ ${t('settings.backingUp')}` : `🔄 ${t('settings.runBackup')}`}
            </button>
            <button onClick={handleIntegrityCheck} disabled={checkingIntegrity} className="btn btn-secondary">
              {checkingIntegrity ? `⏳ ${t('settings.checking')}` : `🔬 ${t('settings.runIntegrity')}`}
            </button>
          </div>

          {integrityResult && (
            <div style={{ marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: integrityResult.ok ? 'var(--green-light)' : 'var(--red-light)',
                color: integrityResult.ok ? 'var(--green)' : 'var(--red)',
                border: `1px solid ${integrityResult.ok ? 'var(--green)' : 'var(--red)'}`,
              }}>
                {integrityResult.ok ? t('settings.dbOk') : t('settings.dbProblem')}
                {integrityResult.checked_at && (
                  <span style={{ fontWeight: 400, opacity: 0.8 }}>· {integrityResult.checked_at}</span>
                )}
              </span>
              {!integrityResult.ok && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>
                  {integrityResult.integrity_check || integrityResult.error}
                </div>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 18, marginTop: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('settings.restoreFromBackup')}</div>
            <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>
              {t('settings.restoreHint')}
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => restoreRef.current.click()} className="btn btn-secondary" style={{ borderStyle: 'dashed' }}>
                {restoreFile ? `📎 ${restoreFile.name}` : t('settings.selectBackupFile')}
              </button>
              <input ref={restoreRef} type="file" accept=".db" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files[0]; if (f) { setRestoreFile(f); setConfirmRestore(false); } }} />
              {restoreFile && !confirmRestore && (
                <button className="btn btn-secondary" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                  onClick={() => setConfirmRestore(true)}>
                  {t('settings.restoreDatabase')}
                </button>
              )}
              {restoreFile && confirmRestore && (
                <button className="btn btn-secondary" style={{ background: 'var(--red)', color: '#fff', border: 'none' }}
                  onClick={handleRestore} disabled={restoring}>
                  {restoring ? t('settings.restoring') : t('settings.confirmReplace')}
                </button>
              )}
              {restoreFile && (
                <button className="btn btn-secondary" onClick={() => { setRestoreFile(null); setConfirmRestore(false); }}>{t('common.cancel')}</button>
              )}
            </div>
            {confirmRestore && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--red-light)', border: '1px solid var(--red)', borderRadius: 8, fontSize: 12, color: 'var(--red)' }}>
                {t('settings.restoreWarning')}
              </div>
            )}
          </div>

          {backupStatus && (<>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap', marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('settings.lastAutoBackup')}: <strong style={{ color: 'var(--text-1)' }}>{backupStatus.last_backup_at || t('common.none')}</strong>
              </span>
              {backupStatus.last_error && (
                <span style={{ fontSize: 12, color: 'var(--red)' }}>{t('common.error')}: {backupStatus.last_error}</span>
              )}
              {backupStatus.startup_integrity && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                  background: backupStatus.startup_integrity.ok ? 'var(--green-light)' : 'var(--red-light)',
                  color: backupStatus.startup_integrity.ok ? 'var(--green)' : 'var(--red)',
                }}>
                  {backupStatus.startup_integrity.ok ? t('settings.startupOk') : t('settings.startupFailed')}
                </span>
              )}
            </div>

            {backupStatus.daily_backups?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                  {t('settings.dailyBackups', { count: backupStatus.daily_backups.length })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {backupStatus.daily_backups.slice(0, 7).map(f => (
                    <div key={f.filename} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 10px', background: 'var(--bg-2)', borderRadius: 6, fontSize: 12,
                    }}>
                      <span style={{ fontFamily: 'monospace', color: 'var(--text-1)', flex: 1 }}>{f.filename}</span>
                      <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{f.size_kb} KB</span>
                      <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{f.modified_at}</span>
                      <span style={{
                        padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap',
                        background: f.checksum_ok ? 'var(--green-light)' : 'var(--yellow-light)',
                        color: f.checksum_ok ? 'var(--green)' : 'var(--yellow)',
                      }}>
                        {f.checksum_ok ? `✓ ${f.checksum_short}` : f.checksum_short === 'no_sidecar' ? '— no checksum' : `✕ ${f.checksum_short}`}
                      </span>
                    </div>
                  ))}
                  {backupStatus.daily_backups.length > 7 && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '2px 10px' }}>
                      + {backupStatus.daily_backups.length - 7} {t('settings.olderBackups')}
                    </div>
                  )}
                </div>
              </div>
            )}

            {backupStatus.weekly_backups?.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                  {t('settings.weeklyBackups', { count: backupStatus.weekly_backups.length })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {backupStatus.weekly_backups.map(f => (
                    <div key={f.filename} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 10px', background: 'var(--bg-2)', borderRadius: 6, fontSize: 12,
                    }}>
                      <span style={{ fontFamily: 'monospace', color: 'var(--text-1)', flex: 1 }}>{f.filename}</span>
                      <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{f.size_kb} KB</span>
                      <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{f.modified_at}</span>
                      <span style={{
                        padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap',
                        background: f.checksum_ok ? 'var(--green-light)' : 'var(--yellow-light)',
                        color: f.checksum_ok ? 'var(--green)' : 'var(--yellow)',
                      }}>
                        {f.checksum_ok ? `✓ ${f.checksum_short}` : f.checksum_short === 'no_sidecar' ? '— no checksum' : `✕ ${f.checksum_short}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>)}
        </Section>}

        {isAdmin && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={save} disabled={saving} className="btn btn-primary" style={{ padding: '10px 32px', fontSize: 15 }}>
              {saving ? t('common.saving') : `💾 ${t('settings.save')}`}
            </button>
          </div>
        )}
      </>)}
    </div>
  );
}
