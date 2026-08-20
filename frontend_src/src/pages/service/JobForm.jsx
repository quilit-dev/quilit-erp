/**
 * The job sheet form.
 *
 * A line is either a PART (drawn from stock, so it needs a stock item) or a
 * CHARGE (labour, callout, a flat fee). The two are added by separate buttons
 * rather than a type dropdown on a generic row, because they are different
 * things to the person filling this in — "what did I fit" and "what am I
 * charging for" — and because the backend rejects the mixed-up combinations
 * anyway. Making them distinct here means the rejection never happens.
 */
import { useEffect, useState } from 'react';
import { createServiceJob, updateServiceJob, getInventory, getUsers,
         getServiceEquipment } from '../../api/client';
import { NumberInput, toast, fmt } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

const JOB_TYPES = ['Installation', 'Maintenance', 'Repair', 'Inspection'];
const PRIORITIES = ['Low', 'Normal', 'High'];

const emptyPart = () => ({ line_type: 'part', inventory_id: '', name: '', quantity: 1, unit_price: 0 });
const emptyCharge = () => ({ line_type: 'charge', inventory_id: null, name: '', quantity: 1, unit_price: 0 });

export default function JobForm({ job, clients, onDone, onCancel }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => ({
    client_id: job?.client_id || '',
    equipment_id: job?.equipment_id || '',
    job_type: job?.job_type || 'Repair',
    priority: job?.priority || 'Normal',
    scheduled_date: job?.scheduled_date || '',
    assigned_to: job?.assigned_to || '',
    reported_fault: job?.reported_fault || '',
    work_done: job?.work_done || '',
  }));
  const [lines, setLines] = useState(() =>
    (job?.lines || []).map(l => ({
      line_type: l.line_type, inventory_id: l.inventory_id || '',
      name: l.name, quantity: l.quantity, unit_price: l.unit_price,
    })));
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInventory().then(r => setItems(r.items || r || [])).catch(() => {});
    getUsers().then(setUsers).catch(() => {});
  }, []);

  // Equipment is per client: showing another customer's machines invites the
  // mistake the backend then rejects.
  useEffect(() => {
    if (!form.client_id) { setEquipment([]); return; }
    getServiceEquipment({ client_id: form.client_id })
      .then(setEquipment)
      .catch(() => setEquipment([]));
  }, [form.client_id]);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setLine = (i, patch) =>
    setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  /** Choosing a stock item fills the name and price, which is what the
   *  technician expects and stops the two drifting apart. */
  function pickItem(i, inventoryId) {
    const it = items.find(x => String(x.id) === String(inventoryId));
    setLine(i, {
      inventory_id: inventoryId,
      name: it?.name || '',
      unit_price: it?.sale_price ?? 0,
    });
  }

  const subtotal = lines.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);

  async function submit(e) {
    e.preventDefault();
    if (!form.client_id) { toast(t('common.required'), 'red'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id: Number(form.client_id),
        equipment_id: form.equipment_id ? Number(form.equipment_id) : null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        scheduled_date: form.scheduled_date || null,
        items: lines
          .filter(l => (l.name || '').trim())
          .map(l => ({
            line_type: l.line_type,
            inventory_id: l.line_type === 'part' ? Number(l.inventory_id) || null : null,
            name: l.name,
            quantity: Number(l.quantity) || 0,
            unit_price: Number(l.unit_price) || 0,
          })),
      };
      if (job?.id) {
        await updateServiceJob(job.id, payload);
        toast(t('service.jobUpdated'));
      } else {
        await createServiceJob(payload);
        toast(t('service.jobCreated'));
      }
      onDone();
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {/* .modal-body carries the padding AND the scroll region:
          .modal is `overflow: hidden` with a flex column, so content
          placed outside this wrapper has no padding and cannot scroll. */}
      <div className="modal-body">
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">{t('common.client')} *</label>
          <select className="form-control" value={form.client_id}
                  onChange={set('client_id')} required>
            <option value="">—</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.equipment')}</label>
          <select className="form-control" value={form.equipment_id}
                  onChange={set('equipment_id')} disabled={!form.client_id}>
            <option value="">—</option>
            {equipment.map(e => (
              <option key={e.id} value={e.id}>
                {e.name}{e.serial_number ? ` (${e.serial_number})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.jobType')}</label>
          <select className="form-control" value={form.job_type} onChange={set('job_type')}>
            {JOB_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.priority')}</label>
          <select className="form-control" value={form.priority} onChange={set('priority')}>
            {PRIORITIES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.scheduledDate')}</label>
          <input type="date" className="form-control" value={form.scheduled_date || ''}
                 onChange={set('scheduled_date')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.assignedTo')}</label>
          <select className="form-control" value={form.assigned_to} onChange={set('assigned_to')}>
            <option value="">{t('service.unassigned')}</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{t('service.reportedFault')}</label>
        <textarea className="form-control" rows="2" value={form.reported_fault || ''}
                  onChange={set('reported_fault')} />
      </div>
      <div className="form-group">
        <label className="form-label">{t('service.workDone')}</label>
        <textarea className="form-control" rows="2" value={form.work_done || ''}
                  onChange={set('work_done')} />
      </div>

      <h3>{t('service.partsAndCharges')}</h3>
      <table>
        <thead>
          <tr>
            <th style={{ width: '45%' }}>{t('common.description')}</th>
            <th className="text-right">{t('common.quantity')}</th>
            <th className="text-right">{t('common.unitPrice')}</th>
            <th className="text-right">{t('common.total')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <span className={`badge badge-${l.line_type === 'part' ? 'blue' : 'gray'}`}>
                  {t(`service.${l.line_type}`)}
                </span>{' '}
                {l.line_type === 'part' ? (
                  <select className="form-control" value={l.inventory_id}
                          onChange={e => pickItem(i, e.target.value)} required>
                    <option value="">—</option>
                    {items.map(it => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.quantity} {it.unit || ''})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="form-control" value={l.name}
                         placeholder={t('service.charge')}
                         onChange={e => setLine(i, { name: e.target.value })} required />
                )}
              </td>
              {/* NumberInput adds no class of its own — it spreads props onto a
                  bare input — so without form-control these two rendered
                  unstyled next to the styled name field beside them. */}
              <td className="text-right">
                <NumberInput className="form-control" min="0" step="any"
                             style={{ textAlign: 'right' }}
                             value={l.quantity}
                             onChange={e => setLine(i, { quantity: e.target.value })} />
              </td>
              <td className="text-right">
                <NumberInput className="form-control" min="0" step="any"
                             style={{ textAlign: 'right' }}
                             value={l.unit_price}
                             onChange={e => setLine(i, { unit_price: e.target.value })} />
              </td>
              <td className="text-right">
                {fmt((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
              </td>
              <td>
                <button type="button" className="btn btn-sm btn-danger"
                        onClick={() => setLines(ls => ls.filter((_, n) => n !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-sm btn-secondary"
                onClick={() => setLines(ls => [...ls, emptyPart()])}>
          {t('service.addPart')}
        </button>
        <button type="button" className="btn btn-sm btn-secondary"
                onClick={() => setLines(ls => [...ls, emptyCharge()])}>
          {t('service.addCharge')}
        </button>
        <div style={{ marginInlineStart: 'auto', alignSelf: 'center' }}>
          <strong>{t('common.subtotal')}: {fmt(subtotal)}</strong>
        </div>
      </div>

      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  );
}
