import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getInventoryByWarehouseReport } from '../../api/client';
import { exportReportPDF } from '../../utils/exportUtils.js';

function WarehouseValuationReport({ t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getInventoryByWarehouseReport()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)         return <LoadingSpinner />;
  if (error)           return <ErrorAlert message={error} />;
  if (!data)           return null;

  const { warehouses = [], totals = {}, top_skus = [] } = data;
  const TYPE_COLOR = {
    Main:'var(--blue)', Branch:'var(--accent)', Production:'var(--purple)',
    Damaged:'var(--red)', Transit:'var(--yellow)', Returns:'var(--text-3)',
  };
  // Map backend type → localized label. The DB stores canonical English type
  // codes ("Main", "Branch", …) — the UI renders the operator's language.
  const TYPE_LABEL = {
    Main:       t('reports.whTypeMain'),
    Branch:     t('reports.whTypeBranch'),
    Production: t('reports.whTypeProduction'),
    Damaged:    t('reports.whTypeDamaged'),
    Transit:    t('reports.whTypeTransit'),
    Returns:    t('reports.whTypeReturns'),
  };

  // Excel export of the same data the user is looking at — header labels follow
  // the active language so an AR operator gets an Arabic-headed workbook.
  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.json_to_sheet(
      warehouses.map(w => ({
        [t('reports.whCode')]:      w.code,
        [t('reports.whWarehouse')]: w.name,
        [t('reports.whType')]:      TYPE_LABEL[w.type] || w.type,
        [t('reports.whSkus')]:      w.sku_count,
        [t('reports.whQuantity')]:  w.qty_total,
        [t('reports.whValueUsd')]:  w.value,
      }))
    );
    XLSX.utils.book_append_sheet(wb, sheet1, t('reports.whValuation'));
    const sheet2 = XLSX.utils.json_to_sheet(
      top_skus.map(s => ({
        [t('reports.whItem')]:            s.name,
        [t('reports.whCategory')]:        s.category || '',
        [t('reports.whQuantity')]:        s.qty_total,
        [t('reports.whUnitCost')]:        s.unit_cost,
        [t('reports.whValueUsd')]:        s.value,
        [t('reports.whPrimaryLocation')]: s.top_warehouse_code || '',
      }))
    );
    XLSX.utils.book_append_sheet(wb, sheet2, t('reports.whTopTitle'));
    XLSX.writeFile(wb, `Inventory-by-Warehouse-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // PDF of the valuation table. The workbook above carries two sheets, which
  // a PDF cannot; this prints the one that gets circulated.
  function exportPdf() {
    exportReportPDF({
      title:    t('reports.whTitle'),
      subtitle: t('reports.whSubtitle'),
      filename: `Inventory-by-Warehouse-${new Date().toISOString().slice(0, 10)}.pdf`,
      columns: [
        { label: t('reports.whCode'),      value: w => w.code, align: 'left' },
        { label: t('reports.whWarehouse'), value: w => w.name, align: 'left' },
        { label: t('reports.whType'),      value: w => TYPE_LABEL[w.type] || w.type, align: 'left' },
        { label: t('reports.whSkus'),      value: w => w.sku_count, align: 'right' },
        { label: t('reports.whQuantity'),  value: w => w.qty_total, align: 'right' },
        { label: t('reports.whValueUsd'),  value: w => w.value, align: 'right' },
      ],
      rows: warehouses,
      totals: { label: t('reports.whTotalGl'),
                columns: [null, null, null, totals.sku_count,
                          totals.qty_total, totals.value] },
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t('reports.whTitle')}</div>
            <div className="card-subtitle">{t('reports.whSubtitle')}</div>
          </div>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button className="btn btn-sm btn-outline" onClick={exportXlsx}>{t('reports.whExport')}</button>
            <button className="btn btn-sm btn-outline" onClick={exportPdf}
                    disabled={!warehouses.length}>{t('reports.exportPDF')}</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reports.whCode')}</th><th>{t('reports.whWarehouse')}</th><th>{t('reports.whType')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whSkus')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whQuantity')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whValueUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map(w => (
                <tr key={w.id}>
                  <td className="td-mono">{w.code}</td>
                  <td className="td-primary">
                    {w.name}
                    {w.is_default ? <span className="badge badge-blue" style={{ marginInlineStart: 8 }}>{t('reports.whDefault')}</span> : null}
                  </td>
                  <td>
                    <span className="badge" style={{
                      background: (TYPE_COLOR[w.type] || 'var(--text-3)') + '20',
                      color: TYPE_COLOR[w.type] || 'var(--text-3)',
                      border: `1px solid ${(TYPE_COLOR[w.type] || 'var(--text-3)')}40`,
                    }}>{TYPE_LABEL[w.type] || w.type}</span>
                  </td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{w.sku_count}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(w.qty_total).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }} className="td-primary">{fmt(w.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td colSpan={3} style={{ textAlign: 'right' }}>{t('reports.whTotalGl')}</td>
                <td style={{ textAlign: 'right' }} className="td-mono">{totals.sku_count}</td>
                <td style={{ textAlign: 'right' }} className="td-mono">{Number(totals.qty_total).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="td-primary">{fmt(totals.value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{t('reports.whTopTitle')}</div>
            <div className="card-subtitle">{t('reports.whTopSubtitle')}</div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('reports.whItem')}</th>
                <th>{t('reports.whCategory')}</th>
                <th>{t('reports.whPrimaryLocation')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whQuantity')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whUnitCost')}</th>
                <th style={{ textAlign: 'right' }}>{t('reports.whValueUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {top_skus.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 28 }}>{t('reports.whNoStock')}</td></tr>
              ) : top_skus.map(s => (
                <tr key={s.id}>
                  <td className="td-primary">{s.name}</td>
                  <td>{s.category || '—'}</td>
                  <td className="td-mono">{s.top_warehouse_code || '—'}</td>
                  <td style={{ textAlign: 'right' }} className="td-mono">{Number(s.qty_total).toLocaleString()} {s.unit || ''}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.unit_cost)}</td>
                  <td style={{ textAlign: 'right' }} className="td-primary">{fmt(s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



export { WarehouseValuationReport };
