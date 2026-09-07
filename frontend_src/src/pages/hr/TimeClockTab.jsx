/**
 * The fingerprint clock: the terminals, the fingers they report, and the
 * working day everything is measured against.
 *
 * Three panels, in the order somebody actually needs them:
 *
 *   1. **Devices.** Register a terminal, get its token, see when it was last
 *      heard from. The token is shown ONCE, formatted as the config block the
 *      site agent needs, because the server keeps only a hash of it.
 *
 *   2. **Unclaimed fingers.** Enrolment numbers the terminal has reported that
 *      nobody has attached to an employee yet. This is the panel that stops the
 *      feature failing silently: a finger enrolled on the device but never
 *      claimed here collects punches against nobody, and the first anyone
 *      notices is a month with no hours in it.
 *
 *   3. **Working day.** Start, finish, grace before Late, and which days count.
 *      Optional --- with no schedule at all the system assumes 08:00-17:00,
 *      Monday to Friday, rather than refusing to work.
 *
 * The staleness warning at the top is the most valuable thing on this screen. A
 * time clock that quietly stops is worse than one that never worked, because
 * payroll gets built on the gap.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  getTimeDevices, createTimeDevice, rotateTimeDevice, revokeTimeDevice,
  getDeviceUsers, setDeviceUser, getWorkSchedules, createWorkSchedule,
  updateWorkSchedule, archiveWorkSchedule,
} from '../../api/client';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Modal, LoadingSpinner, EmptyState, NumberInput, toast }
  from '../../components/shared';
import SearchSelect from '../../components/SearchSelect.jsx';

const STALE_HOURS = 24;

/** Hours since an ISO-ish timestamp, or null when it has never been seen. */
export function hoursSince(stamp, now = new Date()) {
  if (!stamp) return null;
  const t = Date.parse(String(stamp).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3600000;
}

/** A device is worth warning about when it is live but has gone quiet. */
export function isStale(device, now = new Date()) {
  if (device.revoked_at) return false;
  const h = hoursSince(device.last_seen_at, now);
  return h === null || h > STALE_HOURS;
}

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function fmtWhen(v, t) {
  if (!v) return t('timeclock.never');
  return String(v).slice(0, 16).replace('T', ' ');
}

export default function TimeClockTab({ t, canEdit, employees = [] }) {
  // Settings come from the app-wide context, not a fetch of their own: this is
  // one read-only flag and the provider already has it.
  const { settings } = useSettings();
  const source = (settings && settings.attendance_source) || 'manual';
  const [devices, setDevices]   = useState([]);
  const [users, setUsers]       = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [adding, setAdding]     = useState(false);
  const [issued, setIssued]     = useState(null);   // {name, token, ...}
  const [editing, setEditing]   = useState(null);   // a schedule, or 'new'

  const load = useCallback(async () => {
    try {
      const [d, u, sched] = await Promise.all([
        getTimeDevices(), getDeviceUsers(), getWorkSchedules(),
      ]);
      setDevices(d || []);
      setUsers(u || []);
      setSchedules(sched || []);
    } catch (e) {
      toast(e.message || 'Failed to load', 'red');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingSpinner />;

  const unclaimed = users.filter(u => !u.employee_id);
  const stale = devices.filter(d => isStale(d));
  const live = devices.filter(d => !d.revoked_at);

  async function addDevice(name) {
    try {
      const created = await createTimeDevice({ name });
      setIssued(created);            // the only moment the token exists here
      setAdding(false);
      load();
    } catch (e) { toast(e.message || 'Failed', 'red'); }
  }

  async function rotate(d) {
    try {
      setIssued(await rotateTimeDevice(d.id));
      load();
    } catch (e) { toast(e.message || 'Failed', 'red'); }
  }

  async function revoke(d) {
    try {
      await revokeTimeDevice(d.id);
      toast(t('timeclock.revoked'));
      load();
    } catch (e) { toast(e.message || 'Failed', 'red'); }
  }

  async function claim(mapping, employeeId) {
    try {
      const r = await setDeviceUser(mapping.id, { employee_id: employeeId });
      toast(t('timeclock.claimed', { n: r.punches_claimed || 0 }));
      load();
    } catch (e) { toast(e.message || 'Failed', 'red'); }
  }

  return (
    <div>
      {/* Silence is the dangerous failure, so it is said first and plainly. */}
      {stale.length > 0 && (
        <div role="status" className="card" style={{
          marginBottom: 14, padding: '10px 14px', fontSize: 13,
          background: 'var(--caution-tint)',
          border: '1px solid var(--caution)', color: 'var(--caution-ink)',
        }}>
          <strong>{t('timeclock.staleTitle', { n: stale.length })}</strong>{' '}
          {t('timeclock.staleBody')}
        </div>
      )}

      {source !== 'device' && live.length > 0 && (
        <div role="status" className="card" style={{
          marginBottom: 14, padding: '10px 14px', fontSize: 13,
          color: 'var(--text-2)',
        }}>
          {t('timeclock.collectingOnly')}
        </div>
      )}

      {/* ── devices ─────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header" style={{ display: 'flex',
          justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h3 className="card-title">{t('timeclock.devices')}</h3>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              {t('timeclock.addDevice')}
            </button>
          )}
        </div>
        {devices.length === 0 ? (
          <EmptyState message={t('timeclock.noDevices')} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>{t('common.name')}</th>
                <th>{t('timeclock.token')}</th>
                <th>{t('timeclock.lastSeen')}</th>
                <th style={{ textAlign: 'right' }}>{t('timeclock.punches')}</th>
                <th />
              </tr></thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} style={{ opacity: d.revoked_at ? 0.5 : 1 }}>
                    <td className="td-primary">
                      {d.name}
                      {d.revoked_at && (
                        <span className="badge badge-red"
                              style={{ marginInlineStart: 8 }}>
                          {t('timeclock.revokedBadge')}
                        </span>
                      )}
                    </td>
                    <td className="text-mono" style={{ color: 'var(--text-3)' }}>
                      {d.token_prefix ? `${d.token_prefix}…` : '—'}
                    </td>
                    <td style={{ color: isStale(d) ? 'var(--red)' : 'var(--text-2)' }}>
                      {fmtWhen(d.last_seen_at, t)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{d.punch_count}</td>
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                      {canEdit && !d.revoked_at && (
                        <>
                          <button className="btn btn-outline btn-sm"
                                  onClick={() => rotate(d)}>
                            {t('timeclock.rotate')}
                          </button>
                          <button className="btn btn-outline btn-sm"
                                  style={{ marginInlineStart: 6 }}
                                  onClick={() => revoke(d)}>
                            {t('timeclock.revoke')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── unclaimed fingers ───────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3 className="card-title">
            {t('timeclock.unclaimed')}
            {unclaimed.length > 0 && (
              <span className="badge badge-yellow" style={{ marginInlineStart: 8 }}>
                {unclaimed.length}
              </span>
            )}
          </h3>
        </div>
        {users.length === 0 ? (
          <EmptyState message={t('timeclock.noFingers')} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>{t('timeclock.device')}</th>
                <th>{t('timeclock.enrolmentNo')}</th>
                <th style={{ textAlign: 'right' }}>{t('timeclock.punches')}</th>
                <th style={{ minWidth: 220 }}>{t('timeclock.employee')}</th>
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ color: 'var(--text-2)' }}>{u.device}</td>
                    <td className="td-primary">
                      <span className="text-mono">{u.device_user_id}</span>
                      {/* The name typed into the terminal. Not authoritative --
                          the ERP's own employee is what pay depends on -- but
                          it is what turns "who is finger 6?" into an answer. */}
                      {u.device_name && (
                        <span style={{ marginInlineStart: 8, color: 'var(--text-2)' }}>
                          {u.device_name}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{u.punch_count}</td>
                    <td>
                      {canEdit ? (
                        <SearchSelect
                          value={u.employee_id ?? ''}
                          options={employees.map(e => (
                            { value: e.id, label: e.full_name }))}
                          placeholder={t('timeclock.pickEmployee')}
                          allowBlank
                          onChange={v => claim(u, v ? Number(v) : null)}
                        />
                      ) : (u.employee_name || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── the working day ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex',
          justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h3 className="card-title">{t('timeclock.schedules')}</h3>
          {canEdit && (
            <button className="btn btn-outline" onClick={() => setEditing('new')}>
              {t('timeclock.addSchedule')}
            </button>
          )}
        </div>
        {schedules.length === 0 ? (
          <EmptyState message={t('timeclock.noSchedules')} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>{t('common.name')}</th>
                <th>{t('timeclock.hours')}</th>
                <th>{t('timeclock.grace')}</th>
                <th>{t('timeclock.workdays')}</th>
                <th />
              </tr></thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id}>
                    <td className="td-primary">
                      {s.name}
                      {!!s.is_default && (
                        <span className="badge badge-accent"
                              style={{ marginInlineStart: 8 }}>
                          {t('timeclock.default')}
                        </span>
                      )}
                    </td>
                    <td>{s.start_time}–{s.end_time}
                      {!!s.crosses_midnight && (
                        <span style={{ color: 'var(--text-3)', marginInlineStart: 6 }}>
                          {t('timeclock.overnight')}
                        </span>
                      )}
                    </td>
                    <td>{s.grace_minutes} {t('timeclock.minutes')}</td>
                    <td style={{ color: 'var(--text-2)' }}>
                      {String(s.workdays || '').split(',').filter(Boolean)
                        .map(n => t(`timeclock.${DAY_KEYS[Number(n) - 1]}`)).join(' ')}
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {canEdit && (
                        <button className="btn btn-outline btn-sm"
                                onClick={() => setEditing(s)}>
                          {t('common.edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: '10px 18px', fontSize: 12, color: 'var(--text-3)' }}>
          {t('timeclock.scheduleHint')}
        </div>
      </div>

      {adding && (
        <AddDeviceModal t={t} onClose={() => setAdding(false)} onSave={addDevice} />
      )}
      {issued && (
        <TokenModal t={t} device={issued} onClose={() => setIssued(null)} />
      )}
      {editing && (
        <ScheduleModal
          t={t} schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onArchive={async (id) => {
            try { await archiveWorkSchedule(id); setEditing(null); load(); }
            catch (e) { toast(e.message || 'Failed', 'red'); }
          }}
        />
      )}
    </div>
  );
}


function AddDeviceModal({ t, onClose, onSave }) {
  const [name, setName] = useState('');
  return (
    <Modal title={t('timeclock.addDevice')} onClose={onClose}>
      <div className="modal-body">
        <label className="form-label">{t('common.name')}</label>
        <input className="form-input" value={name} autoFocus
               placeholder={t('timeclock.namePlaceholder')}
               onChange={e => setName(e.target.value)} />
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
          {t('timeclock.addHint')}
        </p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={!name.trim()}
                onClick={() => onSave(name.trim())}>
          {t('common.save')}
        </button>
      </div>
    </Modal>
  );
}


/**
 * The token, shown once and never again.
 *
 * The server stores only a SHA-256 of it, so there is no screen anywhere that
 * can show it a second time --- which is exactly why this one hands over the
 * finished config block rather than a bare string to be transcribed.
 */
function TokenModal({ t, device, onClose }) {
  const block = [
    '[timeclock]',
    `erp_url = ${window.location.origin}`,
    `device_token = ${device.token}`,
    '',
    '; device_ip and tenant_slug still need filling in --- see config.example.ini',
  ].join('\n');

  return (
    <Modal title={t('timeclock.tokenTitle')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <div role="status" style={{
          padding: '10px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: 'var(--caution-tint)',
          border: '1px solid var(--caution)', color: 'var(--caution-ink)',
        }}>
          <strong>{t('timeclock.tokenOnce')}</strong> {t('timeclock.tokenOnceBody')}
        </div>
        <pre className="text-mono" style={{
          padding: 12, borderRadius: 6, fontSize: 12, overflowX: 'auto',
          background: 'var(--bg-2, var(--bg))', border: '1px solid var(--border)',
        }}>{block}</pre>
        <button className="btn btn-outline" onClick={() => {
          try { navigator.clipboard.writeText(block); } catch { /* no clipboard */ }
        }}>{t('timeclock.copy')}</button>
      </div>
      <div className="modal-footer">
        <button className="btn btn-primary" onClick={onClose}>
          {t('timeclock.savedIt')}
        </button>
      </div>
    </Modal>
  );
}


function ScheduleModal({ t, schedule, onClose, onSaved, onArchive }) {
  const [f, setF] = useState(() => ({
    name: schedule?.name || '',
    is_default: !!schedule?.is_default,
    start_time: schedule?.start_time || '08:00',
    end_time: schedule?.end_time || '17:00',
    break_minutes: schedule?.break_minutes ?? 0,
    grace_minutes: schedule?.grace_minutes ?? 15,
    min_hours_full_day: schedule?.min_hours_full_day ?? 6,
    workdays: schedule?.workdays || '1,2,3,4,5',
    crosses_midnight: !!schedule?.crosses_midnight,
  }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const days = new Set(String(f.workdays).split(',').filter(Boolean).map(Number));

  function toggleDay(n) {
    const next = new Set(days);
    if (next.has(n)) next.delete(n); else next.add(n);
    set('workdays', [...next].sort((a, b) => a - b).join(','));
  }

  async function save() {
    try {
      const body = { ...f, break_minutes: Number(f.break_minutes) || 0,
                     grace_minutes: Number(f.grace_minutes) || 0,
                     min_hours_full_day: Number(f.min_hours_full_day) || 0 };
      if (schedule) await updateWorkSchedule(schedule.id, body);
      else await createWorkSchedule(body);
      onSaved();
    } catch (e) { toast(e.message || 'Failed', 'red'); }
  }

  return (
    <Modal title={t('timeclock.scheduleTitle')} onClose={onClose}>
      <div className="modal-body">
        <label className="form-label">{t('common.name')}</label>
        <input className="form-input" value={f.name} autoFocus
               onChange={e => set('name', e.target.value)} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
                      marginTop: 10 }}>
          <div>
            <label className="form-label">{t('timeclock.startTime')}</label>
            <input className="form-input" type="time" value={f.start_time}
                   onChange={e => set('start_time', e.target.value)} />
          </div>
          <div>
            <label className="form-label">{t('timeclock.endTime')}</label>
            <input className="form-input" type="time" value={f.end_time}
                   onChange={e => set('end_time', e.target.value)} />
          </div>
          <div>
            <label className="form-label">{t('timeclock.graceLabel')}</label>
            <NumberInput value={f.grace_minutes} min="0"
                         onChange={e => set('grace_minutes', e.target.value)} />
          </div>
          <div>
            <label className="form-label">{t('timeclock.halfDayLabel')}</label>
            <NumberInput value={f.min_hours_full_day} min="0" step="0.5"
                         onChange={e => set('min_hours_full_day', e.target.value)} />
          </div>
          <div>
            <label className="form-label">{t('timeclock.breakLabel')}</label>
            <NumberInput value={f.break_minutes} min="0"
                         onChange={e => set('break_minutes', e.target.value)} />
          </div>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
          {t('timeclock.breakHint')}
        </p>

        <label className="form-label" style={{ marginTop: 12 }}>
          {t('timeclock.workdays')}
        </label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DAY_KEYS.map((k, i) => (
            <button key={k} type="button"
                    className={`btn btn-sm ${days.has(i + 1) ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => toggleDay(i + 1)}>
              {t(`timeclock.${k}`)}
            </button>
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                        marginTop: 12, fontSize: 13 }}>
          <input type="checkbox" checked={f.crosses_midnight}
                 onChange={e => set('crosses_midnight', e.target.checked)} />
          {t('timeclock.overnightLabel')}
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                        marginTop: 8, fontSize: 13 }}>
          <input type="checkbox" checked={f.is_default}
                 onChange={e => set('is_default', e.target.checked)} />
          {t('timeclock.defaultLabel')}
        </label>
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <span>
          {schedule && (
            <button className="btn btn-outline"
                    onClick={() => onArchive(schedule.id)}>
              {t('common.delete')}
            </button>
          )}
        </span>
        <span>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!f.name.trim()}
                  style={{ marginInlineStart: 6 }} onClick={save}>
            {t('common.save')}
          </button>
        </span>
      </div>
    </Modal>
  );
}
