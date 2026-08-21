import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { usePermissions } from '../../hooks/usePermissions';
import { useCategories } from '../../hooks/useCategories';
import { useSettings } from '../../hooks/useSettings.jsx';
import { NumberInput, SupplierCombobox, swallowScannerEnter } from '../../components/shared';
import { UNITS, PRODUCT_TYPES, fmtNum } from './ui';

function ItemForm({ initial = {}, knownCategories = [], suppliers = [], onSave, onCancel, saving }) {
  const { t, tCategory, tEnumValue } = useLocale();
  const { can } = usePermissions();
  const showCost = can('costs');
  const { exchangeRate } = useSettings();
  const rate = Number(exchangeRate?.rate) || 0;
  const hasRate = rate > 0;
  const secondary = exchangeRate?.secondary || 'LBP';
  const isEdit = !!initial.id;
  const regCats = useCategories('inventory');
  const allCats = [...new Set([...knownCategories, ...regCats])];

  const [form, setForm] = useState({
    name:           initial.name       || '',
    category:       initial.category   || '',
    product_type:   initial.product_type || '',
    customCategory: '',
    quantity:       initial.quantity   ?? 0,
    min_stock:      initial.min_stock  ?? 0,
    unit_cost:      initial.unit_cost ?? 0,
    // Cost is always stored in USD, so editing always starts in USD even if it
    // was originally typed in LBP. Sale price keeps its native currency.
    cost_currency:  'USD',
    sale_price:     initial.sale_price ?? 0,
    price_currency: (initial.price_currency || 'USD'),
    supplier:       initial.supplier   || '',
    unit:           initial.unit       || 'pcs',
    barcode:        initial.barcode    || '',
    lot_tracked:    !!initial.lot_tracked,
    shelf_life_days: initial.shelf_life_days ?? '',
  });

  const useCustom = form.category === '__custom__';
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Live equivalent in the *other* currency for a field entered in `cur`.
  function equiv(value, cur) {
    if (!hasRate || !value) return null;
    const n = Number(value) || 0;
    return cur === 'LBP'
      ? `≈ $${fmtNum(n / rate)}`
      : `≈ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n * rate)} ${secondary}`;
  }

  function submit(e) {
    e.preventDefault();
    const category = useCustom ? form.customCategory.trim() : form.category.trim();
    onSave({
      ...form, category: category || null, product_type: form.product_type || null,
      lot_tracked: !!form.lot_tracked,
      // Cost typed in LBP converts to USD server-side at this rate.
      exchange_rate: form.cost_currency === 'LBP' ? rate : undefined,
      shelf_life_days: form.shelf_life_days === '' || form.shelf_life_days == null
        ? null : Number(form.shelf_life_days),
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.itemNameLabel')}</label>
            <input className="form-control" required value={form.name}
              onChange={e => set('name', e.target.value)} />
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('common.category')}</label>
            <select className="form-control" value={form.category}
              onChange={e => set('category', e.target.value)}>
              <option value="">{t('inventory.noCategory')}</option>
              {allCats.map(c => <option key={c} value={c}>{tCategory(c)}</option>)}
              <option value="__custom__">{t('inventory.addCategoryOption')}</option>
            </select>
            {useCustom && (
              <input className="form-control" style={{ marginTop: 8 }}
                placeholder={t('inventory.typeCategoryName')}
                value={form.customCategory}
                onChange={e => set('customCategory', e.target.value)} />
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.productTypeLabel')}</label>
            <select className="form-control" value={form.product_type}
              onChange={e => set('product_type', e.target.value)}>
              <option value="">{t('inventory.ptypeUnclassified')}</option>
              {PRODUCT_TYPES.map(p => <option key={p} value={p}>{t(`inventory.ptype_${p}`)}</option>)}
            </select>
          </div>

          {!isEdit && (
            <div className="form-group">
              <label className="form-label">{t('inventory.initialQuantity')}</label>
              <NumberInput className="form-control" step="1" min="0"
                value={form.quantity} onChange={e => set('quantity', e.target.value)} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('inventory.minStockAlert')}</label>
            <NumberInput className="form-control" step="1" min="0"
              value={form.min_stock} onChange={e => set('min_stock', e.target.value)} />
          </div>

          {/* Hidden without the capability, and the server ignores any cost in
              the payload from such a user and keeps what is stored — so an
              absent field cannot post back as 0 and wipe the item's cost. */}
          {showCost && (
          <div className="form-group">
            <label className="form-label">{t('inventory.unitCostLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} />
              <select className="form-control" style={{ width: 86 }}
                value={form.cost_currency} onChange={e => set('cost_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {form.cost_currency === 'USD'
              ? null
              : <div className="form-help" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                  {t('inventory.costLockedToUsd')} {equiv(form.unit_cost, form.cost_currency)}
                </div>}
          </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('inventory.salePriceLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <NumberInput className="form-control" step="any" min="0" style={{ flex: 1 }}
                value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
              <select className="form-control" style={{ width: 86 }}
                value={form.price_currency} onChange={e => set('price_currency', e.target.value)}>
                <option value="USD">USD</option>
                <option value={secondary} disabled={!hasRate}>{secondary}</option>
              </select>
            </div>
            {equiv(form.sale_price, form.price_currency) && (
              <div className="form-help" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {form.price_currency === 'USD'
                  ? equiv(form.sale_price, 'USD')
                  : `${t('inventory.salePriceFloatsHint')} ${equiv(form.sale_price, form.price_currency)}`}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('inventory.unitLabel')}</label>
            <select className="form-control" value={form.unit}
              onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u} value={u}>{tEnumValue(u)}</option>)}
            </select>
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('inventory.supplierLabel')}</label>
            <SupplierCombobox
              value={form.supplier}
              suppliers={suppliers}
              onChange={v => set('supplier', v)} />
          </div>

          <div className="form-group form-full">
            <label className="form-label">{t('inventory.barcodeLabel')}</label>
            <input className="form-control" value={form.barcode}
              placeholder={t('inventory.barcodePlaceholder')}
              title={t('inventory.barcodeScanHint')}
              onKeyDown={swallowScannerEnter}
              onChange={e => set('barcode', e.target.value)} />
          </div>

          <div className="form-group form-full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={form.lot_tracked} onChange={e => set('lot_tracked', e.target.checked)} />
              {t('inventory.lotTracked')}
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('inventory.lotTrackedHint')}</span>
            </label>
            {form.lot_tracked && (
              <div style={{ marginTop: 8, maxWidth: 240 }}>
                <label className="form-label">{t('inventory.shelfLifeDays')}</label>
                <NumberInput className="form-control" min="0" step="1"
                  value={form.shelf_life_days}
                  onChange={e => set('shelf_life_days', e.target.value)}
                  placeholder={t('inventory.shelfLifeHint')} />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : isEdit ? t('common.save') : t('common.addItem')}
        </button>
      </div>
    </form>
  );
}

export { ItemForm };
