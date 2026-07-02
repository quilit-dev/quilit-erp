import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, toast } from '../../components/shared';
import { getQCInspections } from '../../api/client';
import { num } from './ui';
import { QCResolveModal } from './QCResolveModal';

function QCView({ canEdit, bump }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('Pending');
  const [resolveId, setResolveId] = useState(null);

  const load = useCallback(() => {
    getQCInspections(filter ? { status: filter } : {}).then(setRows).catch(e => toast(e.message, 'red'));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const STATUSES = ['Pending', 'Passed', 'Partial', 'Failed', ''];
  if (!rows) return <LoadingSpinner />;
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('manufacturing.tabQC')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {STATUSES.map(s => (
            <button key={s || 'all'} className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(s)}>{s ? t('manufacturing.qcStatus_' + s) : t('common.all')}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('manufacturing.noInspections')}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('manufacturing.order')}</th><th>{t('manufacturing.outputProduct')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.qcQuantity')}</th>
              <th>{t('common.status')}</th><th>{t('common.date')}</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(q => (
                <tr key={q.id}>
                  <td className="text-mono">{q.order_number}</td>
                  <td className="td-primary">{q.output_name}</td>
                  <td style={{ textAlign: 'end' }}>{num(q.quantity)}
                    {q.status !== 'Pending' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}> ({num(q.passed_qty)}✓ / {num(q.rejected_qty)}✗)</span>}</td>
                  <td><span className={`badge badge-${q.status === 'Passed' ? 'green' : q.status === 'Failed' ? 'red' : q.status === 'Partial' ? 'yellow' : 'gray'}`}>{t('manufacturing.qcStatus_' + q.status)}</span></td>
                  <td>{fmtDate(q.created_at)}</td>
                  <td style={{ textAlign: 'end' }}>
                    {q.status === 'Pending' && canEdit
                      ? <button className="btn btn-sm btn-primary" onClick={() => setResolveId(q.id)}>{t('manufacturing.inspect')}</button>
                      : <button className="btn btn-sm btn-secondary" onClick={() => setResolveId(q.id)}>{t('common.view') || 'View'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resolveId && (
        <QCResolveModal qcId={resolveId} canEdit={canEdit}
          onClose={() => setResolveId(null)}
          onDone={() => { setResolveId(null); load(); bump(); }} />
      )}
    </div>
  );
}


export { QCView };
