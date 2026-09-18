// A working day with per-day hours, and the employee's Saturday rota.
import { describe, test, expect } from 'vitest';
import clockSrc from '../pages/hr/TimeClockTab.jsx?raw';
import hrSrc from '../pages/HR.jsx?raw';

describe('the schedule form', () => {
  test('lets a working day keep its own hours, seeded from the week\'s', () => {
    expect(clockSrc).toMatch(/function toggleOverride\(n\)/);
    expect(clockSrc).toMatch(/next\[n\] = \{ start_time: f\.start_time, end_time: f\.end_time \}/);
    expect(clockSrc).toMatch(/t\('timeclock\.dayHoursLabel'\)/);
  });
  test('only working days may carry an override', () => {
    expect(clockSrc).toMatch(/Object\.entries\(overrides\)\.filter\(\(\[n\]\) => days\.has\(Number\(n\)\)\)/);
  });
  test('reads the stored JSON leniently', () => {
    expect(clockSrc).toMatch(/function parseOverrides\(raw\)/);
    expect(clockSrc).toMatch(/catch \{ return \{\}; \}/);
  });
  test('the table shows the days with their own hours', () => {
    expect(clockSrc).toMatch(/parseOverrides\(s\.day_overrides\)\)\.map/);
  });
});

describe('the employee form', () => {
  test('offers the three rotas and asks for the anchor only for alternate', () => {
    for (const v of ['all', 'alternate', 'none']) expect(hrSrc).toContain(`{ value: '${v}',`);
    expect(hrSrc).toMatch(/\{empForm\.saturday_rota === 'alternate' && \(/);
    expect(hrSrc).toMatch(/saturday_rota_anchor: empForm\.saturday_rota === 'alternate'/);
  });
  test('blank means the working day decides', () => {
    expect(hrSrc).toMatch(/saturday_rota: empForm\.saturday_rota \|\| null/);
  });
});
