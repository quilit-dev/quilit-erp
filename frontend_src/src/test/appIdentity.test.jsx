// The browser tab's identity.
//
// The rule is that the tab always shows SOMETHING. The tenant's logo when they
// have one, the vendor mark otherwise — never the browser's default globe,
// which is what a <link rel="icon"> pointed straight at a 404 leaves behind in
// some browsers while silently reporting nothing.
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { applyTenantFavicon, applyTenantTitle, resetFavicon } from '../utils/appIdentity';

const FALLBACK = '/icon-192.png';

const iconHref = () => document.querySelector('link[rel="icon"]')?.getAttribute('href');

/** Stand in for the shipped tag, so tests start where a real page starts. */
const shipIcon = () => {
  document.head.innerHTML = `<link rel="icon" href="${FALLBACK}">`;
};

const respond = (ok, type = 'image/png') => vi.fn().mockResolvedValue({
  ok,
  headers: { get: () => type },
  blob: async () => new Blob(['x'], { type }),
});

beforeEach(() => {
  shipIcon();
  document.title = 'ERP System';
  // jsdom has no object-URL implementation.
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('the tab icon', () => {
  test('becomes the tenant logo when they have one', async () => {
    globalThis.fetch = respond(true);
    await applyTenantFavicon();

    expect(iconHref()).toMatch(/^blob:/);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/settings/logo',
      expect.objectContaining({ cache: 'no-store' }));
  });

  test('stays on the vendor mark when no logo is uploaded', async () => {
    // The endpoint 404s. The tab must NOT end up pointing at that 404.
    globalThis.fetch = respond(false);
    await applyTenantFavicon();

    expect(iconHref()).toBe(FALLBACK);
  });

  test('an HTML error page is not accepted as an icon', async () => {
    // A proxy or login wall answering 200 with HTML would otherwise be set as
    // the tab icon and render as nothing at all.
    globalThis.fetch = respond(true, 'text/html');
    await applyTenantFavicon();

    expect(iconHref()).toBe(FALLBACK);
  });

  test('a network failure leaves the shipped icon alone', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(applyTenantFavicon()).resolves.toBeUndefined();

    expect(iconHref()).toBe(FALLBACK);
  });

  test('re-applying frees the old blob but never the live one', async () => {
    // Revoking the URL just assigned blanks the tab the moment the browser
    // re-reads it — so the order here is the behaviour, not an optimisation.
    globalThis.fetch = respond(true);
    await applyTenantFavicon();
    const first = iconHref();
    await applyTenantFavicon();
    const second = iconHref();

    expect(second).not.toBe(first);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalledWith(second);
  });

  test('a page with no icon tag still gets one', async () => {
    document.head.innerHTML = '';
    globalThis.fetch = respond(true);
    await applyTenantFavicon();

    expect(iconHref()).toMatch(/^blob:/);
  });

  test('resetting goes back to the vendor mark', async () => {
    globalThis.fetch = respond(true);
    await applyTenantFavicon();
    resetFavicon();

    expect(iconHref()).toBe(FALLBACK);
  });
});

describe('the tab text', () => {
  test('is the company once we know it', () => {
    applyTenantTitle('HAJO SIGN');
    expect(document.title).toBe('HAJO SIGN');
  });

  test.each([[null], [undefined], [''], ['   ']])(
    'falls back to the product name for %p', (value) => {
      // Before login there is no company name to show — the settings endpoint
      // needs a session — so the tab must not go blank.
      applyTenantTitle(value);
      expect(document.title).toBe('ERP System');
    });
});

describe('the wiring, not just the helpers', () => {
  test('the provider drives the title from the company name', async () => {
    // The helper being correct is worthless if nothing calls it. This asserts
    // the connection: settings arrive, the tab changes.
    const { render, waitFor } = await import('@testing-library/react');
    const { SettingsProvider } = await import('../hooks/useSettings.jsx');

    globalThis.fetch = vi.fn(async (url) => ({
      ok: String(url).endsWith('/api/settings/'),
      json: async () => ({ company_name: 'HAJO SIGN' }),
    }));

    render(<SettingsProvider><div /></SettingsProvider>);
    await waitFor(() => expect(document.title).toBe('HAJO SIGN'));
  });

  test('the app applies the icon before React mounts', async () => {
    // On the login screen and on a customer's share page there is no settings
    // provider, so the call cannot live inside one.
    const src = (await import('../main.jsx?raw')).default;
    expect(src).toMatch(/applyTenantFavicon\(\)/);
    // Against the CALL, not the import line at the top of the file.
    expect(src.indexOf('applyTenantFavicon()'))
      .toBeLessThan(src.indexOf('createRoot(document'));
  });
});
