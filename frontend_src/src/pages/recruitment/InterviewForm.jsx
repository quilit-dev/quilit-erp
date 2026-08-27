import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { scheduleInterview, updateInterview } from '../../api/client';
import { INT_TYPES, INT_STATUS, INT_DECISIONS, INT_TYPE_KEY, INT_STATUS_KEY, INT_DECISION_KEY , tEnum } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

function InterviewForm({ appId, existing, onClose, onSaved }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => existing ? {
    interview_type: existing.interview_type,
    scheduled_at:   (existing.scheduled_at || '').slice(0, 16).replace(' ', 'T'),
    duration_min:   existing.duration_min || 60,
    location:       existing.location || '',
    interviewer_name: existing.interviewer_name || '',
    status:         existing.status,
    score:          existing.score ?? '',
    decision:       existing.decision || '',
    notes:          existing.notes || '',
  } : {
    interview_type: 'Phone',
    scheduled_at:   '',
    duration_min:   60,
    location:       '',
    interviewer_name: '',
    status:         'Scheduled',
    score:          '',
    decision:       '',
    notes:          '',
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!form.scheduled_at) { toast(t('recruitment.intDateRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        scheduled_at: (form.scheduled_at || '').replace('T', ' '),
        duration_min: Number(form.duration_min) || 60,
        score: form.score === '' ? null : Number(form.score),
        decision: form.decision || null,
      };
      if (existing) await updateInterview(existing.id, payload);
      else          await scheduleInterview(appId, payload);
      toast(existing ? t('recruitment.intUpdated') : t('recruitment.intCreated'));
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={existing ? t('recruitment.intEditTitle') : t('recruitment.intScheduleTitle')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {!existing && (
            <p style={{
              marginBottom: 12, padding: '8px 12px',
              background: 'var(--surface-2)', borderRadius: 'var(--radius)',
              fontSize: 12, color: 'var(--text-3)',
            }}
            // Locale string carries inline <strong>; render as HTML.
            dangerouslySetInnerHTML={{ __html: t('recruitment.intMirrorNotice') }} />
          )}
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('recruitment.intColType')}</label>
              <SearchSelect
                className="form-control"
                value={form.interview_type}
                onChange={v => setForm(f => ({ ...f, interview_type: v }))}
                options={(INT_TYPES).map(x => ({ value: x, label: tEnum(t, INT_TYPE_KEY, x) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.colStatus')}</label>
              <SearchSelect
                className="form-control"
                value={form.status}
                onChange={v => setForm(f => ({ ...f, status: v }))}
                options={(INT_STATUS).map(x => ({ value: x, label: tEnum(t, INT_STATUS_KEY, x) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldWhen')} *</label>
              <input type="datetime-local" required className="form-control"
                value={form.scheduled_at}
                onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldDuration')}</label>
              <NumberInput min="0" step="5" className="form-control" value={form.duration_min}
                onChange={e => setForm(f => ({ ...f, duration_min: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldInterviewer')}</label>
              <input className="form-control" placeholder={t('recruitment.intInterviewerPlaceholder')}
                value={form.interviewer_name}
                onChange={e => setForm(f => ({ ...f, interviewer_name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldLocation')}</label>
              <input className="form-control" value={form.location}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldScore')}</label>
              <NumberInput min="1" max="10" step="1" className="form-control"
                value={form.score}
                onChange={e => setForm(f => ({ ...f, score: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.intFieldDecision')}</label>
              <SearchSelect
                className="form-control"
                value={form.decision}
                onChange={v => setForm(f => ({ ...f, decision: v }))}
                options={(INT_DECISIONS).map(x => ({ value: x, label: x ? tEnum(t, INT_DECISION_KEY, x) : t('recruitment.intPending') }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.intFieldNotes')}</label>
              <textarea className="form-control" rows={3} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('recruitment.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('recruitment.saving') : (existing ? t('recruitment.intActionSave') : t('recruitment.intActionSchedule'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ── Convert applicant → employee ───────────────────────────────────────────

export { InterviewForm };
