import { useState, useCallback, useEffect } from 'react';
import { LoadingSpinner, EmptyState, ExportButton, toast, NumberInput } from '../../components/shared';
import { getAttendance, saveAttendanceBulk, getAttendanceSummary } from '../../api/client';

function AttendanceTab({ t, canEdit }) {
  const [view, setView]       = useState('day');     // 'day' | 'month'
  const [date, setDate]       = useState(() => new Date().toISOString().slice(0, 10));
  const [month, setMonth]     = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows]       = useState(null);
  const [summary, setSummary] = useState(null);
  const [saving, setSaving]   = useState(false);

  const load = useCallback(() => {
    setRows(null);
    getAttendance(date)
      .then(d => setRows((d.rows || []).map(r => ({ ...r, status: r.status || '' }))))
      .catch(e => { toast(e.message, 'red'); setRows([]); });
  }, [date]);
  const loadMonth = useCallback(() => {
    setSummary(null);
    getAttendanceSummary(month)
      .then(d => setSummary(d.rows || []))
      .catch(e => { toast(e.message, 'red'); setSummary([]); });
  }, [month]);
  useEffect(() => { if (view === 'day') load(); else loadMonth(); }, [view, load, loadMonth]);

  const setRow = (id, field, val) =>
    setRows(rs => rs.map(r => (r.employee_id === id ? { ...r, [field]: val } : r)));
  const markAllPresent = () => setRows(rs => rs.map(r => ({ ...r, status: 'Present' })));

  async function save() {
    setSaving(true);
    try {
      const records = (rows || [])
        .filter(r => r.status)                       // only rows that have a mark
        .map(r => ({
          employee_id: r.employee_id, status: r.status,
          hours: (r.hours === '' || r.hours == null) ? null : Number(r.hours),
          note: r.note || null,
        }));
      const res = await saveAttendanceBulk({ date, records });
      toast(`${t('hr.attSaved')} (${res.saved})`);
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setSaving(false); }
  }

  // Excel export of whichever view is showing — month = per-employee counts,
  // day = the day's roster. Uses the app's shared ExportButton.
  const exportData = view === 'month'
    ? (summary || []).map(emp => {
        const c = emp.counts || {};
        const row = { Employee: emp.full_name };
        let total = 0;
        ATT_STATUSES.forEach(s => { row[s] = c[s] || 0; total += c[s] || 0; });
        row.Total = total;
        return row;
      })
    : (rows || []).map(r => ({
        Employee: r.full_name, 'Job title': r.job_title || '',
        Status: r.status || '', Hours: r.hours ?? '', Notes: r.note || '',
      }));
  const exportName = view === 'month' ? `Attendance-${month}` : `Attendance-${date}`;
  const hasData = view === 'month' ? !!(summary && summary.length) : !!(rows && rows.length);

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="card-title">{t('hr.tabAttendance')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={`btn btn-sm ${view === 'day' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView('day')}>{t('hr.attDay')}</button>
          <button className={`btn btn-sm ${view === 'month' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView('month')}>{t('hr.attMonth')}</button>
        </div>
        {view === 'day' ? (
          <input type="date" className="form-control" style={{ width: 160 }}
            value={date} onChange={e => setDate(e.target.value)} />
        ) : (
          <input type="month" className="form-control" style={{ width: 160 }}
            value={month} onChange={e => setMonth(e.target.value)} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {hasData && (
            <ExportButton data={exportData} filename={exportName} sheetName="Attendance" />
          )}
          {view === 'day' && canEdit && (
            <button className="btn btn-secondary btn-sm" onClick={markAllPresent}
              disabled={!rows || !rows.length}>✓ {t('hr.attMarkAllPresent')}</button>
          )}
          {view === 'day' && canEdit && (
            <button className="btn btn-primary btn-sm" onClick={save}
              disabled={saving || !rows || !rows.length}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
        </div>
      </div>
      {view === 'day' ? (
        !rows ? <LoadingSpinner /> :
        rows.length === 0 ? <EmptyState message={t('hr.noEmployees')} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('hr.colEmployee')}</th>
              <th>{t('hr.attJobTitle')}</th>
              <th>{t('common.status')}</th>
              <th>{t('hr.attHours')}</th>
              <th>{t('common.notes')}</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.employee_id}>
                  <td className="td-primary">{r.full_name}</td>
                  <td style={{ color: 'var(--text-3)', fontSize: 13 }}>{r.job_title || '—'}</td>
                  <td>
                    <select className="form-control" style={{ minWidth: 130 }} value={r.status}
                      disabled={!canEdit} onChange={e => setRow(r.employee_id, 'status', e.target.value)}>
                      <option value="">{t('hr.attNotMarked')}</option>
                      {ATT_STATUSES.map(s => <option key={s} value={s}>{t(ATT_LABEL_KEY[s])}</option>)}
                    </select>
                  </td>
                  <td>
                    <NumberInput className="form-control" style={{ width: 80 }} min="0" step="0.5"
                      value={r.hours ?? ''} disabled={!canEdit}
                      onChange={e => setRow(r.employee_id, 'hours', e.target.value)} />
                  </td>
                  <td>
                    <input className="form-control" value={r.note || ''} disabled={!canEdit}
                      onChange={e => setRow(r.employee_id, 'note', e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      ) : (
        !summary ? <LoadingSpinner /> :
        summary.length === 0 ? <EmptyState message={t('hr.noEmployees')} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>{t('hr.colEmployee')}</th>
                {ATT_STATUSES.map(s => (
                  <th key={s} style={{ textAlign: 'center' }}>{t(ATT_LABEL_KEY[s])}</th>
                ))}
                <th style={{ textAlign: 'center' }}>{t('hr.attTotalMarked')}</th>
              </tr></thead>
              <tbody>
                {summary.map(emp => {
                  const cnt = emp.counts || {};
                  const total = ATT_STATUSES.reduce((a, s) => a + (cnt[s] || 0), 0);
                  return (
                    <tr key={emp.employee_id}>
                      <td className="td-primary">{emp.full_name}</td>
                      {ATT_STATUSES.map(s => (
                        <td key={s} style={{ textAlign: 'center' }}>{cnt[s] || 0}</td>
                      ))}
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}


export { AttendanceTab };
