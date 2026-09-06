/**
 * Who attended what, and whether the service side is making money.
 *
 * The month-end question this was built for: how many services did each
 * technician complete. A job can take two people, which is why the per-person
 * table and the header do not — and must not — add up to the same number.
 *
 * A job with two technicians counts ONCE for the business and once for each of
 * them. So the Jobs column here can legitimately total more than "jobs
 * completed" above it, and `value_attended` is the worth of the calls a person
 * was on, NOT a share of the revenue: two technicians on one $500 job is still
 * $500 to the company. Summing that column would invent money. The server says
 * when the overlap is happening (`technician_rows_overlap`) and the note below
 * appears only then, so the table explains itself rather than looking broken.
 *
 * A technician is staff who works inside the company and goes out on demand, so
 * the row set is a UNION: anyone marked field staff appears whether or not they
 * did a call — somebody present all month with no jobs is a fact worth seeing —
 * and anyone who DID attend one appears whether or not the box was ticked.
 *
 * Days present is HR data and Reports is a wider door than HR, so the server
 * omits the key entirely for a viewer without it. The column is then absent
 * rather than blank: a zero would read as "he was never here".
 */
import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, EmptyState, fmt } from '../../components/shared';
import { getServiceJobsReport } from '../../api/client';
import { StatCard, ExportButtons } from './charts';

function ServiceReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getServiceJobsReport(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const techs  = data.by_technician || [];
  const totals = data.totals || {};
  // Days present is personnel data and Reports is a wider door than HR, so the
  // server withholds it by OMITTING the key rather than sending a zero — a zero
  // would read as "he was never here". The column follows: gone, not blank.
  const showDays = !!data.attendance_visible;

  const techCols = [
    { label: t('service.technician'),   value: r => r.name,           align: 'left'  },
    { label: t('hr.jobTitleField'),          value: r => r.job_title || '', align: 'left' },
    ...(showDays
      ? [{ label: t('service.daysPresent'), value: r => r.days_present, align: 'right' }]
      : []),
    { label: t('service.jobsCompleted'), value: r => r.jobs,          align: 'right' },
    { label: t('service.valueAttended'), value: r => r.value_attended, align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid">
        <StatCard label={t('service.jobsCompleted')} value={totals.completed_jobs ?? 0} />
        <StatCard label={t('reports.revenue')}       value={fmt(totals.revenue)} />
        <StatCard label={t('service.unbilled')}      value={totals.unbilled_count ?? 0}
                  sub={fmt(totals.unbilled_value)} />
        <StatCard label={t('service.technicians')}   value={techs.length} />
      </div>

      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between',
                                              alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3>{t('service.byTechnician')}</h3>
          <ExportButtons rows={techs} columns={techCols} baseName="service_by_technician"
                         pdfTitle={t('service.byTechnician')} t={t} />
        </div>

        {techs.length === 0 ? (
          <EmptyState message={t('service.noCompletedJobs')} />
        ) : (
          <>
            {data.technician_rows_overlap && (
              // Only when it is actually true, so it reads as an explanation
              // rather than boilerplate nobody finishes.
              <p style={{ margin: '10px 18px 0', fontSize: 12, color: 'var(--text-3)' }}>
                {t('service.sharedJobsNote')}
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('service.technician')}</th>
                    <th>{t('hr.jobTitleField')}</th>
                    {showDays && (
                      <th style={{ textAlign: 'right' }}>{t('service.daysPresent')}</th>
                    )}
                    <th style={{ textAlign: 'right' }}>{t('service.jobsCompleted')}</th>
                    <th style={{ textAlign: 'right' }}>{t('service.valueAttended')}</th>
                  </tr>
                </thead>
                <tbody>
                  {techs.map(r => (
                    <tr key={r.employee_id}>
                      <td className="td-primary">{r.name}</td>
                      <td style={{ color: 'var(--text-2)' }}>{r.job_title || '—'}</td>
                      {showDays && (
                        <td style={{ textAlign: 'right' }}>{r.days_present}</td>
                      )}
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.jobs}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(r.value_attended)}</td>
                    </tr>
                  ))}
                </tbody>
                {/* Deliberately NO total row. The Jobs column double-counts a
                    shared call by design, and Value is each job's full worth
                    shown to everyone who attended it — a total under either
                    would be a number that means nothing. The true figures are
                    the cards above, which come from the job rows. */}
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { ServiceReport };
