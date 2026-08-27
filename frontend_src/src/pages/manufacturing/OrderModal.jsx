import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Modal, toast, NumberInput } from '../../components/shared';
import { createProductionOrder } from '../../api/client';
import { Money, CostInput } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

function OrderModal({ boms, initialBom, onClose, onCreated }) {
  const { t } = useLocale();
  const usable = boms.filter(b => b.is_active);
  const [bomId, setBomId]   = useState(initialBom || usable[0]?.id || '');
  const [qty, setQty]       = useState(1);
  const [labor, setLabor]   = useState('');
  const [overhead, setOverhead] = useState('');
  const [priority, setPriority] = useState('Normal');
  const [dueDate, setDueDate]   = useState('');
  const [startDate, setStartDate] = useState('');
  const [notes, setNotes]   = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy]     = useState(false);
  const bom = usable.find(b => String(b.id) === String(bomId));
  // Components draw from — and the finished good lands at — one warehouse
  // (Phase 1 design). Defaults to the user's default warehouse.
  const { warehouses, defaultId } = useWarehouses();
  useEffect(() => {
    if (defaultId && !warehouseId) setWarehouseId(defaultId);
  }, [defaultId, warehouseId]);

  async function create() {
    if (!bomId) { toast(t('manufacturing.selectBom'), 'red'); return; }
    if (!(Number(qty) > 0)) { toast(t('manufacturing.qtyPositive'), 'red'); return; }
    setBusy(true);
    try {
      await createProductionOrder({
        bom_id: Number(bomId), quantity: Number(qty),
        labor_cost: labor === '' ? null : Number(labor),
        overhead_cost: overhead === '' ? null : Number(overhead),
        priority, due_date: dueDate || null, planned_start_date: startDate || null,
        notes: notes.trim() || null,
        warehouse_id: warehouseId ? Number(warehouseId) : null,
      });
      toast(t('manufacturing.orderCreated'), 'green');
      onCreated();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('manufacturing.newOrder')} onClose={onClose}>
      <div className="modal-body">
        <div className="form-group">
          <label className="form-label">{t('manufacturing.bom')}</label>
          <SearchSelect
            className="form-control"
            value={bomId}
            onChange={v => setBomId(v)}
            placeholder={t('manufacturing.selectBom')}
            options={(usable).map(b => ({ value: b.id, label: `${b.name} → ${b.output_name} (v${b.version})` }))} />
        </div>
        {bom && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            {t('manufacturing.unitCost')}: <Money value={bom.unit_cost} /> {t('manufacturing.perUnit')}
          </p>
        )}
        <div className="form-group">
          <label className="form-label">{t('manufacturing.quantityToProduce')}</label>
          <NumberInput className="form-control" step="1" min="1" value={qty}
            onChange={e => setQty(e.target.value)} autoFocus />
        </div>
        {warehouses.length > 1 && (
          <div className="form-group">
            <label className="form-label">{t('warehouses.field')}</label>
            <SearchSelect
              className="form-control"
              value={warehouseId}
              onChange={v => setWarehouseId(v)}
              options={(warehouses).map(w => ({ value: w.id, label: `${w.code} · ${w.name}${w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}` }))} />
            <small style={{ color: 'var(--text-3)' }}>{t('warehouses.fieldHintMfg')}</small>
          </div>
        )}
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('manufacturing.laborCostOverride')}</label>
            <CostInput valueUsd={labor === '' ? null : labor} onChange={v => setLabor(v)}
              placeholder={t('manufacturing.autoFromBom')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.overheadCostOverride')}</label>
            <CostInput valueUsd={overhead === '' ? null : overhead} onChange={v => setOverhead(v)}
              placeholder={t('manufacturing.autoFromBom')} />
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('manufacturing.priority')}</label>
            <SearchSelect
              className="form-control"
              value={priority}
              onChange={v => setPriority(v)}
              options={(['Low', 'Normal', 'High', 'Urgent']).map(p => ({ value: p, label: t(`manufacturing.prio_${p}`) }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.dueDate')}</label>
            <input className="form-control" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.plannedStart')}</label>
            <input className="form-control" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">{t('manufacturing.notes')}</label>
          <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !bomId} onClick={create}>
          {busy ? t('common.saving') : t('manufacturing.createOrder')}
        </button>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// COMPLETE MODAL — actual consumption, scrap and produced quantity
// ════════════════════════════════════════════════════════════════════════════

export { OrderModal };
