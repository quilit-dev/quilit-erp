// A wrong account is corrected with a new linked entry, never by editing the
// posted line; a document's entry is not reversed behind the document's back.
import { describe, test, expect } from 'vitest';
import journalSrc from '../pages/accounting/Journal.jsx?raw';
import clientSrc from '../api/client.js?raw';

describe('the journal entry detail', () => {
  test('offers Reclassify on any live entry, Reverse only on one with no live document', () => {
    expect(journalSrc).toMatch(/const fromDocument = !!entry\.source_type && entry\.source_type !== 'manual'/);
    expect(journalSrc).toMatch(/const reversible = live && !fromDocument/);
    expect(journalSrc).toMatch(/\{canEdit && live && <button[^>]*onClick=\{onReclassify\}/);
    expect(journalSrc).toMatch(/t\('accounting\.reverseViaDocument'\)/);
  });
  test('shows the correction chain from either end', () => {
    expect(journalSrc).toMatch(/entry\.reclassifies && \(/);
    expect(journalSrc).toMatch(/entry\.reclassified_by\?\.length > 0 && \(/);
  });
});

describe('the reclassification form', () => {
  test('moves from an account on the entry to a postable one, with a reason', () => {
    expect(journalSrc).toMatch(/function ReclassifyModal\(/);
    expect(journalSrc).toMatch(/\.filter\(a => Math\.abs\(a\.net\) > 0\.004\)/);
    expect(journalSrc).toMatch(/a\.is_postable !== 0 && a\.is_postable !== false/);
    expect(journalSrc).toMatch(/moving <= max \+ 0\.005 && reason\.trim\(\)/);
    expect(clientSrc).toMatch(/reclassifyJournalEntry = \(id, d\) => api\.post\(`\/api\/accounting\/journal-entries\/\$\{id\}\/reclassify`, d\)/);
  });
});
