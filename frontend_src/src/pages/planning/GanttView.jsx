import { useState, useEffect, useRef, useMemo } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { EmptyState, toast } from '../../components/shared';
import { updateTaskDates } from '../../api/client';
import { LEFT_W, toDate, toIso, addDays, daysBetween, isWeekend } from './constants';

function GanttView({ tasks, projects, milestones, onRefresh }) {
  const { t, lang } = useLocale();
  const dateLocale = lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en';
  const [selProject, setSelProject] = useState('');
  const [viewMode, setViewMode] = useState('month'); // 'week' | 'month'
  const dragRef      = useRef(null);
  const rightGridRef = useRef(null);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [dayW, setDayW] = useState(DAY_W);

  useEffect(() => { setLocalTasks(tasks); }, [tasks]);

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  const [viewStart, setViewStart] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 3);
    return d;
  });

  const DAYS = viewMode === 'week' ? 7 : 30;
  const rangeStart = viewStart;
  const rangeEnd   = addDays(viewStart, DAYS - 1);
  const totalDays  = DAYS;

  // Measure the right panel so days always fill the full available width
  useEffect(() => {
    if (!rightGridRef.current) return;
    function measure() {
      const w = rightGridRef.current?.getBoundingClientRect().width;
      // Float (not floored) so the absolutely-positioned bars line up exactly
      // with the flex-filled day columns below.
      if (w && w > 0) setDayW(w / DAYS);
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rightGridRef.current);
    return () => ro.disconnect();
  }, [DAYS]);

  function goPrev()  { setViewStart(d => addDays(d, -DAYS)); }
  function goNext()  { setViewStart(d => addDays(d, DAYS)); }
  function goToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 3);
    setViewStart(d);
  }

  const navLabel = viewMode === 'week'
    ? `${rangeStart.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} – ${rangeEnd.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : rangeStart.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });

  const filtered = selProject
    ? localTasks.filter(tk => String(tk.project_id) === selProject)
    : localTasks;

  const visibleTasks = filtered.filter(tk => {
    if (!tk.start_date && !tk.end_date) return false;
    const s = toDate(tk.start_date) || toDate(tk.end_date);
    const e = toDate(tk.end_date)   || toDate(tk.start_date);
    return s <= rangeEnd && e >= rangeStart;
  });

  // Build month label groups
  const months = [];
  let cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    const ex = months.find(m => m.key === key);
    if (ex) { ex.days++; }
    else { months.push({ key, label: cursor.toLocaleDateString(dateLocale, { month: 'short', year: 'numeric' }), days: 1 }); }
    cursor = addDays(cursor, 1);
  }

  function startDrag(e, task, type) {
    if (e.button !== 0) return;
    e.preventDefault();
    const s = toDate(task.start_date);
    const en = toDate(task.end_date);
    // capture dayW at drag-start so resize doesn't break if window is resized mid-drag
    dragRef.current = { taskId: task.id, type, startX: e.clientX, origStart: s, origEnd: en, curStart: s, curEnd: en, dayW };

    function onMove(ev) {
      const dr = dragRef.current;
      if (!dr) return;
      const days = Math.round((ev.clientX - dr.startX) / dr.dayW);
      if (dr.type === 'move') {
        dr.curStart = addDays(dr.origStart, days);
        dr.curEnd   = addDays(dr.origEnd, days);
      } else if (dr.type === 'resize-left') {
        const ns = addDays(dr.origStart, days);
        if (ns < dr.origEnd) dr.curStart = ns;
      } else {
        const ne = addDays(dr.origEnd, days);
        if (ne > dr.origStart) dr.curEnd = ne;
      }
      setLocalTasks(prev => prev.map(tk =>
        tk.id === dr.taskId ? { ...tk, start_date: toIso(dr.curStart), end_date: toIso(dr.curEnd) } : tk
      ));
    }

    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const dr = dragRef.current;
      if (!dr) return;
      dragRef.current = null;
      try {
        await updateTaskDates(dr.taskId, { start_date: toIso(dr.curStart), end_date: toIso(dr.curEnd) });
      } catch {
        toast(t('planning.failedSaveDates'), 'error');
        onRefresh();
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const todayOffset = daysBetween(rangeStart, today);
  const MONTH_HDR_H = 36;
  const DAY_HDR_H   = viewMode === 'week' ? 52 : 28;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select className="form-control" style={{ width: 200 }}
          value={selProject} onChange={e => setSelProject(e.target.value)}>
          <option value="">{t('planning.allProjects')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <button className="btn btn-outline btn-sm" onClick={goPrev}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', minWidth: 200, textAlign: 'center' }}>{navLabel}</span>
          <button className="btn btn-outline btn-sm" onClick={goNext}>›</button>
          <button className="btn btn-outline btn-sm" onClick={goToday}>{t('planning.today')}</button>
        </div>

        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {(['week', 'month']).map(mode => (
            <button key={mode}
              className={viewMode === mode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
              style={{ borderRadius: 0, border: 'none', fontSize: 12 }}
              onClick={() => setViewMode(mode)}
            >
              {t('planning.' + mode)}
            </button>
          ))}
        </div>
      </div>

      {visibleTasks.length === 0 ? (
        <EmptyState message={t('planning.noTasksInRange')} />
      ) : (
        <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
          <div style={{ display: 'flex', userSelect: 'none' }}>

            {/* Left label column — fixed width, no scroll */}
            <div style={{ width: LEFT_W, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div style={{ height: MONTH_HDR_H, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', paddingLeft: 14, fontWeight: 700, fontSize: 12, color: 'var(--text-2)' }}>
                {t('planning.taskColumn')}
              </div>
              <div style={{ height: DAY_HDR_H, borderBottom: '2px solid var(--border)', background: 'var(--surface-2)' }} />
              {visibleTasks.map((task, i) => (
                <div key={task.id} style={{
                  height: ROW_H, display: 'flex', alignItems: 'center',
                  paddingLeft: 12, paddingRight: 8,
                  borderBottom: '1px solid var(--border)',
                  background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.project_color || '#4f8ef7', marginRight: 8, flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>{task.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.project_name}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Right grid — flex:1 so it always fills remaining width exactly */}
            <div ref={rightGridRef} style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
              {/* Month header row */}
              <div style={{ display: 'flex', height: MONTH_HDR_H, borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                {months.map(m => (
                  <div key={m.key} style={{
                    flex: `${m.days} 1 0`, minWidth: 0,
                    borderRight: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', paddingLeft: 10,
                    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
                  }}>
                    {m.label}
                  </div>
                ))}
              </div>

              {/* Day header row — taller in week view to show day names */}
              <div style={{ display: 'flex', height: DAY_HDR_H, borderBottom: '2px solid var(--border)', background: 'var(--surface-2)' }}>
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = addDays(rangeStart, i);
                  const wknd = isWeekend(d);
                  const isToday = daysBetween(today, d) === 0;
                  return (
                    <div key={i} style={{
                      flex: '1 1 0', minWidth: 0,
                      borderRight: '1px solid var(--border)',
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 2,
                      background: isToday
                        ? 'var(--accent-light)'
                        : wknd ? 'color-mix(in srgb, var(--border) 55%, transparent)' : 'transparent',
                    }}>
                      {viewMode === 'week' && (
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: isToday ? 'var(--accent)' : 'var(--text-3)' }}>
                          {d.toLocaleDateString('en', { weekday: 'short' })}
                        </span>
                      )}
                      <span style={{
                        fontSize: viewMode === 'week' ? 18 : 10,
                        fontWeight: isToday ? 800 : viewMode === 'week' ? 600 : 400,
                        color: isToday ? 'var(--accent)' : wknd ? 'var(--text-3)' : 'var(--text-2)',
                        lineHeight: 1,
                      }}>
                        {d.getDate()}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Task rows + bars */}
              <div style={{ position: 'relative' }}>
                {visibleTasks.map((task, i) => {
                  const rawS = toDate(task.start_date) || toDate(task.end_date);
                  const rawE = toDate(task.end_date)   || toDate(task.start_date);
                  const s = rawS < rangeStart ? rangeStart : rawS;
                  const e = rawE > rangeEnd   ? rangeEnd   : rawE;
                  const barLeft  = daysBetween(rangeStart, s) * dayW;
                  const barWidth = Math.max(dayW, (daysBetween(s, e) + 1) * dayW);
                  const color = task.project_color || '#4f8ef7';
                  const pct   = task.progress || 0;

                  return (
                    <div key={task.id} style={{
                      height: ROW_H,
                      borderBottom: '1px solid var(--border)',
                      background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                      position: 'relative',
                    }}>
                      {/* Weekend column shading */}
                      {Array.from({ length: totalDays }, (_, di) => {
                        const d = addDays(rangeStart, di);
                        if (!isWeekend(d)) return null;
                        return <div key={di} style={{ position: 'absolute', left: di * dayW, top: 0, width: dayW, height: '100%', background: 'color-mix(in srgb, var(--border) 40%, transparent)', pointerEvents: 'none' }} />;
                      })}

                      {/* Task bar */}
                      <div
                        onMouseDown={e2 => startDrag(e2, task, 'move')}
                        style={{
                          position: 'absolute', left: barLeft, top: 7,
                          width: barWidth, height: ROW_H - 14,
                          background: `linear-gradient(135deg, ${color}ee 0%, ${color}aa 100%)`,
                          border: `1px solid ${color}`,
                          borderRadius: 5, cursor: 'grab',
                          display: 'flex', alignItems: 'center',
                          overflow: 'hidden',
                          boxShadow: `0 2px 8px ${color}44, inset 0 1px 0 rgba(255,255,255,.25)`,
                        }}
                        title={`${task.name}  •  ${task.start_date} → ${task.end_date}  •  ${t('planning.pctDone', { p: pct })}`}
                      >
                        {/* Progress fill overlay */}
                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: 'rgba(255,255,255,.18)', pointerEvents: 'none', borderRadius: '5px 0 0 5px', transition: 'width .3s' }} />
                        {/* Left resize handle */}
                        <div onMouseDown={e2 => { e2.stopPropagation(); startDrag(e2, task, 'resize-left'); }}
                          style={{ width: 7, height: '100%', cursor: 'ew-resize', position: 'absolute', left: 0, top: 0, zIndex: 2, borderRadius: '5px 0 0 5px', background: 'rgba(0,0,0,.12)' }} />
                        {/* Label */}
                        <span style={{ paddingLeft: 10, paddingRight: 8, fontSize: 11, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'relative', zIndex: 1, textShadow: '0 1px 3px rgba(0,0,0,.5)', flex: 1 }}>
                          {task.name}
                          {pct > 0 && <span style={{ opacity: .7, fontWeight: 400, marginLeft: 5, fontSize: 10 }}>{pct}%</span>}
                        </span>
                        {/* Right resize handle */}
                        <div onMouseDown={e2 => { e2.stopPropagation(); startDrag(e2, task, 'resize-right'); }}
                          style={{ width: 7, height: '100%', cursor: 'ew-resize', position: 'absolute', right: 0, top: 0, zIndex: 2, borderRadius: '0 5px 5px 0', background: 'rgba(0,0,0,.12)' }} />
                      </div>
                    </div>
                  );
                })}

                {/* Today line */}
                {todayOffset >= 0 && todayOffset < totalDays && (
                  <div style={{
                    position: 'absolute',
                    left: todayOffset * dayW + Math.floor(dayW / 2) - 1,
                    top: 0, bottom: 0, width: 2,
                    background: 'var(--red)', opacity: .85,
                    pointerEvents: 'none', zIndex: 5,
                  }}>
                    <div style={{ position: 'absolute', top: -3, left: -4, width: 10, height: 10, borderRadius: '50%', background: 'var(--red)' }} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BOARD VIEW ───────────────────────────────────────────────────────────────


export { GanttView };
