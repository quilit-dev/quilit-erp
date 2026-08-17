import { useState, useEffect, useRef } from 'react';
import { api as API, getBackupStatus, runBackupNow, exportBackup, runIntegrityCheck, restoreBackup,
         getExchangeRate, setExchangeRate } from '../api/client';
import { useSettings } from '../hooks/useSettings.jsx';
import { useLocale } from '../hooks/useLocale.jsx';
import InventoryFieldsManager from '../components/InventoryFieldsManager.jsx';
import CategoriesManager from '../components/CategoriesManager.jsx';
import { Icon } from '../components/shared';
import { Section, Field, Input, Toggle, CURRENCIES } from './settings/ui';
import { TaxRatesSection } from './settings/TaxRatesSection';
import UserManualSection from './settings/UserManualSection.jsx';

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
  const [usbPath, setUsbPath]                     = useState(() => localStorage.getItem('erp_usb_backup_path') || '');
  const [exporting, setExporting]                 = useState(false);
  const [exportResult, setExportResult]           = useState(null);
  const restoreRef = useRef();
  const [rateInfo,   setRateInfo]   = useState(null);
  const [newRate,    setNewRate]    = useState('');
  const [rateNote,   setRateNote]   = useState('');
  const [savingRate, setSavingRate] = useState(false);
  const { reload: reloadSettings } = useSettings();

  useEffect(() => {
    API.get('/api/settings/').then(data => {
      setForm(data);
      setLogoPreview(`/api/settings/logo?_=${Date.now()}`);
    }).catch((err) => setMsg({ type: 'err', text: t('settings.failedLoad') + ': ' + (err.message || '') }));
    getBackupStatus().then(setBackupStatus).catch(() => {});
    getExchangeRate().then(setRateInfo).catch(() => {});
  }, []);

  function set(key) { return val => setForm(f => ({ ...f, [key]: val })); }
  function bool(key) { return val => setForm(f => ({ ...f, [key]: val ? '1' : '0' })); }
  function isOn(key) { return form[key] === '1' || form[key] === 1 || form[key] === true; }

  // Fields the PUT /api/settings/ endpoint will accept. Anything else in
  // `form` (e.g. `enabled_modules` — sourced from vendor_config and
  // read-only, or `setup_complete` — controlled by the setup wizard) is
  // dropped so the whole save isn't rejected for an extra field.
  const WRITABLE_SETTINGS = new Set([
    'company_name', 'company_tagline', 'company_address', 'company_city',
    'company_country', 'company_phone', 'company_email', 'company_website',
    'company_tax_number', 'company_reg_number',
    'default_currency', 'secondary_currency',
    'bank_name', 'bank_account', 'bank_iban', 'bank_swift',
    'default_tax_rate', 'tax_enabled', 'payment_terms_days',
    'invoice_prefix', 'quotation_prefix', 'contract_prefix',
    'receipt_voucher_prefix',
    'inventory_costing_method', 'business_type',
    'payroll_tax_pct', 'payroll_nssf_employee_pct',
    'payroll_nssf_employer_pct', 'payroll_overtime_multiplier',
    'footer_text', 'show_discount_col', 'show_tax_col',
    'show_barcode_col', 'show_total_words', 'preprinted_stationery',
    'pos_receipt_width',
  ]);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const payload = Object.fromEntries(
        Object.entries(form).filter(([k]) => WRITABLE_SETTINGS.has(k))
      );
      await API.put('/api/settings/', payload);
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
      setLogoPreview(`/api/settings/logo?_=${Date.now()}`);
      reloadSettings();
    } catch (err) {
      // Surface the real error so 422s / validation failures don't look
      // like generic save failures.
      const detail = err?.message || '';
      setMsg({ type: 'err', text: t('settings.failedSave') + (detail ? ': ' + detail : '') });
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


  async function handleExportBackup() {
    const dest = usbPath.trim();
    if (!dest) { setMsg({ type: 'err', text: t('settings.usbPathRequired') }); return; }
    setExporting(true); setExportResult(null); setMsg(null);
    try {
      localStorage.setItem('erp_usb_backup_path', dest);
      const result = await exportBackup({ path: dest });
      setExportResult(result);
      setMsg({ type: 'ok', text: t('settings.usbBackupDone') });
    } catch (err) {
      setMsg({ type: 'err', text: t('settings.usbBackupFailed') + ': ' + (err.message || '') });
    } finally { setExporting(false); }
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

  async function saveRate() {
    const r = parseFloat(newRate);
    if (!r || r <= 0) { setMsg({ type: 'err', text: t('settings.rateInvalid') }); return; }
    setSavingRate(true); setMsg(null);
    try {
      const updated = await setExchangeRate({ rate: r, note: rateNote || null });
      setRateInfo(updated);
      setNewRate(''); setRateNote('');
      setMsg({ type: 'ok', text: t('settings.rateUpdated') });
    } catch (err) {
      setMsg({ type: 'err', text: err.message || t('settings.failedSave') });
    } finally { setSavingRate(false); }
  }

  if (!form) return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      {msg ? (
        <div className={`alert alert-${msg.type === 'ok' ? 'green' : 'red'}`}>
          <Icon name={msg.type === 'ok' ? 'check-circle' : 'alert-circle'} size={14}
            style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{msg.text}
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
          <h2 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="settings" size={20} strokeWidth={1.9} style={{ color: 'var(--accent)' }} />
            {t('settings.title')}
          </h2>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      {!isAdmin && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: 'var(--yellow-light)', border: '1px solid var(--yellow)', borderRadius: 8, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', color: 'var(--yellow)' }}><Icon name="eye" size={16} /></span>
          <span style={{ fontSize: 13, color: 'var(--yellow)', fontWeight: 500 }}>{t('settings.viewOnly')}</span>
        </div>
      )}

      {/* The manual comes first, and deliberately sits outside the `form &&`
          guard below: someone who opened Settings looking for help should get
          it before a page of fields they may not be allowed to edit, and still
          get it if the settings themselves fail to load. */}
      <UserManualSection />

      {form && (<>
        {msg && (
          <div className={`alert alert-${msg.type === 'ok' ? 'green' : 'red'}`} style={{ marginBottom: 20 }}>
            <Icon name={msg.type === 'ok' ? 'check-circle' : 'alert-circle'} size={14}
            style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{msg.text}
          </div>
        )}

        {/* 1. Company Settings */}
        <Section title={t('settings.companySectionTitle')} icon="building">
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
                    {logoFile ? <><Icon name="paperclip" size={14} style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{logoFile.name}</> : t('settings.uploadLogo')}
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
        <Section title={t('settings.bankDetails')} icon="landmark">
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
        <Section title={t('settings.financialSettings')} icon="banknote">
          <div className="form-grid">
            <Field label={t('settings.invoicePrefix')}>
              <Input disabled={!isAdmin} value={form.invoice_prefix || ''} onChange={set('invoice_prefix')} placeholder="INV-" />
            </Field>
            <Field label={t('settings.quotationPrefix')}>
              <Input disabled={!isAdmin} value={form.quotation_prefix || ''} onChange={set('quotation_prefix')} placeholder="QTN-" />
            </Field>
            <Field label={t('settings.receiptVoucherPrefix')}>
              <Input disabled={!isAdmin} value={form.receipt_voucher_prefix || ''} onChange={set('receipt_voucher_prefix')} placeholder="RV-" />
            </Field>
            <Field label={t('settings.receiptWidth')} hint={t('settings.receiptWidthHint')}>
              <select className="form-control" disabled={!isAdmin}
                value={form.pos_receipt_width || '80'} onChange={set('pos_receipt_width')}>
                <option value="80">80 mm</option>
                <option value="58">58 mm</option>
              </select>
            </Field>
            <Field label={t('settings.contractPrefix')}>
              <Input disabled={!isAdmin} value={form.contract_prefix || ''} onChange={set('contract_prefix')} placeholder="CTR-" />
            </Field>
            <Field label={t('settings.defaultPaymentTerms')} hint={t('common.days')}>
              <Input disabled={!isAdmin} value={form.payment_terms_days || ''} onChange={set('payment_terms_days')} type="number" placeholder="15" />
            </Field>
          </div>
          <Toggle disabled={!isAdmin} label={t('settings.enableTax')} checked={isOn('tax_enabled')} onChange={bool('tax_enabled')} />
        </Section>

        {/* 3·2. Payroll Defaults — feed the payroll engine (tax, NSSF, overtime) */}
        <Section title={t('settings.payrollSettings')} icon="users">
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 14px' }}>
            {t('settings.payrollDefaultsDesc')}
          </p>
          <div className="form-grid">
            <Field label={t('settings.payrollTaxPct')} hint="%">
              <Input disabled={!isAdmin} type="number" value={form.payroll_tax_pct ?? ''} onChange={set('payroll_tax_pct')} placeholder="0" />
            </Field>
            <Field label={t('settings.payrollNssfEmployeePct')} hint="%">
              <Input disabled={!isAdmin} type="number" value={form.payroll_nssf_employee_pct ?? ''} onChange={set('payroll_nssf_employee_pct')} placeholder="0" />
            </Field>
            <Field label={t('settings.payrollNssfEmployerPct')} hint="%">
              <Input disabled={!isAdmin} type="number" value={form.payroll_nssf_employer_pct ?? ''} onChange={set('payroll_nssf_employer_pct')} placeholder="0" />
            </Field>
            <Field label={t('settings.payrollOvertimeMultiplier')} hint="×">
              <Input disabled={!isAdmin} type="number" value={form.payroll_overtime_multiplier ?? ''} onChange={set('payroll_overtime_multiplier')} placeholder="1.5" />
            </Field>
          </div>
        </Section>

        {/* 3c. Inventory & Costing */}
        <Section title={t('settings.inventorySettings')} icon="package">
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 14px' }}>
            {t('settings.inventoryCostingDesc')}
          </p>
          <Field label={t('settings.businessType')} hint={t('settings.businessTypeHint')}>
            <select
              className="form-control"
              style={{ maxWidth: 360, opacity: isAdmin ? 1 : 0.6, cursor: isAdmin ? 'pointer' : 'not-allowed' }}
              value={form.business_type || ''}
              onChange={e => isAdmin && set('business_type')(e.target.value)}
              disabled={!isAdmin}
            >
              <option value="">{t('settings.businessTypeGeneral')}</option>
              <option value="Apparel">{t('settings.businessTypeApparel')}</option>
              <option value="Electronics">{t('settings.businessTypeElectronics')}</option>
              <option value="Food & Beverage">{t('settings.businessTypeFnb')}</option>
            </select>
          </Field>
          <Field label={t('settings.inventoryCostingMethod')} hint={t('settings.inventoryCostingMethodHint')}>
            <select
              className="form-control"
              style={{ maxWidth: 360, opacity: isAdmin ? 1 : 0.6, cursor: isAdmin ? 'pointer' : 'not-allowed' }}
              value={form.inventory_costing_method || 'weighted_avg'}
              onChange={e => isAdmin && set('inventory_costing_method')(e.target.value)}
              disabled={!isAdmin}
            >
              <option value="weighted_avg">{t('settings.costingWeightedAvg')}</option>
              <option value="fifo">{t('settings.costingFifo')}</option>
              <option value="lifo">{t('settings.costingLifo')}</option>
            </select>
          </Field>
          <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg)', borderRadius: 6, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            {{
              weighted_avg: t('settings.costingWeightedAvgDesc'),
              fifo:         t('settings.costingFifoDesc'),
              lifo:         t('settings.costingLifoDesc'),
            }[form.inventory_costing_method || 'weighted_avg']}
            <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 11.5 }}>
              {t('settings.costingSwitchNote')}
            </div>
          </div>
        </Section>

        {/* 3·5. Inventory Fields — owner-defined custom attributes (variants etc.) */}
        <Section title={t('settings.inventoryFields')} icon="sliders">
          <InventoryFieldsManager canEdit={isAdmin} />
        </Section>

        {/* 3·6. Categories — owner-defined per-domain category registry */}
        <Section title={t('settings.categories')} icon="tag">
          <CategoriesManager canEdit={isAdmin} />
        </Section>

        {/* 3a. Tax Rates — used for per-line tax on documents */}
        <TaxRatesSection isAdmin={isAdmin} t={t} />

        {/* 3b. Exchange Rate — dual-currency foundation */}
        <Section title={t('settings.exchangeRate')} icon="arrow-left-right">
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 14px' }}>
            {t('settings.exchangeRateDesc')}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{t('settings.currentRate')}:</span>
            {rateInfo && rateInfo.current ? (
              <strong style={{ fontSize: 15 }}>
                1 {rateInfo.base_currency} = {Number(rateInfo.current.rate).toLocaleString()} {rateInfo.secondary_currency}
              </strong>
            ) : (
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{t('settings.noRateSet')}</span>
            )}
            {rateInfo && rateInfo.current && rateInfo.current.created_at && (
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                · {rateInfo.current.created_at}
                {rateInfo.current.set_by_name ? ` · ${rateInfo.current.set_by_name}` : ''}
              </span>
            )}
          </div>

          {isAdmin && (
            <div className="form-grid">
              <Field label={t('settings.newRate')}
                hint={rateInfo ? `${rateInfo.secondary_currency} / 1 ${rateInfo.base_currency}` : ''}>
                <Input type="number" value={newRate} onChange={setNewRate} placeholder="89000" />
              </Field>
              <Field label={t('settings.rateNote')} hint={t('common.optional')}>
                <Input value={rateNote} onChange={setRateNote} />
              </Field>
            </div>
          )}
          {isAdmin && (
            <button onClick={saveRate} disabled={savingRate} className="btn btn-primary" style={{ marginTop: 4 }}>
              {savingRate ? t('common.saving') : t('settings.saveRate')}
            </button>
          )}

          {rateInfo && rateInfo.history && rateInfo.history.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                {t('settings.rateHistory')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {rateInfo.history.map(h => (
                  <div key={h.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 10px', background: 'var(--bg-2)', borderRadius: 6, fontSize: 12,
                  }}>
                    <strong style={{ minWidth: 90 }}>{Number(h.rate).toLocaleString()}</strong>
                    <span style={{ color: 'var(--text-3)', flex: 1 }}>{h.note || ''}</span>
                    <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{h.set_by_name || ''}</span>
                    <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{h.created_at}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* 4. Document Settings */}
        <Section title={t('settings.documentSettings')} icon="file-text">
          <Field label={t('settings.footerText')}>
            <Input disabled={!isAdmin} value={form.footer_text || ''} onChange={set('footer_text')} />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
            <Toggle disabled={!isAdmin} label={t('settings.showDiscountCol')} checked={isOn('show_discount_col')} onChange={bool('show_discount_col')} />
            <Toggle disabled={!isAdmin} label={t('settings.showTaxCol')} checked={isOn('show_tax_col')} onChange={bool('show_tax_col')} />
            <Toggle disabled={!isAdmin} label={t('settings.showBarcodeCol')} checked={isOn('show_barcode_col')} onChange={bool('show_barcode_col')} />
            <Toggle disabled={!isAdmin} label={t('settings.showTotalWords')} checked={isOn('show_total_words')} onChange={bool('show_total_words')} />
            <Toggle disabled={!isAdmin} label={t('settings.preprintedStationery')} checked={isOn('preprinted_stationery')} onChange={bool('preprinted_stationery')} />
          </div>
        </Section>


        {/* 5. Backup & Integrity — admin only, and only on the self-hosted
            (SQLite) edition. A cloud (Postgres) deployment is backed up
            server-side, so this whole section (incl. the "works offline" pitch
            and USB/local backup) is hidden when form.local_backup is false. */}
        {isAdmin && form.local_backup && <Section title={t('settings.backupIntegrity')} icon="database">
          <div style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            background: 'var(--green-light)', border: '1px solid var(--green)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 18,
          }}>
            <span style={{ display: 'inline-flex', color: 'var(--green)', flexShrink: 0 }}><Icon name="shield" size={18} /></span>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--green)' }}>{t('settings.offlineTitle')}</strong><br />
              {t('settings.offlinePitch')}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <button onClick={handleRunBackup} disabled={runningBackup} className="btn btn-primary">
              {runningBackup ? t('settings.backingUp') : <><Icon name="refresh-cw" size={14} style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{t('settings.runBackup')}</>}
            </button>
            <button onClick={handleIntegrityCheck} disabled={checkingIntegrity} className="btn btn-secondary">
              {checkingIntegrity ? t('settings.checking') : <><Icon name="shield" size={14} style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{t('settings.runIntegrity')}</>}
            </button>
          </div>

          {/* One-click USB / folder backup */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 18, marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('settings.usbBackupTitle')}</div>
            <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>
              {t('settings.usbBackupHint')}
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control"
                style={{ flex: '1 1 240px', minWidth: 200, fontFamily: 'monospace', fontSize: 13 }}
                value={usbPath}
                onChange={e => setUsbPath(e.target.value)}
                placeholder={t('settings.usbPathPlaceholder')}
              />
              <button onClick={handleExportBackup} disabled={exporting || !usbPath.trim()}
                className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
                {exporting ? t('settings.backingUp') : t('settings.usbBackupBtn')}
              </button>
            </div>
            {exportResult && (
              <div style={{
                marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: 'var(--green-light)', border: '1px solid var(--green)', color: 'var(--text-2)',
              }}>
                <Icon name="check-circle" size={14} style={{ verticalAlign: '-2px', marginInlineEnd: 6, color: 'var(--green)' }} />{t('settings.usbBackupSavedTo')} <strong style={{ fontFamily: 'monospace' }}>{exportResult.path}</strong>
                {' '}({exportResult.size_kb} KB)
                {exportResult.verified && <span style={{ color: 'var(--green)' }}> · {t('settings.usbBackupVerified')}</span>}
              </div>
            )}
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
                {restoreFile ? <><Icon name="paperclip" size={14} style={{ verticalAlign: '-2px', marginInlineEnd: 6 }} />{restoreFile.name}</> : t('settings.selectBackupFile')}
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
                        {f.checksum_ok
                          ? <><Icon name="check-circle" size={12} style={{ verticalAlign: '-1px', marginInlineEnd: 4, color: 'var(--green)' }} />{f.checksum_short}</>
                          : f.checksum_short === 'no_sidecar' ? '— no checksum'
                          : <><Icon name="alert-circle" size={12} style={{ verticalAlign: '-1px', marginInlineEnd: 4, color: 'var(--red)' }} />{f.checksum_short}</>}
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
                        {f.checksum_ok
                          ? <><Icon name="check-circle" size={12} style={{ verticalAlign: '-1px', marginInlineEnd: 4, color: 'var(--green)' }} />{f.checksum_short}</>
                          : f.checksum_short === 'no_sidecar' ? '— no checksum'
                          : <><Icon name="alert-circle" size={12} style={{ verticalAlign: '-1px', marginInlineEnd: 4, color: 'var(--red)' }} />{f.checksum_short}</>}
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
              {saving ? t('common.saving') : t('settings.save')}
            </button>
          </div>
        )}
      </>)}
    </div>
  );
}
