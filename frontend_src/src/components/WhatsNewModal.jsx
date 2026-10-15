/**
 * The release note the customer actually reads.
 *
 * Eight things changed in the last few weeks and none of them announce
 * themselves: an Edit button that was not there before, a purchase that can now
 * hold more than one line, a report column. Staff find features like that by
 * accident, months late, or never — so this says it once, on the morning the
 * business was told to expect it.
 *
 * Two rules keep it from becoming furniture:
 *
 *   * It lives for ONE DAY. `SHOW_ON` is a single local calendar date; from the
 *     next morning the component returns null before it looks at anything else,
 *     so a note nobody got round to removing cannot go on greeting people with
 *     stale news. Retiring it is deleting the file and its two call sites.
 *   * It is dismissed PER USER, not per browser. A shop floor terminal is one
 *     browser shared by several people; keying on the signed-in user's id is
 *     what stops the first person through the door from dismissing it on
 *     everyone else's behalf.
 *
 * The date is computed from the LOCAL calendar, never toISOString(): east of
 * Greenwich that returns tomorrow's date all evening, which would have shown
 * this from Sunday 21:00 and hidden it from Monday 21:00 — the two hours of the
 * day it most needed to be up.
 */
import { useState } from 'react';
import { Modal } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import en from '../locales/en';
import ar from '../locales/ar';

// The one day this note is shown, as a local YYYY-MM-DD date.
export const SHOW_ON = '2026-10-16';
// Bumping this alongside SHOW_ON gives a future note a clean slate rather than
// inheriting the dismissals of this one.
export const RELEASE = '2026-10';

// What is new, then what was put right --- the two questions a user asks.
export const ADDED = [
  'returns', 'storeCredit', 'docDiscount', 'unitsSearch', 'quoteProduct',
  'profitSummary', 'exportPeriod', 'payrollPay', 'expensesOwed', 'documents', 'plainCopy',
];
export const FIXED = [
  'fixDueDate', 'fixBankPayment', 'fixExcelExport', 'fixVatExempt',
  'fixItemNames', 'fixPipeline', 'fixLetterhead', 'fixSignInLink',
];
// Something taken away is neither new nor a repair; it gets its own heading.
export const REMOVED = ['quoteToProject'];
export const ITEMS = [...ADDED, ...FIXED, ...REMOVED];

// The note carries its own language switch: an owner reading it in English
// can hand the screen to a cashier who reads Arabic, without changing the
// language of the whole system to do it.
const NOTE_LANGS = { en, ar };

/** `?whatsnew` in the address opens the note on any day, seen or not --- how
 *  the owner previews it before the morning it goes out. It records nothing,
 *  so the real showing on SHOW_ON is unaffected. */
export function previewRequested(search = window.location.search) {
  try { return new URLSearchParams(search).has('whatsnew'); } catch { return false; }
}

export function localToday(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function seenKey(userId) {
  return `whatsnew.${RELEASE}.seen.${userId}`;
}

export default function WhatsNewModal() {
  const { lang: appLang } = useLocale();
  const [lang, setLang] = useState(appLang === 'ar' ? 'ar' : 'en');
  const words = NOTE_LANGS[lang].whatsNew;
  const rtl = lang === 'ar';

  // Everything that decides whether this renders is settled once, on mount:
  // re-reading storage on every render would reopen the modal the instant it
  // was dismissed, and re-reading the clock would reopen it at midnight.
  const [preview] = useState(() => previewRequested());
  const [open, setOpen] = useState(() => {
    if (preview) return true;
    if (localToday() !== SHOW_ON) return false;
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (!user?.id) return false;           // signed out; Login has its own layout
      return localStorage.getItem(seenKey(user.id)) !== '1';
    } catch {
      // Storage blocked or the user blob is malformed. Say nothing: a release
      // note must never be the reason a page looks broken.
      return false;
    }
  });

  if (!open) return null;

  const dismiss = () => {
    setOpen(false);
    if (preview) return;            // a preview leaves the real showing alone
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (user?.id) localStorage.setItem(seenKey(user.id), '1');
    } catch { /* it closes either way; worst case it returns once more today */ }
  };

  const section = (heading, keys, colour) => (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700,
                   textTransform: 'uppercase', letterSpacing: rtl ? 0 : 0.6, color: colour }}>
        {heading}
      </h3>
      <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 10 }}>
        {keys.map(k => (
          <li key={k} style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text)' }}>{words[k]}</strong>
            <div style={{ color: 'var(--text-2)' }}>{words[`${k}Body`]}</div>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <Modal title={words.title} onClose={dismiss} size="modal-lg">
      <div className="modal-body" dir={rtl ? 'rtl' : 'ltr'} lang={lang}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13 }}>{words.intro}</p>
          <div role="group" aria-label="Language" style={{ display: 'flex', gap: 4 }} dir="ltr">
            {[['en', 'English'], ['ar', 'العربية']].map(([code, label]) => (
              <button key={code} type="button"
                className={`btn btn-sm ${lang === code ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={lang === code} onClick={() => setLang(code)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {section(words.added, ADDED, 'var(--affirm-ink)')}
        {section(words.fixed, FIXED, 'var(--info-ink)')}
        {section(words.removed, REMOVED, 'var(--text-2)')}
      </div>
      <div className="modal-footer">
        <button className="btn btn-primary" onClick={dismiss} autoFocus>
          {words.dismiss}
        </button>
      </div>
    </Modal>
  );
}
