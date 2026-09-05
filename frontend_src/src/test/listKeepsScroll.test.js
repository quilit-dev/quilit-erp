// A refresh must not throw the user back to the top of the page.
//
// Every list page follows the same shape: an action saves, then calls `load()`,
// which sets `loading = true` and refetches. While that flag is up the render
// was `{loading ? <LoadingSpinner /> : ...the table...}` — so the entire table
// came out of the DOM. A 25-row table is well over a screen tall; replacing it
// with a spinner collapses the document below the viewport height, and the
// browser then clamps `scrollTop` to the new maximum, which is ~0. When the
// rows come back a moment later the height returns but the scroll position is
// gone. Edit the 40th item and you are reading the 1st.
//
// Nothing in the code scrolls anywhere — `grep -r scrollTo` finds only two
// `scrollIntoView` calls in comboboxes — so there is no scroll restore to fix.
// The fix is to stop unmounting: show the spinner only when there is nothing on
// screen yet. The rows stay, the height stays, and the browser has no reason to
// move. Several pages already did it this way (accounting/Journal,
// accounting/FxDifferences, clients/AccountPlan); this makes it uniform.
//
// The trade-off, accepted deliberately: a search keystroke now shows the
// previous results until the new ones land, instead of a spinner flash. Stale
// for 200ms beats losing your place.
//
// This is a stylesheet-and-source test rather than a rendering one because
// jsdom does no layout — it has no scroll height to clamp, so the bug is not
// reproducible there. What IS checkable is the condition that caused it.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(src, p), 'utf8');

/** Surfaces where a save/refresh happens under a list the user scrolls.
 *  [file, the expression that says "there is already something on screen"] */
const LISTS = [
  ['pages/Inventory.jsx',                  '!items.length'],
  ['pages/Clients.jsx',                    '!sorted.length'],
  ['pages/Invoices.jsx',                   '!pagedInvoices.length'],
  ['pages/Quotations.jsx',                 '!pagedQuotations.length'],
  ['pages/Purchases.jsx',                  '!filtered.length'],
  ['pages/Expenses.jsx',                   '!filtered.length'],
  ['pages/FixedAssets.jsx',                '!filtered.length'],
  ['pages/Suppliers.jsx',                  '!filtered.length'],
  ['pages/Projects.jsx',                   '!filtered.length'],
  ['pages/Promotions.jsx',                 '!promos.length'],
  ['pages/HR.jsx',                         '!emps.length'],
  ['pages/RoleManagement.jsx',             '!roles.length'],
  ['pages/UserManagement.jsx',             '!users.length'],
  ['pages/ApprovalPolicies.jsx',           '!safePolicies.length'],
  ['pages/ApprovalRequests.jsx',           '!safeReqs.length'],
  ['pages/crm/ActivitiesTab.jsx',          '!activities?.length'],
  ['pages/crm/ContactsTab.jsx',            '!contacts?.length'],
  ['pages/crm/LeadsTab.jsx',               '!leads?.length'],
  ['pages/crm/PipelineTab.jsx',            '!activeDeals.length'],
  ['pages/hr/ContractsSection.jsx',        '!list.length'],
  ['components/RecurringExpensesPanel.jsx', '!(templates || []).length'],
];

describe('a refresh keeps the rows on screen', () => {
  test.each(LISTS)('%s gates its spinner on being empty', (file, guard) => {
    const text = read(file);
    expect(text, `${file}: expected \`loading && ${guard} ? <LoadingSpinner />\``)
      .toContain(`loading && ${guard} ? <LoadingSpinner />`);
  });

  test.each(LISTS)('%s has no bare `loading ?` spinner left over', (file) => {
    const text = read(file);
    // A second, ungated branch elsewhere in the same file would reintroduce
    // the unmount on whichever tab it renders.
    const bare = text.match(/\{\s*loading\s*\?\s*<LoadingSpinner/g) || [];
    expect(bare, `${file}: ${bare.length} ungated spinner branch(es)`).toHaveLength(0);
  });

  test('the guard expression names a variable the file actually has', () => {
    // A typo here fails open: `!itmes.length` throws at render, but a guard on
    // a variable that is always empty silently restores the old behaviour.
    for (const [file, guard] of LISTS) {
      const name = guard.replace(/^!\(?/, '').split(/[.?\s|)]/)[0];
      expect(read(file), `${file}: no declaration of \`${name}\``)
        .toMatch(new RegExp(`(const|let|var)\\s*[[{]?[^;\\n]*\\b${name}\\b`));
    }
  });
});

describe('Announcements gates its three branches together', () => {
  // It renders the spinner and the two tab bodies as three sibling
  // expressions, so all three have to agree or the list and the spinner show
  // at once — or neither does.
  const text = read('pages/Announcements.jsx');

  test('firstLoad is derived from the visible tab', () => {
    expect(text).toMatch(/const firstLoad = loading && !\(tab === 'inbox' \? filtered\.length : \(sent \|\| \[\]\)\.length\)/);
  });

  test('all three branches use it', () => {
    expect(text).toContain('{firstLoad && <LoadingSpinner />}');
    expect(text).toContain("{!firstLoad && tab === 'inbox' &&");
    expect(text).toContain("{!firstLoad && tab === 'sent' &&");
    expect(text).not.toMatch(/\{!loading && tab ===/);
  });
});
