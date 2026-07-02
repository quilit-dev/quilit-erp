import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, toast } from '../../components/shared';
import { getManufacturingAnalytics } from '../../api/client';
import { num, Money } from './ui';

function AnalyticsView() {
  const { t } = useLocale();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getManufacturingAnalytics({ start, end })
      .then(setData).catch(e => toast(e.message, 'red')).finally(() => setLoading(false));
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const Kpi = ({ label, children }) => (
    <div className="stat-card" style={{ padding: '12px 14px' }}>
      <div className="stat-label" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{children}</div>
    </div>
  );
  const Row = ({ label, children, strong }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  fontWeight: strong ? 700 : 400, padding: '2px 0' }}>
      <span style={{ color: strong ? undefined : 'var(--text-2)' }}>{label}</span><span>{children}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('manufacturing.dateRange')}:</span>
        <input type="date" className="form-control" style={{ width: 150, height: 32 }} value={start} onChange={e => setStart(e.target.value)} />
        <span>–</span>
        <input type="date" className="form-control" style={{ width: 150, height: 32 }} value={end} onChange={e => setEnd(e.target.value)} />
      </div>

      {loading || !data ? <LoadingSpinner /> : data.summary.orders === 0 ? (
        <EmptyState message={t('manufacturing.noAnalytics')} icon="📊" />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 18 }}>
            <Kpi label={t('manufacturing.ordersCompleted')}>{data.summary.orders}</Kpi>
            <Kpi label={t('manufacturing.unitsProduced')}>{num(data.summary.units)}</Kpi>
            <Kpi label={t('manufacturing.totalCost')}><Money value={data.summary.total_cost} /></Kpi>
            <Kpi label={t('manufacturing.avgUnitCost')}><Money value={data.summary.avg_unit_cost} /></Kpi>
            <Kpi label={t('manufacturing.efficiency')}>{data.time_efficiency.efficiency_pct != null ? `${data.time_efficiency.efficiency_pct}%` : '—'}</Kpi>
            <Kpi label={t('manufacturing.onTimePct')}>{data.on_time.on_time_pct != null ? `${data.on_time.on_time_pct}%` : '—'}</Kpi>
            <Kpi label={t('manufacturing.qcPassRate')}>{data.qc.pass_rate != null ? `${data.qc.pass_rate}%` : '—'}</Kpi>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.costBreakdown')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.materialsCost')}><Money value={data.summary.materials} /></Row>
                {data.summary.labor > 0 && <Row label={t('manufacturing.laborCost')}><Money value={data.summary.labor} /></Row>}
                <Row label={t('manufacturing.overheadCost')}><Money value={data.summary.overhead} /></Row>
                {data.summary.scrap > 0 && <Row label={t('manufacturing.scrapCost')}><Money value={data.summary.scrap} /></Row>}
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                  <Row label={t('manufacturing.totalCost')} strong><Money value={data.summary.total_cost} /></Row>
                </div>
              </div>
            </div>

            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.costVariance')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.standardCost')}><Money value={data.cost_variance.standard} /></Row>
                <Row label={t('manufacturing.actualCost')}><Money value={data.cost_variance.actual} /></Row>
                <Row label={t('manufacturing.variance')} strong>
                  <span style={{ color: data.cost_variance.variance > 0 ? 'var(--red)' : 'var(--green)' }}>
                    <Money value={data.cost_variance.variance} />
                    {data.cost_variance.variance_pct != null ? ` (${data.cost_variance.variance_pct}%)` : ''}
                  </span>
                </Row>
              </div>
            </div>

            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.timeEfficiency')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.plannedHours')}>{num(data.time_efficiency.planned_hours)}</Row>
                <Row label={t('manufacturing.actualHours')}>{num(data.time_efficiency.actual_hours)}</Row>
                <Row label={t('manufacturing.efficiency')} strong>{data.time_efficiency.efficiency_pct != null ? `${data.time_efficiency.efficiency_pct}%` : '—'}</Row>
              </div>
            </div>
          </div>

          {data.cost_variance.top.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header"><span className="card-title">{t('manufacturing.topVariance')}</span></div>
              <div className="table-wrap">
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr>
                    <th>{t('manufacturing.orderNumber')}</th><th>{t('manufacturing.product')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.standardCost')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.actualCost')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.variance')}</th>
                  </tr></thead>
                  <tbody>
                    {data.cost_variance.top.map(v => (
                      <tr key={v.order_number}>
                        <td className="text-mono">{v.order_number}</td>
                        <td>{v.product}</td>
                        <td style={{ textAlign: 'end' }}><Money value={v.standard_cost} /></td>
                        <td style={{ textAlign: 'end' }}><Money value={v.actual_cost} /></td>
                        <td style={{ textAlign: 'end', color: v.variance > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                          <Money value={v.variance} />{v.variance_pct != null ? ` (${v.variance_pct}%)` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.time_efficiency.by_resource.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header"><span className="card-title">{t('manufacturing.resourceCostBreakdown')}</span></div>
              <div className="table-wrap">
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr>
                    <th>{t('manufacturing.resourceName')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.hours')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.cost')}</th>
                  </tr></thead>
                  <tbody>
                    {data.time_efficiency.by_resource.map((r, i) => (
                      <tr key={i}>
                        <td>{r.resource}</td>
                        <td style={{ textAlign: 'end' }}>{num(r.hours)}</td>
                        <td style={{ textAlign: 'end' }}><Money value={r.cost} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Quality Control view ─────────────────────────────────────────────────────

export { AnalyticsView };
