// Report and finance periods are calendar dates in the user's own time zone.
// Built with toISOString() they shifted a day in Lebanon (UTC+2/+3): "this
// month" in November went out as 31 Oct – 29 Nov.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRange as reportRange } from '../pages/reports/charts';
import { getRange as financeRange } from '../pages/finance/charts';

const ORIGINAL_TZ = globalThis.process.env.TZ;

describe('date ranges follow the local calendar', () => {
  beforeEach(() => {
    globalThis.process.env.TZ = 'Asia/Beirut';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T09:00:00+02:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.process.env.TZ = ORIGINAL_TZ;
  });

  it.each([['reports', reportRange], ['finance', financeRange]])('%s: this month is the whole month', (_, getRange) => {
    const r = getRange('month', {});
    expect(r.start).toBe('2026-11-01');
    expect(r.end).toBe('2026-11-30');
  });

  it.each([['reports', reportRange], ['finance', financeRange]])('%s: this year is 1 Jan – 31 Dec', (_, getRange) => {
    const r = getRange('year', {});
    expect(r.start).toBe('2026-01-01');
    expect(r.end).toBe('2026-12-31');
  });

  it('finance compares with the whole previous month', () => {
    const r = financeRange('month', {});
    expect(r.prevStart).toBe('2026-10-01');
    expect(r.prevEnd).toBe('2026-10-31');
  });
});
