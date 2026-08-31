// The copy of a hajosign invoice that gets sent to the customer.
//
// This is the one document where the ERP draws the letterhead rather than
// leaving room for it: `_company()` deliberately withholds
// `preprinted_stationery` from the share payload, because the person opening
// the link has none of the supplier's paper. So everything the stationery
// carries in ink — frame, mark, wordmark, contact strip — has to be drawn here,
// and has to match the printed article.
//
// Three things were wrong with it, all only visible on this path:
//
//   * the contact strip came from settings, which had drifted away from what is
//     printed on the paper — a different website spelling, a personal mailbox;
//   * the frame is drawn to the paper edge, which is right for a commercial
//     press and impossible on an office printer, so the top band vanished when
//     a customer printed it;
//   * the mark was 14.5mm, which is a smudge on the phone this is read on.
import { describe, test, expect } from 'vitest';
import { THEMES } from '../utils/documentThemes';
import { buildInvoiceHTML } from '../utils/exportUtils';
import themeSrc from '../utils/documentThemes.js?raw';

const css = THEMES.hajosign.css;

// Settings deliberately carrying the STALE values, to prove they cannot win.
const SETTINGS = {
  company_name: 'Hajo Sign',
  company_tagline: 'Signs & Printing',
  company_phone: '+961 00000000',
  company_email: 'stale@example.com',
  company_website: 'www.stale-example.com',
  company_address: 'Somewhere Else, Another Street',
  default_currency: 'USD',
  document_template: 'hajosign',
  // no preprinted_stationery — this is the shared copy
};
const INVOICE = {
  id: 7, invoice_number: 'INV-2026-0007', created_at: '2026-08-06T13:07:00Z',
  client: { name: 'A Client' },
  items: [{ name: 'Flex Roll 320cm', quantity: 1, unit_price: 1200 }],
  payments: [],
};
const html = buildInvoiceHTML(INVOICE, SETTINGS).html;

const mm = (prop, sel) => {
  const m = css.match(new RegExp(`${sel}[^}]*${prop}:\\s*([\\d.]+)mm`));
  return m ? parseFloat(m[1]) : null;
};

describe('the contact strip matches the printed paper', () => {
  test.each([
    '+961 71771441', '+961 79177441',
    'www.hajosign.com', 'info@hajosign.com',
    'Beirut - St. Michael Church', 'Fawaz Center - First floor',
  ])('shows %s', (line) => {
    expect(html).toContain(line);
  });

  test('settings cannot override what is printed in ink', () => {
    // The whole point: the customer holding the paper and the customer opening
    // the link must see one company, and only one of those two can be edited.
    for (const stale of ['+961 00000000', 'stale@example.com',
                         'www.stale-example.com', 'Another Street']) {
      expect(html, stale).not.toContain(stale);
    }
  });

  test('the strip is built without reading settings at all', () => {
    expect(themeSrc).toMatch(/function hajoContacts\(\)/);
    expect(themeSrc).toMatch(/const \{ phones, web, place \} = HAJO_CONTACT;/);
  });
});

describe('the mark is big enough to read on a phone', () => {
  test('it is drawn larger than the original artwork measurement', () => {
    // The print file has it at 14.5mm; that is a commercial press's problem,
    // not a phone screen's.
    const size = parseFloat(themeSrc.match(/logoSize: ([\d.]+)/)[1]);
    expect(size).toBeGreaterThan(14.5);
  });

  test('the lockup keeps its original spacing', () => {
    // 4.4mm from the mark to the wordmark, 6.0mm to the tagline. Growing the
    // mark without moving the rest down would have overlapped them.
    const n = (k) => parseFloat(themeSrc.match(new RegExp(`${k}: ([\\d.]+)`))[1]);
    expect(n('wordTop') - n('logoTop') - n('logoSize')).toBeCloseTo(4.4, 1);
    expect(n('tagTop') - n('wordTop') - n('wordHeight')).toBeCloseTo(6.0, 1);
  });

  test('the text still starts below the masthead', () => {
    // The masthead grew, so the clearance had to grow with it or the first
    // line of the invoice lands on the tagline.
    const n = (k) => parseFloat(themeSrc.match(new RegExp(`${k}: ([\\d.]+)`))[1]);
    const mastheadEnds = n('tagTop') + n('tagHeight');
    const contentStarts = mm('height', '\\.hj-sheet > thead > tr > td');
    expect(contentStarts).toBeGreaterThan(mastheadEnds);
    expect(contentStarts - mastheadEnds).toBeGreaterThan(4);   // real clearance
  });
});

describe('the frame survives an office printer', () => {
  test('print pulls the letterhead inside the unprintable border', () => {
    // No desk printer reaches the paper edge; at full bleed the top band was
    // simply cut off the page.
    const printBlock = css.slice(css.indexOf('@media print'));
    expect(printBlock).toMatch(/\.hj-sheet-art \{\s*transform: scale\(0?\.\d+\)/);
    expect(printBlock).toMatch(/transform-origin: 50% 50%/);
  });

  test('the scale leaves a believable margin, and is not a redesign', () => {
    const s = parseFloat(themeSrc.match(/const BLEED_SAFE = ([\d.]+)/)[1]);
    expect(s).toBeLessThan(1);            // actually pulls in
    expect(s).toBeGreaterThan(0.9);       // ...but only to the border
    const marginMM = 210 * (1 - s) / 2;
    expect(marginMM).toBeGreaterThan(4);  // clears a typical 4-6mm border
  });

  test('only the artwork is scaled, never the text', () => {
    // Scaling the content too would undo the clearances that keep it off the
    // artwork, and shrink the type the customer asked to have enlarged.
    const printBlock = css.slice(css.indexOf('@media print'));
    expect(printBlock).not.toMatch(/\.hj-inner[^}]*transform/);
    expect(printBlock).not.toMatch(/\.hj-sheet \{[^}]*transform/);
  });

  test('the screen copy keeps its full bleed', () => {
    const screen = css.slice(0, css.indexOf('@media print'));
    expect(screen).not.toMatch(/\.hj-sheet-art[^}]*transform: scale/);
  });
});
