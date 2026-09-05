import { useState, useCallback, useEffect, useMemo } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { usePermissions } from '../../hooks/usePermissions.js';
import { Modal, ConfirmModal, toast } from '../../components/shared';
import { getPlanningEvents, deletePlanningEvent } from '../../api/client';
import { toIso, addDays, isWeekend } from './constants';
import { EventForm } from './EventForm';

function CalendarView() {
  const { t, lang } = useLocale();
  const { user: currentUser } = usePermissions();
  const currentUserId = currentUser?.id ?? null;
  const dateLocale = lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en';
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  // Modal state — null = closed; { date } = create; { event } = edit
  const [modal, setModal] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  // Events fetched for the visible window — refetched when month changes
  // or after any create/update/delete.
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const firstDay   = new Date(year, month, 1);
  const lastDay    = new Date(year, month + 1, 0);
  const startPad   = firstDay.getDay();                                  // 0=Sun
  const totalCells = Math.ceil((startPad + lastDay.getDate()) / 7) * 7;
  // Pull a slightly wider window so events that overlap into the visible
  // padding rows still render (e.g. a multi-day event that starts in the
  // previous month and ends in this one).
  const winStart   = toIso(addDays(firstDay, -startPad));
  const winEnd     = toIso(addDays(lastDay,  totalCells - startPad - lastDay.getDate()));

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getPlanningEvents({ start: winStart, end: winEnd });
      setEvents(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast(e.message || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [winStart, winEnd, t]);

  useEffect(() => { reload(); }, [reload]);

  function prevMonth() { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); }
  function nextMonth() { if (month === 11) { setYear(y => y + 1); setMonth(0); }  else setMonth(m => m + 1); }
  function goToday()   { setYear(today.getFullYear()); setMonth(today.getMonth()); }

  // Events whose date range includes `d` (inclusive on both ends).
  function eventsForDay(d) {
    const iso = toIso(d);
    return events.filter(ev => {
      const s = ev.start_date;
      const e = ev.end_date || ev.start_date;
      return iso >= s && iso <= e;
    });
  }

  async function handleDelete(ev) {
    setConfirmDel(null);
    try {
      await deletePlanningEvent(ev.id);
      toast(t('planning.eventDeleted'));
      setModal(null);
      reload();
    } catch (e) { toast(e.message || t('common.error'), 'error'); }
  }

  const monthLabel = firstDay.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });
  const dayNames   = Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + i).toLocaleDateString(dateLocale, { weekday: 'short' }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('planning.calendarHint')}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-outline btn-sm" onClick={prevMonth} aria-label={t('common.previous')}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', minWidth: 160, textAlign: 'center' }}>
            {monthLabel}
          </span>
          <button className="btn btn-outline btn-sm" onClick={nextMonth} aria-label={t('common.next')}>›</button>
          <button className="btn btn-outline btn-sm" onClick={goToday}>{t('planning.today')}</button>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ date: toIso(today) })}>
            + {t('planning.newEvent')}
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="card" style={{
        padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        height: 'calc(100vh - 300px)', minHeight: 420, opacity: loading ? 0.65 : 1,
        transition: 'opacity .15s',
      }}>
        {/* Day-name header */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0,
        }}>
          {dayNames.map((d, i) => (
            <div key={i} style={{
              padding: '8px 0', textAlign: 'center',
              fontSize: 11, fontWeight: 700, letterSpacing: '.5px',
              color: 'var(--text-3)', textTransform: 'uppercase',
            }}>{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
          gridTemplateRows: `repeat(${Math.ceil(totalCells / 7)}, 1fr)`,
          flex: 1, overflow: 'hidden',
        }}>
          {Array.from({ length: totalCells }, (_, i) => {
            const dayNum  = i - startPad + 1;
            const valid   = dayNum >= 1 && dayNum <= lastDay.getDate();
            const d       = valid ? new Date(year, month, dayNum) : null;
            const isToday = d && d.toDateString() === today.toDateString();
            const isWknd  = d && isWeekend(d);
            const dayEvts = d ? eventsForDay(d) : [];

            return (
              <div
                key={i}
                onClick={valid ? () => setModal({ date: toIso(d) }) : undefined}
                style={{
                  padding: '6px 6px 4px', overflow: 'hidden', position: 'relative',
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  background: !valid
                    ? 'var(--bg)'
                    : isWknd
                      ? 'color-mix(in srgb, var(--border) 18%, var(--card))'
                      : 'var(--card)',
                  cursor: valid ? 'pointer' : 'default',
                  transition: 'background .15s',
                }}
                onMouseEnter={e => { if (valid) e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 6%, var(--card))'; }}
                onMouseLeave={e => {
                  if (!valid) return;
                  e.currentTarget.style.background = isWknd
                    ? 'color-mix(in srgb, var(--border) 18%, var(--card))'
                    : 'var(--card)';
                }}
              >
                {valid && (
                  <>
                    {/* Date number */}
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 4,
                    }}>
                      <div style={{
                        fontWeight: isToday ? 800 : 600, fontSize: 12,
                        color: isToday ? '#fff' : 'var(--text-2)',
                        background: isToday ? 'var(--accent)' : 'transparent',
                        borderRadius: isToday ? '50%' : 0,
                        width: isToday ? 22 : 'auto', height: isToday ? 22 : 'auto',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {dayNum}
                      </div>
                      {/* Quick-add button — only visible when there's space */}
                      {dayEvts.length === 0 && (
                        <span style={{
                          fontSize: 11, color: 'var(--text-3)', opacity: 0.6,
                          fontWeight: 600, transition: 'opacity .15s',
                        }}>+</span>
                      )}
                    </div>

                    {/* Event chips */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {dayEvts.slice(0, 3).map(ev => {
                        const color = ev.color || 'var(--info)';
                        const tm = !ev.all_day && ev.start_time ? ev.start_time + ' ' : '';
                        const attCount = Array.isArray(ev.attendees) ? ev.attendees.length : 0;
                        return (
                          <button key={ev.id}
                            type="button"
                            onClick={e2 => { e2.stopPropagation(); setModal({ event: ev }); }}
                            title={`${ev.title}${tm ? '  •  ' + tm : ''}${attCount ? '  •  ' + attCount + ' attendees' : ''}`}
                            style={{
                              all: 'unset',
                              fontSize: 10, fontWeight: 600, cursor: 'pointer',
                              background: color + '26',
                              color, borderLeft: `3px solid ${color}`,
                              borderRadius: '0 4px 4px 0',
                              padding: '2px 6px', whiteSpace: 'nowrap',
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              display: 'flex', alignItems: 'center', gap: 4,
                              maxWidth: '100%',
                            }}
                          >
                            {tm && <span style={{ opacity: 0.7, fontWeight: 500 }}>{tm}</span>}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                              {ev.title}
                            </span>
                            {attCount > 0 && (
                              <span style={{
                                fontSize: 9, fontWeight: 700, opacity: 0.85,
                                background: color + '55', padding: '0 5px',
                                borderRadius: 999, color,
                              }}>
                                👥{attCount}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {dayEvts.length > 3 && (
                        <div style={{ fontSize: 9, color: 'var(--text-3)', paddingLeft: 4, fontWeight: 600 }}>
                          {t('planning.moreCount', { n: dayEvts.length - 3 })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Event modal — create or edit */}
      {modal && (
        <Modal
          title={modal.event ? t('planning.editEvent') : t('planning.newEvent')}
          onClose={() => setModal(null)}
          size="md"
        >
          <EventForm
            initial={modal.event || null}
            defaultDate={modal.date}
            currentUserId={currentUserId}
            onSave={() => { setModal(null); reload(); }}
            onClose={() => setModal(null)}
            onDelete={ev => setConfirmDel(ev)}
          />
        </Modal>
      )}

      {/* Delete confirmation */}
      {confirmDel && (
        <ConfirmModal
          title={t('planning.deleteEvent')}
          message={`${t('planning.deleteEventConfirm')} "${confirmDel.title}"?`}
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={() => handleDelete(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// ─── PROJECTS PANEL ───────────────────────────────────────────────────────────


export { CalendarView };
