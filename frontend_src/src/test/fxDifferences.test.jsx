// The workspace an accountant closes a period in.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import fxSrc from '../pages/accounting/FxDifferences.jsx?raw';
import accountingSrc from '../pages/Accounting.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('it is reachable and it asks the server', () => {
  test('the tab is mounted in Accounting', () => {
    expect(accountingSrc).toMatch(/<FxDifferences/);
    expect(accountingSrc).toMatch(/'fxDifferences', t\('fx\.title'\)/);
  });

  test('filters go in the query string like every other list', () => {
    expect(apiSrc).toMatch(/getFxDifferences\s+= \(params = \{\}\) =>/);
    expect(apiSrc).toMatch(/fx-differences\$\{_qs\(params\)\}/);
  });
});

describe('the two kinds stay apart', () => {
  test('each row says which it is, and they are styled differently', () => {
    // Presenting them as one number would misstate what the period earned.
    expect(fxSrc).toMatch(/t\(`fx\.kind_\$\{r\.kind\}`\)/);
    expect(fxSrc).toMatch(/r\.kind === 'realized' \? 'blue' : 'yellow'/);
  });

  test('the totals are reported separately, not merged', () => {
    expect(fxSrc).toMatch(/sum\.realized/);
    expect(fxSrc).toMatch(/sum\.unrealized/);
  });

  test('each has an explanation of what it means', () => {
    expect(en.fx.realizedHint).toMatch(/money arrived/i);
    expect(en.fx.unrealizedHint).toMatch(/reverses/i);
  });
});

describe('a row explains itself', () => {
  test('both rates are shown together', () => {
    // The difference is the gap between them; one without the other says
    // nothing.
    expect(fxSrc).toMatch(/r\.recognition_rate/);
    expect(fxSrc).toMatch(/r\.settlement_rate/);
  });

  test('the detail walks the whole chain in order', () => {
    for (const step of ['stepDocument', 'stepAgreed', 'stepRecognitionRate',
                        'stepBaseAtRecognition', 'stepLaterRate',
                        'stepValueThen', 'stepDifference', 'stepTreatment']) {
      expect(fxSrc, step).toContain(`fx.${step}`);
    }
  });

  test('it links to the entry that carried it', () => {
    expect(fxSrc).toMatch(/\/accounting\?tab=journal&focus=\$\{row\.journal_entry_id\}/);
  });
});

describe('reviewing is not an accounting action', () => {
  test('the screen says so where the accountant is about to do it', () => {
    expect(en.fx.reviewHint).toMatch(/posts nothing/i);
  });

  test('it is gated on permission and can be undone', () => {
    expect(fxSrc).toMatch(/canReconcile = can\('accounting', 'edit'\)/);
    expect(fxSrc).toMatch(/onMark\(row, true\)/);
  });
});

describe('the filters the brief asked for', () => {
  test('every one is sent', () => {
    for (const f of ['kind', 'currency', 'direction', 'client_id', 'status',
                     'start', 'end']) {
      expect(fxSrc, f).toContain(f);
    }
  });

  test('they can be cleared at once', () => {
    expect(fxSrc).toMatch(/setKind\(''\); setCurrency\(''\); setDirection\(''\);/);
  });

  test('the list can be exported', () => {
    expect(fxSrc).toMatch(/<ExportButtons/);
  });
});

describe('translation and styling', () => {
  test('every key resolves in both languages', () => {
    const keys = [...fxSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the interpolated key names its parameters', () => {
    for (const dict of [en, ar]) {
      const named = [...dict.fx.reviewedBy.matchAll(/\{\{(\w+)\}\}/g)]
        .map(m => m[1]).sort();
      expect(named).toEqual(['date', 'name']);
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['title', 'kind_realized', 'kind_unrealized', 'difference',
                  'reconciled', 'stillToReview', 'reviewHint'];
    expect(KEYS.filter(k => /[A-Za-z]{3,}/.test(ar.fx[k])
                            && !/[؀-ۿ]/.test(ar.fx[k]))).toEqual([]);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of fxSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
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
    const { SettingsProvider } = await import('../hooks/useSettings.jsx');
    const { FxDifferences } = await import('../pages/accounting/FxDifferences.jsx');

    let container;
    await act(async () => {
      ({ container } = render(
        <ThemeProvider><LocaleProvider><SettingsProvider><MemoryRouter>
          <FxDifferences t={k => k} fmt={n => String(n)}
            fmtDate={d => String(d)} can={() => true} />
        </MemoryRouter></SettingsProvider></LocaleProvider></ThemeProvider>,
      ));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(container).toBeTruthy();
  });
});
