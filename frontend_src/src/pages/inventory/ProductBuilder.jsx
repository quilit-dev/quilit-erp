import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useCategories } from '../../hooks/useCategories';
import { useSettings } from '../../hooks/useSettings.jsx';
import { toast, NumberInput, swallowScannerEnter } from '../../components/shared';
import { getAttributeDefs } from '../../api/client';
import { fmtNum } from './ui';

function ProductBuilder({ knownCategories = [], onSave, onCancel, saving }) {
  const { t, tCategory } = useLocale();
  const { settings, exchangeRate } = useSettings();
  const rate = Number(exchangeRate?.rate) || 0;
  const hasRate = rate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
  const businessType = settings?.business_type || '';
  const regCats = useCategories('inventory');
  const allCats = [...new Set([...knownCategories, ...regCats])];

  const [defs, setDefs] = useState([]);
  const [form, setForm] = useState({
    name: '', category: '', brand: '', barcode_prefix: '',
    unit: 'pcs', unit_cost: 0, cost_currency: 'USD',
    sale_price: 0, price_currency: 'USD', min_stock: 0,
  });
  // axisSel[name] = Set of chosen values; descriptors[name] = string
  const [axisSel, setAxisSel] = useState({});
  const [descriptors, setDescriptors] = useState({});
  const [removed, setRemoved] = useState(() => new Set());   // combo keys dropped from the preview
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    // Pull owner-defined global fields plus the business-type presets, then
    // de-dupe by name (a custom "Size" shouldn't show twice next to a preset).
    Promise.all([
      getAttributeDefs({ scope_type: 'global' }),
      businessType ? getAttributeDefs({ scope_type: 'business', scope_value: businessType }) : Promise.resolve([]),
    ]).then(([global, biz]) => {
      const seen = new Set();
      const merged = [];
      for (const d of [...(global || []), ...(biz || [])]) {
        const key = (d.name || '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(d);
      }
      setDefs(merged);
    }).catch(() => setDefs([]));
  }, [businessType]);

  const axes = defs.filter(d => d.is_variant_axis);
  const descs = defs.filter(d => !d.is_variant_axis);

  function toggleAxis(name, val) {
    setAxisSel(s => {
      const next = new Set(s[name] || []);
      next.has(val) ? next.delete(val) : next.add(val);
      return { ...s, [name]: next };
    });
  }

  // Live preview: the actual combinations that will be generated, each
  // removable so the owner can drop combos they don't sell (e.g. 256GB / Red).
  const chosenAxes = axes
    .map(a => ({ name: a.name, values: [...(axisSel[a.name] || [])] }))
    .filter(a => a.values.length > 0);

  const allCombos = (() => {
    if (chosenAxes.length === 0) return [{ key: '__base__', label: null, attributes: {} }];
    let acc = [[]];
    for (const ax of chosenAxes) {
      const next = [];
      for (const combo of acc) for (const v of ax.values) next.push([...combo, v]);
      acc = next;
    }
    return acc.map(vals => ({
      key: vals.join(' / '),
      label: vals.join(' / '),
      attributes: Object.fromEntries(chosenAxes.map((ax, i) => [ax.name, vals[i]])),
    }));
  })();

  // Drop any stale removals whenever the axis selection changes.
  const comboSig = allCombos.map(c => c.key).join('|');
  useEffect(() => { setRemoved(new Set()); }, [comboSig]);

  const keptCombos = allCombos.filter(c => !removed.has(c.key));
  const variantCount = keptCombos.length;

  function equiv(value, cur) {
    if (!hasRate || !value) return null;
    const n = Number(value) || 0;
    return cur === 'LBP' ? `≈ $${fmtNum(n / rate)}`
      : `≈ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n * rate)} ${secondary}`;
  }

  function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('inventory.productNameRequired'), 'red'); return; }
    if (keptCombos.length === 0) { toast(t('inventory.keepOneVariant'), 'red'); return; }
    const cleanDesc = {};
    descs.forEach(d => { if (descriptors[d.name]) cleanDesc[d.name] = descriptors[d.name]; });
    if (form.brand) cleanDesc.Brand = form.brand;
    onSave({
      name: form.name.trim(), category: form.category || null, brand: form.brand || null,
      barcode_prefix: form.barcode_prefix || null, unit: form.unit,
      min_stock: Number(form.min_stock) || 0,
      unit_cost: Number(form.unit_cost) || 0, cost_currency: form.cost_currency,
      exchange_rate: form.cost_currency === 'LBP' ? rate : undefined,
      sale_price: Number(form.sale_price) || 0, price_currency: form.price_currency,
      // The exact (kept) combinations to create; backend creates these verbatim.
      variants: keptCombos.map(c => ({ label: c.label, attributes: c.attributes })),
      descriptors: cleanDesc,
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        {axes.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12,
            padding: '8px 10px', background: 'var(--bg)', borderRadius: 6 }}>
            {t('inventory.noVariantFieldsHint')}
          </div>
        )}
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.productNameLabel')}</label>
            <input className="form-control" required value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.category')}</label>
            <select className="form-control" value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">{t('inventory.noCategory')}</option>
              {allCats.map(c => <option key={c} value={c}>{tCategory(c)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.brandLabel')}</label>
            <input className="form-control" value={form.brand} onChange={e => set('brand', e.target.value)} />
          </div>
        </div>

        {/* Variant axes */}
        {axes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="form-label" style={{ marginBottom: 6 }}>{t('inventory.variantOptionsLabel')}</div>
            {axes.map(a => (
              <div key={a.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{a.name}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(a.options || []).map(opt => {
                    const on = (axisSel[a.name] || new Set()).has(opt);
                    return (
                      <button type="button" key={opt} onClick={() => toggleAxis(a.name, opt)}
                        className={`btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`}>
                        {opt}
                      </button>
                    );
                  })}
                  {(!a.options || a.options.length === 0) && (
                    <input className="form-control" style={{ height: 30, fontSize: 12 }}
                      placeholder={t('inventory.commaSeparatedValues')}
                      onBlur={e => {
                        const vals = e.target.value.split(',').map(v => v.trim()).filter(Boolean);
                        setAxisSel(s => ({ ...s, [a.name]: new Set(vals) }));
                      }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Descriptors (non-varying) */}
        {descs.length > 0 && (
          <div className="form-grid" style={{ marginTop: 8 }}>
            {descs.map(d => (
              <div key={d.id} className="form-group">
                <label className="form-label">{d.name}</label>
                <input className="form-control" value={descriptors[d.name] || ''}
                  onChange={e => setDescriptors(s => ({ ...s, [d.name]: e.target.value }))} />
              </div>
            ))}
          </div>
        )}

        {/* Variant preview — each combo removable before creating */}
        <div style={{ marginTop: 12 }}>
          <div className="form-label" style={{ marginBottom: 6 }}>
            {t('inventory.variantsPreviewLabel')} ({variantCount})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 150, overflowY: 'auto',
            padding: keptCombos.length ? 8 : 0, border: '1px solid var(--border)', borderRadius: 6 }}>
            {keptCombos.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--red)', padding: 8 }}>{t('inventory.keepOneVariant')}</div>
            ) : keptCombos.map(c => (
              <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 6px 4px 10px', borderRadius: 16, background: 'var(--bg)', fontSize: 12.5 }}>
                {c.label || t('inventory.baseVariant')}
                <button type="button" title={t('common.remove')}
                  onClick={() => setRemoved(s => new Set(s).add(c.key))}
                  style={{ border: 'none', background: 'var(--border)', color: 'var(--text-2)',
                    width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', lineHeight: 1, fontSize: 13 }}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {removed.size > 0 && (
            <button type="button" className="btn btn-sm btn-link" style={{ marginTop: 4, fontSize: 12 }}
              onClick={() => setRemoved(new Set())}>
              {t('inventory.restoreRemovedVariants', { count: removed.size })}
            </button>
          )}
        </div>

        {/* Base price/cost — inherited by every variant */}
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="form-group">
            <label className="form-label">{t('inventory.unitCostLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
              <select className="form-control" style={{ width: 80 }} value={form.cost_currency}
                onChange={e => set('cost_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.cost_currency === 'LBP' && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('inventory.costLockedToUsd')} {equiv(form.unit_cost, 'LBP')}</div>}
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
              <select className="form-control" style={{ width: 80 }} value={form.price_currency}
                onChange={e => set('price_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.price_currency === 'LBP' && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('inventory.salePriceFloatsHint')} {equiv(form.sale_price, 'LBP')}</div>}
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.barcodePrefixLabel')}</label>
            <input className="form-control" value={form.barcode_prefix}
              onKeyDown={swallowScannerEnter}
              onChange={e => set('barcode_prefix', e.target.value)} placeholder="e.g. TSHIRT-" />
          </div>
        </div>
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {t('inventory.variantsToCreate', { count: variantCount })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('inventory.createProductBtn')}
          </button>
        </div>
      </div>
    </form>
  );
}

export { ProductBuilder };
