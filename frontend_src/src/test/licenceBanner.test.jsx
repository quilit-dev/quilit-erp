// The expiry warning the CUSTOMER sees.
//
// Before this, the first sign a business had that its licence had lapsed was
// being locked out one morning — for something as ordinary as a renewal invoice
// sitting unpaid in someone's inbox. So the banner has to appear early enough
// to act on, and it has to stay quiet the rest of the time: a warning shown
// every day for a year is one nobody reads on the day it matters.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';

let status;
vi.mock('../api/client', () => ({
  getLicenceStatus: () => Promise.resolve(status),
}));

import LicenceBanner from '../components/LicenceBanner';

const mount = async () => {
  const r = render(<LocaleProvider><LicenceBanner /></LocaleProvider>);
  await act(async () => { await new Promise(res => setTimeout(res, 0)); });
  return r;
};

const banner = () => screen.queryByRole('status');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('erp_lang', 'en');
  status = { applicable: false };
});

describe('the licence banner stays quiet', () => {
  test('renders nothing in single-tenant mode', async () => {
    status = { applicable: false };
    await mount();
    expect(banner()).toBeNull();
  });

  test('renders nothing on a healthy licence', async () => {
    status = { applicable: true, kind: 'licence', days_left: 200,
               in_grace: false, grace_days: 7 };
    await mount();
    expect(banner()).toBeNull();
  });

  test('says nothing at all if the request fails', async () => {
    // A banner must never be why a page looks broken.
    status = Promise.reject(new Error('network'));
    await mount();
    expect(banner()).toBeNull();
  });
});

describe('the licence banner speaks up', () => {
  test('warns within thirty days', async () => {
    status = { applicable: true, kind: 'licence', days_left: 21,
               in_grace: false, grace_days: 7 };
    await mount();
    expect(banner()).toBeTruthy();
    expect(banner().textContent).toContain('21');
  });

  test('names a trial as a trial, not a licence', async () => {
    status = { applicable: true, kind: 'trial', days_left: 3,
               in_grace: false, grace_days: 7 };
    await mount();
    expect(banner().textContent.toLowerCase()).toContain('trial');
  });

  test('handles the day it expires without saying "in 0 days"', async () => {
    status = { applicable: true, kind: 'licence', days_left: 0,
               in_grace: false, grace_days: 7 };
    await mount();
    expect(banner().textContent).toMatch(/today/i);
  });

  test('during grace, counts down what is LEFT, not how long ago it lapsed', async () => {
    // Expired 2 days ago on a 7-day grace: 5 days of access remain. Showing
    // "2" here would read as time remaining and is the opposite of the truth.
    status = { applicable: true, kind: 'licence', days_left: -2,
               in_grace: true, grace_days: 7 };
    await mount();
    expect(banner().textContent).toContain('5');
    expect(banner().textContent.toLowerCase()).toContain('expired');
  });

  test('never counts below zero once grace is used up', async () => {
    status = { applicable: true, kind: 'licence', days_left: -30,
               in_grace: true, grace_days: 7 };
    await mount();
    expect(banner().textContent).toContain('0');
    expect(banner().textContent).not.toContain('-');
  });

  test('translates into Arabic', async () => {
    localStorage.setItem('erp_lang', 'ar');
    status = { applicable: true, kind: 'trial', days_left: 5,
               in_grace: false, grace_days: 7 };
    await mount();
    // Arabic text, and the day count still legible as digits.
    expect(banner().textContent).toMatch(/[؀-ۿ]/);
    expect(banner().textContent).toContain('5');
  });
});
