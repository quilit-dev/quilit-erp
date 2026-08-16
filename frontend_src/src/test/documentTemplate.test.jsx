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

    expect(html).not.toContain('hj-frame');
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

    expect(html).toContain('hj-frame');
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
    expect(html).toContain('hj-frame');
    expect(html).toContain('Quotation');
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

  test('follows the currency the document is shown in', () => {
    // The document may be rendered in the secondary currency; the words have to
    // describe THAT figure, not the stored USD one.
    const html = buildInvoiceHTML(
      INVOICE, { ...BASE, show_total_words: '1' }, null,
      { displayCurrency: 'LBP', exchangeRate: { rate: 89000, secondary: 'LBP' } }).html;

    expect(html).toContain('Lebanese Pounds only');
    expect(html).not.toContain('Dollars only');
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
