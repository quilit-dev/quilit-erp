// Payment Plans: the instalment book on one page.
//
// Laid out the way a collections desk works it — the state of the whole book
// first (what is out, what is late, how much of what fell due was actually
// paid), then where the arrears sit by age and what is due to come in month by
// month, then every plan, worst first, each opening onto its own schedule.
//
// The figures come from the server already derived (see backend/plan_report.py)
// so this page and the plan panels on the customer and the invoice cannot
// disagree.
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingSpinner, ErrorAlert, fmt, fmtDate } from '../../components/shared';
import { getReportPaymentPlans } from '../../api/client';
import { StatCard, AgingBucketBar, VBarChart, ExportButtons } from './charts';

const STATUS_BADGE = {
  on_track: 'badge-green', late: 'badge-red', completed: 'badge-blue', cancelled: 'badge-gray',
  covered: 'badge-purple',
};
const LINE_BADGE = { Paid: 'badge-green', Overdue: 'badge-red', Partial: 'badge-yellow', Due: 'badge-gray' };
const FILTERS = ['open', 'late', 'on_track', 'completed', 'cancelled', 'covered', 'all'];

function PaymentPlansReport({ params, t }) {
  const [status, setStatus]   = useState('open');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(() => new Set());

  const start = params?.start, end = params?.end;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getReportPaymentPlans({ start, end, status })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [start, end, status]);

  if (loading && !data) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const { summary: s, aging, forecast } = data;
  const q = search.trim().toLowerCase();
  const plans = q
    ? data.plans.filter(p => [p.client_name, p.reference].some(v => (v || '').toLowerCase().includes(q)))
    : data.plans;

  const statusLabel = k => t(`reports.pp.status.${k}`);
  const freqLabel = k => t(`reports.pp.freq.${k}`);
  const toggle = key => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const counts = {
    open: s.on_track + s.late, late: s.late, on_track: s.on_track,
    completed: s.completed, cancelled: s.cancelled, covered: s.covered || 0,
    all: s.plans + s.cancelled + (s.covered || 0),
  };

  // Exports: the plan list, and the full schedule behind it (one row per
  // instalment), which is what an accountant reconciling the book asks for.
  const planCols = [
    { label: t('reports.client'),           value: p => p.client_name || '',        align: 'left' },
    { label: t('reports.pp.plan'),          value: p => p.reference,                align: 'left' },
    { label: t('reports.pp.type'),          value: p => t(`reports.pp.kind.${p.kind}`), align: 'left' },
    { label: t('reports.pp.frequency'),     value: p => freqLabel(p.frequency),     align: 'left' },
    { label: t('reports.pp.instalments'),   value: p => `${p.paid_count}/${p.count}`, align: 'left' },
    { label: t('reports.pp.total'),         value: p => p.total,                    align: 'right' },
    { label: t('reports.pp.paid'),          value: p => p.paid,                     align: 'right' },
    { label: t('reports.pp.remaining'),     value: p => p.remaining,                align: 'right' },
    { label: t('reports.pp.overdue'),       value: p => p.overdue,                  align: 'right' },
    { label: t('reports.pp.daysLate'),      value: p => p.days_late,                align: 'right' },
    { label: t('reports.pp.nextDue'),       value: p => p.next_due_date || '',      align: 'left' },
    { label: t('reports.pp.nextAmount'),    value: p => p.next_due_amount,          align: 'right' },
    { label: t('reports.pp.dueInPeriod'),   value: p => p.due_in_period,            align: 'right' },
    { label: t('common.status'),            value: p => statusLabel(p.status),      align: 'left' },
  ];
  const scheduleRows = plans.flatMap(p => p.installments.map(i => ({ ...i, plan: p })));
  const scheduleCols = [
    { label: t('reports.client'),          value: r => r.plan.client_name || '', align: 'left' },
    { label: t('reports.pp.plan'),         value: r => r.plan.reference,         align: 'left' },
    { label: '#',                          value: r => r.seq,                    align: 'right' },
    { label: t('reports.dueDate'),         value: r => r.due_date,               align: 'left' },
    { label: t('reports.pp.amount'),       value: r => r.amount,                 align: 'right' },
    { label: t('reports.pp.paid'),         value: r => r.paid,                   align: 'right' },
    { label: t('reports.pp.remaining'),    value: r => r.remaining,              align: 'right' },
    { label: t('common.status'),           value: r => t(`reports.pp.line.${r.status}`), align: 'left' },
  ];
  // The chart formats 'YYYY-MM' itself; hand it the raw month.
  const chartData = forecast.map(f => ({ month: f.month, value: f.due }));

  return (
    <div>
      {/* ── The state of the book ─────────────────────────────────────── */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.pp.activePlans')} value={s.on_track + s.late}
          sub={t('reports.pp.activeSub', { onTrack: s.on_track, late: s.late })} />
        <StatCard label={t('reports.pp.outstanding')} value={fmt(s.outstanding)}
          sub={t('reports.pp.outstandingSub', { scheduled: fmt(s.scheduled) })} />
        <StatCard label={t('reports.pp.overdue')} value={fmt(s.overdue)}
          color={s.overdue > 0 ? 'red' : undefined}
          sub={t('reports.pp.overdueSub', { count: s.overdue_installments })} />
        <StatCard label={t('reports.pp.dueInPeriod')} value={fmt(s.due_in_period)}
          sub={t('reports.pp.dueInPeriodSub', { scheduled: fmt(s.scheduled_in_period) })} />
        <StatCard label={t('reports.pp.collectionRate')}
          value={s.collection_rate == null ? '—' : `${s.collection_rate}%`}
          color={s.collection_rate == null ? undefined : s.collection_rate >= 90 ? 'green' : s.collection_rate >= 70 ? 'yellow' : 'red'}
          sub={t('reports.pp.collectionRateSub', { collected: fmt(s.collected) })} />
      </div>

      {/* ── Where the arrears sit, and what is coming in ─────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header chart-header"><h2 className="card-title">{t('reports.pp.arrearsTitle')}</h2></div>
          <div className="card-body">
            {s.overdue > 0
              ? <AgingBucketBar summary={aging} />
              : <div style={{ color: 'var(--green)', fontSize: 13 }}>{t('reports.pp.noArrears')}</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-header chart-header"><h2 className="card-title">{t('reports.pp.forecastTitle')}</h2></div>
          <div className="card-body">
            {chartData.length
              ? <VBarChart data={chartData} labelKey="month" valueKey="value" />
              : <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.pp.noForecast')}</div>}
          </div>
        </div>
      </div>

      {/* ── Every plan ───────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="card-title">{t('reports.pp.title')}</span>
          <div className="seg" role="group" aria-label={t('common.status')}
               style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            {FILTERS.map(f => (
              <button key={f} type="button"
                className={`btn btn-sm ${status === f ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={status === f} onClick={() => setStatus(f)}>
                {t(`reports.pp.filter.${f}`)} <span style={{ opacity: 0.7 }}>{counts[f]}</span>
              </button>
            ))}
          </div>
          <input className="form-control" type="search" value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('reports.pp.search')} aria-label={t('reports.pp.search')}
            style={{ maxWidth: 240, marginInlineStart: 'auto' }} />
          {/* Two exports: the plan list, and the full schedule behind it. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('reports.pp.exportPlans')}</span>
            <ExportButtons rows={plans} columns={planCols} baseName="payment_plans"
              pdfTitle={t('reports.pp.title')} t={t} />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('reports.pp.exportSchedule')}</span>
            <ExportButtons rows={scheduleRows} columns={scheduleCols} baseName="payment_plan_schedule"
              pdfTitle={t('reports.pp.scheduleTitle')} t={t} />
          </span>
        </div>

        {plans.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            {q ? t('reports.pp.noMatch') : t('reports.pp.empty')}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>{t('reports.client')}</th>
                  <th>{t('reports.pp.plan')}</th>
                  <th style={{ minWidth: 130 }}>{t('reports.pp.progress')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.pp.total')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.pp.remaining')}</th>
                  <th>{t('reports.pp.nextDue')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.pp.overdue')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {plans.map(p => {
                  const expanded = open.has(p.key);
                  return (
                    <Fragment key={p.key}>
                      <tr onClick={() => toggle(p.key)} style={{ cursor: 'pointer' }}
                          aria-expanded={expanded}>
                        <td>
                          <button type="button" className="icon-btn" aria-label={t('reports.pp.showSchedule')}
                            onClick={e => { e.stopPropagation(); toggle(p.key); }}
                            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
                            ›
                          </button>
                        </td>
                        <td className="td-primary">
                          {p.client_id
                            ? <Link to={`/clients/${p.client_id}`} onClick={e => e.stopPropagation()}
                                style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{p.client_name}</Link>
                            : p.client_name}
                        </td>
                        <td>
                          <div style={{ fontWeight: 500 }}>
                            {p.invoice_id
                              ? <Link to={`/invoices?focus=${p.invoice_id}`} onClick={e => e.stopPropagation()}
                                  style={{ color: 'inherit' }}>{p.reference}</Link>
                              : p.reference}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                            {t(`reports.pp.kind.${p.kind}`)} · {freqLabel(p.frequency)} · {fmtDate(p.first_due)} → {fmtDate(p.last_due)}
                          </div>
                          {/* One debt, one agreement: an invoice plan taken in by a later
                              account plan is shown for reference and counted only once. */}
                          {p.covered_by && (
                            <div style={{ fontSize: 11.5, color: 'var(--accent)' }}>
                              {t('reports.pp.coveredBy', { plan: p.covered_by })}
                            </div>
                          )}
                          {p.covers?.length > 0 && (
                            <div style={{ fontSize: 11.5, color: 'var(--accent)' }}>
                              {t('reports.pp.includes', { refs: p.covers.join(', ') })}
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                            <span>{t('reports.pp.ofCount', { paid: p.paid_count, count: p.count })}</span>
                            <span style={{ color: 'var(--text-3)' }}>{Math.round(p.progress)}%</span>
                          </div>
                          <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(p.progress)}
                               aria-valuemin={0} aria-valuemax={100}>
                            <div className="progress-fill"
                              style={{ width: `${Math.min(100, p.progress)}%`,
                                       background: p.status === 'late' ? 'var(--red)' : undefined }} />
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmt(p.total)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(p.remaining)}</td>
                        <td>
                          {p.next_due_date
                            ? <><div>{fmtDate(p.next_due_date)}</div>
                                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{fmt(p.next_due_amount)}</div></>
                            : <span style={{ color: 'var(--text-3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {p.overdue > 0
                            ? <><div style={{ color: 'var(--red)', fontWeight: 600 }}>{fmt(p.overdue)}</div>
                                <div style={{ fontSize: 11.5, color: 'var(--red)' }}>{t('reports.pp.daysLateShort', { days: p.days_late })}</div></>
                            : <span style={{ color: 'var(--text-3)' }}>—</span>}
                        </td>
                        <td><span className={`badge ${STATUS_BADGE[p.status]}`}>{statusLabel(p.status)}</span></td>
                      </tr>
                      {expanded && (
                        <tr className="plan-schedule">
                          <td />
                          <td colSpan={8} style={{ background: 'var(--surface-2)', padding: '12px 16px' }}>
                            {p.note && <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>{p.note}</div>}
                            <table style={{ width: '100%', maxWidth: 720 }}>
                              <thead>
                                <tr>
                                  <th>#</th>
                                  <th>{t('reports.dueDate')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('reports.pp.amount')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('reports.pp.paid')}</th>
                                  <th style={{ textAlign: 'right' }}>{t('reports.pp.remaining')}</th>
                                  <th>{t('common.status')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.installments.map(i => (
                                  <tr key={i.seq}>
                                    <td>{i.seq}</td>
                                    <td>{fmtDate(i.due_date)}</td>
                                    <td style={{ textAlign: 'right' }}>{fmt(i.amount)}</td>
                                    <td style={{ textAlign: 'right', color: i.paid > 0 ? 'var(--green)' : 'var(--text-3)' }}>{fmt(i.paid)}</td>
                                    <td style={{ textAlign: 'right', fontWeight: i.remaining > 0 ? 600 : 400 }}>{fmt(i.remaining)}</td>
                                    <td><span className={`badge ${LINE_BADGE[i.status] || 'badge-gray'}`}>{t(`reports.pp.line.${i.status}`)}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
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
    </div>
  );
}

export { PaymentPlansReport };
