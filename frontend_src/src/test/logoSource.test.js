// Where the logo is fetched FROM.
//
// `/logo.png` is a static file: one path, served off the container filesystem
// for the whole server. On a multi-tenant deployment that is one logo shared by
// every customer, so whoever uploaded last appeared on everyone else's invoices
// — and because static/ is baked into the image with no volume behind it, the
// upload did not even survive the next deploy.
//
// `/api/settings/logo` reads the logo from the requesting tenant's own
// database. This pins the URL, because reverting it would silently restore
// cross-tenant branding rather than break anything visible in development,
// where there is only ever one tenant.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getLogoDataURL } from '../utils/exportUtils';

let lastUrl = null;

beforeEach(() => {
  lastUrl = null;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    lastUrl = String(url);
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    };
  }));
});

describe('getLogoDataURL', () => {
  test('reads the tenant-scoped endpoint, not the shared static file', async () => {
    await getLogoDataURL();

    expect(lastUrl).toContain('/api/settings/logo');
    expect(lastUrl.startsWith('/logo.png'), 'the static file is shared by every tenant')
      .toBe(false);
  });

  test('returns null when the tenant has no logo, so templates omit the image',
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
      expect(await getLogoDataURL()).toBeNull();
    });

  test('returns null when the response is not an image', async () => {
    // A 200 that is actually the SPA shell (the catch-all used to answer here)
    // must not be embedded into a customer's invoice as a broken image.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'text/html' },
      blob: async () => new Blob(['<!doctype html>'], { type: 'text/html' }),
    })));
    expect(await getLogoDataURL()).toBeNull();
  });
});
