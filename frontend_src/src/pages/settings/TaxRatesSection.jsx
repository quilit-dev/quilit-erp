import { useState, useEffect } from 'react';
import { getTaxRates, createTaxRate, updateTaxRate, deleteTaxRate } from '../../api/client';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Section, Field, Input, Toggle } from './ui';

const TAX_TYPES = ['standard', 'zero', 'exempt'];
const EMPTY_RATE = { name: '', rate: '', tax_type: 'standard', is_default: false, is_active: true };

// Manage the tax_rates table — the named rates assignable to document lines.
function TaxRatesSection({ canEdit, t }) {
  const { reload: reloadSettings } = useSettings();
  const [rates, setRates]   = useState([]);
  const [editing, setEditing] = useState(null);   // rate id | 'new' | null
  const [form, setForm]     = useState(EMPTY_RATE);
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');

  async function load() {
    try { setRates(await getTaxRates()); } catch { /* ignore */ }
  }
  useEffect(() => { load(); }, []);

  function startNew()  { setForm(EMPTY_RATE); setEditing('new'); setErr(''); }
  function startEdit(r) {
    setForm({ name: r.name, rate: r.rate, tax_type: r.tax_type,
              is_default: !!r.is_default, is_active: !!r.is_active });
    setEditing(r.id); setErr('');
  }

  async function save() {
    if (!form.name.trim()) { setErr(t('settings.taxRateNameRequired')); return; }
    setBusy(true); setErr('');
    try {
      const payload = { ...form, name: form.name.trim(), rate: Number(form.rate) || 0 };
      if (editing === 'new') await createTaxRate(payload);
      else                   await updateTaxRate(editing, payload);
      setEditing(null);
      await load();
      reloadSettings();   // refresh the rates the document forms see
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  async function remove(r) {
    setErr('');
    try { await deleteTaxRate(r.id); await load(); reloadSettings(); }
    catch (e) { setErr(e.message || 'Could not remove rate'); }
  }

  const setF = k => v => setForm(f => ({ ...f, [k]: v }));

  return (
    <Section title={t('settings.taxRates')} icon="receipt">
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: -4, marginBottom: 12 }}>
        {t('settings.taxRatesHint')}
      </p>
      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table>
          <thead>
            <tr>
              <th>{t('settings.taxRateName')}</th>
              <th style={{ textAlign: 'right' }}>{t('settings.taxRatePct')}</th>
              <th>{t('settings.taxRateType')}</th>
              <th></th>
              {canEdit && <th></th>}
            </tr>
          </thead>
          <tbody>
            {rates.length === 0 && (
              <tr><td colSpan={canEdit ? 5 : 4} style={{ color: 'var(--text-3)', fontSize: 13 }}>
                {t('settings.taxRatesEmpty')}
              </td></tr>
            )}
            {rates.map(r => (
              <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.5 }}>
                <td className="td-primary">{r.name}</td>
                <td style={{ textAlign: 'right' }}>{r.rate}%</td>
                <td style={{ textTransform: 'capitalize' }}>{t(`settings.taxType_${r.tax_type}`)}</td>
                <td>
                  {r.is_default ? <span className="badge badge-blue">{t('settings.taxRateDefault')}</span>
                    : !r.is_active ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('settings.taxRateInactive')}</span>
                    : null}
                </td>
                {canEdit && (
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => startEdit(r)}>
                      {t('common.edit')}
                    </button>
                    {!r.is_default && r.is_active && (
                      <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }}
                        onClick={() => remove(r)}>{t('settings.taxRateRemove')}</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <div className="alert alert-red" style={{ marginBottom: 12 }}>{err}</div>}

      {canEdit && editing !== null && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
          <div className="form-grid">
            <Field label={t('settings.taxRateName')}>
              <Input value={form.name} onChange={setF('name')} placeholder="VAT 11%" />
            </Field>
            <Field label={t('settings.taxRatePct')} hint="%">
              <Input value={form.rate} onChange={setF('rate')} type="number" placeholder="11" />
            </Field>
            <Field label={t('settings.taxRateType')}>
              <select className="form-control" value={form.tax_type}
                onChange={e => setF('tax_type')(e.target.value)}>
                {TAX_TYPES.map(tt => <option key={tt} value={tt}>{t(`settings.taxType_${tt}`)}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 20, margin: '8px 0 12px', flexWrap: 'wrap' }}>
            <Toggle label={t('settings.taxRateDefaultLabel')} checked={form.is_default}
              onChange={setF('is_default')} />
            <Toggle label={t('settings.taxRateActive')} checked={form.is_active}
              onChange={setF('is_active')} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setEditing(null); setErr(''); }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {canEdit && editing === null && (
        <button className="btn btn-secondary btn-sm" onClick={startNew}>
          + {t('settings.taxRateAdd')}
        </button>
      )}
    </Section>
  );
}

export { TaxRatesSection };
