import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { convertApplicant, getApplicantOffers } from '../../api/client';
import { EMP_TYPES, EMP_TYPE_KEY , tEnum } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

function ConvertForm({ applicant, positions, onClose, onConverted }) {
  const { t } = useLocale();
  const pos = positions.find(p => p.id === applicant.position_id) || {};
  // If the candidate has an Accepted offer, that offer is the authoritative
  // source for title / salary / type — pre-fill from it so HR doesn't re-key
  // the same numbers from two different forms. Loaded lazily so the modal
  // opens fast even when there are no offers.
  const [acceptedOffer, setAcceptedOffer] = useState(null);
  const [form, setForm] = useState({
    job_title:       pos.title || '',
    department_id:   pos.department_id || '',
    employment_type: pos.employment_type || 'Full-time',
    salary:          applicant.offered_salary || applicant.expected_salary || 0,
    hire_date:       new Date().toISOString().slice(0, 10),
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const offers = await getApplicantOffers(applicant.id);
        // Most recent Accepted offer wins (the API already orders newest-first).
        const acc = (offers || []).find(o => o.status === 'Accepted');
        if (cancelled || !acc) return;
        setAcceptedOffer(acc);
        setForm(f => ({
          ...f,
          job_title:     acc.job_title     || f.job_title,
          department_id: acc.department_id || f.department_id,
          salary:        acc.salary        || f.salary,
          hire_date:     acc.start_date    || f.hire_date,
        }));
      } catch { /* no offers — fall back to position defaults */ }
    })();
    return () => { cancelled = true; };
  }, [applicant.id]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...form,
        department_id: form.department_id ? Number(form.department_id) : null,
        salary: Number(form.salary) || 0,
        // Pass the accepted-offer id so the backend can auto-mint a matching
        // Active hr_contracts row instead of forcing HR to redraft everything
        // they already agreed in the offer.
        accepted_offer_id: acceptedOffer ? acceptedOffer.id : null,
      };
      const res = await convertApplicant(applicant.id, payload);
      toast(res.contract_created
            ? t('recruitment.onboardedWithContract', { empCode: res.employee_code, contractNumber: res.contract_number })
            : t('recruitment.onboardedAs', { code: res.employee_code }));
      onConverted();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('recruitment.onboardTitle', { name: applicant.full_name })} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {acceptedOffer ? (
            <div style={{
              padding: '8px 12px', marginBottom: 14, borderRadius: 6,
              background: 'color-mix(in srgb, var(--green) 10%, var(--surface-2))',
              border: '1px solid color-mix(in srgb, var(--green) 30%, var(--border))',
              fontSize: 12, color: 'var(--text-2)',
            }}
            // Locale text carries the bolded offer number; render as HTML.
            dangerouslySetInnerHTML={{
              __html: t('recruitment.onboardFromOfferBanner', {
                number: `<strong>${(acceptedOffer.offer_number || '').replace(/</g, '&lt;')}</strong>`,
              }),
            }} />
          ) : (
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 14 }}>
              {t('recruitment.onboardExplain')}
            </p>
          )}
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldJobTitle')}</label>
              <input className="form-control" value={form.job_title}
                onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldEmploymentType')}</label>
              <SearchSelect
                className="form-control"
                value={form.employment_type}
                onChange={v => setForm(f => ({ ...f, employment_type: v }))}
                options={(EMP_TYPES).map(x => ({ value: x, label: tEnum(t, EMP_TYPE_KEY, x) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldSalary')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.salary}
                onChange={e => setForm(f => ({ ...f, salary: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.fieldHireDate')}</label>
              <input type="date" className="form-control" value={form.hire_date}
                onChange={e => setForm(f => ({ ...f, hire_date: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('recruitment.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('recruitment.onboarding') : t('recruitment.onboardSubmit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// OFFER LETTER FORM
// ════════════════════════════════════════════════════════════════════════════
// Lebanon-aware draft contract for an applicant. Form mirrors the backend
// validation: probation capped at 3 months (Labor Code Art. 9), weekly hours
// capped at 48 (Art. 31). Defaults reflect standard local practice — annual
// leave 15 days, monthly pay, NSSF + EOS clauses on, confidentiality on,
// non-compete off (it's controversial and often unenforceable here).

export { ConvertForm };
