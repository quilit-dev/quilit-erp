// Printing onto paper that already has a letterhead on it.
//
// hajosign feeds pre-printed sheets. The ERP suppresses the artwork for them —
// printing it again would lay ink over ink — but it still has to leave the
// space, because the design is on the paper whether we drew it or not. The
// clearance that was there (50mm) was measured against the letterhead THIS
// system draws, and the real sheet's logo reaches further down, so the first
// line of text was landing on it.
//
// Two numbers move together for all five document types: invoices,
// quotations, receipt vouchers, work orders, and the statement of account.
// The last is the one that is easy to miss — it is not a themed document at
// all, it goes through the generic report builder, so it needed the clearance
// wiring in separately.
//
// The hard requirement underneath all of it: nothing here may change what any
// other tenant prints.
import { describe, test, expect } from 'vitest';
import { THEMES, themeFor, reportPrint } from '../utils/documentThemes';
import exportSrc from '../utils/exportUtils.js?raw';
import voucherSrc from '../utils/receiptVoucher.js?raw';
import workOrderSrc from '../utils/workOrder.js?raw';
import themeSrc from '../utils/documentThemes.js?raw';

const css = THEMES.hajosign.css;

const mm = (name) => {
  // e.g. ".hj-sheet--preprinted > thead > tr > td { height: 62mm; }"
  const m = css.match(new RegExp(`${name}[^}]*height:\\s*([\\d.]+)mm`));
  return m ? parseFloat(m[1]) : null;
};

describe('the clearance for pre-printed paper', () => {
  test('is larger than the one for the letterhead we draw ourselves', () => {
    const drawn = mm('\\.hj-sheet > thead > tr > td');
    const preprinted = mm('\\.hj-sheet--preprinted > thead > tr > td');
    expect(drawn).toBeGreaterThan(0);
    expect(preprinted).toBeGreaterThan(drawn);
  });

  test('every themed document asks for it when the paper is pre-printed', () => {
    // Invoice and quotation share one builder; the voucher has two.
    for (const [src, name] of [[exportSrc, 'exportUtils'],
                               [voucherSrc, 'receiptVoucher'],
                               [workOrderSrc, 'workOrder']]) {
      expect(src, name).toMatch(/hj-sheet\$\{C\.preprinted \? ' hj-sheet--preprinted' : ''\}/);
      // and no bare sheet table left behind
      expect(src, `${name} has an unconverted table`).not.toMatch(/class="hj-sheet"/);
    }
  });

  test('the statement of account gets it too, via the report builder', () => {
    // It is not a themed document, so it would otherwise print at the top of
    // the sheet, straight onto the customer's logo.
    expect(exportSrc).toMatch(/const rp = reportPrint\(settings\)/);
    expect(exportSrc).toMatch(/\$\{rp \? `\$\{rp\.topMM\}mm 22px 18px` : '18px 22px'\}/);
  });
});

describe('the text prints larger', () => {
  test('the themed documents scale their body and table text', () => {
    expect(css).toMatch(/\.hj-inner \{ font-size: [\d.]+px; \}/);
    expect(css).toMatch(/\.hj-inner tbody td \{ font-size: [\d.]+px; \}/);
  });

  test('the scale is a real increase, not a rounding artefact', () => {
    // SHARED_CSS prints table cells at 9px; the theme must be meaningfully
    // above that or the change is invisible on paper.
    const cell = parseFloat(css.match(/\.hj-inner tbody td \{ font-size: ([\d.]+)px/)[1]);
    expect(cell).toBeGreaterThan(9);
    // ...and not so large it reflows the measured layout.
    expect(cell).toBeLessThan(9 * 1.35);
  });

  test('the report builder scales its own sizes through the same knob', () => {
    expect(exportSrc).toMatch(/rpx = \(n\) =>/);
    expect(exportSrc).toMatch(/font-size: \$\{rpx\(/);
  });

  test('both knobs are single named numbers, meant to be nudged', () => {
    expect(themeSrc).toMatch(/const TOP_PREPRINTED = [\d.]+;/);
    expect(themeSrc).toMatch(/const HJ_TYPE = [\d.]+;/);
  });
});

describe('nothing draws the letterhead a second time', () => {
  // The header is built in two branches; split on the marker so each can be
  // inspected on its own.
  const bare = exportSrc.slice(exportSrc.indexOf('rpt-hdr--bare'),
                               exportSrc.indexOf('rpt-hdr">'));
  const full = exportSrc.slice(exportSrc.indexOf('rpt-hdr">'));

  test('pre-printed paper gets a header with no logo and no company name', () => {
    // Both are on the sheet already; printing them again lands our ink a few
    // millimetres off the printer's and shows as a doubled edge.
    expect(exportSrc).toMatch(/const headerHTML = rp/);
    expect(exportSrc).toMatch(/rpt-hdr rpt-hdr--bare/);
    expect(bare).not.toMatch(/rpt-logo/);
    expect(bare).not.toMatch(/rpt-co-name/);
    expect(bare).not.toMatch(/companyName/);
  });

  test('it keeps the title and date, which are not on the paper', () => {
    expect(bare).toMatch(/rpt-doc-title/);
    expect(bare).toMatch(/rpt-doc-date/);
  });

  test('a tenant on blank paper still gets its logo and name', () => {
    expect(full).toMatch(/rpt-logo/);
    expect(full).toMatch(/rpt-co-name/);
  });

  test('the title is realigned once nothing sits to its left', () => {
    expect(exportSrc).toMatch(/\.rpt-hdr--bare \.rpt-doc \{ text-align: left; \}/);
  });

  test('no themed document draws a logo of its own', () => {
    // Their only logo is inside theme.sheet(), which preprinted blanks.
    expect(voucherSrc).not.toMatch(/<img/);
    expect(workOrderSrc).not.toMatch(/<img/);
  });
});

describe('the clearance survives printing', () => {
  // The bug this pins: the report's screen padding is explicitly zeroed under
  // @media print, so setting `body { padding: 62mm }` alone looked correct in
  // the preview and printed straight onto the logo. A page margin is also the
  // only thing that reserves space on the SECOND sheet of a long statement.
  test('the page margin carries it, not the body padding', () => {
    expect(exportSrc).toMatch(
      /@page \{ margin: \$\{rp \? `\$\{rp\.topMM\}mm` : '14mm'\} 12mm 14mm;/);
  });

  test('body padding is still zeroed in print, as before', () => {
    const printBlock = exportSrc.slice(exportSrc.indexOf('@media print {'));
    expect(printBlock).toMatch(/body \{ padding: 0; \}/);
  });

  test('blank paper keeps the margins it always had', () => {
    // 14mm top, 12mm sides, 14mm bottom — the same box as `14mm 12mm`.
    expect(exportSrc).toMatch(/: '14mm'\} 12mm 14mm/);
  });
});

describe('no other tenant is touched', () => {
  test('reportPrint is null on blank paper', () => {
    expect(reportPrint({})).toBeNull();
    expect(reportPrint({ preprinted_stationery: '0' })).toBeNull();
    expect(reportPrint(undefined)).toBeNull();
  });

  test('and returns both knobs on pre-printed paper', () => {
    const rp = reportPrint({ preprinted_stationery: '1' });
    expect(rp.topMM).toBeGreaterThan(50);
    expect(rp.scale).toBeGreaterThan(1);
  });

  test('the generic template has no theme, so no scaled text reaches it', () => {
    expect(themeFor({})).toBeNull();
    expect(themeFor({ document_template: 'default' })).toBeNull();
  });

  test('every scaled rule is scoped under .hj-inner', () => {
    // A bare `tbody td { font-size }` in the theme would be harmless today —
    // the theme only loads for hajosign — but the scoping is what makes that
    // true by construction rather than by luck.
    const scaled = css.split('\n').filter(l => /font-size: [\d.]+px/.test(l)
                                            && /^\.hj-inner/.test(l.trim()) === false
                                            && /^\./.test(l.trim()));
    for (const line of scaled) {
      expect(line.trim(), `unscoped: ${line.trim()}`).toMatch(/^\.hj-/);
    }
  });
});
