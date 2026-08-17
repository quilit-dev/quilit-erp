// The browser tab's identity.
//
// The icon is NOT tested here, because it is not JavaScript any more: index.html
// carries a plain <link rel="icon" href="/api/settings/favicon"> and the server
// decides what that returns. That endpoint's contract — always an image, the
// tenant's logo when they have one — is asserted in backend/tests/test_favicon.py.
//
// The first attempt did probe and swap the tag from JavaScript, and it did not
// work: Chrome reads the icon while parsing the head and does not reliably
// repaint when a script rewrites the href afterwards. The DOM changed and the
// tab kept the old icon, which is precisely why the assertions below are about
// the TAG being right in the shipped HTML rather than about what a script does
// to it later.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyTenantTitle } from '../utils/appIdentity';

beforeEach(() => { document.title = 'ERP System'; });
afterEach(() => { vi.restoreAllMocks(); });

describe('the tab icon is declared, not scripted', () => {
  test('index.html points the icon at the endpoint that always answers', async () => {
    const html = (await import('../../index.html?raw')).default;

    expect(html).toMatch(/<link rel="icon" href="\/api\/settings\/favicon"/);
    // Not /logo: that endpoint 404s when no logo is uploaded, which is what
    // leaves a tab on the browser's default globe.
    expect(html).not.toMatch(/rel="icon"[^>]*\/api\/settings\/logo/);
  });

  test('nothing rewrites the icon at runtime', async () => {
    // A script that sets link.href changes the DOM and not the tab. If this
    // starts failing, the swap has been reintroduced.
    const sources = await Promise.all([
      import('../main.jsx?raw'),
      import('../utils/appIdentity.js?raw'),
      import('../pages/Settings.jsx?raw'),
    ]);
    // Comments stripped first — this file's own module doc discusses the icon
    // at length, and matching prose would fail for the wrong reason.
    const code = sources.map(m => m.default
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')).join('\n');

    expect(code).not.toMatch(/querySelector\(\s*['"]link/);
    expect(code).not.toMatch(/createObjectURL|applyTenantFavicon/);
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
      // needs a session, unlike the logo — so the tab must not go blank.
      applyTenantTitle(value);
      expect(document.title).toBe('ERP System');
    });

  test('the provider drives it from the company name', async () => {
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
});
