import { useState, useCallback, useEffect, useRef } from 'react';
import { useData } from '../hooks/useData';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  fmt, fmtDate, toast, NumberInput, BranchField} from '../components/shared';
import {
  getRecruitmentSummary,
  getPositions, createPosition, updatePosition, archivePosition,
  getApplicants, getApplicant, createApplicant, updateApplicant,
  changeApplicantStatus, archiveApplicant, convertApplicant,
  scheduleInterview, updateInterview, deleteInterview,
  uploadApplicantFile, deleteApplicantFile, applicantFileURL,
  getDepartments,
  getApplicantOffers, createApplicantOffer, updateOffer,
  changeOfferStatus, archiveOffer, getOfferPrintData,
} from '../api/client';

// ── Reference values (must match backend/routers/recruitment.py) ───────────
const PIPELINE = [
  { key: 'Applied',         label: 'Applied' },
  { key: 'Screening',       label: 'Screening' },
  { key: 'Interview',       label: 'Interview' },
  { key: 'Technical Test',  label: 'Technical Test' },
  { key: 'Accepted',        label: 'Accepted' },
  { key: 'Rejected',        label: 'Rejected' },
];
const TERMINAL    = new Set(['Accepted', 'Rejected', 'Withdrawn']);
const EMP_TYPES   = ['Full-time', 'Part-time', 'Contract', 'Intern'];
const INT_TYPES   = ['Phone', 'Video', 'On-site', 'Technical', 'Final'];
const INT_STATUS  = ['Scheduled', 'Completed', 'Cancelled', 'No-show'];
const INT_DECISIONS = ['', 'Hire', 'No hire', 'Maybe', 'Strong hire', 'Strong no hire'];
const FILE_KINDS  = ['cv', 'cover_letter', 'portfolio', 'certificate', 'other'];

const POS_BADGE   = { Open: 'green', 'On Hold': 'yellow', Filled: 'blue', Cancelled: 'gray' };
const APP_BADGE   = {
  Applied: 'gray', Screening: 'blue', Interview: 'yellow',
  'Technical Test': 'yellow', Accepted: 'green', Rejected: 'red', Withdrawn: 'gray',
};

// ── Enum → locale-key maps ─────────────────────────────────────────────────
// Backend stores enum values in English. The UI translates via a lookup here
// so a backend payload of `status: "Applied"` renders as "تقدّم" in Arabic
// without changing the wire protocol. Anything missing falls back to the raw
// English value (defensive — never breaks the UI).
const POS_STATUS_KEY = {
  'Open': 'recruitment.statusOpen', 'On Hold': 'recruitment.statusOnHold',
  'Filled': 'recruitment.statusFilled', 'Cancelled': 'recruitment.statusCancelled',
};
const PIPELINE_KEY = {
  'Applied': 'recruitment.pipApplied', 'Screening': 'recruitment.pipScreening',
  'Interview': 'recruitment.pipInterview', 'Technical Test': 'recruitment.pipTechnicalTest',
  'Accepted': 'recruitment.pipAccepted', 'Rejected': 'recruitment.pipRejected',
  'Withdrawn': 'recruitment.pipWithdrawn',
};
const EMP_TYPE_KEY = {
  'Full-time': 'recruitment.empFullTime', 'Part-time': 'recruitment.empPartTime',
  'Contract':  'recruitment.empContract', 'Intern':    'recruitment.empIntern',
};
const INT_TYPE_KEY = {
  'Phone': 'recruitment.intTypePhone', 'Video': 'recruitment.intTypeVideo',
  'On-site': 'recruitment.intTypeOnsite', 'Technical': 'recruitment.intTypeTechnical',
  'Final': 'recruitment.intTypeFinal',
};
const INT_STATUS_KEY = {
  'Scheduled': 'recruitment.intStatusScheduled', 'Completed': 'recruitment.intStatusCompleted',
  'Cancelled': 'recruitment.intStatusCancelled', 'No-show': 'recruitment.intStatusNoShow',
};
const INT_DECISION_KEY = {
  'Hire': 'recruitment.intDecisionHire', 'No hire': 'recruitment.intDecisionNoHire',
  'Maybe': 'recruitment.intDecisionMaybe',
  'Strong hire': 'recruitment.intDecisionStrongHire',
  'Strong no hire': 'recruitment.intDecisionStrongNoHire',
};
const FILE_KIND_KEY = {
  cv: 'recruitment.fileKindCV', cover_letter: 'recruitment.fileKindCoverLetter',
  portfolio: 'recruitment.fileKindPortfolio', certificate: 'recruitment.fileKindCertificate',
  other: 'recruitment.fileKindOther',
};
const OFFER_STATUS_TEXT_KEY = {
  Draft: 'recruitment.offerStatusDraft', Sent: 'recruitment.offerStatusSent',
  Accepted: 'recruitment.offerStatusAccepted', Declined: 'recruitment.offerStatusDeclined',
  Expired: 'recruitment.offerStatusExpired',
};
const OFFER_CT_KEY = {
  'Permanent':  'recruitment.ctPermanent',  'Fixed-term': 'recruitment.ctFixedTerm',
  'Probation':  'recruitment.ctProbation',  'Internship': 'recruitment.ctInternship',
  'Consultant': 'recruitment.ctConsultant',
};
const PAY_SCHED_KEY = {
  Monthly: 'recruitment.paySchedMonthly', 'Bi-weekly': 'recruitment.paySchedBiweekly',
  Weekly:  'recruitment.paySchedWeekly',
};

/** Translate via lookup map; fall back to the raw value if the key is unknown. */
function tEnum(t, map, val) {
  return map[val] ? t(map[val]) : (val ?? '');
}

const EMPTY_POSITION  = {
  title: '', department_id: '', employment_type: 'Full-time', location: '',
  salary_min: '', salary_max: '', headcount: 1, status: 'Open',
  description: '', requirements: '', branch_id: '',
};
const EMPTY_APPLICANT = {
  full_name: '', position_id: '', email: '', phone: '', source: '',
  expected_salary: '', rating: '', notes: '', branch_id: '',
};

// ── Offer letter constants (Lebanon-aware) ────────────────────────────────
// Mirrors the backend validation in routers/recruitment.py — keeping these
// in sync with the server lets the form catch obvious mistakes before a POST.
const OFFER_CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation', 'Internship', 'Consultant'];
const OFFER_CURRENCIES     = ['USD', 'EUR', 'LBP', 'AED', 'SAR'];
const OFFER_PAY_SCHEDULES  = ['Monthly', 'Bi-weekly', 'Weekly'];
const OFFER_STATUS_BADGE   = {
  Draft: 'gray', Sent: 'blue', Accepted: 'green',
  Declined: 'red', Expired: 'gray',
};
// Article 9 — probation capped at 3 months. Article 31 — 48-hour working week.
const LB_MAX_PROBATION_MONTHS = 3;
const LB_MAX_WEEKLY_HOURS     = 48;

const EMPTY_OFFER = {
  contract_type:           'Permanent',
  job_title:               '',
  department_id:           '',
  start_date:              '',
  end_date:                '',
  probation_months:        3,
  probation_end_date:      '',
  work_schedule:           'Mon–Fri 9:00–18:00',
  weekly_hours:            48,
  annual_leave_days:       15,
  notice_period_days:      30,
  salary:                  0,
  salary_currency:         'USD',
  payment_schedule:        'Monthly',
  include_nssf:            true,
  include_eos:             true,
  include_confidentiality: true,
  include_non_compete:     false,
  non_compete_months:      6,
  benefits:                '',
  additional_terms:        '',
  place_of_work:           '',
  expires_at:              '',
};

function Kpi({ label, value, color = 'var(--text)' }) {
  return (
    <div className="stat-card" style={{ padding: '14px 18px' }}>
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function Recruitment() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [tab, setTab]                 = useState('pipeline');
  const [detailId, setDetailId]       = useState(null);          // applicant id
  const [positionId, setPositionId]   = useState(null);          // position drill-down or 'new'
  const [applicantForm, setApplicantForm] = useState(null);      // null | 'new' | {id}

  const canView   = can('recruitment', 'view');
  const canCreate = can('recruitment', 'create');
  const canEdit   = can('recruitment', 'edit');
  const canDelete = can('recruitment', 'delete');

  const { data: summary,    reload: reloadSummary }  = useData(getRecruitmentSummary);
  const { data: positions,  reload: reloadPositions } = useData(useCallback(() => getPositions(), []));
  const { data: applicants, reload: reloadApplicants } = useData(useCallback(() => getApplicants(), []));
  const { data: departments } = useData(getDepartments);

  const reloadAll = useCallback(() => {
    reloadSummary(); reloadPositions(); reloadApplicants();
  }, [reloadSummary, reloadPositions, reloadApplicants]);

  if (!canView) {
    return <EmptyState message={t('recruitment.noAccess')} icon="🔒" />;
  }

  const positionList  = Array.isArray(positions)  ? positions  : [];
  const applicantList = Array.isArray(applicants) ? applicants : [];
  const deptList      = Array.isArray(departments) ? departments : [];

  // ── Pipeline column grouping ────────────────────────────────────────────
  const byStatus = {};
  PIPELINE.forEach(s => { byStatus[s.key] = []; });
  for (const a of applicantList) {
    if (byStatus[a.status]) byStatus[a.status].push(a);
  }

  const s = summary || {};
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('recruitment.pageTitle')}</h1>
          <p className="page-subtitle">{t('recruitment.pageSubtitle')}</p>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 20 }}>
        <Kpi label={t('recruitment.kpiOpenPositions')}      value={s.open_positions ?? 0}      color="var(--accent)" />
        <Kpi label={t('recruitment.kpiApplied')}            value={s.applied ?? 0} />
        <Kpi label={t('recruitment.kpiInScreening')}        value={s.screening ?? 0}           color="var(--blue)" />
        <Kpi label={t('recruitment.kpiInInterview')}        value={(s.interview || 0) + (s.technical_test || 0)} color="var(--yellow)" />
        <Kpi label={t('recruitment.kpiUpcomingInterviews')} value={s.upcoming_interviews ?? 0} color="var(--accent)" />
        <Kpi label={t('recruitment.kpiHiredYTD')}           value={s.hired_ytd ?? 0}           color="var(--green)" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {[
            { key: 'pipeline',   label: t('recruitment.tabPipeline') },
            { key: 'applicants', label: `${t('recruitment.tabApplicants')} (${applicantList.length})` },
            { key: 'positions',  label: `${t('recruitment.tabPositions')} (${positionList.length})` },
          ].map(tb => (
            <button key={tb.key}
              className={`tab-btn${tab === tb.key ? ' active' : ''}`}
              onClick={() => setTab(tb.key)}>
              {tb.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {canCreate && tab !== 'positions' && (
            <button className="btn btn-primary" onClick={() => setApplicantForm('new')}>{t('recruitment.addApplicant')}</button>
          )}
          {canCreate && tab === 'positions' && (
            <button className="btn btn-primary" onClick={() => setPositionId('new')}>{t('recruitment.addPosition')}</button>
          )}
        </div>
      </div>

      {/* ── Pipeline (kanban) ──────────────────────────────────────────── */}
      {tab === 'pipeline' && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${PIPELINE.length}, 1fr)`, gap: 10 }}>
          {PIPELINE.map(col => (
            <div key={col.key} className="card" style={{ padding: 10, minHeight: 200, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {tEnum(t, PIPELINE_KEY, col.key)}
                </div>
                <span className={`badge badge-${APP_BADGE[col.key] || 'gray'}`} style={{ fontSize: 10 }}>
                  {byStatus[col.key].length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {byStatus[col.key].map(a => (
                  <button key={a.id}
                    onClick={() => setDetailId(a.id)}
                    style={{
                      textAlign: 'left', padding: '8px 10px', background: 'var(--surface)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                      cursor: 'pointer', fontSize: 12,
                    }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{a.full_name}</div>
                    <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
                      {a.position_title || '—'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11 }}>
                      <span style={{ color: 'var(--text-3)' }}>{fmtDate(a.applied_at)}</span>
                      {a.interview_count > 0 && <span title={t('recruitment.sectionInterviews')}>📅 {a.interview_count}</span>}
                    </div>
                  </button>
                ))}
                {byStatus[col.key].length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', padding: '10px 4px' }}>
                    {t('recruitment.columnEmpty')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Applicants table ───────────────────────────────────────────── */}
      {tab === 'applicants' && (
        <div className="card" style={{ padding: 0 }}>
          {applicantList.length === 0 ? <EmptyState message={t('recruitment.noApplicants')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.colName')}</th>
                    <th>{t('recruitment.colPosition')}</th>
                    <th>{t('recruitment.colStatus')}</th>
                    <th>{t('recruitment.colApplied')}</th>
                    <th>{t('recruitment.colRating')}</th>
                    <th>{t('recruitment.colFiles')}</th>
                    <th>{t('recruitment.colInterviews')}</th>
                  </tr>
                </thead>
                <tbody>
                  {applicantList.map(a => (
                    <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(a.id)}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>
                        <span style={{ color: 'var(--accent)' }}>{a.full_name}</span>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.email || a.phone}</div>
                      </td>
                      <td>{a.position_title || '—'}</td>
                      <td><span className={`badge badge-${APP_BADGE[a.status] || 'gray'}`}>{tEnum(t, PIPELINE_KEY, a.status)}</span></td>
                      <td>{fmtDate(a.applied_at)}</td>
                      <td>{a.rating ? '★'.repeat(a.rating) : '—'}</td>
                      <td>{a.file_count ?? 0}</td>
                      <td>{a.interview_count ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Positions table ────────────────────────────────────────────── */}
      {tab === 'positions' && (
        <div className="card" style={{ padding: 0 }}>
          {positionList.length === 0 ? <EmptyState message={t('recruitment.noPositions')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.colTitle')}</th>
                    <th>{t('recruitment.colDepartment')}</th>
                    <th>{t('recruitment.colType')}</th>
                    <th>{t('recruitment.colHeadcount')}</th>
                    <th>{t('recruitment.colApplicants')}</th>
                    <th>{t('recruitment.colStatus')}</th>
                    <th>{t('recruitment.colPosted')}</th>
                    <th>{t('recruitment.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {positionList.map(p => (
                    <tr key={p.id}>
                      <td className="td-primary" style={{ fontWeight: 600 }}>{p.title}</td>
                      <td>{p.department_name || '—'}</td>
                      <td>{tEnum(t, EMP_TYPE_KEY, p.employment_type)}</td>
                      <td>{p.headcount}</td>
                      <td>{p.applicants ?? 0}</td>
                      <td><span className={`badge badge-${POS_BADGE[p.status] || 'gray'}`}>{tEnum(t, POS_STATUS_KEY, p.status)}</span></td>
                      <td>{fmtDate(p.posted_at)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setPositionId(p.id)}>{t('recruitment.actionEdit')}</button>}
                          {canDelete && <button className="btn btn-sm btn-danger" onClick={async () => {
                            try { await archivePosition(p.id); toast(t('recruitment.positionArchived')); reloadAll(); }
                            catch (e) { toast(e.message, 'error'); }
                          }}>{t('recruitment.actionArchive')}</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Applicant detail panel — full pipeline + interviews + files */}
      {detailId && (
        <ApplicantDetail
          appId={detailId}
          canEdit={canEdit}
          canDelete={canDelete}
          positions={positionList}
          onClose={() => setDetailId(null)}
          onChanged={reloadAll}
        />
      )}

      {/* Applicant form (create or edit) */}
      {applicantForm && (
        <ApplicantForm
          mode={applicantForm === 'new' ? 'create' : 'edit'}
          initial={applicantForm === 'new' ? null : applicantList.find(a => a.id === applicantForm)}
          positions={positionList}
          onClose={() => setApplicantForm(null)}
          onSaved={reloadAll}
        />
      )}

      {/* Position form (create or edit) */}
      {positionId && (
        <PositionForm
          posId={positionId === 'new' ? null : positionId}
          initial={positionId === 'new' ? null : positionList.find(p => p.id === positionId)}
          departments={deptList}
          onClose={() => setPositionId(null)}
          onSaved={reloadAll}
        />
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// POSITION FORM
// ════════════════════════════════════════════════════════════════════════════
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
function ApplicantDetail({ appId, canEdit, canDelete, positions, onClose, onChanged }) {
  const { t } = useLocale();
  const [app, setApp]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [busy, setBusy]       = useState(false);
  const [showInterview, setShowInterview] = useState(false);
  const [editInterview, setEditInterview] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [acceptReason, setAcceptReason] = useState('');
  const [converting, setConverting] = useState(false);

  // Pre-employment offer letters. Loaded lazily after the applicant detail
  // resolves so the modal opens fast even when an applicant has several
  // historical offers attached.
  const [offers, setOffers] = useState([]);
  const [showOffer, setShowOffer] = useState(false);
  const [editOffer, setEditOffer] = useState(null);
  const [archivingOffer, setArchivingOffer] = useState(null);

  const reloadOffers = useCallback(async () => {
    try { setOffers(await getApplicantOffers(appId)); }
    catch { /* non-fatal — the section will render empty */ }
  }, [appId]);
  useEffect(() => { reloadOffers(); }, [reloadOffers]);

  async function printOffer(offerId) {
    try {
      const data = await getOfferPrintData(offerId);
      printOfferHTML(data.offer, data.company, data.lebanon);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function transitionOffer(offerId, status, declined_reason = null) {
    try {
      await changeOfferStatus(offerId, { status, declined_reason });
      await reloadOffers();
      // Per-status toast key so translations can read naturally in both languages.
      toast(t(`recruitment.offerToast_${status}`));
    } catch (err) { toast(err.message, 'error'); }
  }

  async function doArchiveOffer(offer) {
    setArchivingOffer(null);
    try {
      await archiveOffer(offer.id);
      toast(t('recruitment.offerArchived'));
      await reloadOffers();
    } catch (err) { toast(err.message, 'error'); }
  }

  const fileInputRef = useRef(null);
  const fileKindRef  = useRef('cv');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setApp(await getApplicant(appId)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  async function advance(to, note = null, reason = null) {
    setBusy(true);
    try {
      await changeApplicantStatus(appId, { new_status: to, note, reason });
      await load(); onChanged();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function handleUpload(kind, file) {
    if (!file) return;
    // Accept PDF + Word. Office files sometimes report an empty/octet-stream
    // MIME type, so fall back to the extension (matches the backend check).
    const okType = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(file.type);
    const okExt = /\.(pdf|docx?)$/i.test(file.name || '');
    if (!okType && !okExt) {
      toast(t('recruitment.pdfOnly'), 'error'); return;
    }
    setBusy(true);
    try {
      await uploadApplicantFile(appId, kind, file);
      toast(t('recruitment.fileUploaded')); await load();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function handleDeleteFile(fileId) {
    try { await deleteApplicantFile(fileId); toast(t('recruitment.fileDeleted')); await load(); }
    catch (err) { toast(err.message, 'error'); }
  }

  if (loading) return <Modal title={t('recruitment.detailTitleApplicant')} onClose={onClose} size="modal-lg"><div className="modal-body"><LoadingSpinner /></div></Modal>;
  if (error || !app) return <Modal title={t('recruitment.detailTitleApplicant')} onClose={onClose} size="modal-lg"><div className="modal-body"><ErrorAlert message={error || t('recruitment.notFound')} onRetry={load} /></div></Modal>;

  const isTerminal = TERMINAL.has(app.status);
  const cv = (app.files || []).find(f => f.kind === 'cv');
  const otherFiles = (app.files || []).filter(f => f.kind !== 'cv');

  return (
    <Modal title={`${app.full_name}${app.position_title ? ` — ${app.position_title}` : ''}`}
           onClose={onClose} size="modal-lg">
      <div className="modal-body">

        {/* Status + quick actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
          <span className={`badge badge-${APP_BADGE[app.status] || 'gray'}`} style={{ fontSize: 13, padding: '4px 10px' }}>
            {tEnum(t, PIPELINE_KEY, app.status)}
          </span>
          {!isTerminal && canEdit && (
            <>
              {nextStatus(app.status) && (
                <button className="btn btn-sm btn-primary" disabled={busy}
                  onClick={() => advance(nextStatus(app.status))}>
                  {t('recruitment.moveTo', { next: tEnum(t, PIPELINE_KEY, nextStatus(app.status)) })}
                </button>
              )}
              {app.status !== 'Accepted' && (
                <button className="btn btn-sm btn-success" disabled={busy}
                  onClick={() => { setAccepting(true); setAcceptReason(''); }}>
                  {t('recruitment.accept')}
                </button>
              )}
              <button className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => { setRejecting(true); setRejectReason(''); }}>
                {t('recruitment.reject')}
              </button>
            </>
          )}
          {app.status === 'Accepted' && !app.converted_employee_id && canEdit && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => setConverting(true)}>
              {t('recruitment.onboardAsEmployee')}
            </button>
          )}
          {app.converted_employee_id && (
            <span className="badge badge-green">
              {t('recruitment.onboarded', { code: app.converted_employee_code })}
            </span>
          )}
        </div>

        {/* Profile */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 22 }}>
          <Field label={t('recruitment.fEmail')}      value={app.email || '—'} />
          <Field label={t('recruitment.fPhone')}      value={app.phone || '—'} />
          <Field label={t('recruitment.fSource')}     value={app.source || '—'} />
          <Field label={t('recruitment.fPosition')}   value={app.position_title || '—'} />
          <Field label={t('recruitment.fDepartment')} value={app.department_name || '—'} />
          <Field label={t('recruitment.fExpected')}   value={app.expected_salary ? fmt(app.expected_salary) : '—'} />
          {app.offered_salary && (
            <Field label={t('recruitment.fOffered')} value={<strong>{fmt(app.offered_salary)}</strong>} />
          )}
          <Field label={t('recruitment.fRating')}     value={app.rating ? '★'.repeat(app.rating) : '—'} />
          <Field label={t('recruitment.fApplied')}    value={fmtDate(app.applied_at)} />
        </div>

        {app.notes && (
          <Section title={t('recruitment.sectionNotes')}>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{app.notes}</div>
          </Section>
        )}

        {/* Hire / rejection rationale — surfaced separately from the audit
            trail so reviewers see *why* a decision was made at a glance. */}
        {app.status === 'Accepted' && app.accepted_reason && (
          <Section title={t('recruitment.sectionWhyAccepted')}>
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--radius)',
              background: 'var(--green-light)', color: 'var(--green)',
              fontSize: 13,
            }}>
              {app.accepted_reason}
            </div>
          </Section>
        )}
        {app.status === 'Rejected' && app.rejected_reason && (
          <Section title={t('recruitment.sectionWhyRejected')}>
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--radius)',
              background: 'var(--red-light)', color: 'var(--red)',
              fontSize: 13,
            }}>
              {app.rejected_reason}
            </div>
          </Section>
        )}

        {/* Files (CV + attachments) */}
        <Section title={t('recruitment.sectionDocs')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FileSlot
              label={t('recruitment.cvLabel')} file={cv} canEdit={canEdit}
              onPick={() => { fileKindRef.current = 'cv'; fileInputRef.current?.click(); }}
              onDelete={() => handleDeleteFile(cv.id)}
              urlFn={applicantFileURL} />
            {canEdit && (
              <div style={{ padding: 12, border: '1px dashed var(--border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
                  Other documents
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {FILE_KINDS.filter(k => k !== 'cv').map(k => (
                    <button key={k} className="btn btn-sm btn-secondary" disabled={busy}
                      onClick={() => { fileKindRef.current = k; fileInputRef.current?.click(); }}>
                      + {tEnum(t, FILE_KIND_KEY, k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {otherFiles.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {otherFiles.map(f => (
                <div key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', fontSize: 13,
                }}>
                  <span style={{ flex: 1 }}>
                    <strong>{tEnum(t, FILE_KIND_KEY, f.kind)}</strong> · {f.filename}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {(f.size_bytes / 1024).toFixed(0)} KB
                  </span>
                  <a className="btn btn-sm btn-secondary" href={applicantFileURL(f.id)}
                     target="_blank" rel="noopener noreferrer">{t('recruitment.view')}</a>
                  {canEdit && <button className="btn btn-sm btn-danger" onClick={() => handleDeleteFile(f.id)}>{t('recruitment.delete')}</button>}
                </div>
              ))}
            </div>
          )}
          <input ref={fileInputRef} type="file"
                 accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                 style={{ display: 'none' }}
                 onChange={e => { handleUpload(fileKindRef.current, e.target.files?.[0]); e.target.value = ''; }} />
        </Section>

        {/* Interviews */}
        <Section title={t('recruitment.sectionInterviews')} right={canEdit && (
          <button className="btn btn-sm btn-secondary" onClick={() => setShowInterview(true)}>{t('recruitment.scheduleBtn')}</button>
        )}>
          {(app.interviews || []).length === 0 ? (
            <EmptyState message={t('recruitment.noInterviewsYet')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.intColType')}</th>
                    <th>{t('recruitment.intColWhen')}</th>
                    <th>{t('recruitment.intColInterviewer')}</th>
                    <th>{t('recruitment.colStatus')}</th>
                    <th>{t('recruitment.intColScore')}</th>
                    <th>{t('recruitment.intColDecision')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {app.interviews.map(iv => (
                    <tr key={iv.id}>
                      <td>{tEnum(t, INT_TYPE_KEY, iv.interview_type)}</td>
                      <td>{fmtDate(iv.scheduled_at)}</td>
                      <td>{iv.interviewer_user_name || iv.interviewer_name || '—'}</td>
                      <td><span className={`badge badge-${iv.status === 'Completed' ? 'green' : iv.status === 'Cancelled' ? 'red' : 'yellow'}`}>{tEnum(t, INT_STATUS_KEY, iv.status)}</span></td>
                      <td>{iv.score != null ? `${iv.score}/10` : '—'}</td>
                      <td>{iv.decision ? tEnum(t, INT_DECISION_KEY, iv.decision) : '—'}</td>
                      <td>
                        {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setEditInterview(iv)}>{t('recruitment.actionEdit')}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Offer letters / pre-employment contracts */}
        <Section
          title={t('recruitment.sectionOffers')}
          right={canEdit && app.status !== 'Rejected' && app.status !== 'Withdrawn' && (
            <button className="btn btn-sm btn-primary"
                    onClick={() => { setEditOffer(null); setShowOffer(true); }}>
              {t('recruitment.addOffer')}
            </button>
          )}
        >
          {offers.length === 0 ? (
            <EmptyState
              icon="📄"
              message={app.status === 'Accepted'
                ? t('recruitment.noOffersAccepted')
                : t('recruitment.noOffersOther')}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.offerColNumber')}</th>
                    <th>{t('recruitment.offerColType')}</th>
                    <th>{t('recruitment.offerColStatus')}</th>
                    <th>{t('recruitment.offerColStart')}</th>
                    <th style={{ textAlign: 'right' }}>{t('recruitment.offerColSalary')}</th>
                    <th>{t('recruitment.offerColActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.map(o => (
                    <tr key={o.id}>
                      <td className="text-mono">{o.offer_number || `#${o.id}`}</td>
                      <td>{tEnum(t, OFFER_CT_KEY, o.contract_type)}</td>
                      <td>
                        <span className={`badge badge-${OFFER_STATUS_BADGE[o.status] || 'gray'}`}>
                          {tEnum(t, OFFER_STATUS_TEXT_KEY, o.status)}
                        </span>
                      </td>
                      <td>{fmtDate(o.start_date)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {Number(o.salary || 0).toLocaleString('en-US', {
                          style: 'currency', currency: o.salary_currency || 'USD',
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button className="btn btn-sm btn-secondary"
                                  onClick={() => printOffer(o.id)}>
                            {t('recruitment.offerActionPrint')}
                          </button>
                          {/* mailto: opens the user's email client with a body
                              describing the attached PDF. We don't auto-attach
                              because mailto: can't carry attachments — the user
                              attaches the PDF they just downloaded. */}
                          {o.status !== 'Declined' && o.status !== 'Expired' && app.email && (
                            <a className="btn btn-sm btn-secondary"
                               href={mailtoOffer(o, app)}>
                              {t('recruitment.offerActionEmail')}
                            </a>
                          )}
                          {canEdit && o.status === 'Draft' && (
                            <>
                              <button className="btn btn-sm btn-secondary"
                                      onClick={() => { setEditOffer(o); setShowOffer(true); }}>
                                {t('recruitment.actionEdit')}
                              </button>
                              <button className="btn btn-sm btn-primary"
                                      onClick={() => transitionOffer(o.id, 'Sent')}>
                                {t('recruitment.offerActionMarkSent')}
                              </button>
                            </>
                          )}
                          {canEdit && o.status === 'Sent' && (
                            <>
                              <button className="btn btn-sm btn-success"
                                      onClick={() => transitionOffer(o.id, 'Accepted')}>
                                {t('recruitment.offerActionAccepted')}
                              </button>
                              <button className="btn btn-sm btn-danger"
                                      onClick={() => {
                                        const reason = window.prompt(t('recruitment.offerDeclinePrompt'), '');
                                        if (reason !== null) transitionOffer(o.id, 'Declined', reason || 'Declined');
                                      }}>
                                {t('recruitment.offerActionDeclined')}
                              </button>
                            </>
                          )}
                          {canDelete && (
                            <button className="btn btn-sm btn-danger"
                                    onClick={() => setArchivingOffer(o)}
                                    title={t('recruitment.actionArchive')}>
                              🗑
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Status history */}
        <Section title={t('recruitment.sectionHistory')}>
          {(app.status_history || []).length === 0 ? <EmptyState message="—" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {app.status_history.map(h => (
                <div key={h.id} style={{
                  padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', fontSize: 12,
                }}>
                  <div><strong>{h.old_status ? tEnum(t, PIPELINE_KEY, h.old_status) : '—'} → {tEnum(t, PIPELINE_KEY, h.new_status)}</strong></div>
                  <div style={{ color: 'var(--text-3)', marginTop: 2 }}>
                    {fmtDate(h.created_at)}{h.changed_by_name ? ` · ${t('recruitment.historyBy', { who: h.changed_by_name })}` : ''}
                    {h.note ? ` · ${h.note}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('recruitment.close')}</button>
      </div>

      {showInterview && (
        <InterviewForm
          appId={appId}
          onClose={() => setShowInterview(false)}
          onSaved={() => { setShowInterview(false); load(); onChanged(); }}
        />
      )}
      {editInterview && (
        <InterviewForm
          appId={appId}
          existing={editInterview}
          onClose={() => setEditInterview(null)}
          onSaved={() => { setEditInterview(null); load(); onChanged(); }}
        />
      )}
      {accepting && (
        <ConfirmModal
          title={t('recruitment.acceptTitle')}
          message={(
            <div>
              <p style={{ marginBottom: 10 }}>
                {/* Dangerously-set so the <strong> wrapping the name renders.
                    Safe — we control the format string and the name is escaped
                    server-side before reaching the DB. */}
                <span dangerouslySetInnerHTML={{
                  __html: t('recruitment.acceptPrompt', { name: `<strong>${(app.full_name || '').replace(/</g, '&lt;')}</strong>` }),
                }} />
              </p>
              <label className="form-label">{t('recruitment.acceptReason')}</label>
              <input className="form-control" placeholder={t('recruitment.acceptReasonPh')}
                value={acceptReason} onChange={e => setAcceptReason(e.target.value)} />
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
                {t('recruitment.acceptHint')}
              </p>
            </div>
          )}
          confirmLabel={t('recruitment.acceptConfirm')}
          confirmClass="btn-success"
          onConfirm={async () => {
            await advance('Accepted', null, acceptReason || null);
            setAccepting(false);
          }}
          onCancel={() => setAccepting(false)}
        />
      )}
      {rejecting && (
        <ConfirmModal
          title={t('recruitment.rejectTitle')}
          message={(
            <div>
              <p style={{ marginBottom: 10 }}>
                <span dangerouslySetInnerHTML={{
                  __html: t('recruitment.rejectPrompt', { name: `<strong>${(app.full_name || '').replace(/</g, '&lt;')}</strong>` }),
                }} />
              </p>
              <label className="form-label">{t('recruitment.rejectReason')}</label>
              <input className="form-control" placeholder={t('recruitment.rejectReasonPh')}
                value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            </div>
          )}
          confirmLabel={t('recruitment.rejectConfirm')}
          confirmClass="btn-danger"
          onConfirm={async () => {
            await advance('Rejected', null, rejectReason || t('recruitment.rejectDefault'));
            setRejecting(false);
          }}
          onCancel={() => setRejecting(false)}
        />
      )}
      {converting && (
        <ConvertForm
          applicant={app}
          positions={positions}
          onClose={() => setConverting(false)}
          onConverted={async () => { setConverting(false); await load(); onChanged(); }}
        />
      )}
      {showOffer && (
        <OfferForm
          appId={appId}
          applicant={app}
          existing={editOffer}
          onClose={() => setShowOffer(false)}
          onSaved={() => { setShowOffer(false); reloadOffers(); }}
        />
      )}
      {archivingOffer && (
        <ConfirmModal
          title={t('recruitment.offerArchiveTitle')}
          message={t('recruitment.offerArchivePrompt', { number: archivingOffer.offer_number })}
          confirmLabel={t('recruitment.offerArchiveConfirm')}
          confirmClass="btn-danger"
          onConfirm={() => doArchiveOffer(archivingOffer)}
          onCancel={() => setArchivingOffer(null)}
        />
      )}
    </Modal>
  );
}

function nextStatus(current) {
  const order = ['Applied', 'Screening', 'Interview', 'Technical Test'];
  const i = order.indexOf(current);
  return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
}


// ── Interview create / edit ────────────────────────────────────────────────
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
              <select className="form-control" value={form.interview_type}
                onChange={e => setForm(f => ({ ...f, interview_type: e.target.value }))}>
                {INT_TYPES.map(x => <option key={x} value={x}>{tEnum(t, INT_TYPE_KEY, x)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t('recruitment.colStatus')}</label>
              <select className="form-control" value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {INT_STATUS.map(x => <option key={x} value={x}>{tEnum(t, INT_STATUS_KEY, x)}</option>)}
              </select>
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
              <select className="form-control" value={form.decision}
                onChange={e => setForm(f => ({ ...f, decision: e.target.value }))}>
                {INT_DECISIONS.map(x => <option key={x} value={x}>{x ? tEnum(t, INT_DECISION_KEY, x) : t('recruitment.intPending')}</option>)}
              </select>
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
              <select className="form-control" value={form.employment_type}
                onChange={e => setForm(f => ({ ...f, employment_type: e.target.value }))}>
                {EMP_TYPES.map(x => <option key={x} value={x}>{tEnum(t, EMP_TYPE_KEY, x)}</option>)}
              </select>
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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


// ── Small UI primitives reused from HR.jsx layout ──────────────────────────
function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}
function Section({ title, right, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 10,
      }}>
        <h4 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px',
                     color: 'var(--text-3)', margin: 0 }}>{title}</h4>
        {right}
      </div>
      {children}
    </div>
  );
}
function FileSlot({ label, file, canEdit, onPick, onDelete, urlFn }) {
  return (
    <div style={{
      padding: '12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
      background: file ? 'var(--surface)' : 'transparent',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{label}</div>
      {file ? (
        <>
          <div style={{ fontSize: 13, marginBottom: 4 }}>{file.filename}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
            {(file.size_bytes / 1024).toFixed(0)} KB · uploaded {fmtDate(file.created_at)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <a className="btn btn-sm btn-primary" href={urlFn(file.id)} target="_blank" rel="noopener noreferrer">View</a>
            {canEdit && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={onPick}>Replace</button>
                <button className="btn btn-sm btn-danger" onClick={onDelete}>Delete</button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>No file uploaded yet.</div>
          {canEdit && <button className="btn btn-sm btn-primary" onClick={onPick}>Upload PDF</button>}
        </>
      )}
    </div>
  );
}
