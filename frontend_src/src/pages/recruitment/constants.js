// Shared Recruitment reference values, badge maps + status-key lookups.
// Extracted from Recruitment.jsx so the page and its section/modal components
// share them without duplication or a circular import.

export const PIPELINE = [
  { key: 'Applied',         label: 'Applied' },
  { key: 'Screening',       label: 'Screening' },
  { key: 'Interview',       label: 'Interview' },
  { key: 'Technical Test',  label: 'Technical Test' },
  { key: 'Accepted',        label: 'Accepted' },
  { key: 'Rejected',        label: 'Rejected' },
];
export const TERMINAL    = new Set(['Accepted', 'Rejected', 'Withdrawn']);
export const EMP_TYPES   = ['Full-time', 'Part-time', 'Contract', 'Intern'];
export const INT_TYPES   = ['Phone', 'Video', 'On-site', 'Technical', 'Final'];
export const INT_STATUS  = ['Scheduled', 'Completed', 'Cancelled', 'No-show'];
export const INT_DECISIONS = ['', 'Hire', 'No hire', 'Maybe', 'Strong hire', 'Strong no hire'];
export const FILE_KINDS  = ['cv', 'cover_letter', 'portfolio', 'certificate', 'other'];

export const POS_BADGE   = { Open: 'green', 'On Hold': 'yellow', Filled: 'blue', Cancelled: 'gray' };
export const APP_BADGE   = {
  Applied: 'gray', Screening: 'blue', Interview: 'yellow',
  'Technical Test': 'yellow', Accepted: 'green', Rejected: 'red', Withdrawn: 'gray',
};

// ── Enum → locale-key maps ─────────────────────────────────────────────────
// Backend stores enum values in English. The UI translates via a lookup here
// so a backend payload of `status: "Applied"` renders as "تقدّم" in Arabic
// without changing the wire protocol. Anything missing falls back to the raw
// English value (defensive — never breaks the UI).
export const POS_STATUS_KEY = {
  'Open': 'recruitment.statusOpen', 'On Hold': 'recruitment.statusOnHold',
  'Filled': 'recruitment.statusFilled', 'Cancelled': 'recruitment.statusCancelled',
};
export const PIPELINE_KEY = {
  'Applied': 'recruitment.pipApplied', 'Screening': 'recruitment.pipScreening',
  'Interview': 'recruitment.pipInterview', 'Technical Test': 'recruitment.pipTechnicalTest',
  'Accepted': 'recruitment.pipAccepted', 'Rejected': 'recruitment.pipRejected',
  'Withdrawn': 'recruitment.pipWithdrawn',
};
export const EMP_TYPE_KEY = {
  'Full-time': 'recruitment.empFullTime', 'Part-time': 'recruitment.empPartTime',
  'Contract':  'recruitment.empContract', 'Intern':    'recruitment.empIntern',
};
export const INT_TYPE_KEY = {
  'Phone': 'recruitment.intTypePhone', 'Video': 'recruitment.intTypeVideo',
  'On-site': 'recruitment.intTypeOnsite', 'Technical': 'recruitment.intTypeTechnical',
  'Final': 'recruitment.intTypeFinal',
};
export const INT_STATUS_KEY = {
  'Scheduled': 'recruitment.intStatusScheduled', 'Completed': 'recruitment.intStatusCompleted',
  'Cancelled': 'recruitment.intStatusCancelled', 'No-show': 'recruitment.intStatusNoShow',
};
export const INT_DECISION_KEY = {
  'Hire': 'recruitment.intDecisionHire', 'No hire': 'recruitment.intDecisionNoHire',
  'Maybe': 'recruitment.intDecisionMaybe',
  'Strong hire': 'recruitment.intDecisionStrongHire',
  'Strong no hire': 'recruitment.intDecisionStrongNoHire',
};
export const FILE_KIND_KEY = {
  cv: 'recruitment.fileKindCV', cover_letter: 'recruitment.fileKindCoverLetter',
  portfolio: 'recruitment.fileKindPortfolio', certificate: 'recruitment.fileKindCertificate',
  other: 'recruitment.fileKindOther',
};
export const OFFER_STATUS_TEXT_KEY = {
  Draft: 'recruitment.offerStatusDraft', Sent: 'recruitment.offerStatusSent',
  Accepted: 'recruitment.offerStatusAccepted', Declined: 'recruitment.offerStatusDeclined',
  Expired: 'recruitment.offerStatusExpired',
};
export const OFFER_CT_KEY = {
  'Permanent':  'recruitment.ctPermanent',  'Fixed-term': 'recruitment.ctFixedTerm',
  'Probation':  'recruitment.ctProbation',  'Internship': 'recruitment.ctInternship',
  'Consultant': 'recruitment.ctConsultant',
};
export const PAY_SCHED_KEY = {
  Monthly: 'recruitment.paySchedMonthly', 'Bi-weekly': 'recruitment.paySchedBiweekly',
  Weekly:  'recruitment.paySchedWeekly',
};

/** Translate via lookup map; fall back to the raw value if the key is unknown. */
function tEnum(t, map, val) {
  return map[val] ? t(map[val]) : (val ?? '');
}

export const EMPTY_POSITION  = {
  title: '', department_id: '', employment_type: 'Full-time', location: '',
  salary_min: '', salary_max: '', headcount: 1, status: 'Open',
  description: '', requirements: '', branch_id: '',
};
export const EMPTY_APPLICANT = {
  full_name: '', position_id: '', email: '', phone: '', source: '',
  expected_salary: '', rating: '', notes: '', branch_id: '',
};

// ── Offer letter constants (Lebanon-aware) ────────────────────────────────
// Mirrors the backend validation in routers/recruitment.py — keeping these
// in sync with the server lets the form catch obvious mistakes before a POST.
export const OFFER_CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation', 'Internship', 'Consultant'];
export const OFFER_CURRENCIES     = ['USD', 'EUR', 'LBP', 'AED', 'SAR'];
export const OFFER_PAY_SCHEDULES  = ['Monthly', 'Bi-weekly', 'Weekly'];
export const OFFER_STATUS_BADGE   = {
  Draft: 'gray', Sent: 'blue', Accepted: 'green',
  Declined: 'red', Expired: 'gray',
};
// Article 9 — probation capped at 3 months. Article 31 — 48-hour working week.
export const LB_MAX_PROBATION_MONTHS = 3;
export const LB_MAX_WEEKLY_HOURS     = 48;

export const EMPTY_OFFER = {
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
