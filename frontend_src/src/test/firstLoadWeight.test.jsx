// What every visitor downloads before they have done anything.
//
// The login screen once shipped a 500 KB spreadsheet library. Not because
// anyone decided it should: `components/shared.jsx` had `import * as XLSX from
// 'xlsx'` at module scope, `App.jsx` imports `LoadingSpinner` from that file,
// and so the entry chunk statically depended on it. Splitting it into its own
// `vendor-xlsx` chunk did not help --- a separate chunk that the entry imports
// is still downloaded. The comment in vite.config.js claimed it was "only
// loaded when a page exports"; it had never been true.
//
// That is an easy regression to reintroduce, because a top-level import is the
// obvious way to write the code and nothing complains. This file is the thing
// that complains.
import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, '..', ...p), 'utf8');

// Modules reachable from App.jsx WITHOUT going through a React.lazy boundary.
// Anything imported at module scope here lands in the first download.
const EAGER = [
  ['components', 'shared.jsx'],
  ['components', 'Sidebar.jsx'],
  ['components', 'ToastContainer.jsx'],
  ['components', 'ErrorBoundary.jsx'],
  ['components', 'SearchSelect.jsx'],
  ['App.jsx'],
];

// Libraries big enough that shipping them to somebody who has not logged in is
// a real cost. Each must be reached with `await import(...)`, not a top-level
// import, from anywhere on the eager path.
const HEAVY = ['xlsx'];

describe('the first load stays light', () => {
  test.each(EAGER.map(p => [p.join('/'), p]))(
    '%s does not statically import a heavy library', (_label, parts) => {
      const text = src(...parts);
      for (const lib of HEAVY) {
        const statically = new RegExp(
          `^\\s*import\\s[^\\n]*from\\s+['"]${lib}['"]`, 'm').test(text);
        expect(statically, `${parts.join('/')} imports '${lib}' at module ` +
          'scope, so every visitor downloads it before they can log in. Use ' +
          `\`const m = await import('${lib}')\` inside the function that needs it.`)
          .toBe(false);
      }
    });

  test('the export helper loads the spreadsheet library on demand', () => {
    const text = src('components', 'shared.jsx');
    expect(text).toMatch(/await import\(['"]xlsx['"]\)/);
    expect(text).toMatch(/export async function exportToExcel/);
  });

  test('its only caller awaits it', () => {
    // exportToExcel became async. A caller that forgot to await would export
    // nothing and report success.
    const text = src('components', 'shared.jsx');
    const run = text.slice(text.indexOf('async function run()'));
    expect(run.slice(0, 500)).toMatch(/await exportToExcel\(/);
  });
});

describe('the built entry page', () => {
  // Skipped when static/ has not been built --- the CI frontend job builds
  // before running, and this is the assertion that actually proves the bytes
  // are gone rather than that the source looks right.
  const indexPath = join(here, '..', '..', '..', 'static', 'index.html');
  const built = existsSync(indexPath);

  test.runIf(built)('does not preload the spreadsheet chunk', () => {
    const html = readFileSync(indexPath, 'utf8');
    expect(html).not.toMatch(/vendor-xlsx/);
  });

  test.runIf(built)('preloads only react and the entry chunk', () => {
    const html = readFileSync(indexPath, 'utf8');
    // Strip only the FINAL `-<hash>.js` segment. A greedy pattern eats the
    // name too: `vendor-react-CtbwOg7X.js` would reduce to `vendor`.
    const preloaded = [...html.matchAll(/href="\/assets\/([^"]+\.js)"/g)]
      .map(m => m[1].replace(/-[^-]+\.js$/, ''));
    for (const chunk of preloaded) {
      expect(['index', 'vendor-react']).toContain(chunk);
    }
  });
});
