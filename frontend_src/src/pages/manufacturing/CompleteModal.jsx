import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { completeProductionOrder } from '../../api/client';
import { num, CostInput } from './ui';

function CompleteModal({ order, onClose, onDone }) {
  const { t } = useLocale();
  const remaining = order.remaining != null ? order.remaining : order.quantity;
  const usesResources = (order.resources || []).length > 0;
  const [partial, setPartial]   = useState(false);
  const [produced, setProduced] = useState(remaining);
  const [hours, setHours]       = useState('');
  const [labor, setLabor]       = useState(order.labor_cost ?? 0);
  const [overhead, setOverhead] = useState(order.overhead_cost ?? 0);
  const [rows, setRows] = useState(
    order.items.map(it => ({
      id: it.id, name: it.name, required: it.quantity_required,
      consumed: it.quantity_required, scrapped: 0,
    })),
  );
  const [busy, setBusy] = useState(false);

  const setRow = (id, patch) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));

  async function submit() {
    if (!(Number(produced) > 0)) { toast(t('manufacturing.qtyPositive'), 'red'); return; }
    setBusy(true);
    try {
      await completeProductionOrder(order.id, {
        quantity_produced: Number(produced),
        production_hours: hours === '' ? undefined : Number(hours),
        labor_cost: Number(labor) || 0,
        overhead_cost: Number(overhead) || 0,
        close: !partial,
        items: rows.map(r => ({
          id: r.id,
          quantity_consumed: Number(r.consumed) || 0,
          quantity_scrapped: Number(r.scrapped) || 0,
        })),
      });
      toast(partial ? t('manufacturing.partialRecorded') : t('manufacturing.orderCompleted'), 'green');
      onDone();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('manufacturing.completeTitle')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 0 }}>
          {t('manufacturing.completeHint')}
        </p>
        <table className="table" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>{t('manufacturing.component')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.planned')}</th>
              <th style={{ width: 120 }}>{t('manufacturing.consumed')}</th>
              <th style={{ width: 120 }}>{t('manufacturing.scrapped')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(r.required)}</td>
                <td>
                  <NumberInput className="form-control" style={{ height: 32 }} step="1" min="0"
                    value={r.consumed} onChange={e => setRow(r.id, { consumed: e.target.value })} />
                </td>
                <td>
                  <NumberInput className="form-control" style={{ height: 32 }} step="1" min="0"
                    value={r.scrapped} onChange={e => setRow(r.id, { scrapped: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.quantityProduced')}</label>
            <NumberInput className="form-control" step="1" min="1" value={produced}
              onChange={e => setProduced(e.target.value)} />
          </div>
          {usesResources ? (
            <div className="form-group">
              <label className="form-label">{t('manufacturing.productionHours')}
                <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
                  {t('manufacturing.productionHoursHint')}</span>
              </label>
              <NumberInput className="form-control" step="any" min="0" value={hours}
                onChange={e => setHours(e.target.value)} placeholder={t('manufacturing.standardIfBlank')} />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.laborCost')}</label>
                <CostInput valueUsd={labor} onChange={setLabor} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.overheadCost')}</label>
                <CostInput valueUsd={overhead} onChange={setOverhead} />
              </div>
            </>
          )}
        </div>
        {usesResources && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
            {t('manufacturing.resourcesOnOrder')}: {order.resources.map(r => `${r.name} ($${r.hourly_rate}/h)`).join(' · ')}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />
          {t('manufacturing.partialRun')}
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('manufacturing.partialRunHint')}</span>
        </label>
        {order.quantity_completed > 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '6px 0 0' }}>
            {t('manufacturing.alreadyProduced', { done: num(order.quantity_completed), planned: num(order.quantity) })}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? t('common.saving') : t('manufacturing.complete')}
        </button>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ORDER DETAIL MODAL — lifecycle, material status, cost, variance
// ════════════════════════════════════════════════════════════════════════════

export { CompleteModal };
