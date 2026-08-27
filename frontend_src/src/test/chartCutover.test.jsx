// Carrying the balances across after a change of chart.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import cutoverSrc from '../pages/accounting/ChartCutover.jsx?raw';
import accountingSrc from '../pages/Accounting.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('it is reachable', () => {
  test('the API calls and the tab exist', () => {
    expect(apiSrc).toMatch(/getChartCutoverPreview/);
    expect(apiSrc).toMatch(/postChartCutover/);
    expect(accountingSrc).toMatch(/<ChartCutover/);
    expect(accountingSrc).toMatch(/'cutover', t\('cutover\.title'\)/);
  });
});

describe('nothing is posted until it is posted', () => {
  test('the button waits for every account to have a destination', () => {
    // A half-finished move leaves the books across two charts while looking
    // finished, which is worse than not starting.
    expect(cutoverSrc).toMatch(/disabled=\{busy \|\| !canPost \|\| missing\.length > 0\}/);
    expect(cutoverSrc).toMatch(/cutover\.stillUnmapped/);
  });

  test('it asks before writing to the ledger', () => {
    expect(cutoverSrc).toMatch(/<ConfirmModal/);
    expect(cutoverSrc).toMatch(/cutover\.confirm/);
  });

  test('posting is gated on permission', () => {
    expect(cutoverSrc).toMatch(/canPost = can\('accounting', 'create'\)/);
  });
});

describe('the operator can tell a derivation from a guess', () => {
  test('each row says which it was, and they look different', () => {
    // "Same part" is not a guess — receivables to receivables. "Best guess"
    // is somebody's judgement about their own books.
    expect(cutoverSrc).toMatch(/l\.suggested_by === 'role' \? 'green' : 'yellow'/);
    expect(cutoverSrc).toMatch(/cutover\.byRole/);
    expect(cutoverSrc).toMatch(/cutover\.bySimilarity/);
    expect(en.cutover.bySimilarity).toMatch(/check it/i);
  });

  test('the destination can be overridden', () => {
    expect(cutoverSrc).toMatch(/setOverrides\(o => \(\{/);
  });

  test('only accounts of the same type are offered', () => {
    // Moving a balance across types restates the books rather than relocating
    // them, and the server refuses it — so the picker should not offer it.
    expect(cutoverSrc).toMatch(/\(accounts \|\| \[\]\)\.filter\(a => a\.type === l\.type\)/);
  });
});

describe('it does not offer a button that would refuse', () => {
  test('an already-carried tenant is told so and shown the entry', () => {
    expect(cutoverSrc).toMatch(/done \?/);
    expect(cutoverSrc).toMatch(/cutover\.alreadyDone/);
    expect(cutoverSrc).toMatch(/\/accounting\?tab=journal&focus=\$\{done\.id\}/);
  });

  test('a tenant with nothing to move is told that instead', () => {
    expect(cutoverSrc).toMatch(/cutover\.nothingToMove/);
  });
});

describe('translation', () => {
  test('every key resolves in both languages', () => {
    const keys = [...cutoverSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(12);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the interpolated keys name their parameters', () => {
    for (const [key, args] of [['cutover.whatItDoes', ['total']],
                               ['cutover.stillUnmapped', ['count']],
                               ['cutover.alreadyDone', ['date']],
                               ['cutover.confirm', ['total', 'count']]]) {
      for (const dict of [en, ar]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)]
          .map(m => m[1]).sort();
        expect(named, key).toEqual([...args].sort());
      }
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['title', 'subtitle', 'balance', 'post', 'nothingToMove'];
    expect(KEYS.filter(k => /[A-Za-z]{3,}/.test(ar.cutover[k])
                            && !/[؀-ۿ]/.test(ar.cutover[k]))).toEqual([]);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of cutoverSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});

describe('it mounts', () => {
  test('renders against an empty backend without throwing', async () => {
    const { render, act } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { ThemeProvider } = await import('../hooks/useTheme.jsx');
    const { LocaleProvider } = await import('../hooks/useLocale.jsx');
    const { ChartCutover } = await import('../pages/accounting/ChartCutover.jsx');

    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        as_of: '2026-08-24', total: 900, unmapped: [], already_posted: null,
        lines: [{ from_code: '1100', from_name: 'Accounts Receivable',
                  type: 'Asset', balance: 500, side: 'debit',
                  to_code: '4111', to_name: 'Customers', suggested_by: 'role' }],
      }),
      text: () => Promise.resolve(''),
      headers: { get: () => 'application/json' },
    });
    try {
      let container;
      await act(async () => {
        ({ container } = render(
          <ThemeProvider><LocaleProvider><MemoryRouter>
            <ChartCutover t={k => k} fmt={n => String(n)} fmtDate={d => String(d)}
              tAccount={a => a?.name || ''} can={() => true} />
          </MemoryRouter></LocaleProvider></ThemeProvider>));
        await new Promise(r => setTimeout(r, 0));
      });
      // Every dropdown in the app is a SearchSelect now; a <select> here
      // would mean the page had missed the sweep.
      expect(container.querySelectorAll('[role="combobox"]').length)
        .toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
