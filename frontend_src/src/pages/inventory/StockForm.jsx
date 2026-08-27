import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useWarehouses } from '../../hooks/useWarehouses';
import { toast, NumberInput } from '../../components/shared';
import { updateStock, getInventoryByWarehouse } from '../../api/client';
import SearchSelect from '../../components/SearchSelect.jsx';

function StockForm({ item, onDone, onCancel }) {
  const { t, tCategory } = useLocale();
  const [delta,  setDelta]  = useState('');
  const [type,   setType]   = useState('adjustment');
  const [note,   setNote]   = useState('');
  const [saving, setSaving] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [perWarehouse, setPerWarehouse] = useState([]);
  // Adjustments are warehouse-specific — show the per-warehouse breakdown
  // alongside the form so the operator can see what's where before adjusting.
  const { warehouses, defaultId } = useWarehouses();
  useEffect(() => {
    if (defaultId && !warehouseId) setWarehouseId(defaultId);
  }, [defaultId, warehouseId]);
  useEffect(() => {
    getInventoryByWarehouse(item.id)
      .then(setPerWarehouse)
      .catch(() => setPerWarehouse([]));
  }, [item.id]);

  const selectedWh = perWarehouse.find(p => p.warehouse_id === Number(warehouseId));

  async function submit(e) {
    e.preventDefault();
    const d = parseFloat(delta);
    if (isNaN(d) || d === 0) { toast(t('inventory.nonZeroQty'), 'red'); return; }
    setSaving(true);
    try {
      await updateStock(item.id, {
        delta: d, type, note,
        warehouse_id: warehouseId ? Number(warehouseId) : null,
      });
      toast(t('inventory.stockUpdated'));
      onDone();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="alert alert-yellow" style={{ marginBottom: 16 }}>
          {t('inventory.currentStock')} <strong>{item.quantity} {item.unit}</strong> {t('warehouses.breakdownTotal')}
          {perWarehouse.length > 0 && (
            <span style={{ color: 'var(--text-3)', fontSize: 12, marginInlineStart: 8 }}>
              · {perWarehouse.filter(p => p.quantity > 0).map(p => `${p.code} ${p.quantity}`).join(' · ') || t('warehouses.breakdownNone')}
            </span>
          )}
        </div>
        <div className="form-grid">
          {warehouses.length > 0 && (
            <div className="form-group form-full">
              <label className="form-label">{t('warehouses.field')}</label>
              <SearchSelect className="form-control" value={warehouseId}
                onChange={setWarehouseId} allowBlank={false}
                options={warehouses.map(w => {
                  const onHand = perWarehouse.find(p => p.warehouse_id === w.id)?.quantity ?? 0;
                  return {
                    value: w.id,
                    label: `${w.code} · ${w.name}`,
                    hint: `${onHand}${t('warehouses.onHandSuffix')}`,
                  };
                })} />
              {selectedWh && (
                <small style={{ color: 'var(--text-3)' }}>
                  {t('warehouses.adjustHint', { code: selectedWh.code })}
                </small>
              )}
            </div>
          )}
          <div className="form-group form-full">
            <label className="form-label">{t('inventory.qtyChange')}</label>
            <NumberInput className="form-control" step="1" required
              placeholder="e.g. 10 or -5"
              value={delta} onChange={e => setDelta(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.type')}</label>
            <SearchSelect
              className="form-control"
              value={type}
              onChange={v => setType(v)}
              options={[{ value: 'adjustment', label: t('inventory.manualAdj') }, { value: 'purchase', label: t('inventory.purchaseReceipt') }, { value: 'usage', label: t('inventory.usageConsumption') }, { value: 'return', label: t('inventory.return') }, { value: 'loss', label: t('inventory.lossDamage') }]} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('inventory.noteOptional')}</label>
            <input className="form-control" placeholder="Reason…"
              value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('inventory.updateStock')}
        </button>
      </div>
    </form>
  );
}

export { StockForm };
