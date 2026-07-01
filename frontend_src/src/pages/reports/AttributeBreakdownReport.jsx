import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getInventoryByAttributeReport } from '../../api/client';
import { StatCard } from './charts';

function AttributeBreakdownReport({ t }) {
  const [attribute, setAttribute] = useState(null);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getInventoryByAttributeReport(attribute)
      .then(d => { setData(d); if (attribute == null) setAttribute(d.selected); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [attribute]);

  if (loading && !data) return <LoadingSpinner />;
  if (error)            return <ErrorAlert message={error} />;
  if (!data)            return null;

  const { attributes = [], rows = [], totals = {} } = data;

  if (attributes.length === 0) {
    return (
      <div className="card"><div className="card-body" style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)' }}>
        {t('reports.noAttributes') || 'No product attributes yet. Create a product with variants (e.g. Size, Color) to use this report.'}
      </div></div>
    );
  }

  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows.map(r => ({
      [data.selected]:            r.attr_value,
      [t('reports.whSkus')]:      r.sku_count,
      [t('reports.whQuantity')]:  r.qty_total,
      [t('reports.whValueUsd')]:  r.value_usd,
    })));
    XLSX.utils.book_append_sheet(wb, sheet, 'By Attribute');
    XLSX.writeFile(wb, `Inventory-by-${data.selected}-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t('reports.byAttribute') || 'Inventory by Attribute'}</div>
            <div className="card-subtitle">{t('reports.byAttributeSub') || 'Stock units and value across variants.'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="form-control" style={{ height: 34, fontSize: 13 }}
              value={attribute || ''} onChange={e => setAttribute(e.target.value)}>
              {attributes.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <button className="btn btn-sm btn-outline" onClick={exportXlsx}>{t('reports.whExport') || 'Export'}</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{data.selected}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whSkus') || 'SKUs'}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whQuantity') || 'Quantity'}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whValueUsd') || 'Value'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>{t('reports.whNoStock') || 'No stock'}</td></tr>
              ) : rows.map(r => (
                <tr key={r.attr_value}>
                  <td className="td-primary">{r.attr_value || '—'}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{r.sku_count}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(r.qty_total).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }} className="td-primary">{fmt(r.value_usd)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>{t('common.total') || 'Total'}</td>
                  <td />
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(totals.qty_total || 0).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(totals.value_usd)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

export { AttributeBreakdownReport };
