// The rate book in the top bar.
//
// Put there deliberately: in Lebanon the pound rate moves week to week, every
// operator needs to know what the till will convert at, and a rate that lives
// three clicks into Settings is a rate that goes stale.
//
// What the tests hold is the part that keeps the books consistent — one number
// per currency with every pair derived from it, and a date on every change.
import { describe, test, expect } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import src from '../components/RateBook.jsx?raw';
import appSrc from '../App.jsx?raw';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

const BOOK = {
  base_currency: 'USD',
  secondary_currency: 'LBP',
  current: { id: 2, rate: 89000, effective_date: '2026-08-20' },
  rates: {
    LBP: { id: 2, rate: 89000, effective_date: '2026-08-20', set_by_name: 'Ali' },
    EUR: { id: 3, rate: 0.92, effective_date: '2026-08-22', set_by_name: 'Ali' },
  },
  pairs: [
    { from: 'USD', to: 'LBP', rate: 89000, since: '2026-08-20', derived: false },
    { from: 'USD', to: 'EUR', rate: 0.92, since: '2026-08-22', derived: false },
    { from: 'LBP', to: 'USD', rate: 1 / 89000, since: '2026-08-20', derived: false },
    { from: 'EUR', to: 'USD', rate: 1 / 0.92, since: '2026-08-22', derived: false },
    { from: 'EUR', to: 'LBP', rate: 89000 / 0.92, since: '2026-08-20', derived: true },
    { from: 'LBP', to: 'EUR', rate: 0.92 / 89000, since: '2026-08-20', derived: true },
  ],
  history: [
    { id: 3, rate: 0.92, currency: 'EUR', effective_date: '2026-08-22', set_by_name: 'Ali', note: 'Bank' },
    { id: 2, rate: 89000, currency: 'LBP', effective_date: '2026-08-20', set_by_name: 'Ali', note: 'Parallel' },
  ],
};

// Opened, because the panel is what the tests are about — the pill is the
// closed state and is covered by its own assertions.
async function mount(book = BOOK, { open = true } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(
      String(url).includes('exchange-rate') ? book : {}),
    text: () => Promise.resolve(''),
    headers: { get: () => 'application/json' },
  });
  const { default: RateBook } = await import('../components/RateBook.jsx');
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><SettingsProvider><MemoryRouter>
        <RateBook />
      </MemoryRouter></SettingsProvider></LocaleProvider></ThemeProvider>));
    await new Promise(r => setTimeout(r, 0));
  });
  if (open) {
    await act(async () => {
      fireEvent.click(container.querySelector('button'));
      await new Promise(r => setTimeout(r, 0));
    });
  }
  globalThis.fetch = realFetch;
  return container;
}

describe('it is where the rate is actually needed', () => {
  test('in the top bar, beside the bell', () => {
    expect(appSrc).toMatch(/<RateBook \/>/);
    expect(appSrc).toMatch(/import RateBook from '\.\/components\/RateBook'/);
  });

  test('the pill states the rate without being opened', () => {
    // Reading it is the common case by a wide margin; setting it is rare.
    expect(src).toMatch(/1 \$\{base\} = \$\{fmtRate\(headline\.rate\)\} \$\{secondary\}/);
  });

  test('a rate nobody has touched in a week is flagged', () => {
    // Same seven days the stale-rate notification uses, so the dot on the pill
    // and the alert in the bell cannot disagree.
    expect(src).toMatch(/const STALE_DAYS = 7/);
    expect(src).toMatch(/rates\.staleDays/);
  });

  test('it opens for everyone and only an admin may write', () => {
    expect(src).toMatch(/\{isAdmin && \(/);
  });
});

describe('one number per currency, every pair derived', () => {
  test('all six directions are on the panel', async () => {
    const text = (await mount()).textContent;

    for (const [a, b] of [['USD', 'LBP'], ['USD', 'EUR'], ['LBP', 'USD'],
                          ['EUR', 'USD'], ['EUR', 'LBP'], ['LBP', 'EUR']]) {
      expect(text, `${a}->${b}`).toContain(`1 ${a} =`);
      expect(text).toContain(b);
    }
  });

  test('a cross-rate is labelled as worked out, not typed', async () => {
    // So nobody goes hunting for where EUR→LBP was entered, or worse, tries
    // to enter it and gets a figure that fights the two dollar rates.
    const text = (await mount()).textContent;

    expect(text).toContain(en.rates.derived);
    expect(en.rates.derivedHint).toMatch(/dollar/i);
  });

  test('typing the other direction stores the same one number', () => {
    // A rate and its reciprocal are one agreement said twice. Storing both is
    // how they come to disagree, so the form inverts and stores one.
    expect(src).toMatch(/const perUsd = form\.invert \? 1 \/ typed : typed;/);
    expect(src).toMatch(/rates\.enterOtherWay/);
  });

  test('the label follows the direction, so the box says what it holds', () => {
    expect(src).toMatch(/form\.invert$/m);
    expect(en.rates.perOne).toMatch(/\{\{of\}\}.*\{\{unit\}\}/);
  });
});

describe('the date is the point', () => {
  test('every change is entered with the date it takes effect', async () => {
    expect(src).toMatch(/effective_date: form\.effective_date \|\| today\(\)/);
    expect((await mount()).querySelector('input[type="date"]')).toBeTruthy();
  });

  test('each pair shows when it started applying', async () => {
    expect(src).toMatch(/p\.since \? fmtDate\(p\.since\) : ''/);
  });

  test('recent changes name the date, the rate and who set it', async () => {
    const text = (await mount()).textContent;

    expect(text).toContain(en.rates.recentChanges);
    expect(text).toContain('Ali');
    expect(text).toContain('Parallel');
  });

  test('and it says plainly that history does not move', () => {
    expect(en.rates.historyHint).toMatch(/nothing already posted/i);
    expect(src).toMatch(/rates\.historyHint/);
  });
});

describe('it reads in both languages', () => {
  test('every string the panel asks for exists in each', () => {
    const keys = [...src.matchAll(/t\('(rates\.\w+)'/g)].map(m => m[1]);

    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(typeof lookup(en, k), `en ${k}`).toBe('string');
      expect(typeof lookup(ar, k), `ar ${k}`).toBe('string');
    }
  });

  test('the Arabic is Arabic and keeps the same placeholders', () => {
    const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
      .map(m => m[1]).sort().join(',');

    for (const [k, v] of Object.entries(en.rates)) {
      expect(ar.rates[k], `ar.rates.${k}`).toBeTruthy();
      expect(/[؀-ۿ]/.test(ar.rates[k]), k).toBe(true);
      expect(named(ar.rates[k]), k).toBe(named(v));
    }
  });
});

describe('Settings shows the same panel, not a second one', () => {
  test('the page renders the shared panel', async () => {
    const settingsSrc = (await import('../pages/Settings.jsx?raw')).default;

    expect(settingsSrc).toMatch(/<RateBookPanel \/>/);
    // And no longer carries its own form: the one it had took a rate with no
    // currency and no date, so a rate set there could not be found by the
    // dated lookup it was meant to feed.
    expect(settingsSrc).not.toMatch(/setExchangeRate/);
    expect(settingsSrc).not.toMatch(/settings\.newRate/);
  });
});

describe('it mounts', () => {
  test('with no rates set at all', async () => {
    const container = await mount({
      base_currency: 'USD', secondary_currency: 'LBP',
      current: null, rates: {}, pairs: [], history: [],
    });

    expect(container.textContent).toContain(en.rates.none);
  });
});
