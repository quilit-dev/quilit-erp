/**
 * The job's header: the record of the call.
 *
 * Creating a job is the first step of the workflow and asks what a phone call
 * gives you: who is calling, which machine, what is wrong with it. There is
 * nowhere to put work done or parts used yet, because nobody has been to site
 * — offering those fields invites the office to guess, and a guess printed on
 * the work order is a line the technician will not write over.
 *
 * Editing the same job afterwards corrects the record of that call — the
 * machine was misidentified, the technician changed, the date moved. That is a
 * different and rarer thing than writing up a visit, which happens on the job's
 * own pane the moment it is opened (see WriteUp.jsx). Neither place carries a
 * copy of the other, so there is no second lines editor to keep in step.
 *
 * The payload therefore says nothing about `items`, and the endpoint leaves the
 * lines alone when it is not told about them. Posting an empty list would wipe
 * every part the technician had entered.
 */
import { useEffect, useState } from 'react';
import { createServiceJob, updateServiceJob, getServiceTechnicians,
         getServiceEquipment } from '../../api/client';
import { toast } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';

// Fixed lists, so the option VALUE is what gets stored and stays English
// whatever the reader's language; only the label is translated. tEnumValue is
// the same dictionary used for payment methods and units, which means the
// translation follows the value everywhere it is displayed later.
const JOB_TYPES = ['Installation', 'Maintenance', 'Repair', 'Inspection'];
const PRIORITIES = ['Low', 'Normal', 'High'];

export default function JobForm({ job, clients, onDone, onCancel }) {
  const { t, tEnumValue } = useLocale();
  const editing = !!job?.id;
  const [form, setForm] = useState(() => ({
    client_id: job?.client_id || '',
    equipment_id: job?.equipment_id || '',
    job_type: job?.job_type || 'Repair',
    priority: job?.priority || 'Normal',
    scheduled_date: job?.scheduled_date || '',
    // Who attended. Several people, drawn from the employee register rather
    // than from logins — a technician usually has no account, and a two-man
    // call is ordinary.
    technician_ids: (job?.technicians || []).map(x => x.id),
    reported_fault: job?.reported_fault || '',
  }));
  const [technicians, setTechnicians] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getServiceTechnicians().then(setTechnicians).catch(() => {});
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
  // SearchSelect hands over the value itself rather than an event, so
  // the curried setter above has a sibling that takes one.
  const setVal = k => v => setForm(f => ({ ...f, [k]: v }));
  const toggleTech = id => setForm(f => ({
    ...f,
    technician_ids: f.technician_ids.includes(id)
      ? f.technician_ids.filter(x => x !== id)
      : [...f.technician_ids, id],
  }));
  // Same shape as the announcement audience picker, which is the only other
  // place in the app that picks several people at once.
  const chip = (active) => ({
    padding: '6px 12px', borderRadius: 999,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid',
    borderColor: active ? 'var(--accent)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'var(--surface)',
    color: active ? 'var(--accent-ink)' : 'var(--text-2)',
    transition: 'all .12s',
  });

  async function submit(e) {
    e.preventDefault();
    if (!form.client_id) { toast(t('common.required'), 'red'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id: Number(form.client_id),
        equipment_id: form.equipment_id ? Number(form.equipment_id) : null,
        technician_ids: form.technician_ids,
        scheduled_date: form.scheduled_date || null,
        // Deliberately no `items`. The lines belong to the write-up, and the
        // endpoint leaves them untouched when a request says nothing about
        // them.
      };
      if (editing) {
        await updateServiceJob(job.id, payload);
        toast(t('service.jobUpdated'));
        onDone();
      } else {
        // The id goes back so the caller can open the job it just made: the
        // work order prints from there, and printing it is the next thing that
        // happens.
        const res = await createServiceJob(payload);
        toast(t('service.jobCreated'));
        onDone(res?.id);
      }
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
          <label className="form-label">{t('service.equipment')}</label>
          <SearchSelect className="form-control" value={form.equipment_id}
            onChange={setVal('equipment_id')} disabled={!form.client_id}
            placeholder="—"
            options={(equipment || []).map(e => ({
              value: e.id, label: e.name, hint: e.serial_number,
            }))} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.jobType')}</label>
          <SearchSelect className="form-control" value={form.job_type}
            onChange={setVal('job_type')} allowBlank={false}
            options={JOB_TYPES.map(x => ({ value: x, label: tEnumValue(x) }))} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.priority')}</label>
          <SearchSelect className="form-control" value={form.priority}
            onChange={setVal('priority')} allowBlank={false}
            options={PRIORITIES.map(x => ({ value: x, label: tEnumValue(x) }))} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.scheduledDate')}</label>
          <input type="date" className="form-control" value={form.scheduled_date || ''}
                 onChange={set('scheduled_date')} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('service.technicians')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 10,
                        background: 'var(--surface-2)', borderRadius: 8 }}>
            {technicians.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('service.noTechnicians')}
              </span>
            )}
            {technicians.map(p => (
              <button key={p.id} type="button" onClick={() => toggleTech(p.id)}
                      style={chip(form.technician_ids.includes(p.id))}
                      title={p.job_title || undefined}>
                {p.full_name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{t('service.reportedFault')}</label>
        <textarea className="form-control" rows="2" value={form.reported_fault || ''}
                  onChange={set('reported_fault')} />
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 0' }}>
        {editing ? t('service.editJobHint') : t('service.newJobHint')}
      </p>

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
