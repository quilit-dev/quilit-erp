// The two things the time-clock screens have to get right.
//
// **A device that has gone quiet must be visible.** A time clock that silently
// stops is worse than one that never worked, because payroll gets built on the
// gap and nobody finds out until somebody is paid wrong. The staleness check is
// the whole early-warning system, so it is tested directly rather than through
// a rendered banner that could be restyled away.
//
// **The token is shown once.** The server keeps only a SHA-256 of it, so there
// is no screen anywhere that can show it again. If the modal that hands it over
// were ever quietly dropped, the feature would look like it worked and the
// person installing the agent would have nothing to paste.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import en from '../locales/en';
import ar from '../locales/ar';
import { hoursSince, isStale } from '../pages/hr/TimeClockTab.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');
const clockSrc = read('pages', 'hr', 'TimeClockTab.jsx');
const attSrc = read('pages', 'hr', 'AttendanceTab.jsx');
const hrSrc = read('pages', 'HR.jsx');

const NOW = new Date('2026-09-10T12:00:00Z');
const live = (seen) => ({ last_seen_at: seen, revoked_at: null });

describe('a terminal that has gone quiet is noticed', () => {
  test('one heard from minutes ago is fine', () => {
    expect(isStale(live('2026-09-10 11:30:00'), NOW)).toBe(false);
  });

  test('one heard from yesterday morning is not', () => {
    expect(isStale(live('2026-09-09 09:00:00'), NOW)).toBe(true);
  });

  test('one that has NEVER reported is stale, not silently fine', () => {
    // The install-went-wrong case, and the easiest one to get wrong: `null`
    // hours-since must not read as "recent".
    expect(isStale(live(null), NOW)).toBe(true);
    expect(hoursSince(null)).toBeNull();
  });

  test('a revoked terminal is not nagged about', () => {
    // Somebody turned it off on purpose. Warning about it forever trains people
    // to ignore the banner that matters.
    expect(isStale({ last_seen_at: null, revoked_at: '2026-09-01 10:00:00' }, NOW))
      .toBe(false);
  });

  test('an unreadable timestamp counts as stale rather than fine', () => {
    expect(isStale(live('not a date'), NOW)).toBe(true);
  });

  test('the boundary is a day, not an hour or a week', () => {
    expect(isStale(live('2026-09-09 13:00:00'), NOW)).toBe(false);  // 23h
    expect(isStale(live('2026-09-09 11:00:00'), NOW)).toBe(true);   // 25h
  });
});

describe('the token is handed over exactly once', () => {
  test('the screen shows it only from what a create or rotate returned', () => {
    // `issued` is set from the response of createTimeDevice / rotateTimeDevice
    // and from nowhere else. There is no list read that could supply it.
    expect(clockSrc).toMatch(/setIssued\(created\)/);
    expect(clockSrc).toMatch(/setIssued\(await rotateTimeDevice/);
    expect(clockSrc).toMatch(/TokenModal/);
  });

  test('it hands over a ready-made config block, not a bare string', () => {
    // Whoever installs this is copying into a file, and a transcribed 43-char
    // secret is a support call waiting to happen.
    expect(clockSrc).toMatch(/\[timeclock\]/);
    expect(clockSrc).toMatch(/device_token = /);
  });

  test('the warning that it will not be shown again is in both languages', () => {
    expect(en.timeclock.tokenOnce).toBeTruthy();
    expect(ar.timeclock.tokenOnce).toBeTruthy();
    expect(ar.timeclock.tokenOnceBody).not.toBe(en.timeclock.tokenOnceBody);
  });
});

describe('the attendance screen says where a number came from', () => {
  test('it shows the punch times', () => {
    expect(attSrc).toMatch(/first_in/);
    expect(attSrc).toMatch(/last_out/);
  });

  test('a row the clock owns is marked as such', () => {
    expect(attSrc).toMatch(/r\.source === 'device'/);
    expect(attSrc).toMatch(/attFromClock/);
  });

  test('a disagreement between typed and recorded hours is shown', () => {
    // The "you typed 8, the clock says 7.5" line. Rendered only when they
    // differ, so it reads as information rather than decoration.
    expect(attSrc).toMatch(/device_hours/);
    expect(attSrc).toMatch(/attClockSays/);
    expect(attSrc).toMatch(/!==\s*Number\(r\.hours/);
  });

  test('and the rule is stated in words, not just implied by a chip', () => {
    expect(en.hr.attEditHint).toMatch(/off the clock/i);
    expect(ar.hr.attEditHint).toBeTruthy();
  });
});

describe('wiring', () => {
  test('the tab is mounted in HR', () => {
    expect(hrSrc).toMatch(/import TimeClockTab from '\.\/hr\/TimeClockTab'/);
    expect(hrSrc).toMatch(/tab === 'timeclock'/);
    expect(hrSrc).toMatch(/<TimeClockTab/);
  });

  test.each([
    'devices', 'addDevice', 'noDevices', 'lastSeen', 'rotate', 'revoke',
    'staleTitle', 'staleBody', 'collectingOnly', 'unclaimed', 'enrolmentNo',
    'pickEmployee', 'claimed', 'tokenTitle', 'schedules', 'scheduleHint',
    'graceLabel', 'halfDayLabel', 'breakLabel', 'breakHint', 'overnightLabel',
  ])('timeclock.%s is translated in both', (k) => {
    expect(en.timeclock[k], `en.timeclock.${k}`).toBeTruthy();
    expect(ar.timeclock[k], `ar.timeclock.${k}`).toBeTruthy();
    expect(ar.timeclock[k], `ar.timeclock.${k} is still English`)
      .not.toBe(en.timeclock[k]);
  });

  test.each(['attIn', 'attOut', 'attFromClock', 'attNeedsReview',
             'attClockSays', 'attRefresh', 'attEditHint', 'tabTimeClock'])(
    'hr.%s is translated in both', (k) => {
      expect(en.hr[k], `en.hr.${k}`).toBeTruthy();
      expect(ar.hr[k], `ar.hr.${k}`).toBeTruthy();
      expect(ar.hr[k]).not.toBe(en.hr[k]);
    });
});
