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
import SearchSelect from '../../components/SearchSelect.jsx';

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
  // SearchSelect hands over the value itself rather than an event, so
  // the curried setter above has a sibling that takes one.
  const setVal = k => v => setForm(f => ({ ...f, [k]: v }));

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
      {/* .modal-body carries the padding AND the scroll region:
          .modal is `overflow: hidden` with a flex column, so content
          placed outside this wrapper has no padding and cannot scroll. */}
      <div className="modal-body">
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">{t('common.client')} *</label>
          <SearchSelect
            value={form.client_id}
            onChange={setVal('client_id')}
            required
            allowBlank={false}
            placeholder="—"
            options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('common.name')} *</label>
          <input className="form-control" value={form.name}
                 onChange={set('name')} required />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.manufacturer')}</label>
          <input className="form-control" value={form.manufacturer} onChange={set('manufacturer')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.model')}</label>
          <input className="form-control" value={form.model} onChange={set('model')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.serialNumber')}</label>
          <input className="form-control" value={form.serial_number} onChange={set('serial_number')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.installDate')}</label>
          <input type="date" className="form-control" value={form.install_date || ''}
                 onChange={set('install_date')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.location')}</label>
          <input className="form-control" value={form.location} onChange={set('location')} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">{t('common.notes')}</label>
        <textarea className="form-control" rows="2" value={form.notes} onChange={set('notes')} />
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
