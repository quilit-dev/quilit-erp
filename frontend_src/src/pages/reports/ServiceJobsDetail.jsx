// Every service job in the period, with its detail one click away.
//
// The row is the job at a glance: when, for whom, on what machine, who went,
// what it brought in and whether it has been invoiced and paid. Opening it
// shows what was wrong, what was done, and every line --- labour and charges,
// parts with what they cost. Part costs and margin come only when the server
// says the user may see cost (`showCost`); otherwise those columns are absent.
import { Fragment, useMemo, useState } from 'react';
import { fmt, fmtDate } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';
import { ExportButtons } from './charts';

const qty = v => String(+Number(v || 0).toFixed(3));
const when = r => r.completed_at || r.scheduled_date || r.created_at;

function ServiceJobsDetail({ jobs, showCost, t }) {
  const { tStatus } = useLocale();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);

  const statuses = useMemo(() => [...new Set(jobs.map(j => j.status))].sort(), [jobs]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return jobs.filter(j => (!status || j.status === status) && (!needle || [
      j.job_number, j.client_name, j.equipment_name, j.job_type, j.reported_fault,
      j.work_done, j.invoice_number, ...(j.technicians || []),
    ].some(v => String(v || '').toLowerCase().includes(needle))));
  }, [jobs, status, q]);

  const cols = [
    { label: t('service.jobNumber'),   value: r => r.job_number,                    align: 'left'  },
    { label: t('common.date'),         value: r => (when(r) || '').slice(0, 10),    align: 'left'  },
    { label: t('common.client'),       value: r => r.client_name || '',             align: 'left'  },
    { label: t('service.equipment'),   value: r => r.equipment_name || '',          align: 'left'  },
    { label: t('service.jobType'),     value: r => r.job_type || '',                align: 'left'  },
    { label: t('common.status'),       value: r => r.status,                        align: 'left'  },
    { label: t('service.technicians'), value: r => (r.technicians || []).join(', '), align: 'left' },
    { label: t('service.reportedFault'), value: r => r.reported_fault || '',        align: 'left'  },
    { label: t('service.workDone'),    value: r => r.work_done || '',               align: 'left'  },
    { label: t('service.labourTotal'), value: r => r.labour_total,                  align: 'right' },
    { label: t('service.partsTotal'),  value: r => r.parts_total,                   align: 'right' },
    { label: t('reports.revenue'),     value: r => r.revenue,                       align: 'right' },
    ...(showCost ? [
      { label: t('service.partsCost'), value: r => r.parts_cost,                    align: 'right' },
      { label: t('service.margin'),    value: r => r.margin,                        align: 'right' },
    ] : []),
    { label: t('service.invoice'),     value: r => r.invoice_number || t('service.unbilled'), align: 'left' },
  ];
  // A narrower set for A4: the write-up and the lines live in the spreadsheet.
  const pdfCols = cols.filter(c => ![t('service.reportedFault'), t('service.workDone'),
                                      t('service.labourTotal'), t('service.partsTotal')].includes(c.label));

  const span = showCost ? 9 : 7;   // every column but the arrow

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between',
                                            alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3>{t('service.jobDetails')} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({rows.length})</span></h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-control" style={{ width: 200 }} value={q}
            onChange={e => setQ(e.target.value)} placeholder={t('service.searchJobs')} />
          <SearchSelect className="form-control" style={{ width: 150 }} value={status}
            onChange={v => setStatus(v)}
            options={[{ value: '', label: t('service.allStatuses') },
                      ...statuses.map(s => ({ value: s, label: tStatus(s) }))]} />
          <ExportButtons rows={rows} columns={cols} pdfColumns={pdfCols}
            baseName="service_jobs" pdfTitle={t('service.jobDetails')} t={t} />
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
          {t('service.noJobs')}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>{t('service.jobNumber')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.client')}</th>
                <th>{t('service.technicians')}</th>
                <th>{t('common.status')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.revenue')}</th>
                {showCost && <th style={{ textAlign: 'right' }}>{t('service.partsCost')}</th>}
                {showCost && <th style={{ textAlign: 'right' }}>{t('service.margin')}</th>}
                <th>{t('service.invoice')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.id)} style={{ cursor: 'pointer' }}
                        aria-expanded={isOpen}>
                      <td style={{ color: 'var(--text-3)' }}>{isOpen ? '▾' : '▸'}</td>
                      <td className="td-primary" style={{ whiteSpace: 'nowrap' }}>
                        {r.job_number}
                        <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>{r.job_type}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(when(r))}</td>
                      <td>
                        {r.client_name || '—'}
                        {r.equipment_name && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.equipment_name}</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>{(r.technicians || []).join(', ') || '—'}</td>
                      <td><span className="badge">{tStatus(r.status)}</span></td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.revenue)}</td>
                      {showCost && <td style={{ textAlign: 'right' }}>{fmt(r.parts_cost)}</td>}
                      {showCost && (
                        <td style={{ textAlign: 'right', color: r.margin < 0 ? 'var(--red)' : 'var(--green)' }}>
                          {fmt(r.margin)}
                          {r.margin_pct != null && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.margin_pct}%</div>}
                        </td>
                      )}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.invoice_number
                          ? <>{r.invoice_number}<div style={{ fontSize: 11, color: 'var(--text-3)' }}>{tStatus(r.invoice_status)}</div></>
                          : <span style={{ color: 'var(--caution-ink)' }}>{t('service.unbilled')}</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td></td>
                        <td colSpan={span} style={{ background: 'var(--surface-2)', padding: '12px 16px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                        gap: 12, marginBottom: 12, fontSize: 13 }}>
                            <div><div className="form-label">{t('service.reportedFault')}</div>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.reported_fault || '—'}</div></div>
                            <div><div className="form-label">{t('service.workDone')}</div>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{r.work_done || '—'}</div></div>
                            <div><div className="form-label">{t('service.priority')}</div>
                              <div>{tStatus(r.priority) || '—'}</div>
                              <div className="form-label" style={{ marginTop: 8 }}>{t('service.scheduledDate')}</div>
                              <div>{r.scheduled_date ? fmtDate(r.scheduled_date) : '—'}
                                {r.completed_at && <> · {t('service.completedAt')} {fmtDate(r.completed_at)}</>}</div></div>
                          </div>
                          {(r.lines || []).length === 0 ? (
                            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('service.noLines')}</div>
                          ) : (
                            <table style={{ background: 'var(--surface)', fontSize: 12 }}>
                              <thead>
                                <tr>
                                  <th>{t('service.partsAndCharges')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('service.qty')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('service.unitPrice')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('service.lineNet')}</th>
                                  {showCost && <th style={{ textAlign: 'right' }}>{t('service.partsCost')}</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {r.lines.map((l, i) => (
                                  <tr key={i}>
                                    <td>
                                      {l.name}
                                      <span style={{ marginInlineStart: 6, fontSize: 11, color: 'var(--text-3)' }}>
                                        {l.type === 'part' ? t('service.part') : t('service.charge')}
                                      </span>
                                    </td>
                                    <td style={{ textAlign: 'right' }}>{qty(l.quantity)}</td>
                                    <td style={{ textAlign: 'right' }}>{fmt(l.unit_price)}</td>
                                    <td style={{ textAlign: 'right' }}>{fmt(l.net)}</td>
                                    {showCost && (
                                      <td style={{ textAlign: 'right' }}>
                                        {l.type !== 'part' ? '—' : l.cost != null ? fmt(l.cost) : t('service.notConsumed')}
                                      </td>
                                    )}
                                  </tr>
                                ))}
                                <tr style={{ fontWeight: 600 }}>
                                  <td colSpan={3}>{t('service.labourTotal')}: {fmt(r.labour_total)} · {t('service.partsTotal')}: {fmt(r.parts_total)}</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(r.subtotal)}</td>
                                  {showCost && <td style={{ textAlign: 'right' }}>{fmt(r.parts_cost)}</td>}
                                </tr>
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export { ServiceJobsDetail };
