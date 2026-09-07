import { useState, useCallback, useEffect } from 'react';
import { LoadingSpinner, EmptyState, ExportButton, toast, NumberInput } from '../../components/shared';
import { getAttendance, saveAttendanceBulk, getAttendanceSummary,
         deriveAttendance } from '../../api/client';
import SearchSelect from '../../components/SearchSelect.jsx';

const ATT_STATUSES = ['Present', 'Absent', 'Late', 'Half-day', 'Leave'];

/** 'HH:MM:SS' as 'HH:MM'. Seconds are noise on a screen about working days. */
const hhmm = (v) => (v ? String(v).slice(0, 5) : '');
const ATT_LABEL_KEY = {
  'Present': 'hr.attPresent', 'Absent': 'hr.attAbsent', 'Late': 'hr.attLate',
  'Half-day': 'hr.attHalfday', 'Leave': 'hr.attLeave',
};

function AttendanceTab({ t, canEdit }) {
  const [view, setView]       = useState('day');     // 'day' | 'month'
  const [date, setDate]       = useState(() => new Date().toISOString().slice(0, 10));
  const [month, setMonth]     = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows]       = useState(null);
  const [summary, setSummary] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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

  async function refreshFromClock() {
    setRefreshing(true);
    try {
      const r = await deriveAttendance({ start: date, end: date });
      // `enabled: false` means the tenant is still collecting punches without
      // letting them become attendance. Saying so is more use than a silent
      // no-op that looks like a broken button.
      toast(r.enabled ? t('hr.attRefreshed', { n: r.written || 0 })
                      : t('timeclock.collectingOnly'));
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setRefreshing(false); }
  }

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
        Status: r.status || '', Hours: r.hours ?? '',
        In: hhmm(r.first_in), Out: hhmm(r.last_out),
        'From the clock': r.source === 'device' ? 'yes' : '',
        Notes: r.note || '',
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
            <button className="btn btn-secondary btn-sm" onClick={refreshFromClock}
              disabled={refreshing}>
              {refreshing ? t('common.saving') : t('hr.attRefresh')}
            </button>
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
        <>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('hr.colEmployee')}</th>
              <th>{t('hr.attJobTitle')}</th>
              <th>{t('hr.attIn')}</th>
              <th>{t('hr.attOut')}</th>
              <th>{t('common.status')}</th>
              <th>{t('hr.attHours')}</th>
              <th>{t('common.notes')}</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.employee_id}>
                  <td className="td-primary">
                    {r.full_name}
                    {/* Where this row came from. A day the clock owns looks
                        different from a day somebody typed, because editing one
                        takes it off the clock and that has to be visible. */}
                    {r.source === 'device' && (
                      <span className="badge badge-accent"
                            style={{ marginInlineStart: 6, fontSize: 10 }}>
                        {t('hr.attFromClock')}
                      </span>
                    )}
                    {!!r.needs_review && (
                      <span className="badge badge-yellow"
                            title={r.note || ''}
                            style={{ marginInlineStart: 6, fontSize: 10 }}>
                        {t('hr.attNeedsReview')}
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 13 }}>{r.job_title || '—'}</td>
                  <td className="text-mono" style={{ fontSize: 13 }}>{hhmm(r.first_in) || '—'}</td>
                  <td className="text-mono" style={{ fontSize: 13 }}>{hhmm(r.last_out) || '—'}</td>
                  <td>
                    <SearchSelect
                      className="form-control"
                      style={{ minWidth: 130 }}
                      disabled={!canEdit}
                      value={r.status}
                      onChange={v => setRow(r.employee_id, 'status', v)}
                      placeholder={t('hr.attNotMarked')}
                      options={(ATT_STATUSES).map(s => ({ value: s, label: t(ATT_LABEL_KEY[s]) }))} />
                  </td>
                  <td>
                    <NumberInput className="form-control" style={{ width: 80 }} min="0" step="0.5"
                      value={r.hours ?? ''} disabled={!canEdit}
                      onChange={e => setRow(r.employee_id, 'hours', e.target.value)} />
                    {r.device_hours != null
                      && Number(r.device_hours) !== Number(r.hours ?? NaN) && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                        {t('hr.attClockSays', { h: r.device_hours })}
                      </div>
                    )}
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
        <div style={{ padding: '8px 18px', fontSize: 12, color: 'var(--text-3)' }}>
          {t('hr.attEditHint')}
        </div>
        </>
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
