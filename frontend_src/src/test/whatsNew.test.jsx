// The release note that shows for one day.
//
// Two things make it either useful or a nuisance, and both are asserted here.
//
// It must retire ITSELF. A note left up because nobody deleted the file is a
// dialog every user closes every morning, and the next real announcement is
// then something they dismiss without reading. So the day is the outermost
// gate: from Tuesday it renders nothing, whatever storage says.
//
// And it is dismissed per USER, not per browser. A shop terminal is one browser
// shared by several people; keyed the easy way, the first person in dismisses
// it for the whole shop and nobody else ever learns what changed.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import en from '../locales/en';
import ar from '../locales/ar';
import WhatsNewModal, { SHOW_ON, RELEASE, localToday } from '../components/WhatsNewModal';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'components', 'WhatsNewModal.jsx'), 'utf8');
const appSrc = readFileSync(join(here, '..', 'App.jsx'), 'utf8');

/** SHOW_ON, and its neighbours, as local Dates at midday — far from any
 *  timezone edge so the test asserts the rule, not the clock. */
const at = (dayOffset, hour = 12) => {
  const [y, m, d] = SHOW_ON.split('-').map(Number);
  return new Date(y, m - 1, d + dayOffset, hour, 0, 0);
};

const signIn = (id) => localStorage.setItem('user', JSON.stringify({ id, username: `u${id}` }));

const mount = () => render(<LocaleProvider><WhatsNewModal /></LocaleProvider>);
const dialog = () => screen.queryByText(en.whatsNew.title);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('erp_lang', 'en');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(at(0));
  signIn(7);
});
afterEach(() => { vi.useRealTimers(); });

describe('it appears on its one day', () => {
  test('a signed-in user sees it', () => {
    mount();
    expect(dialog()).toBeTruthy();
  });

  test('and every item is listed, not just the first few', () => {
    mount();
    for (const k of ['posEdit', 'purchaseEdit', 'purchaseLines', 'purchasePrepay',
                     'archiveVoided', 'paymentPlan', 'outstandingPdf',
                     'serviceTechnicians']) {
      expect(screen.queryByText(en.whatsNew[k]), `${k} is missing from the note`)
        .toBeTruthy();
    }
  });
});

describe('the day is the outermost gate', () => {
  test('nothing the day before', () => {
    vi.setSystemTime(at(-1));
    mount();
    expect(dialog()).toBeNull();
  });

  test('nothing the day after, even for a user who never saw it', () => {
    // The whole point: an undismissed note does NOT wait around for its reader.
    vi.setSystemTime(at(1));
    signIn(999);
    mount();
    expect(localStorage.getItem(`whatsnew.${RELEASE}.seen.999`), 'setup: never dismissed')
      .toBeNull();
    expect(dialog(), 'a note that outlives its day is furniture').toBeNull();
  });

  test('nothing a year later', () => {
    vi.setSystemTime(at(365));
    mount();
    expect(dialog()).toBeNull();
  });
});

describe('it is dismissed once, per user', () => {
  test('closing it hides it and records that user', () => {
    mount();
    fireEvent.click(screen.getByText(en.whatsNew.dismiss));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem(`whatsnew.${RELEASE}.seen.7`)).toBe('1');
  });

  test('it stays closed on the next page they open', () => {
    const { unmount } = mount();
    fireEvent.click(screen.getByText(en.whatsNew.dismiss));
    unmount();
    mount();
    expect(dialog(), 'navigating must not bring it back').toBeNull();
  });

  test("one user's dismissal is not everyone's", () => {
    // The shared-terminal case. Keyed per browser, this is the assertion that
    // fails and the colleague who never hears about the new features.
    mount();
    fireEvent.click(screen.getByText(en.whatsNew.dismiss));
    signIn(8);
    mount();
    expect(dialog(), 'the next person to sign in has not seen it').toBeTruthy();
  });
});

describe('it never breaks the page it sits on', () => {
  test('signed out, it renders nothing', () => {
    localStorage.removeItem('user');
    mount();
    expect(dialog()).toBeNull();
  });

  test('a malformed user blob renders nothing rather than throwing', () => {
    localStorage.setItem('user', 'not json');
    expect(() => mount()).not.toThrow();
    expect(dialog()).toBeNull();
  });
});

describe('the date is the local calendar, not UTC', () => {
  test('the whole of the local day counts, from midnight to midnight', () => {
    // toISOString() would return the NEXT date all evening east of Greenwich —
    // hiding this from 21:00 on the day it was announced, and showing it from
    // 21:00 the night before.
    expect(localToday(at(0, 0))).toBe(SHOW_ON);
    expect(localToday(at(0, 23))).toBe(SHOW_ON);
    expect(localToday(at(-1, 23))).not.toBe(SHOW_ON);
    expect(localToday(at(1, 0))).not.toBe(SHOW_ON);
  });

  test('the source does not reach for toISOString', () => {
    // The prose above the component says why; this pins the code itself.
    expect(src).not.toMatch(/\.toISOString\(/);
  });
});

describe('wiring and translation', () => {
  test('it is mounted in the authenticated layout', () => {
    expect(appSrc).toMatch(/import WhatsNewModal from '\.\/components\/WhatsNewModal'/);
    expect(appSrc).toMatch(/<WhatsNewModal \/>/);
  });

  test.each(['title', 'intro', 'dismiss',
             'posEdit', 'posEditBody',
             'purchaseEdit', 'purchaseEditBody',
             'purchaseLines', 'purchaseLinesBody',
             'purchasePrepay', 'purchasePrepayBody',
             'archiveVoided', 'archiveVoidedBody',
             'paymentPlan', 'paymentPlanBody',
             'outstandingPdf', 'outstandingPdfBody',
             'serviceTechnicians', 'serviceTechniciansBody'])(
    'whatsNew.%s is written in both languages', (k) => {
      expect(en.whatsNew[k], `en.whatsNew.${k}`).toBeTruthy();
      expect(ar.whatsNew[k], `ar.whatsNew.${k}`).toBeTruthy();
      expect(ar.whatsNew[k], `ar.whatsNew.${k} is still English`).not.toBe(en.whatsNew[k]);
    });
});
