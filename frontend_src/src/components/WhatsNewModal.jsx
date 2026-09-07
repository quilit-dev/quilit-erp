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

// The one day this note is shown, as a local YYYY-MM-DD date.
export const SHOW_ON = '2026-09-07';
// Bumping this alongside SHOW_ON gives a future note a clean slate rather than
// inheriting the dismissals of this one.
export const RELEASE = '2026-09';

const ITEMS = [
  'posEdit', 'purchaseEdit', 'purchaseLines', 'purchasePrepay',
  'archiveVoided', 'paymentPlan', 'outstandingPdf', 'serviceTechnicians',
];

export function localToday(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function seenKey(userId) {
  return `whatsnew.${RELEASE}.seen.${userId}`;
}

export default function WhatsNewModal() {
  const { t } = useLocale();

  // Everything that decides whether this renders is settled once, on mount:
  // re-reading storage on every render would reopen the modal the instant it
  // was dismissed, and re-reading the clock would reopen it at midnight.
  const [open, setOpen] = useState(() => {
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
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (user?.id) localStorage.setItem(seenKey(user.id), '1');
    } catch { /* it closes either way; worst case it returns once more today */ }
  };

  return (
    <Modal title={t('whatsNew.title')} onClose={dismiss} size="modal-lg">
      <div className="modal-body">
        <p style={{ margin: '0 0 16px', color: 'var(--text-2)', fontSize: 13 }}>
          {t('whatsNew.intro')}
        </p>
        <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 12 }}>
          {ITEMS.map(k => (
            <li key={k} style={{ fontSize: 13, lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text)' }}>{t(`whatsNew.${k}`)}</strong>
              <div style={{ color: 'var(--text-2)' }}>{t(`whatsNew.${k}Body`)}</div>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-footer">
        <button className="btn btn-primary" onClick={dismiss} autoFocus>
          {t('whatsNew.dismiss')}
        </button>
      </div>
    </Modal>
  );
}
