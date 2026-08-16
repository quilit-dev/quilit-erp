// One company's letterhead, and the two document features that are everyone's.
//
// The property that matters most here is the NEGATIVE one: introducing a
// custom design for one tenant must leave every other tenant's invoices exactly
// as they were. A styling change that leaks across tenants would put one
// business's branding on another's documents — which is not a cosmetic bug, it
// is a company sending out paper that misrepresents who issued it.
//
// The second property is that `document_template` is presentation only. A theme
// may change how a document looks and must never change what it says, so the
// figures, the client and the reference are asserted identical across both.
import { describe, test, expect } from 'vitest';
import { buildInvoiceHTML, buildQuotationHTML } from '../utils/exportUtils';
import { themeFor, THEMES } from '../utils/documentThemes';
import { amountInWords } from '../utils/numberToWords';

const BASE = {
  company_name: 'Hajo Sign',
  company_tagline: 'Signs & Printing',
  company_phone: '+961 71771441 / +961 79177441',
  company_email: 'hajo.sign@gmail.com',
  company_website: 'www.hajo-sign.com',
  company_address: 'Beirut, St. Michael Church, Fawaz Center',
  default_currency: 'USD',
  payment_terms_days: '15',
};

const INVOICE = {
  id: 7,
  invoice_number: 'INV-2026-0007',
  created_at: '2026-08-06T13:07:00Z',
  client: { name: 'مديرية الشؤون الجغرافية' },
  items: [
    { name: 'Flex Roll 320cm', quantity: 1, unit_price: 1200, barcode: '1000387' },
    { name: 'Backlit Roll 100cm', quantity: 2, unit_price: 300, barcode: null },
  ],
  payments: [],
};

const QUOTE = {
  id: 3,
  quote_number: 'QTN-2026-0003',
  created_at: '2026-08-06T13:07:00Z',
  client: { name: 'A Client' },
  items: [{ name: 'Vinyl roll 107cm', quantity: 3, unit_price: 40, barcode: '1000400' }],
};

const build = (settings, doc = INVOICE) => buildInvoiceHTML(doc, settings).html;

// Assertions about what a document SAYS must look at the markup, not the whole
// file: the <style> block is full of words that would satisfy a naive substring
// search and produce a test that passes for the wrong reason.
const body = (...args) => build(...args).split('</head>')[1] || '';

describe('themeFor', () => {
  test('no template key means the generic design', () => {
    expect(themeFor({})).toBeNull();
    expect(themeFor({ document_template: '' })).toBeNull();
    expect(themeFor({ document_template: 'default' })).toBeNull();
    expect(themeFor(undefined)).toBeNull();
  });

  test('an unknown template falls back rather than rendering half a design', () => {
    // A typo in vendor_config, or a tenant pointed at a theme that was removed,
    // must produce a correct generic invoice — not a broken branded one.
    expect(themeFor({ document_template: 'no-such-theme' })).toBeNull();
  });

  test('a known template resolves', () => {
    expect(themeFor({ document_template: 'hajosign' })).toBe(THEMES.hajosign);
  });
});

describe('the design reaches only the tenant it belongs to', () => {
  test('another tenant gets no trace of it', () => {
    const html = build(BASE);

    expect(html).not.toContain('hj-sheet');     // its page structure
    expect(html).not.toContain('hj-masthead');
    expect(html).not.toContain('F07100');       // the letterhead orange
    expect(html).not.toContain('hj-art');       // its artwork
    expect(html).toContain('doc-header');       // the generic header, intact
  });

  test('the generic document is byte-identical with and without the key', () => {
    // The strongest form of "nobody else changed": adding the plumbing must not
    // have moved a single character for a tenant that has no theme.
    expect(build({ ...BASE, document_template: 'default' })).toBe(build(BASE));
  });

  test('the themed tenant gets the letterhead', () => {
    const html = build({ ...BASE, document_template: 'hajosign' });

    expect(html).toContain('hj-sheet');
    expect(html).toContain('hj-masthead');
    expect(html).toContain('hj-foot');
    expect(html).toContain('Sales Invoice');
    // Replaced, not layered on top. Matching the class ATTRIBUTE, not the
    // string: SHARED_CSS still defines .doc-header, and a bare substring search
    // would pass on the stylesheet while the markup was wrong.
    expect(html).not.toContain('class="doc-header"');
    expect(html).not.toContain('class="info-grid"');
  });

  test('quotations are themed too', () => {
    const html = buildQuotationHTML(QUOTE, { ...BASE, document_template: 'hajosign' }).html;
    expect(html).toContain('hj-sheet');
    expect(html).toContain('Quotation');
  });
});

// The first version of this letterhead printed a one-line invoice as two broken
// pages: the artwork stranded at the foot of page one, the contact strip alone
// on page two. The cause was `position: fixed`, which reads as the obvious way
// to pin something to every sheet and is not — Chrome lays a fixed element out
// once, against the first page. The mechanism browsers DO honour is a repeated
// thead. These pin the structure that fixed it, because the failure is only
// visible in a real print and nothing else here would catch a regression.
describe('the letterhead repeats on every printed sheet', () => {
  const themed = build({ ...BASE, document_template: 'hajosign' });

  test('the page is a table with a thead and a tfoot', () => {
    expect(themed).toMatch(/<table class="hj-sheet">\s*<thead>/);
    expect(themed).toContain('<tfoot>');
  });

  test('the whole letterhead hangs off the thead, not the tfoot', () => {
    // The tfoot only reserves the foot margin. On a short final page it sits
    // directly under the last row, so anything positioned against it lands in
    // the middle of the paper — which is exactly where the contact strip and
    // the bottom bar ended up before.
    const thead = themed.split('<thead>')[1].split('</thead>')[0];
    const tfoot = themed.split('<tfoot>')[1].split('</tfoot>')[0];

    for (const part of ['hj-masthead', 'hj-art', 'hj-watermark', 'hj-foot']) {
      expect(thead).toContain(part);
    }
    expect(tfoot.trim()).toBe('<tr><td></td></tr>');
  });

  test('nothing in the theme relies on fixed positioning', () => {
    // Scoped to the theme's own stylesheet. SHARED_CSS still pins the GENERIC
    // template's footer that way — which this theme hides in print — so
    // searching the whole document would fail on somebody else's rule.
    expect(THEMES.hajosign.css).not.toContain('position: fixed');
  });

  test('the sheet is pinned to a full page so the foot reaches the paper', () => {
    // A table treats height as a minimum: it holds the contact strip at the
    // bottom of a short invoice and still lets a long one grow across pages.
    expect(themed).toContain('height: 297mm');
  });

  test('the bleed is clipped at the paper edge', () => {
    // Not cosmetic. The artwork's paths deliberately overrun the trim, and
    // although the SVG clips what it paints, the paths still counted toward the
    // document's scroll width — so Chrome shrank the ENTIRE page by 210/215.11
    // to fit, and every measurement on the sheet came out 2.4% small. Clipping
    // the art box is what keeps the printed page at 1:1.
    expect(THEMES.hajosign.css).toMatch(/\.hj-sheet-art\s*\{[^}]*overflow:\s*hidden/);
  });

  test('printing leaves no page margin for the artwork to be inset by', () => {
    // The bands bleed to the paper edge, so the page box has to BE the paper.
    // A non-zero margin here would also let the browser print its own header
    // and footer over the design.
    expect(themed).toMatch(/@page \{ margin: 0; size: A4; \}/);
  });
});

// The first letterhead shipped without either: no monogram on the masthead and
// no watermark, because both were driven purely by the tenant's uploaded logo
// and nobody had uploaded one. The mark belongs to this letterhead the same way
// the orange chevrons do, so a sheet must never arrive with a hole where the
// identity goes.
describe('the monogram', () => {
  const UPLOADED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  test('the letterhead supplies its own when none is uploaded', () => {
    const html = build({ ...BASE, document_template: 'hajosign' });

    expect(html).toContain('class="hj-logo"');
    expect(html).toContain('class="hj-watermark"');
    expect(html).toContain('data:image/svg+xml');   // the traced mark, inline
  });

  test("an uploaded logo wins, on the masthead and the watermark alike", () => {
    const html = buildInvoiceHTML(
      INVOICE, { ...BASE, document_template: 'hajosign' }, UPLOADED).html;

    const imgs = html.match(/<img class="hj-(?:logo|watermark)" src="([^"]*)"/g) || [];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img).toContain(UPLOADED);
    expect(html).not.toContain('data:image/svg+xml');  // fallback stood aside
  });

  test('it does not leak onto the generic template', () => {
    // A tenant with no theme and no logo still gets no logo — the mark is one
    // company's, and must not appear on anybody else's invoice.
    expect(build(BASE)).not.toContain('data:image/svg+xml');
  });
});

// The customer prints onto paper that already carries the letterhead, so their
// own export must put nothing but data on it. Printing the design again would
// lay ink over ink, and since no printer feeds a sheet within a tenth of a
// millimetre, the second impression would sit slightly off the first and show
// as a doubled edge.
describe('pre-printed stationery', () => {
  const ON = { ...BASE, document_template: 'hajosign', preprinted_stationery: '1' };

  test('the design is left off', () => {
    // Markup, not the whole file: the theme's stylesheet still defines these
    // classes, and a search over the document would match the CSS while the
    // page was in fact printing the design.
    const markup = body(ON);

    for (const part of ['hj-art', 'hj-masthead', 'hj-watermark', 'hj-foot']) {
      expect(markup, `${part} would print over the pre-printed sheet`)
        .not.toContain(`class="${part}`);
    }
    expect(markup).toContain('<thead><tr><td></td></tr></thead>');
  });

  test('but the margins are unchanged, so the data still lands in the blank area', () => {
    // The whole point: the text has to fall exactly where the paper is empty.
    // If turning this on moved the content, it would print over the letterhead
    // it was meant to avoid.
    expect(build(ON)).toContain('height: 50mm');       // thead reservation
    expect(build(ON)).toContain('height: 32mm');       // tfoot reservation
    expect(build(ON)).toContain('padding: 0 16mm');    // side margins
  });

  test('the document still says everything it said', () => {
    const html = build(ON);
    for (const needle of ['INV-2026-0007', 'Flex Roll 320cm', '1,800.00', 'Sales Invoice']) {
      expect(html).toContain(needle);
    }
  });

  test('a customer opening the share link still gets the design', () => {
    // The public payload deliberately withholds this setting, because it
    // describes the SUPPLIER's paper. Simulated here by its absence.
    const shared = body({ ...BASE, document_template: 'hajosign' });
    expect(shared).toContain('class="hj-art');
    expect(shared).toContain('class="hj-masthead"');
  });

  test('it does nothing to a tenant with no letterhead', () => {
    expect(build({ ...BASE, preprinted_stationery: '1' })).toBe(build(BASE));
  });
});

describe('currencies with no minor unit', () => {
  const LBP = { ...BASE, default_currency: 'LBP', show_total_words: '1' };

  test('LBP prints whole, not to two decimals', () => {
    // "LBP 12,172,000.00" has nothing the .00 could refer to, and makes an
    // eight-digit figure two characters harder to read.
    const html = buildInvoiceHTML(
      { ...INVOICE, items: [{ name: 'Flex Roll 320cm', quantity: 1, unit_price: 12172000 }] },
      LBP).html;

    expect(html).toContain('12,172,000');
    expect(html).not.toContain('12,172,000.00');
  });

  test('USD still prints its cents', () => {
    expect(build(BASE)).toContain('1,800.00');
  });

  test('the words agree with the figure', () => {
    const html = buildInvoiceHTML(
      { ...INVOICE, items: [{ name: 'x', quantity: 1, unit_price: 12172000 }] }, LBP).html;

    expect(html).toContain('12,172,000');
    expect(html).toContain('Twelve million one hundred seventy-two thousand Lebanese Pounds only');
  });

  test('the converted view was already right and stays right', () => {
    const html = buildInvoiceHTML(INVOICE, { ...BASE }, null,
      { displayCurrency: 'LBP', exchangeRate: { rate: 89000, secondary: 'LBP' } }).html;
    expect(html).not.toMatch(/LBP[^<]*\.\d\d/);
  });
});

describe('a theme changes presentation, never the figures', () => {
  const plain = build(BASE);
  const themed = build({ ...BASE, document_template: 'hajosign' });

  test.each([
    ['the reference', 'INV-2026-0007'],
    ['the client', 'مديرية الشؤون الجغرافية'],
    ['a line item', 'Flex Roll 320cm'],
    ['the grand total', '1,800.00'],
  ])('%s survives the theme', (_what, needle) => {
    expect(plain).toContain(needle);
    expect(themed).toContain(needle);
  });
});

describe('barcode column', () => {
  test('absent by default', () => {
    const html = build(BASE);
    expect(html).not.toContain('>Barcode<');
    expect(html).not.toContain('1000387');
  });

  test('appears when switched on, for any tenant', () => {
    const html = build({ ...BASE, show_barcode_col: '1' });
    expect(html).toContain('>Barcode<');
    expect(html).toContain('1000387');
  });

  test('a hand-typed line shows a dash, not a neighbour\'s code', () => {
    // Lines with no inventory link (a delivery charge, a one-off service) have
    // no barcode. Anything other than a dash there would be a code that scans
    // as the wrong product.
    const html = build({ ...BASE, show_barcode_col: '1' });
    const rows = html.split('<tr>').filter(r => r.includes('Backlit Roll'));
    expect(rows[0]).toContain('—');
  });

  test('it is independent of the letterhead', () => {
    // The two were asked for together but are separate features: a tenant with
    // no theme can have barcodes, and a themed tenant can have none.
    expect(build({ ...BASE, show_barcode_col: '1' })).toContain('>Barcode<');
    expect(build({ ...BASE, document_template: 'hajosign' })).not.toContain('>Barcode<');
  });
});

describe('total in words', () => {
  test('absent by default', () => {
    expect(body(BASE)).not.toContain(' only');
  });

  test('states the same amount the totals box prints', () => {
    const html = build({ ...BASE, show_total_words: '1' });
    expect(html).toContain('1,800.00');
    expect(html).toContain('One thousand eight hundred Dollars only');
  });

  // This is THE assertion for this feature, and the first version of it was
  // worthless: it checked the words said "Lebanese Pounds" and never that they
  // described the printed figure. An invoice went out reading
  // "Balance LBP 1,780,000" over "Twenty Lebanese Pounds only" — right
  // currency, wrong amount — because the box converted the total and the words
  // spelled the unconverted one. Assert the number, not the noun.
  const grandTotalOf = html => {
    const row = html.split('totals-row grand')[1] || '';
    const m = row.match(/>([^<]*[\d,][^<]*)<\/span>\s*<\/div>/);
    return (m ? m[1] : '').replace(/[^\d.]/g, '');
  };
  const wordsOf = html => (html.match(/([A-Z][^<]*? only)/) || [])[1] || '';

  test.each([
    ['no conversion, USD',   undefined,                        'USD'],
    ['converted to LBP',     { rate: 89000, secondary: 'LBP' }, 'LBP'],
    ['a different rate',     { rate: 15000, secondary: 'LBP' }, 'LBP'],
  ])('the words describe the printed figure — %s', (_label, exchangeRate, code) => {
    const html = buildInvoiceHTML(
      INVOICE, { ...BASE, show_total_words: '1' }, null,
      exchangeRate ? { displayCurrency: 'LBP', exchangeRate } : {}).html;

    const printed = Number(grandTotalOf(html));
    expect(printed, 'could not read the grand total back out').toBeGreaterThan(0);

    // Spelled independently from the figure the document actually prints.
    expect(wordsOf(html)).toBe(amountInWords(printed, code));
  });

  test('the reported case: 20 USD at 89,000 is not "twenty"', () => {
    const html = buildInvoiceHTML(
      { ...INVOICE, items: [{ name: 'x', quantity: 1, unit_price: 20 }] },
      { ...BASE, show_total_words: '1' }, null,
      { displayCurrency: 'LBP', exchangeRate: { rate: 89000, secondary: 'LBP' } }).html;

    expect(html).toContain('1,780,000');
    expect(html).toContain('One million seven hundred eighty thousand Lebanese Pounds only');
    expect(html).not.toContain('Twenty Lebanese Pounds only');
  });

  test('appears on quotations as well', () => {
    const html = buildQuotationHTML(QUOTE, { ...BASE, show_total_words: '1' }).html;
    expect(html).toContain('One hundred twenty Dollars only');
  });

  test('is independent of the letterhead', () => {
    expect(body({ ...BASE, show_total_words: '1' })).toContain(' only');
    expect(body({ ...BASE, document_template: 'hajosign' })).not.toContain(' only');
  });
});
