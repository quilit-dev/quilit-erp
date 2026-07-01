import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportVAT } from '../../api/client';
import { StatCard, ExportButtons, fmtMonth } from './charts';

function VatReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportVAT(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  if (!data.vat_enabled) {
    return (
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-3)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            {t('reports.vatDisabledTitle')}
          </div>
          <div style={{ fontSize: 13 }}>{t('reports.vatDisabledHint')}</div>
        </div>
      </div>
    );
  }

  const payable = data.net_vat >= 0;

  const vatCols = [
    { label: 'Month',      value: r => r.month,      align: 'left'  },
    { label: 'Output VAT', value: r => r.output_vat, align: 'right' },
    { label: 'Input VAT',  value: r => r.input_vat,  align: 'right' },
    { label: 'Net VAT',    value: r => r.net_vat,    align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <StatCard label={t('reports.vatOutput')} value={fmt(data.output.vat)} color="green"
          sub={`${t('reports.vatOnSales')} ${fmt(data.output.gross)}`} />
        <StatCard label={t('reports.vatInput')} value={fmt(data.input.vat)} color="red"
          sub={`${t('reports.vatOnPurchases')} ${fmt(data.input.gross)}`} />
        <StatCard label={payable ? t('reports.vatNetPayable') : t('reports.vatNetReclaim')}
          value={fmt(Math.abs(data.net_vat))} color={payable ? 'red' : 'green'}
          sub={`${t('reports.vatRate')}: ${data.rate}%`} />
      </div>

      <div className="alert alert-blue" style={{ marginBottom: 16, fontSize: 12.5 }}>
        {t('reports.vatEstimateNote')}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.vatMonthly')}</span>
          {data.monthly.length > 0 && (
            <ExportButtons
              rows={data.monthly} columns={vatCols}
              baseName="vat_report" pdfTitle={t('reports.vat') || 'VAT Report'} t={t} />
          )}
        </div>
        {data.monthly.length === 0
          ? <div className="card-body" style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noData')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.month')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatOutput')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatInput')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.vatNet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.monthly.map(row => (
                    <tr key={row.month}>
                      <td className="td-primary">{fmtMonth(row.month)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(row.output_vat)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(row.input_vat)}</td>
                      <td style={{ textAlign: 'right', color: row.net_vat >= 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{fmt(row.net_vat)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                    <td style={{ padding: '10px 14px' }}>{t('reports.total')}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--green)' }}>{fmt(data.output.vat)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--red)' }}>{fmt(data.input.vat)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: payable ? 'var(--red)' : 'var(--green)' }}>{fmt(data.net_vat)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Project Profitability Panel ────────────────────────────────────────────

export { VatReport };
