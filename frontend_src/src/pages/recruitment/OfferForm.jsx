import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { createApplicantOffer, updateOffer } from '../../api/client';
import { OFFER_CT_KEY, PAY_SCHED_KEY, OFFER_CONTRACT_TYPES, OFFER_CURRENCIES,
         OFFER_PAY_SCHEDULES, LB_MAX_PROBATION_MONTHS, LB_MAX_WEEKLY_HOURS, EMPTY_OFFER , tEnum } from './constants';

function OfferForm({ appId, applicant, existing, onClose, onSaved }) {
  const { t } = useLocale();
  const [form, setForm] = useState(() => {
    if (existing) {
      return {
        ...EMPTY_OFFER,
        ...existing,
        // Backend stores NULL → JSON null; coerce to '' for date inputs.
        end_date:           existing.end_date           || '',
        probation_end_date: existing.probation_end_date || '',
        expires_at:         existing.expires_at         || '',
        benefits:           existing.benefits           || '',
        additional_terms:   existing.additional_terms   || '',
        place_of_work:      existing.place_of_work      || '',
        department_id:      existing.department_id      || '',
      };
    }
    // Sensible defaults: start a month out, monthly pay, USD (post-2019
    // dollarisation reality in Lebanon — change to LBP per contract if needed).
    const oneMonthOut = new Date(); oneMonthOut.setDate(oneMonthOut.getDate() + 30);
    const probEnd     = new Date(oneMonthOut); probEnd.setMonth(probEnd.getMonth() + 3);
    return {
      ...EMPTY_OFFER,
      job_title:          applicant?.position_title || '',
      start_date:         oneMonthOut.toISOString().slice(0, 10),
      probation_end_date: probEnd.toISOString().slice(0, 10),
      salary:             applicant?.expected_salary || 0,
    };
  });
  const [saving, setSaving] = useState(false);

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  // Auto-derive probation_end_date as the user changes start_date / probation_months,
  // unless they explicitly set their own end date. Keeps the contract internally
  // consistent without forcing manual arithmetic.
  useEffect(() => {
    if (!form.start_date || !form.probation_months) return;
    const start = new Date(form.start_date);
    if (isNaN(start)) return;
    const end = new Date(start);
    end.setMonth(end.getMonth() + Number(form.probation_months));
    setForm(f => ({ ...f, probation_end_date: end.toISOString().slice(0, 10) }));

  }, [form.start_date, form.probation_months]);

  async function submit(e) {
    e.preventDefault();
    if (!form.start_date)       { toast(t('recruitment.offerStartRequired'), 'error'); return; }
    if (!(Number(form.salary) > 0)) { toast(t('recruitment.offerSalaryRequired'), 'error'); return; }
    if (Number(form.probation_months) > LB_MAX_PROBATION_MONTHS) {
      toast(t('recruitment.offerProbExceed', { n: LB_MAX_PROBATION_MONTHS }), 'error');
      return;
    }
    if (Number(form.weekly_hours || 0) > LB_MAX_WEEKLY_HOURS) {
      toast(t('recruitment.offerHoursExceed', { n: LB_MAX_WEEKLY_HOURS }), 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        department_id:       form.department_id ? Number(form.department_id) : null,
        weekly_hours:        form.weekly_hours !== '' ? Number(form.weekly_hours) : null,
        annual_leave_days:   Number(form.annual_leave_days) || 0,
        notice_period_days:  Number(form.notice_period_days) || 0,
        salary:              Number(form.salary) || 0,
        probation_months:    Number(form.probation_months) || 0,
        non_compete_months:  Number(form.non_compete_months) || 0,
        end_date:           form.end_date           || null,
        probation_end_date: form.probation_end_date || null,
        expires_at:         form.expires_at         || null,
        benefits:           form.benefits           || null,
        additional_terms:   form.additional_terms   || null,
        place_of_work:      form.place_of_work      || null,
        job_title:          form.job_title          || null,
      };
      if (existing) await updateOffer(existing.id, payload);
      else          await createApplicantOffer(appId, payload);
      toast(existing ? t('recruitment.offerUpdated') : t('recruitment.offerCreated'));
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={existing ? t('recruitment.editOfferTitle', { number: existing.offer_number })
                            : t('recruitment.draftOfferTitle')}
           onClose={onClose} size="modal-lg">
      <form onSubmit={submit}>
        <div className="modal-body">

          {/* Disclaimer banner — never let HR forget this is a template */}
          <div style={{
            padding: '8px 12px', marginBottom: 14, borderRadius: 6,
            background: 'color-mix(in srgb, var(--yellow) 12%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--yellow) 35%, var(--border))',
            fontSize: 12, color: 'var(--text-2)',
          }}>
            {t('recruitment.offerDisclaimer')}
          </div>

          <div className="form-grid">

            {/* — Position & term — */}
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerContractType')}</label>
              <select className="form-control" value={form.contract_type}
                onChange={e => set('contract_type', e.target.value)}>
                {OFFER_CONTRACT_TYPES.map(x => <option key={x} value={x}>{tEnum(t, OFFER_CT_KEY, x)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerJobTitle')}</label>
              <input className="form-control" value={form.job_title}
                     onChange={e => set('job_title', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerStartDate')} *</label>
              <input type="date" required className="form-control" value={form.start_date}
                     onChange={e => set('start_date', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerEndDate')}</label>
              <input type="date" className="form-control" value={form.end_date}
                     onChange={e => set('end_date', e.target.value)}
                     min={form.start_date || undefined} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('recruitment.offerEndHint')}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerProbMonths')}</label>
              <NumberInput min="0" max={LB_MAX_PROBATION_MONTHS} step="1"
                     className="form-control" value={form.probation_months}
                     onChange={e => set('probation_months', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('recruitment.offerProbHint', { n: LB_MAX_PROBATION_MONTHS })}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerProbEnds')}</label>
              <input type="date" className="form-control" value={form.probation_end_date}
                     onChange={e => set('probation_end_date', e.target.value)} />
            </div>

            {/* — Schedule — */}
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.offerWorkSchedule')}</label>
              <input className="form-control" value={form.work_schedule}
                     onChange={e => set('work_schedule', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerWeeklyHours')}</label>
              <NumberInput min="0" max={LB_MAX_WEEKLY_HOURS} step="0.5"
                     className="form-control" value={form.weekly_hours}
                     onChange={e => set('weekly_hours', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('recruitment.offerWeeklyHint', { n: LB_MAX_WEEKLY_HOURS })}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerPlaceOfWork')}</label>
              <input className="form-control" value={form.place_of_work}
                     onChange={e => set('place_of_work', e.target.value)}
                     placeholder={t('recruitment.offerPlacePh')} />
            </div>

            {/* — Compensation — */}
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerSalaryLbl')} *</label>
              <NumberInput min="0" step="any" required className="form-control"
                     value={form.salary} onChange={e => set('salary', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerCurrency')}</label>
              <select className="form-control" value={form.salary_currency}
                onChange={e => set('salary_currency', e.target.value)}>
                {OFFER_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerPaymentSched')}</label>
              <select className="form-control" value={form.payment_schedule}
                onChange={e => set('payment_schedule', e.target.value)}>
                {OFFER_PAY_SCHEDULES.map(p => <option key={p} value={p}>{tEnum(t, PAY_SCHED_KEY, p)}</option>)}
              </select>
            </div>

            {/* — Leave & termination — */}
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerAnnualLeave')}</label>
              <NumberInput min="0" step="1" className="form-control"
                     value={form.annual_leave_days}
                     onChange={e => set('annual_leave_days', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('recruitment.offerAnnualHint')}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.offerNoticePeriod')}</label>
              <NumberInput min="0" step="1" className="form-control"
                     value={form.notice_period_days}
                     onChange={e => set('notice_period_days', e.target.value)} />
            </div>

            {/* — Lebanon-specific clauses — */}
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.offerClausesLbl')}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={form.include_nssf}
                         onChange={e => set('include_nssf', e.target.checked)} />
                  {t('recruitment.offerClauseNssf')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={form.include_eos}
                         onChange={e => set('include_eos', e.target.checked)} />
                  {t('recruitment.offerClauseEos')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={form.include_confidentiality}
                         onChange={e => set('include_confidentiality', e.target.checked)} />
                  {t('recruitment.offerClauseConf')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={form.include_non_compete}
                         onChange={e => set('include_non_compete', e.target.checked)} />
                  {t('recruitment.offerClauseNC')}
                </label>
                {form.include_non_compete && (
                  <div style={{ marginInlineStart: 24, marginTop: 4 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>{t('recruitment.offerNCDuration')}</label>
                    <NumberInput min="0" max="24" step="1"
                           className="form-control" style={{ maxWidth: 140 }}
                           value={form.non_compete_months}
                           onChange={e => set('non_compete_months', e.target.value)} />
                  </div>
                )}
              </div>
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.offerBenefitsLbl')}</label>
              <textarea className="form-control" rows={3}
                placeholder={t('recruitment.offerBenefitsPh')}
                value={form.benefits}
                onChange={e => set('benefits', e.target.value)} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('recruitment.offerExtraTermsLbl')}</label>
              <textarea className="form-control" rows={3}
                placeholder={t('recruitment.offerExtraTermsPh')}
                value={form.additional_terms}
                onChange={e => set('additional_terms', e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">{t('recruitment.offerExpiresOn')}</label>
              <input type="date" className="form-control" value={form.expires_at}
                     onChange={e => set('expires_at', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('recruitment.offerExpiresHint')}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('recruitment.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('recruitment.saving') : (existing ? t('recruitment.save') : t('recruitment.offerSaveDraft'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// OFFER LETTER PDF — Lebanon-style printable contract.
// Renders the offer as A4 HTML in a hidden iframe; user picks "Save as PDF"
// in the print dialog. Mirrors the existing pattern used by contracts /
// quotations / invoices so the print pipeline stays consistent.
// ════════════════════════════════════════════════════════════════════════════
function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Build a mailto: URL for sending an offer to the candidate. The PDF must be
 * downloaded separately and attached manually — mailto: can't carry attachments
 * across all clients. The body is short and assumes the user just generated
 * the PDF before clicking Email.
 */
function mailtoOffer(offer, applicant) {
  if (!applicant?.email) return '#';
  const subject = `Offer of employment — ${offer.offer_number}`;
  const body =
    `Dear ${applicant.full_name},\n\n` +
    `Please find attached our offer of employment as ${offer.job_title || 'discussed'}.\n` +
    `Start date: ${offer.start_date}.\n\n` +
    `Kindly review the contract, sign it, and return a signed copy at your ` +
    `earliest convenience. If you have any questions please reply to this email.\n\n` +
    `Best regards,`;
  return `mailto:${encodeURIComponent(applicant.email)}` +
         `?subject=${encodeURIComponent(subject)}` +
         `&body=${encodeURIComponent(body)}`;
}

function printOfferHTML(offer, company, lebanon) {
  const esc = _escHtml;
  const currency = offer.salary_currency || 'USD';
  const salaryFmt = Number(offer.salary || 0).toLocaleString('en-US', {
    style: 'currency', currency, maximumFractionDigits: 2,
  });
  const benefits = (offer.benefits || '').split('\n').filter(Boolean);
  const isPerm   = offer.contract_type === 'Permanent';

  // Build clause sections conditionally so the numbering stays clean.
  const clauses = [];
  // 1. Parties
  clauses.push({ title: 'Parties / الأطراف', body: `
    <table class="kv">
      <tr><td class="k">Employer / صاحب العمل</td><td>${esc(company.company_name || '—')}</td></tr>
      ${company.company_address ? `<tr><td class="k">Address / العنوان</td><td>${esc(company.company_address)}</td></tr>` : ''}
      ${company.company_tax_id ? `<tr><td class="k">Tax ID / الرقم الضريبي</td><td>${esc(company.company_tax_id)}</td></tr>` : ''}
      ${company.company_nssf_number ? `<tr><td class="k">NSSF No. / رقم الضمان</td><td>${esc(company.company_nssf_number)}</td></tr>` : ''}
      <tr><td class="k">Employee / الموظّف</td><td>${esc(offer.applicant_name)}</td></tr>
      ${offer.applicant_email ? `<tr><td class="k">Email / البريد</td><td>${esc(offer.applicant_email)}</td></tr>` : ''}
      ${offer.applicant_phone ? `<tr><td class="k">Phone / الهاتف</td><td>${esc(offer.applicant_phone)}</td></tr>` : ''}
    </table>`,
  });

  // 2. Position & duties
  clauses.push({ title: 'Position &amp; Duties / الوظيفة والمهام', body: `
    <table class="kv">
      <tr><td class="k">Position</td><td>${esc(offer.job_title || '—')}</td></tr>
      <tr><td class="k">Department</td><td>${esc(offer.department_name || '—')}</td></tr>
      <tr><td class="k">Place of work</td><td>${esc(offer.place_of_work || '—')}</td></tr>
    </table>
    <p>The Employee shall perform the duties customarily associated with the
    above position and any other reasonable tasks assigned by the Employer in
    line with the Employee's qualifications.</p>`,
  });

  // 3. Term & probation
  clauses.push({ title: 'Term &amp; Probation / المدة والتجربة', body: `
    <table class="kv">
      <tr><td class="k">Contract type</td><td>${esc(offer.contract_type)}</td></tr>
      <tr><td class="k">Start date</td><td>${esc(offer.start_date)}</td></tr>
      <tr><td class="k">End date</td><td>${esc(offer.end_date || (isPerm ? 'Indefinite' : '—'))}</td></tr>
      <tr><td class="k">Probation period</td><td>${esc(offer.probation_months)} months${offer.probation_end_date ? ` (ends ${esc(offer.probation_end_date)})` : ''}</td></tr>
    </table>
    <p style="font-size:10pt;color:#475569;">
      <em>Per ${esc(lebanon.labor_code_reference)} (Art. 9), the probationary
      period is capped at ${lebanon.max_probation_months} months. Either party
      may terminate the contract during this period without notice or indemnity.</em>
    </p>`,
  });

  // 4. Working hours
  clauses.push({ title: 'Working Hours / ساعات العمل', body: `
    <table class="kv">
      <tr><td class="k">Schedule</td><td>${esc(offer.work_schedule || '—')}</td></tr>
      <tr><td class="k">Weekly hours</td><td>${esc(offer.weekly_hours ?? '—')}</td></tr>
    </table>
    <p style="font-size:10pt;color:#475569;">
      <em>Article 31 of the Labor Code limits the working week to
      ${lebanon.max_weekly_hours} hours. Hours worked beyond the agreed weekly
      schedule are governed by the overtime provisions of the Labor Code.</em>
    </p>`,
  });

  // 5. Compensation
  clauses.push({ title: 'Compensation / التعويض', body: `
    <p>The Employer shall pay the Employee a gross
    ${esc(offer.payment_schedule.toLowerCase())} salary of
    <strong>${salaryFmt}</strong>, less any taxes, social security contributions
    and other lawful deductions.</p>`,
  });

  // 6. Annual leave
  clauses.push({ title: 'Annual Leave / الإجازة السنوية', body: `
    <p>The Employee is entitled to <strong>${esc(offer.annual_leave_days)}</strong>
    working days of paid annual leave per year, in accordance with Article 39
    of the Labor Code (minimum ${lebanon.min_annual_leave} days after one year
    of continuous service).</p>`,
  });

  // 7. NSSF (conditional)
  if (offer.include_nssf) {
    clauses.push({ title: 'Social Security / الضمان الاجتماعي', body: `
      <p>The Employer shall register the Employee with the
      <strong>${esc(lebanon.nssf_full_name)}</strong> and shall remit all
      employer and employee contributions in accordance with the Social
      Security Law. Income tax shall be withheld at source under Schedule R5
      and remitted to the Lebanese tax authority.</p>`,
    });
  }

  // 8. End-of-service indemnity (conditional)
  if (offer.include_eos) {
    clauses.push({ title: 'End-of-Service Indemnity / تعويض نهاية الخدمة', body: `
      <p>Upon lawful termination of this contract for any reason other than
      gross misconduct (Articles 74–75 of the Labor Code), the Employee shall
      be entitled to end-of-service indemnity calculated in accordance with
      the Social Security Law and the Labor Code — typically one month of
      the last drawn salary per year of service, accrued and payable through
      the NSSF end-of-service fund.</p>`,
    });
  }

  // 9. Notice period
  clauses.push({ title: 'Notice Period / مهلة الإنذار', body: `
    <p>Either party may terminate this contract by giving written notice of
    at least <strong>${esc(offer.notice_period_days)} days</strong> after the
    probationary period, without prejudice to the termination protections
    afforded by the Labor Code.</p>`,
  });

  // 10. Confidentiality (conditional)
  if (offer.include_confidentiality) {
    clauses.push({ title: 'Confidentiality / السرّية', body: `
      <p>The Employee undertakes to keep strictly confidential all information,
      documents, trade secrets and data relating to the Employer's business
      that the Employee may receive in the course of employment, both during
      and after the term of this contract.</p>`,
    });
  }

  // 11. Non-compete (conditional)
  if (offer.include_non_compete) {
    clauses.push({ title: 'Non-Compete / عدم المنافسة', body: `
      <p>For a period of <strong>${esc(offer.non_compete_months)} months</strong>
      following the end of this contract, the Employee shall not directly or
      indirectly engage in any business that competes with the Employer
      within the Republic of Lebanon. The parties acknowledge that
      enforceability of this clause is subject to the limits set by Lebanese
      law and the courts' assessment of reasonableness.</p>`,
    });
  }

  // 12. Additional terms (free text)
  if (offer.additional_terms) {
    clauses.push({ title: 'Additional Terms / أحكام إضافية', body: `
      <div class="clause">${esc(offer.additional_terms)}</div>`,
    });
  }

  // 13. Governing law (always)
  clauses.push({ title: 'Governing Law / القانون الواجب التطبيق', body: `
    <p>This contract is governed by the laws of the Republic of Lebanon, in
    particular the Labor Code and the Social Security Law. Any dispute
    arising from or in connection with this contract shall be referred to
    the competent labor courts in Beirut.</p>`,
  });

  // 14. Benefits (only if any listed)
  let benefitsHtml = '';
  if (benefits.length) {
    benefitsHtml = `
      <h2>${clauses.length + 1}. Benefits / المزايا</h2>
      <ul>${benefits.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
  }

  const html = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>Offer ${esc(offer.offer_number)}</title>
  <style>
    @page { size: A4; margin: 22mm 18mm; }
    body  { font-family: 'Helvetica Neue', Arial, 'Segoe UI', sans-serif;
            color: #1a1a1a; font-size: 11pt; line-height: 1.55; }
    .draft-stamp {
      position: fixed; top: 12mm; right: 14mm;
      background: #fef3c7; color: #92400e;
      padding: 4px 10px; border: 1px solid #f59e0b; border-radius: 3px;
      font-size: 9pt; font-weight: 700; letter-spacing: 0.5px;
    }
    .head { display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 18px; }
    .head h1   { font-size: 20pt; margin: 0; letter-spacing: 0.5px; }
    .head .sub { font-size: 12pt; color: #475569; margin-top: 2px;
                 letter-spacing: 0.3px; }
    .meta  { font-size: 9pt; color: #475569; text-align: right; line-height: 1.4; }
    .meta strong { color: #0f172a; }
    h2     { font-size: 12pt; border-bottom: 1px solid #cbd5e1;
             padding-bottom: 3px; margin: 16px 0 6px; }
    table.kv { width: 100%; border-collapse: collapse; }
    table.kv td { padding: 3px 8px; vertical-align: top; font-size: 10.5pt; }
    table.kv td.k { color: #475569; width: 30%; }
    .clause { white-space: pre-wrap; font-size: 10.5pt; }
    ul     { margin: 4px 0 4px 18px; padding: 0; }
    .sig   { display: flex; justify-content: space-between; gap: 30px;
             margin-top: 50px; page-break-inside: avoid; }
    .sig .box  { width: 45%; }
    .sig .line { border-top: 1px solid #1a1a1a; margin-top: 50px;
                 padding-top: 4px; font-size: 9pt; color: #475569; }
    .footer-note { margin-top: 30px; font-size: 8pt; color: #94a3b8;
                   text-align: center; border-top: 1px dashed #cbd5e1;
                   padding-top: 6px; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
             font-size: 8pt; background: #e2e8f0; color: #0f172a; }
  </style>
</head><body>

  <div class="draft-stamp">DRAFT — REVIEW WITH COUNSEL</div>

  <div class="head">
    <div>
      <h1>${esc(company.company_name || 'Employment Offer')}</h1>
      <div class="sub">EMPLOYMENT OFFER &middot; عرض عمل</div>
      <div style="color:#475569;font-size:9pt;margin-top:6px;">
        ${esc(company.company_address || '')}
        ${company.company_phone ? `<br>${esc(company.company_phone)}` : ''}
        ${company.company_email ? ` &middot; ${esc(company.company_email)}` : ''}
      </div>
    </div>
    <div class="meta">
      <div><strong>${esc(offer.offer_number)}</strong></div>
      <div>Issued: ${new Date().toLocaleDateString('en-GB')}</div>
      <div>${esc(offer.contract_type)} <span class="badge">${esc(offer.status)}</span></div>
      ${offer.expires_at ? `<div style="margin-top:2px;">Expires: ${esc(offer.expires_at)}</div>` : ''}
    </div>
  </div>

  <p>This document sets out the terms of the offer of employment from
  <strong>${esc(company.company_name || 'the Employer')}</strong>
  (the <em>"Employer"</em>) to
  <strong>${esc(offer.applicant_name)}</strong>
  (the <em>"Employee"</em>), with a proposed effective date of
  <strong>${esc(offer.start_date)}</strong>.
  This offer is governed by the ${esc(lebanon.labor_code_reference)}.</p>

  ${clauses.map((c, i) => `
    <h2>${i + 1}. ${c.title}</h2>
    ${c.body}
  `).join('')}

  ${benefitsHtml}

  <div class="sig">
    <div class="box">
      <div style="font-size:10pt;font-weight:700;">For the Employer / عن صاحب العمل</div>
      <div class="line">${esc(company.company_name || '')}<br>Name &amp; Title:<br>Date:</div>
    </div>
    <div class="box">
      <div style="font-size:10pt;font-weight:700;">The Employee / الموظّف</div>
      <div class="line">${esc(offer.applicant_name)}<br>Signature:<br>Date:</div>
    </div>
  </div>

  <p class="footer-note">
    DRAFT for legal review — this template was generated from the ERP and is
    not legal advice. Please have a qualified Lebanese labor-law professional
    review and finalise the document before signature.<br>
    ${esc(company.company_name || '')} · Generated ${new Date().toLocaleString('en-GB')}
  </p>

</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(html);
  iframe.contentDocument.close();
  iframe.onload = () => {
    try {
      iframe.contentWindow.document.title =
        `Offer_${offer.offer_number || offer.id}.pdf`;
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      // Give the print dialog time to grab focus before we tear down the frame.
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }
  };
}



export { OfferForm, mailtoOffer, printOfferHTML };
