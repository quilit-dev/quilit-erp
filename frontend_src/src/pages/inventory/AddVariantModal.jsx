// One more variant for a product that already exists.
//
// The builder makes every variant on the day the product is created. A size
// that sells out and comes back in a colour nobody ordered before arrives
// later, and until this existed there was nowhere to put it --- a standalone
// item outside the group, or rebuilding the product. This is the small form
// for that case: the product's own variant fields, pre-filled with the values
// its siblings use so the new one is a pick and not a retype; price, cost and
// opening stock optional, inherited from the siblings when left blank.
import { useState, useEffect, useMemo } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { usePermissions } from '../../hooks/usePermissions';
import { LoadingSpinner, toast, NumberInput, fmt } from '../../components/shared';
import { getProduct, getAttributeDefs, addProductVariant } from '../../api/client';

export default function AddVariantModal({ productId, onSaved, onCancel }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const showCost = can('costs');
  const [product, setProduct] = useState(null);
  const [defs, setDefs] = useState([]);
  const [values, setValues] = useState({});      // axis name -> chosen value
  const [label, setLabel] = useState('');         // only when the product has no axes
  const [form, setForm] = useState({ barcode: '', sale_price: '', unit_cost: '', initial_quantity: '' });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    let alive = true;
    Promise.all([getProduct(productId), getAttributeDefs().catch(() => [])])
      .then(([p, d]) => { if (alive) { setProduct(p); setDefs(d || []); } })
      .catch(err => { if (alive) toast(err.message, 'red'); });
    return () => { alive = false; };
  }, [productId]);

  // The product's axes are whatever its existing variants carry --- Size and
  // Colour on a shirt --- not every field the business has defined. The
  // options for each are the definition's list plus any value a sibling
  // already uses, so a custom size the builder was given once is offered
  // again.
  const axes = useMemo(() => {
    if (!product) return [];
    const names = [];
    const used = {};
    for (const v of product.variants || []) {
      for (const [name, val] of Object.entries(v.attributes || {})) {
        if (!names.includes(name)) names.push(name);
        (used[name] ||= new Set()).add(val);
      }
    }
    return names.map(name => {
      const def = defs.find(d => (d.name || '').toLowerCase() === name.toLowerCase());
      const opts = new Set([...(def?.options || []), ...(used[name] || [])]);
      return { name, options: [...opts] };
    });
  }, [product, defs]);

  const siblings = product?.variants || [];
  const tpl = siblings[siblings.length - 1];
  const preview = axes.length
    ? axes.map(a => values[a.name]).filter(Boolean).join(' / ')
    : label.trim();
  const duplicate = preview && siblings.some(v =>
    (v.variant_label || '').trim().toLowerCase() === preview.toLowerCase());

  async function submit(e) {
    e.preventDefault();
    if (!preview) { toast(t('inventory.variantValueRequired'), 'red'); return; }
    if (axes.some(a => !values[a.name])) { toast(t('inventory.variantValueRequired'), 'red'); return; }
    if (duplicate) { toast(t('inventory.variantExists', { label: preview }), 'red'); return; }
    setSaving(true);
    try {
      const res = await addProductVariant(productId, {
        attributes: axes.length ? values : {},
        label: axes.length ? null : preview,
        barcode: form.barcode.trim() || null,
        sale_price: form.sale_price === '' ? null : Number(form.sale_price),
        unit_cost: form.unit_cost === '' ? null : Number(form.unit_cost),
        initial_quantity: Number(form.initial_quantity) || 0,
      });
      toast(t('inventory.variantAdded', { label: res.variant_label }));
      onSaved(res);
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  if (!product) return <LoadingSpinner />;

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
          <strong>{product.name}</strong>
          {siblings.length > 0 && (
            <span style={{ color: 'var(--text-3)' }}>
              {' · '}{t('inventory.existingVariants')}: {siblings.map(v => v.variant_label || '—').join(', ')}
            </span>
          )}
        </div>

        <div className="form-grid">
          {axes.length > 0 ? axes.map(a => (
            <div className="form-group" key={a.name}>
              <label className="form-label">{a.name}</label>
              {/* A text box with the known values offered, not a fixed list: a
                  size the definition never listed is still a size. */}
              <input className="form-control" list={`variant-axis-${a.name}`}
                value={values[a.name] || ''} autoComplete="off"
                onChange={e => setValues(s => ({ ...s, [a.name]: e.target.value.trim() }))}
                placeholder={t('inventory.pickOrTypeValue')} />
              <datalist id={`variant-axis-${a.name}`}>
                {a.options.map(o => <option key={o} value={o} />)}
              </datalist>
            </div>
          )) : (
            <div className="form-group form-full">
              <label className="form-label">{t('inventory.variantLabel')}</label>
              <input className="form-control" value={label} autoFocus
                onChange={e => setLabel(e.target.value)} placeholder={t('inventory.variantLabelPlaceholder')} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('inventory.barcodeLabel')}</label>
            <input className="form-control" value={form.barcode} onChange={set('barcode')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceHeader')}</label>
            <NumberInput className="form-control" min="0" step="0.01" value={form.sale_price}
              onChange={set('sale_price')}
              placeholder={tpl ? `${fmt(tpl.sale_price)} (${t('inventory.sameAsSiblings')})` : '0'} />
          </div>
          {showCost && (
            <div className="form-group">
              <label className="form-label">{t('inventory.unitCost')}</label>
              <NumberInput className="form-control" min="0" step="0.01" value={form.unit_cost}
                onChange={set('unit_cost')}
                placeholder={tpl ? `${fmt(tpl.unit_cost)} (${t('inventory.sameAsSiblings')})` : '0'} />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('inventory.openingStock')}</label>
            <NumberInput className="form-control" min="0" step="1" value={form.initial_quantity}
              onChange={set('initial_quantity')} placeholder="0" />
          </div>
        </div>

        {preview && (
          <div style={{ marginTop: 10, fontSize: 12, color: duplicate ? 'var(--red)' : 'var(--text-3)' }}>
            {duplicate
              ? t('inventory.variantExists', { label: preview })
              : <>{t('inventory.willCreate')} <strong>{product.name} — {preview}</strong></>}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving || !preview || duplicate}>
          {saving ? t('common.saving') : t('inventory.addVariantBtn')}
        </button>
      </div>
    </form>
  );
}
