import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput, BranchField } from '../../components/shared';
import { createApplicant, updateApplicant } from '../../api/client';
import { EMPTY_APPLICANT } from './constants';

function ApplicantForm({ mode, initial, positions, onClose, onSaved }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => ({
    ...EMPTY_APPLICANT,
    ...(initial || {}),
    position_id: initial?.position_id ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const isEdit = mode === 'edit';

  async function submit(e) {
    e.preventDefault();
    if (!form.full_name.trim()) { toast(t('recruitment.nameRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        full_name:       form.full_name.trim(),
        position_id:     form.position_id ? Number(form.position_id) : null,
        expected_salary: form.expected_salary !== '' ? Number(form.expected_salary) : null,
        rating:          form.rating ? Number(form.rating) : null,
        branch_id:       form.branch_id || null,
      };
      if (isEdit) await updateApplicant(initial.id, payload);
      else        await createApplicant(payload);
      toast(isEdit ? t('recruitment.applicantUpdated') : t('recruitment.applicantCreated'));
      onClose(); onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={isEdit ? t('recruitment.editApplicant') : t('recruitment.newApplicant')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.fieldFullName')} *</label>
              <input required className="form-control" value={form.full_name}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.colPosition')}</label>
              <select className="form-control" value={form.position_id || ''}
                onChange={e => setForm(f => ({ ...f, position_id: e.target.value }))}>
                <option value="">{t('recruitment.optSpeculative')}</option>
                {positions.filter(p => p.status === 'Open').map(p =>
                  <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
            <BranchField value={form.branch_id}
              onChange={v => setForm(f => ({ ...f, branch_id: v }))} />
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldSource')}</label>
              <input className="form-control" placeholder={t('recruitment.sourcePlaceholder')}
                value={form.source || ''}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldEmail')}</label>
              <input type="email" className="form-control" value={form.email || ''}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldPhone')}</label>
              <input className="form-control" value={form.phone || ''}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldExpected')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.expected_salary || ''}
                onChange={e => setForm(f => ({ ...f, expected_salary: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldRating')}</label>
              <NumberInput min="1" max="5" step="1" className="form-control" value={form.rating || ''}
                onChange={e => setForm(f => ({ ...f, rating: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.fieldNotes')}</label>
              <textarea className="form-control" rows={3} value={form.notes || ''}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
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
// APPLICANT DETAIL — pipeline + interviews + files + offered salary
// ════════════════════════════════════════════════════════════════════════════

export { ApplicantForm };
