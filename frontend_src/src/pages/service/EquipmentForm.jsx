/**
 * A customer's machine.
 *
 * Serial number carries no unique constraint on purpose: serials collide across
 * manufacturers and are frequently blank on older equipment, so enforcing
 * uniqueness would block legitimate records for no gain.
 */
import { useState } from 'react';
import { createServiceEquipment, updateServiceEquipment } from '../../api/client';
import { toast } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

export default function EquipmentForm({ equipment, clients, onDone, onCancel }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => ({
    client_id:     equipment?.client_id || '',
    name:          equipment?.name || '',
    manufacturer:  equipment?.manufacturer || '',
    model:         equipment?.model || '',
    serial_number: equipment?.serial_number || '',
    install_date:  equipment?.install_date || '',
    location:      equipment?.location || '',
    notes:         equipment?.notes || '',
  }));
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id: Number(form.client_id),
        install_date: form.install_date || null,
      };
      if (equipment?.id) await updateServiceEquipment(equipment.id, payload);
      else await createServiceEquipment(payload);
      toast(t('common.saved'));
      onDone();
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <div className="form-group">
          <label>{t('common.client')} *</label>
          <select className="form-control" value={form.client_id}
                  onChange={set('client_id')} required>
            <option value="">—</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>{t('common.name')} *</label>
          <input className="form-control" value={form.name}
                 onChange={set('name')} required />
        </div>
        <div className="form-group">
          <label>{t('service.manufacturer')}</label>
          <input className="form-control" value={form.manufacturer} onChange={set('manufacturer')} />
        </div>
        <div className="form-group">
          <label>{t('service.model')}</label>
          <input className="form-control" value={form.model} onChange={set('model')} />
        </div>
        <div className="form-group">
          <label>{t('service.serialNumber')}</label>
          <input className="form-control" value={form.serial_number} onChange={set('serial_number')} />
        </div>
        <div className="form-group">
          <label>{t('service.installDate')}</label>
          <input type="date" className="form-control" value={form.install_date || ''}
                 onChange={set('install_date')} />
        </div>
        <div className="form-group">
          <label>{t('service.location')}</label>
          <input className="form-control" value={form.location} onChange={set('location')} />
        </div>
      </div>
      <div className="form-group">
        <label>{t('common.notes')}</label>
        <textarea className="form-control" rows="2" value={form.notes} onChange={set('notes')} />
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
