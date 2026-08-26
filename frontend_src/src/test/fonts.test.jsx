// The typefaces are served by this app, not fetched from Google.
//
// They used to arrive through `@import url(fonts.googleapis.com/...)` — once in
// the app stylesheet and once in the CSS injected into printed documents. The
// production Content-Security-Policy permits `style-src 'self'` and nothing
// else, so both were blocked on every page load and every print: the whole app
// and every invoice fell back to system fonts, and Arabic rendered without
// Cairo, the face its screens were designed in.
//
// Nothing failed. There was a console warning, and the app simply looked wrong
// to anybody who had never seen it look right — which is exactly the kind of
// defect that survives to a delivery.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_CSS } from '../utils/exportUtils';

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FONT_DIR = path.join(path.dirname(SRC), 'public', 'fonts');

// Read from disk rather than importing: Vite's CSS plugin claims `?raw` on a
// stylesheet, so the import comes back empty and every assertion below would
// pass vacuously.
const appCss = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

// One file per family and subset. All three are variable fonts, so a single
// file covers the whole weight range — which is why there are six and not the
// thirteen a weight-per-file approach would need.
const EXPECTED = [
  'inter-latin.woff2',
  'inter-latin-ext.woff2',
  'jetbrains-mono-latin.woff2',
  'jetbrains-mono-latin-ext.woff2',
  'cairo-arabic.woff2',
  'cairo-latin.woff2',
];

describe('the fonts ship with the app', () => {
  test('every file the stylesheets ask for is actually there', () => {
    // A @font-face pointing at a missing file fails exactly as silently as the
    // blocked import did.
    for (const f of EXPECTED) {
      expect(fs.existsSync(path.join(FONT_DIR, f)), f).toBe(true);
      expect(fs.statSync(path.join(FONT_DIR, f)).size, f).toBeGreaterThan(5000);
    }
  });

  test('and no font is sitting there unreferenced', () => {
    // A file nobody asks for is dead weight in every deploy. The README beside
    // them is the licence note, not a font.
    const onDisk = fs.readdirSync(FONT_DIR)
      .filter(f => f.endsWith('.woff2')).sort();

    expect(onDisk).toEqual([...EXPECTED].sort());
  });

  test('the app stylesheet declares all three families locally', () => {
    for (const family of ['Inter', 'JetBrains Mono', 'Cairo']) {
      expect(appCss, family).toContain(`font-family: '${family}'`);
    }
    expect((appCss.match(/@font-face/g) || []).length).toBe(EXPECTED.length);
    expect(appCss).toContain("src: url('/fonts/inter-latin.woff2')");
  });

  test('printed documents carry their own, including Arabic', () => {
    // The print stylesheet goes into a same-origin iframe, so it inherits the
    // page's CSP. The receipt voucher and the work order are bilingual, so
    // Cairo has to be there or half of each prints in a fallback face.
    expect(SHARED_CSS).toContain("url('/fonts/inter-latin.woff2')");
    expect(SHARED_CSS).toContain("url('/fonts/cairo-arabic.woff2')");
  });

  test('no stylesheet reaches out to Google', () => {
    // The regression this exists to catch. Anything matching here is blocked in
    // production and renders in a fallback face.
    const live = (css) => css
      .replace(/\/\*[\s\S]*?\*\//g, '')      // comments explain the history
      .replace(/^\s*\/\/.*$/gm, '');

    expect(live(appCss)).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(live(SHARED_CSS)).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(live(appCss)).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
    expect(live(SHARED_CSS)).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
  });

  test('the weight range covers every weight the design uses', () => {
    // Declared as a range because these are variable fonts. Ask for 800 with a
    // face declared `font-weight: 400` and the browser synthesises a fake bold.
    expect(appCss).toMatch(/font-family: 'Inter';[\s\S]{0,120}font-weight: 400 800;/);
    expect(appCss).toMatch(/font-family: 'Cairo';[\s\S]{0,120}font-weight: 400 800;/);
  });

  test('text stays readable while a face loads', () => {
    // `display: swap`, not the default `auto` — which hides the text for up to
    // three seconds on a slow connection.
    const faces = appCss.match(/@font-face\s*\{[^}]*\}/g) || [];
    expect(faces.length).toBe(EXPECTED.length);
    for (const f of faces) expect(f).toContain('font-display: swap');
  });
});
