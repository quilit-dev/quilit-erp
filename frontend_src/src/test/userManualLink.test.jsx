// The "Open the user manual" button in Settings.
//
// The manual is compiled into the deployment by a separate Docker stage. That
// makes it possible to ship an image where the manual is missing but the button
// is not — and a help link that leads nowhere is worse than no help link, since
// the person clicking it is already lost.
//
// So the section proves the manual is there before offering it, and the proof
// has to be real. Every host in front of this app answers unknown paths with the
// SPA shell so client-side routing works: HTML, status 200, indistinguishable
// from a page that exists. Asking for sitemap.xml and requiring an XML content
// type is what separates a real manual from the fallback.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import UserManualSection from '../pages/settings/UserManualSection.jsx';

const reply = (ok, contentType) => Promise.resolve({
  ok,
  headers: { get: () => contentType },
});

const mount = async () => {
  const r = render(<LocaleProvider><UserManualSection /></LocaleProvider>);
  await act(async () => { await new Promise(res => setTimeout(res, 0)); });
  return r;
};

const link = () => screen.queryByRole('link');

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.setItem('erp_lang', 'en');
});

describe('the manual link appears only when the manual is really there', () => {
  test('shows the link when the probe returns XML', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(true, 'application/xml')));
    await mount();

    expect(link()).not.toBeNull();
    expect(link().getAttribute('href')).toBe('/manual/');
  });

  test('text/xml counts too — servers disagree on which one to send', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(true, 'text/xml; charset=utf-8')));
    await mount();

    expect(link()).not.toBeNull();
  });

  test('hides the link when a 200 HTML shell comes back instead', async () => {
    // The failure this whole check exists for: the SPA fallback answering for
    // a manual that was never built.
    vi.stubGlobal('fetch', vi.fn(() => reply(true, 'text/html; charset=utf-8')));
    await mount();

    expect(link(), 'an HTML answer is the app shell, not the manual').toBeNull();
  });

  test('hides the link on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(false, 'text/plain')));
    await mount();

    expect(link()).toBeNull();
  });

  test('hides the link, and does not throw, when the probe fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await mount();

    expect(link()).toBeNull();
  });

  test('probes with HEAD — the manual is not small', async () => {
    const fetchMock = vi.fn(() => reply(true, 'application/xml'));
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/manual/');
    expect(opts.method).toBe('HEAD');
  });
});

describe('the link itself', () => {
  test('opens in a new tab without handing over window.opener', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(true, 'application/xml')));
    await mount();

    expect(link().getAttribute('target')).toBe('_blank');
    expect(link().getAttribute('rel')).toContain('noopener');
  });
});
