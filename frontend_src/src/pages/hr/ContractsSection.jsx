import { useState, useCallback, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal, fmt, fmtDate, toast, NumberInput } from '../../components/shared';
import { getContracts, createContract, updateContract,
         setContractStatus, getContractPrintData } from '../../api/client';
import { contractStatusLabel } from './constants';
import { Section } from './primitives';
import SearchSelect from '../../components/SearchSelect.jsx';

const CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation', 'Internship', 'Consultant'];
const CONTRACT_BADGE = { Draft: 'gray', Active: 'green', Expired: 'yellow', Terminated: 'red' };

function ContractsSection({ empId, canEdit }) {
  const { t } = useLocale();
  const [list,     setList]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing,  setEditing]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setList(await getContracts({ employee_id: empId })); }
    catch { /* silent — section will show empty */ }
    finally { setLoading(false); }
  }, [empId]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(id, status, reason = null) {
    try {
      await setContractStatus(id, { status, reason });
      toast(t('hr.contractStatusChanged', { status: contractStatusLabel(status, t) }));
      await load();
    }
    catch (err) { toast(err.message, 'error'); }
  }

  async function printContract(id) {
    try {
      const data = await getContractPrintData(id);
      printContractHTML(data.contract, data.company);
    } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <Section title={t('hr.employmentContracts')} right={canEdit && (
      <button className="btn btn-sm btn-primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
        {t('hr.newContract')}
      </button>
    )}>
      {loading ? <LoadingSpinner /> :
       list.length === 0 ? <EmptyState message={t('hr.noContractsOnFile')} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('hr.colNumber')}</th><th>{t('hr.colType')}</th><th>{t('common.status')}</th><th>{t('hr.colPeriod')}</th>
                <th style={{ textAlign: 'right' }}>{t('hr.colSalary')}</th><th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map(c => (
                <tr key={c.id}>
                  <td className="text-mono">{c.contract_number || `#${c.id}`}</td>
                  <td>{c.contract_type}</td>
                  <td><span className={`badge badge-${CONTRACT_BADGE[c.status] || 'gray'}`}>{contractStatusLabel(c.status, t)}</span></td>
                  <td>
                    {fmtDate(c.start_date)}{c.end_date ? ` → ${fmtDate(c.end_date)}` : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(c.salary || 0)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => printContract(c.id)}>📄 {t('hr.print')}</button>
                      {canEdit && (
                        <>
                          <button className="btn btn-sm btn-secondary" onClick={() => { setEditing(c); setFormOpen(true); }}>{t('common.edit')}</button>
                          {c.status === 'Draft' && (
                            <button className="btn btn-sm btn-primary" onClick={() => setStatus(c.id, 'Active')}>{t('hr.activate')}</button>
                          )}
                          {c.status === 'Active' && (
                            <button className="btn btn-sm btn-danger" onClick={() => {
                              const reason = window.prompt(t('hr.terminationReasonPrompt'), '');
                              if (reason !== null) setStatus(c.id, 'Terminated', reason || 'Terminated');
                            }}>{t('hr.terminate')}</button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <ContractForm
          empId={empId}
          existing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={async () => { setFormOpen(false); await load(); }}
        />
      )}
    </Section>
  );
}


function ContractForm({ empId, existing, onClose, onSaved }) {
  const { t, tEnumValue } = useLocale();
  const [form, setForm] = useState(() => existing ? {
    contract_type:      existing.contract_type,
    start_date:         existing.start_date || '',
    end_date:           existing.end_date || '',
    probation_end_date: existing.probation_end_date || '',
    job_title:          existing.job_title || '',
    work_schedule:      existing.work_schedule || '',
    weekly_hours:       existing.weekly_hours ?? '',
    salary:             existing.salary ?? 0,
    salary_currency:    existing.salary_currency || 'USD',
    benefits:           existing.benefits || '',
    terms:              existing.terms || '',
  } : {
    contract_type:      'Permanent',
    start_date:         new Date().toISOString().slice(0, 10),
    end_date:           '',
    probation_end_date: '',
    job_title:          '',
    work_schedule:      'Mon–Fri 9:00–18:00',
    weekly_hours:       40,
    salary:             0,
    salary_currency:    'USD',
    benefits:           '',
    terms:              '',
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!form.start_date) { toast(t('hr.startDateRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        employee_id: empId,
        ...form,
        weekly_hours: form.weekly_hours !== '' ? Number(form.weekly_hours) : null,
        salary:       Number(form.salary) || 0,
        // dates with empty strings → null
        end_date:           form.end_date           || null,
        probation_end_date: form.probation_end_date || null,
      };
      if (existing) await updateContract(existing.id, payload);
      else          await createContract(payload);
      toast(existing ? t('hr.contractUpdated') : t('hr.contractCreated'));
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={existing ? t('hr.editContract') : t('hr.newEmploymentContract')} onClose={onClose} size="modal-lg">
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('hr.contractType')}</label>
              <SearchSelect
                className="form-control"
                value={form.contract_type}
                onChange={v => setForm(f => ({ ...f, contract_type: v }))}
                options={(CONTRACT_TYPES).map(x => ({ value: x, label: tEnumValue(x) }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.jobTitleField')}</label>
              <input className="form-control" value={form.job_title}
                onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.fldStartDate')} *</label>
              <input type="date" required className="form-control" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.fldEndDate')}</label>
              <input type="date" className="form-control" value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.probationEnds')}</label>
              <input type="date" className="form-control" value={form.probation_end_date}
                onChange={e => setForm(f => ({ ...f, probation_end_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.weeklyHours')}</label>
              <NumberInput min="0" step="0.5" className="form-control" value={form.weekly_hours}
                onChange={e => setForm(f => ({ ...f, weekly_hours: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.workSchedule')}</label>
              <input className="form-control" value={form.work_schedule}
                onChange={e => setForm(f => ({ ...f, work_schedule: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.salaryField')}</label>
              <NumberInput min="0" step="any" className="form-control" value={form.salary}
                onChange={e => setForm(f => ({ ...f, salary: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('hr.currencyField')}</label>
              <SearchSelect
                className="form-control"
                value={form.salary_currency}
                onChange={v => setForm(f => ({ ...f, salary_currency: v }))}
                options={(['USD', 'EUR', 'LBP', 'AED', 'SAR']).map(c => ({ value: c, label: c }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.benefitsField')}</label>
              <textarea className="form-control" rows={3} placeholder={t('hr.benefitsPh')}
                value={form.benefits}
                onChange={e => setForm(f => ({ ...f, benefits: e.target.value }))} />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{t('hr.additionalTerms')}</label>
              <textarea className="form-control" rows={4} placeholder={t('hr.additionalTermsPh')}
                value={form.terms}
                onChange={e => setForm(f => ({ ...f, terms: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// CONTRACT PDF — render contract HTML in a hidden iframe and trigger print.
// Mirrors the print pattern used by quotations / invoices, so the printed
// output stays consistent with the rest of the ERP.
// ════════════════════════════════════════════════════════════════════════════
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function printContractHTML(contract, company) {
  const esc = escapeHTML;
  const currency = contract.salary_currency || 'USD';
  const benefits = (contract.benefits || '').split('\n').filter(Boolean);
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Contract ${esc(contract.contract_number || contract.id)}</title>
  <style>
    @page { size: A4; margin: 22mm 18mm; }
    body  { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12pt; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 18px; }
    .head h1 { font-size: 22pt; margin: 0; letter-spacing: 1px; }
    .meta { font-size: 10pt; color: #475569; text-align: right; }
    h2 { font-size: 14pt; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin: 18px 0 8px; }
    table.kv { width: 100%; border-collapse: collapse; }
    table.kv td { padding: 4px 8px; vertical-align: top; font-size: 11pt; }
    table.kv td.k { color: #475569; width: 35%; }
    .clause { white-space: pre-wrap; font-size: 11pt; }
    ul { margin: 6px 0 6px 18px; padding: 0; }
    .sig { display: flex; justify-content: space-between; margin-top: 50px; }
    .sig .box { width: 45%; }
    .sig .line { border-top: 1px solid #1a1a1a; margin-top: 50px; padding-top: 4px; font-size: 10pt; color: #475569; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 9pt; background: #e2e8f0; color: #0f172a; }
  </style>
</head><body>

  <div class="head">
    <div>
      <h1>${esc(company.company_name || 'Employment Contract')}</h1>
      <div style="color:#475569;font-size:10pt;">
        ${esc(company.company_address || '')}
        ${company.company_phone ? `<br>${esc(company.company_phone)}` : ''}
        ${company.company_email ? ` · ${esc(company.company_email)}` : ''}
      </div>
    </div>
    <div class="meta">
      <div><strong>EMPLOYMENT CONTRACT</strong></div>
      <div>${esc(contract.contract_number || '')}</div>
      <div>${esc(contract.contract_type)} <span class="badge">${esc(contract.status)}</span></div>
    </div>
  </div>

  <p>This Employment Agreement (the <em>"Agreement"</em>) is entered into between
  <strong>${esc(company.company_name || 'the Company')}</strong> (the <em>"Employer"</em>)
  and <strong>${esc(contract.employee_name)}</strong> (the <em>"Employee"</em>), effective
  as of <strong>${esc(contract.start_date)}</strong>.</p>

  <h2>1. Parties</h2>
  <table class="kv">
    <tr><td class="k">Employer</td><td>${esc(company.company_name || '—')}</td></tr>
    <tr><td class="k">Employee</td><td>${esc(contract.employee_name)} (${esc(contract.employee_code || '')})</td></tr>
    <tr><td class="k">Email</td><td>${esc(contract.employee_email || '—')}</td></tr>
    <tr><td class="k">Phone</td><td>${esc(contract.employee_phone || '—')}</td></tr>
    <tr><td class="k">Address</td><td>${esc(contract.employee_address || '—')}</td></tr>
  </table>

  <h2>2. Position &amp; schedule</h2>
  <table class="kv">
    <tr><td class="k">Job title</td><td>${esc(contract.job_title || '—')}</td></tr>
    <tr><td class="k">Department</td><td>${esc(contract.department_name || '—')}</td></tr>
    <tr><td class="k">Manager</td><td>${esc(contract.manager_name || '—')}</td></tr>
    <tr><td class="k">Work schedule</td><td>${esc(contract.work_schedule || '—')}</td></tr>
    <tr><td class="k">Weekly hours</td><td>${contract.weekly_hours != null ? esc(contract.weekly_hours) : '—'}</td></tr>
  </table>

  <h2>3. Term</h2>
  <table class="kv">
    <tr><td class="k">Contract type</td><td>${esc(contract.contract_type)}</td></tr>
    <tr><td class="k">Start date</td><td>${esc(contract.start_date)}</td></tr>
    <tr><td class="k">End date</td><td>${esc(contract.end_date || 'Indefinite')}</td></tr>
    <tr><td class="k">Probation ends</td><td>${esc(contract.probation_end_date || '—')}</td></tr>
  </table>

  <h2>4. Compensation</h2>
  <p>The Employee shall receive a salary of
    <strong>${Number(contract.salary || 0).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })}</strong>
    payable on a regular schedule as set by the Employer, subject to applicable taxes
    and social-security contributions.</p>

  ${benefits.length ? `
  <h2>5. Benefits</h2>
  <ul>${benefits.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}

  ${contract.terms ? `
  <h2>${benefits.length ? '6' : '5'}. Additional terms</h2>
  <div class="clause">${esc(contract.terms)}</div>` : ''}

  <div class="sig">
    <div class="box">
      <div class="line">For the Employer</div>
    </div>
    <div class="box">
      <div class="line">${esc(contract.employee_name)}</div>
    </div>
  </div>

  <p style="margin-top:30px;color:#94a3b8;font-size:9pt;text-align:center;">
    ${esc(company.company_name || '')} · Generated by ERP on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
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
      iframe.contentWindow.document.title = `Contract_${contract.contract_number || contract.id}.pdf`;
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }
  };
}

// ── Attendance tab (daily) ────────────────────────────────────────────────────
const ATT_STATUSES = ['Present', 'Absent', 'Late', 'Half-day', 'Leave'];
const ATT_LABEL_KEY = {
  'Present': 'hr.attPresent', 'Absent': 'hr.attAbsent', 'Late': 'hr.attLate',
  'Half-day': 'hr.attHalfday', 'Leave': 'hr.attLeave',
};


export { ContractsSection };
