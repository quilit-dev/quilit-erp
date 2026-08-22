// Marking foreign cash to the closing rate, from a screen rather than by
// calling the API by hand.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import revalSrc from '../pages/accounting/Revaluation.jsx?raw';
import accountingSrc from '../pages/Accounting.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the job can be done at all', () => {
  test('the API call exists and the tab is mounted', () => {
    expect(apiSrc).toMatch(/postFxRevaluation/);
    expect(accountingSrc).toMatch(/<Revaluation/);
    expect(accountingSrc).toMatch(/'revaluation', t\('accounting\.fxRevaluation'\)/);
  });

  test('it sends a count per currency, only for the ones filled in', () => {
    // Sending a currency the operator left blank would revalue it against a
    // count of zero and write off the whole balance.
    expect(revalSrc).toMatch(/counts\[f\.code\] !== ''/);
    expect(revalSrc).toMatch(/for \(const f of supplied\) body\[f\.field\] = Number/);
  });

  test('only currencies the chart has an account for are offered', () => {
    // Otherwise a tenant on a chart without one is invited to revalue into
    // nothing.
    expect(revalSrc).toMatch(/accounts\.some\(a => a\.code === f\.account\)/);
  });

  test('the dollar is not offered against itself', () => {
    const foreign = revalSrc.slice(revalSrc.indexOf('const FOREIGN'),
                                   revalSrc.indexOf('function Revaluation'));
    expect(foreign).not.toMatch(/'USD'/);
    expect(foreign).toMatch(/'LBP'/);
    expect(foreign).toMatch(/'EUR'/);
  });
});

describe('it does not post by accident', () => {
  test('posting is gated on permission and on something to post', () => {
    expect(revalSrc).toMatch(/disabled=\{busy \|\| !canPost \|\| !supplied\.length\}/);
    expect(revalSrc).toMatch(/can\('accounting', 'create'\)/);
  });

  test('it asks before writing to the ledger', () => {
    // The entry cannot be edited afterwards, only reversed.
    expect(revalSrc).toMatch(/<ConfirmModal/);
    expect(revalSrc).toMatch(/accounting\.confirmRevaluation/);
  });

  test('the result is what the server said, not a local guess', () => {
    expect(revalSrc).toMatch(/\(result\.results \|\| \[\]\)\.map/);
  });
});

describe('translation and styling', () => {
  test('every key the screen uses resolves in both languages', () => {
    const keys = [...revalSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the interpolated key names the parameter it is given', () => {
    for (const dict of [en, ar]) {
      const named = [...dict.accounting.countedIn.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
      expect(named).toEqual(['currency']);
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['fxRevaluation', 'fxRevaluationHint', 'onTheBooks',
                  'worthToday', 'difference', 'postRevaluation'];
    expect(KEYS.filter(k => /[A-Za-z]{3,}/.test(ar.accounting[k])
                            && !/[؀-ۿ]/.test(ar.accounting[k]))).toEqual([]);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of revalSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});

// The tab lives under pages/accounting/, which the page smoke test's glob does
// not reach — and an inactive tab is not rendered by mounting Accounting.jsx.
// So it is mounted here directly, for the bug classes static analysis misses.
describe('it mounts', () => {
  test('renders against an empty backend without throwing', async () => {
    const { render, act } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { ThemeProvider } = await import('../hooks/useTheme.jsx');
    const { LocaleProvider } = await import('../hooks/useLocale.jsx');
    const { SettingsProvider } = await import('../hooks/useSettings.jsx');
    const { Revaluation } = await import('../pages/accounting/Revaluation.jsx');

    // The shared mock resolves everything to [], which sends this component
    // down its loading branch and proves nothing. Give it a chart so the form
    // itself renders.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve([
        { id: 1, code: '1000', name: 'Cash & Bank' },
        { id: 2, code: '1010', name: 'Cash — LBP' },
        { id: 3, code: '1020', name: 'Cash — EUR' },
      ]),
      text: () => Promise.resolve(''),
      headers: { get: () => 'application/json' },
    });

    let container;
    try {
      await act(async () => {
        ({ container } = render(
          <ThemeProvider><LocaleProvider><SettingsProvider><MemoryRouter>
            <Revaluation t={k => k} fmt={n => String(n)} can={() => true} />
          </MemoryRouter></SettingsProvider></LocaleProvider></ThemeProvider>,
        ));
        await new Promise(r => setTimeout(r, 0));
      });
      // Both foreign currencies have an account here, so both get a field —
      // and the dollar does not.
      expect(container.querySelectorAll('input[type="number"]').length)
        .toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
