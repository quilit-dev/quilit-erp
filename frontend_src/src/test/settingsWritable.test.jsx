// Every toggle on the Settings page must actually reach the server.
//
// The page filters its PUT body through a hand-maintained WRITABLE_SETTINGS
// list, so the server will not reject an unknown field. The cost is that adding
// a control and forgetting the list produces a switch that flips, saves without
// error, and silently reverts on reload — which is exactly what happened to the
// barcode and total-in-words toggles: both shipped, neither could be turned on.
//
// Nothing else catches this. The backend tests pass (the API accepts the key),
// the render tests pass (the toggle exists), and only a human clicking it and
// reloading would notice.
import { describe, test, expect } from 'vitest';
import settingsSrc from '../pages/Settings.jsx?raw';

/** The keys the page will actually send. */
function writable() {
  const block = settingsSrc.match(/WRITABLE_SETTINGS = new Set\(\[([\s\S]*?)\]\)/);
  expect(block, 'WRITABLE_SETTINGS not found — was it renamed?').toBeTruthy();
  return new Set([...block[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]));
}

/** The setting keys the page binds a control to. */
function bound() {
  const keys = new Set();
  for (const m of settingsSrc.matchAll(/\b(?:bool|set)\('([a-z0-9_]+)'\)/g)) keys.add(m[1]);
  return keys;
}

// Read-only or handled outside the settings PUT, so they are meant to be absent.
const NOT_SAVED_HERE = new Set([
  'setup_complete',        // owned by the first-run wizard
  'enabled_modules',       // vendor_config, never tenant-writable
  'document_template',     // vendor_config, never tenant-writable
  'local_backup',          // derived from the database backend
]);

describe('Settings can save what it lets you change', () => {
  test('every bound control is in the writable list', () => {
    const missing = [...bound()].filter(k => !writable().has(k) && !NOT_SAVED_HERE.has(k));

    expect(missing, `these controls change state but are stripped from the PUT, so `
      + `they appear to save and then revert: ${missing.join(', ')}`).toEqual([]);
  });

  test('the document toggles in particular', () => {
    // Named explicitly: these are the ones that shipped broken, and a generic
    // assertion would not say so when it fails again.
    for (const key of ['show_discount_col', 'show_tax_col', 'show_barcode_col',
                       'show_total_words', 'preprinted_stationery']) {
      expect(writable().has(key), `${key} would be dropped from the save`).toBe(true);
      expect(bound().has(key), `${key} has no control on the page`).toBe(true);
    }
  });

  test('the vendor-controlled keys are NOT writable', () => {
    // The other direction. A letterhead is not a preference, and putting it in
    // this list would hand every tenant another company's branding.
    for (const key of ['document_template', 'enabled_modules']) {
      expect(writable().has(key), `${key} must never be sent from Settings`).toBe(false);
    }
  });
});
