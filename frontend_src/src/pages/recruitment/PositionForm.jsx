import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput, BranchField } from '../../components/shared';
import { createPosition, updatePosition } from '../../api/client';
import { EMP_TYPES, POS_STATUS_KEY, EMP_TYPE_KEY, EMPTY_POSITION , tEnum } from './constants';

function PositionForm({ posId, initial, departments, onClose, onSaved }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => ({ ...EMPTY_POSITION, ...(initial || {}) }));
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) { toast(t('recruitment.titleRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        title:         form.title.trim(),
        department_id: form.department_id ? Number(form.department_id) : null,
        salary_min:    form.salary_min !== '' ? Number(form.salary_min) : null,
        salary_max:    form.salary_max !== '' ? Number(form.salary_max) : null,
        headcount:     Number(form.headcount) || 1,
        branch_id:     form.branch_id || null,
      };
      if (posId) await updatePosition(posId, payload);
      else       await createPosition(payload);
      toast(posId ? t('recruitment.positionUpdated') : t('recruitment.positionCreated'));
      onClose(); onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={posId ? t('recruitment.editPosition') : t('recruitment.newPosition')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.fieldTitle')} *</label>
              <input required className="form-control" value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldDepartment')}</label>
              <select className="form-control" value={form.department_id || ''}
                onChange={e => setForm(f => ({ ...f, department_id: e.target.value }))}>
                <option value="">{t('recruitment.optNone')}</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldEmploymentType')}</label>
              <select className="form-control" value={form.employment_type}
                onChange={e => setForm(f => ({ ...f, employment_type: e.target.value }))}>
                {EMP_TYPES.map(x => <option key={x} value={x}>{tEnum(t, EMP_TYPE_KEY, x)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldLocation')}</label>
              <input className="form-control" value={form.location || ''}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldHeadcount')}</label>
              <NumberInput step="1" min="1" className="form-control" value={form.headcount}
                onChange={e => setForm(f => ({ ...f, headcount: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldSalaryMin')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.salary_min || ''}
                onChange={e => setForm(f => ({ ...f, salary_min: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldSalaryMax')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.salary_max || ''}
                onChange={e => setForm(f => ({ ...f, salary_max: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldStatus')}</label>
              <select className="form-control" value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {['Open', 'On Hold', 'Filled', 'Cancelled'].map(s =>
                  <option key={s} value={s}>{tEnum(t, POS_STATUS_KEY, s)}</option>)}
              </select>
            </div>
            <BranchField value={form.branch_id}
              onChange={v => setForm(f => ({ ...f, branch_id: v }))} />
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.fieldDescription')}</label>
              <textarea className="form-control" rows={3} value={form.description || ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.fieldRequirements')}</label>
              <textarea className="form-control" rows={3} value={form.requirements || ''}
                onChange={e => setForm(f => ({ ...f, requirements: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('recruitment.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('recruitment.saving') : t('recruitment.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// APPLICANT FORM
// ════════════════════════════════════════════════════════════════════════════

export { PositionForm };
