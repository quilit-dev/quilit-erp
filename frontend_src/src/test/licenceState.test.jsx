// The licence badge in the Control Center, and the renew arithmetic.
//
// This is the operator's answer to "who needs chasing", so the states have to
// be honest at the boundaries: a customer one day past expiry is in grace and
// still working, one well past it is suspended, and a customer with no dates is
// perpetual — not "expired at the beginning of time".
import { describe, test, expect } from 'vitest';
import { licenceState, daysUntil } from '../pages/platform/LicenceEditor';

const iso = (offsetDays) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  // Local calendar date — toISOString() would shift it a day east of UTC.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('daysUntil', () => {
  test('counts forward and backward from today', () => {
    expect(daysUntil(iso(0))).toBe(0);
    expect(daysUntil(iso(10))).toBe(10);
    expect(daysUntil(iso(-3))).toBe(-3);
  });

  test('is null for a missing or unparseable date', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('')).toBeNull();
    expect(daysUntil('not-a-date')).toBeNull();
  });
});

describe('licenceState', () => {
  test('no dates means perpetual, not expired', () => {
    // The bug this guards: treating NULL as "expired long ago" would show every
    // perpetual customer as lapsed and invite someone to suspend them.
    const s = licenceState({});
    expect(s.tone).toBe('none');
    expect(s.label).toBe('Perpetual');
  });

  test('a healthy licence is green', () => {
    expect(licenceState({ license_expires_at: iso(200) }).tone).toBe('green');
  });

  test('warns a month out', () => {
    expect(licenceState({ license_expires_at: iso(20) }).tone).toBe('yellow');
  });

  test('just past expiry is grace, not expired', () => {
    // Still working — this is the window where a renewal is merely late.
    const s = licenceState({ license_expires_at: iso(-2) }, 7);
    expect(s.tone).toBe('orange');
    expect(s.label).toContain('grace');
  });

  test('past the grace period is expired', () => {
    const s = licenceState({ license_expires_at: iso(-30) }, 7);
    expect(s.tone).toBe('red');
    expect(s.label).toContain('expired');
  });

  test('the sooner of trial and licence governs', () => {
    // A licence running to next year is no comfort if the trial lapsed.
    const s = licenceState({ trial_ends_at: iso(-40), license_expires_at: iso(300) }, 7);
    expect(s.tone).toBe('red');
    expect(s.kind).toBe('trial');
  });

  test('a trial still running is reported over a distant licence', () => {
    const s = licenceState({ trial_ends_at: iso(5), license_expires_at: iso(300) });
    expect(s.kind).toBe('trial');
    expect(s.tone).toBe('yellow');
  });

  test('respects a custom grace period', () => {
    expect(licenceState({ license_expires_at: iso(-3) }, 0).tone).toBe('red');
    expect(licenceState({ license_expires_at: iso(-3) }, 30).tone).toBe('orange');
  });
});
