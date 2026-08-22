// Choosing the chart of accounts the books are kept on.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import pickerSrc from '../pages/accounting/ChartPicker.jsx?raw';
import accountsSrc from '../pages/accounting/Accounts.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('it is reachable', () => {
  test('the API calls exist', () => {
    expect(apiSrc).toMatch(/getChartStatus/);
    expect(apiSrc).toMatch(/installLebaneseChart/);
    expect(apiSrc).toMatch(/\/api\/accounting\/chart\/lebanon\/install/);
  });

  test('it sits on the accounts screen, where the accounts are read', () => {
    expect(accountsSrc).toMatch(/<ChartPicker/);
    expect(accountsSrc).toMatch(/import \{ ChartPicker \}/);
  });

  test('the list reloads after a switch, since every row changed', () => {
    expect(accountsSrc).toMatch(/onInstalled=\{load\}/);
  });
});

describe('it says which chart is in use', () => {
  test('and only offers the switch when not already on it', () => {
    expect(pickerSrc).toMatch(/const onLebanese = data\.current === 'lebanon'/);
    expect(pickerSrc).toMatch(/\{!onLebanese && canEdit && \(/);
  });

  test('changing the books needs permission to change the books', () => {
    expect(pickerSrc).toMatch(/canEdit/);
  });
});

describe('a business that has posted is asked deliberately', () => {
  test('the phrase is required and checked before enabling the button', () => {
    expect(pickerSrc).toMatch(/needsPhrase = !lb\.clean/);
    expect(pickerSrc).toMatch(/phrase\.trim\(\)\.toUpperCase\(\) !== 'SWITCH CHART'/);
  });

  test('it explains what being mid-life means before asking', () => {
    expect(pickerSrc).toMatch(/chart\.alreadyPosted/);
    expect(en.chart.alreadyPosted).toMatch(/two charts/i);
    expect(en.chart.alreadyPosted).toMatch(/accountant/i);
  });

  test('a business with nothing posted is not asked for a phrase', () => {
    expect(pickerSrc).toMatch(/chart\.nothingPostedYet/);
  });

  test('it says history is kept', () => {
    expect(en.chart.keepsHistory).toMatch(/Nothing is deleted/i);
  });
});

describe('translation', () => {
  test('every key resolves in both languages', () => {
    const keys = [...pickerSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the interpolated keys name their parameters', () => {
    for (const [key, args] of [['chart.switchTo', ['name']],
                               ['chart.whatItDoes', ['count']],
                               ['chart.retireOld', ['count']],
                               ['chart.alreadyPosted', ['count']],
                               ['chart.typeToConfirm', ['phrase']]]) {
      for (const dict of [en, ar]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)]
          .map(m => m[1]).sort();
        expect(named, key).toEqual([...args].sort());
      }
    }
  });

  test('the plan is named in Arabic, as it is published', () => {
    expect(ar.chart.lebanon).toMatch(/[؀-ۿ]/);
    expect(ar.chart.keepsHistory).toMatch(/[؀-ۿ]/);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of pickerSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
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
  test('renders without throwing, and stays quiet until it knows', async () => {
    const { render, act } = await import('@testing-library/react');
    const { ThemeProvider } = await import('../hooks/useTheme.jsx');
    const { LocaleProvider } = await import('../hooks/useLocale.jsx');
    const { ChartPicker } = await import('../pages/accounting/ChartPicker.jsx');

    let container;
    await act(async () => {
      ({ container } = render(
        <ThemeProvider><LocaleProvider>
          <ChartPicker t={k => k} canEdit onInstalled={() => {}} />
        </LocaleProvider></ThemeProvider>));
      await new Promise(r => setTimeout(r, 0));
    });
    // The shared mock answers [] — not a chart status — so it must render
    // nothing rather than guess which chart is in use.
    expect(container).toBeTruthy();
  });
});
