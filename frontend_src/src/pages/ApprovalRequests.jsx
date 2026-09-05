import { useState, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData.js';
import { LoadingSpinner, ErrorAlert, toast } from '../components/shared';
import SearchSelect from '../components/SearchSelect.jsx';
import {
  getApprovalRequests,
  approveRequest,
  rejectRequest,
  forceApproveRequest,
  cancelApprovalRequest,
} from '../api/client';

// ── Display config ──────────────────────────────────────────────────────────

const STATUS_CFG = {
  pending:   { labelKey: 'statusPending',   bg: 'var(--caution-tint)', color: 'var(--caution-ink)' },
  approved:  { labelKey: 'approved',        bg: 'var(--affirm-tint)', color: 'var(--affirm)' },
  rejected:  { labelKey: 'rejected',        bg: 'var(--negate-tint)', color: 'var(--negate)' },
  cancelled: { labelKey: 'statusCancelled', bg: 'var(--bg)', color: 'var(--text-3)' },
};

const MODULE_CFG = {
  expense:     { color: 'var(--caution-ink)', bg: 'var(--caution-tint)' },
  purchase:    { color: 'var(--affirm)', bg: 'var(--affirm-tint)' },
  project:     { color: '#be185d', bg: '#fce7f3' },
  quotation:   { color: 'var(--info-ink)', bg: 'var(--info-tint)' },
  invoice:     { color: '#0369a1', bg: '#e0f2fe' },
  fixed_asset: { color: '#6d28d9', bg: '#ede9fe' },
};

const STEP_STATUS_CFG = {
  pending:  { icon: '⏳', color: 'var(--caution-ink)' },
  waiting:  { icon: '⏸',  color: 'var(--text-3)' },
  approved: { icon: '✓',  color: 'var(--affirm)' },
  rejected: { icon: '✗',  color: 'var(--negate)' },
  skipped:  { icon: '⤼',  color: 'var(--text-3)' },
};

function timeAgo(ts, t) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts + 'Z')) / 1000;
  if (diff < 60)    return t('approvals.justNow');
  if (diff < 3600)  return t('approvals.minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('approvals.hoursAgo', { n: Math.floor(diff / 3600) });
  return t('approvals.daysAgo', { n: Math.floor(diff / 86400) });
}

function StatusBadge({ status }) {
  const { t } = useLocale();
  const cfg = STATUS_CFG[status] || STATUS_CFG.pending;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color }}>
      {t('approvals.' + cfg.labelKey)}
    </span>
  );
}

function ModuleTag({ module }) {
  const cfg = MODULE_CFG[module] || { color: 'var(--text-2)', bg: 'var(--bg)' };
  return (
    <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, background: cfg.bg, color: cfg.color, textTransform: 'capitalize' }}>
      {(module || '').replace(/_/g, ' ')}
    </span>
  );
}

// ── Step Timeline ───────────────────────────────────────────────────────────

function StepTimeline({ steps, currentStep }) {
  if (!steps || steps.length === 0) return null;

  const grouped = steps.reduce((acc, s) => {
    (acc[s.step_number] = acc[s.step_number] || []).push(s);
    return acc;
  }, {});
  const stepNums = Object.keys(grouped).map(Number).sort((a, b) => a - b);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {stepNums.map((num, i) => {
        const rows      = grouped[num];
        const status    = rows[0]?.status || 'waiting';
        const cfg       = STEP_STATUS_CFG[status] || STEP_STATUS_CFG.waiting;
        const isCurrent = num === currentStep;
        return (
          <div key={num} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 8px', borderRadius: 99, fontSize: 11,
              border: `1.5px solid ${isCurrent ? cfg.color : 'var(--border)'}`,
              background: isCurrent ? `${cfg.color}18` : 'transparent',
            }}>
              <span style={{ fontSize: 12, color: cfg.color }}>{cfg.icon}</span>
              <span style={{ color: isCurrent ? cfg.color : 'var(--text-3)', fontWeight: isCurrent ? 700 : 400 }}>
                {rows.map(s => s.approver_role).join(' / ')}
              </span>
              {rows[0]?.actor_name && status !== 'waiting' && status !== 'pending' && (
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>· {rows[0].actor_name}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Action Panel ────────────────────────────────────────────────────────────
// Decision note: written by the approver on approve/reject/cancel/force,
// surfaced to every viewer of the request as the per-step `s.comment` line
// in the step list and as the bottom "Final note" callout once the request
// is resolved. There is intentionally no free-form discussion thread — a
// request carries exactly one note per decision so the audit trail stays
// crisp and unambiguous.

function ActionPanel({ req, onDone }) {
  const { t } = useLocale();
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(null);

  // Permissions come straight from the server — no client-side role guessing.
  const { can_act: canAct, can_force: canForce, can_cancel: canCancel } = req;
  if (!canAct && !canForce && !canCancel) return null;

  async function act(action) {
    setLoading(action);
    try {
      const payload = { comment: comment.trim() || undefined };
      if (action === 'approve')       await approveRequest(req.id, payload);
      if (action === 'reject')        await rejectRequest(req.id, payload);
      if (action === 'force-approve') await forceApproveRequest(req.id, payload);
      if (action === 'cancel')        await cancelApprovalRequest(req.id, payload);
      toast({
        approve:         t('approvals.requestApproved'),
        reject:          t('approvals.requestRejected'),
        'force-approve': t('approvals.requestForceApproved'),
        cancel:          t('approvals.requestCancelled'),
      }[action]);
      onDone();
    } catch (err) {
      toast(err.message || t('approvals.actionFailed'), 'error');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div style={{ marginTop: 4, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <textarea
        className="form-control"
        rows={2}
        placeholder={t('approvals.decisionNote')}
        value={comment}
        onChange={e => setComment(e.target.value)}
        style={{ marginBottom: 8, resize: 'none' }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {canCancel && (
          <button className="btn btn-outline btn-sm" onClick={() => act('cancel')} disabled={!!loading}
            style={{ color: 'var(--text-3)' }}>
            {loading === 'cancel' ? t('approvals.cancelling') : t('approvals.cancelRequest')}
          </button>
        )}
        {canForce && (
          <button className="btn btn-outline btn-sm" onClick={() => act('force-approve')} disabled={!!loading}
            style={{ color: '#7c3aed', borderColor: '#7c3aed' }}
            title={t('approvals.forceApproveTitle')}>
            {loading === 'force-approve' ? t('approvals.forcing') : t('approvals.forceApprove')}
          </button>
        )}
        {canAct && <>
          <button className="btn btn-outline btn-sm" onClick={() => act('reject')} disabled={!!loading}
            style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>
            {loading === 'reject' ? t('approvals.rejecting') : t('approvals.reject')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => act('approve')} disabled={!!loading}>
            {loading === 'approve' ? t('approvals.approving') : t('approvals.approve')}
          </button>
        </>}
      </div>
    </div>
  );
}

// ── Request Row ─────────────────────────────────────────────────────────────

function RequestRow({ req, onRefresh }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const snapshot = req.entity_snapshot || {};

  return (
    <>
      <tr onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer' }}
          className={req.status === 'pending' ? 'tr-highlight' : ''}>
        <td style={{ width: 28 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </td>
        <td>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
            {req.entity_label || `${req.module} #${req.entity_id}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{req.policy_name}</div>
        </td>
        <td><ModuleTag module={req.module} /></td>
        <td><StatusBadge status={req.status} /></td>
        <td><StepTimeline steps={req.steps_detail} currentStep={req.current_step} /></td>
        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {req.requester_name || '—'}
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{timeAgo(req.requested_at, t)}</div>
        </td>
        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {req.status !== 'pending'
            ? <>{req.resolver_name || '—'}<div style={{ fontSize: 10, color: 'var(--text-3)' }}>{timeAgo(req.resolved_at, t)}</div></>
            : <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding: 0, background: 'var(--surface)' }}>
            <div style={{ padding: '14px 20px 14px 44px' }}>

              {Object.keys(snapshot).length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.5px' }}>
                    {t('approvals.snapshot')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {Object.entries(snapshot).map(([k, v]) => (
                      <div key={k} style={{ fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px' }}>
                        <span style={{ color: 'var(--text-3)' }}>{k}: </span>
                        <strong style={{ color: 'var(--text)' }}>{String(v ?? '—')}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.5px' }}>
                  {t('approvals.approvalSteps')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(req.steps_detail || []).map(s => {
                    const cfg = STEP_STATUS_CFG[s.status] || STEP_STATUS_CFG.waiting;
                    return (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: `${cfg.color}22`, fontSize: 11, color: cfg.color, fontWeight: 700,
                        }}>{s.step_number}</div>
                        <span style={{ color: 'var(--text)', fontWeight: 600, minWidth: 140 }}>{s.approver_role}</span>
                        <span style={{ color: cfg.color, fontWeight: 600, fontSize: 11 }}>{t('approvals.step_' + s.status)}</span>
                        {s.actor_name && <span style={{ color: 'var(--text-3)' }}>{t('approvals.by')} {s.actor_name}</span>}
                        {s.acted_at   && <span style={{ color: 'var(--text-3)' }}>· {timeAgo(s.acted_at, t)}</span>}
                        {s.comment    && <span style={{ color: 'var(--text-2)', fontStyle: 'italic' }}>"{s.comment}"</span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {req.resolution_comment && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', padding: '6px 10px', borderLeft: '3px solid var(--border)', marginBottom: 12 }}>
                  <strong>{t('approvals.decisionNote')}:</strong> {req.resolution_comment}
                </div>
              )}

              <ActionPanel req={req} onDone={onRefresh} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

const TABS = [
  { key: 'all',      labelKey: 'tabAll' },
  { key: 'pending',  labelKey: 'tabPending' },
  { key: 'mine',     labelKey: 'tabMine' },
  { key: 'approved', labelKey: 'tabApproved' },
  { key: 'rejected', labelKey: 'tabRejected' },
];

const MODULE_OPTIONS = ['expense', 'invoice', 'purchase', 'project'];

// Each tab maps to an explicit, non-overlapping server query.
function paramsForTab(tab, modFil) {
  const p = {};
  if (tab === 'pending')       { p.view = 'inbox'; }
  else if (tab === 'mine')     { p.view = 'mine'; }
  else if (tab === 'approved') { p.view = 'all'; p.status = 'approved'; }
  else if (tab === 'rejected') { p.view = 'all'; p.status = 'rejected'; }
  else                         { p.view = 'all'; }
  if (modFil) p.module = modFil;
  return p;
}

export default function ApprovalRequests() {
  const { t } = useLocale();
  const [tab,    setTab]    = useState('pending');
  const [modFil, setModFil] = useState('');

  // fetchFn rebuilt whenever tab/module changes…
  const fetchReqs = useCallback(
    () => getApprovalRequests(paramsForTab(tab, modFil)),
    [tab, modFil],
  );
  // …and useData re-runs because the same deps are passed through.
  const { data: requests, reload, loading, error } = useData(fetchReqs, [tab, modFil]);

  const safeReqs = Array.isArray(requests) ? requests : [];

  const pending  = safeReqs.filter(r => r.status === 'pending').length;
  const approved = safeReqs.filter(r => r.status === 'approved').length;
  const rejected = safeReqs.filter(r => r.status === 'rejected').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('approvals.requestsTitle')}</h1>
          <p className="page-subtitle">{t('approvals.requestsSubtitle')}</p>
        </div>
      </div>

      {/* KPI strip — matches the canonical stat-card pattern used by every
          other module (Manufacturing, Fixed Assets, HR, ...): default
          surface, muted label, status colour reserved for the value only.
          Pending grey-fades when there's nothing waiting, same treatment
          as Recurring Expenses' "Due" card. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: t('approvals.statusPending'), value: pending,
            color: pending  > 0 ? 'var(--yellow)' : 'var(--text-3)' },
          { label: t('approvals.approved'),      value: approved,
            color: approved > 0 ? 'var(--green)'  : 'var(--text-3)' },
          { label: t('approvals.rejected'),      value: rejected,
            color: rejected > 0 ? 'var(--red)'    : 'var(--text-3)' },
        ].map(c => (
          <div key={c.label} className="stat-card" style={{ padding: '14px 18px' }}>
            <div className="stat-label">{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c.color, marginTop: 2 }}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {TABS.map(tb => (
            <button key={tb.key}
              className={`tab-btn${tab === tb.key ? ' active' : ''}`}
              onClick={() => setTab(tb.key)}>
              {t('approvals.' + tb.labelKey)}
            </button>
          ))}
        </div>
        <SearchSelect
          className="form-control"
          style={{ width: 160, marginLeft: 'auto' }}
          value={modFil}
          onChange={v => setModFil(v)}
          placeholder={t('common.allModules')}
          options={(MODULE_OPTIONS).map(m => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))} />
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading && !safeReqs.length ? <LoadingSpinner /> : error ? <ErrorAlert message={error} onRetry={reload} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>{t('approvals.entityPolicy')}</th>
                  <th>{t('approvals.module')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('approvals.approvalChain')}</th>
                  <th>{t('approvals.requestedBy')}</th>
                  <th>{t('approvals.resolvedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {safeReqs.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 48, color: 'var(--text-3)' }}>
                    {t('approvals.noRequests')}
                  </td></tr>
                ) : safeReqs.map(req => (
                  <RequestRow key={req.id} req={req} onRefresh={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
