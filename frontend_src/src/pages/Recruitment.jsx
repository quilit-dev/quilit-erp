import { useState, useCallback } from 'react';
import { useData } from '../hooks/useData';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import { EmptyState, fmtDate, toast } from '../components/shared';
import {
  getRecruitmentSummary, getPositions, archivePosition,
  getApplicants, getDepartments,
} from '../api/client';

// Section & modal components extracted into ./recruitment/ — this file is the
// orchestrator (pipeline board + shared state); each logical piece is its own file.
import { PositionForm } from './recruitment/PositionForm';
import { ApplicantForm } from './recruitment/ApplicantForm';
import { ApplicantDetail } from './recruitment/ApplicantDetail';
import {
  PIPELINE, POS_BADGE, APP_BADGE, POS_STATUS_KEY, PIPELINE_KEY, EMP_TYPE_KEY,
} from './recruitment/constants';

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
