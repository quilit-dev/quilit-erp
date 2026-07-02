// Vitest setup — the jsdom shims and network stubs the pages need to mount.
//
// Philosophy: the smoke suite renders every page with an EMPTY backend
// (every fetch resolves to `[]`, which safely reads as both an empty list
// and an object whose properties are undefined). Anything that crashes under
// that regime would also crash in production on a slow/empty tenant.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// ── Browser APIs jsdom doesn't implement ────────────────────────────────────
window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}));
window.ResizeObserver = window.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
window.IntersectionObserver = window.IntersectionObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
window.scrollTo = window.scrollTo || (() => {});
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:test';

// ── Network: every API call resolves with an empty payload ─────────────────
// `[]` doubles as "empty list" and "object with no fields" (property reads
// yield undefined), which matches how the pages guard their data.
globalThis.fetch = () => Promise.resolve({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => [],
  text: async () => '[]',
  clone() { return this; },
});

// ── Session: a superadmin user so permission-gated UI actually renders ─────
localStorage.setItem('user', JSON.stringify({
  id: 1, username: 'test', is_superadmin: true, admin_access: true, permissions: {},
}));

afterEach(() => cleanup());
