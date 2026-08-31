// Per-company letterhead designs for invoices and quotations.
//
// Every tenant shares one generic template (SHARED_CSS in exportUtils.js). A
// company that has commissioned its own printed identity gets a theme here
// instead: a CSS layer, the letterhead artwork, and its own header and footer.
//
// WHICH company gets WHICH theme is decided server-side, in
// backend/vendor_config.py, and arrives as the read-only `document_template`
// setting. It is not a tenant-writable field on purpose — a letterhead is one
// business's identity, and any tenant able to set this key could send documents
// carrying another company's branding.
//
// The artwork is VECTOR — CSS boxes and inline SVG, a couple of KB. The source
// design was a 13 MB Canva PDF, and embedding that as a page background would
// have put 13 MB into every printed document, softened it at print resolution,
// and buried the text in a raster. This stays sharp at any size and leaves the
// figures selectable and searchable.
//
// Themes are data-driven: the name, tagline, contacts and logo all come from
// the tenant's own settings. Only the geometry and the palette belong to the
// design. That is what makes a theme a house style rather than a hardcoded
// company.

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// ═══════════════════════════════════════════════════════════════════════════
// HAJO SIGN — orange/black cornered sheet, centred wordmark, contact strip
// ═══════════════════════════════════════════════════════════════════════════

// Sampled from the supplied letterhead, not guessed from a screenshot: the
// PDF draws one flat raster seventeen times, each clipped to a shape, so every
// colour below is the dominant pixel inside its own clip.
const HAJO = {
  orange: '#F07100',
  ink: '#282828',
  rule: '#DCDCDC',
  muted: '#6B6B6B',
  headerBg: '#F7F7F7',
};

// The HAJO SIGN monogram, traced out of the letterhead.
//
// The mark only existed in the original as pixels — Canva flattened it along
// with everything else — so it was recovered by run-length tracing the
// watermark copy, which is printed at 110.9mm and therefore carries far more
// detail than the 14.7mm masthead one. It is strictly rectilinear, so the trace
// is exact rather than approximate: the decomposition round-trips its source
// with zero mismatch, and edge error against the full-resolution original is
// 1.1% — 0.06mm at the size it is actually printed.
//
// This is the FALLBACK. A tenant that has uploaded its own logo gets that
// instead, on both the masthead and the watermark. But the monogram belongs to
// this letterhead exactly as the orange chevrons do, so the sheet should not
// arrive missing it just because nobody has been into Settings yet.
const HAJO_MARK_PATH =
  'M1.56 0.00H13.67V0.39H1.56ZM22.66 0.00H77.73V0.39H22.66ZM87.11 0.00H100.00V0.39H87.11Z' +
  'M0.78 0.39H14.06V0.78H0.78ZM21.88 0.39H78.52V1.17H21.88ZM86.72 0.39H100.00V0.78H86.72Z' +
  'M0.39 0.78H14.45V1.17H0.39ZM86.33 0.78H100.00V1.56H86.33ZM0.00 1.17H14.45V9.77H0.00Z' +
  'M21.48 1.17H78.91V2.34H21.48ZM85.94 1.56H100.00V9.77H85.94Z' +
  'M21.09 2.34H78.91V10.16H21.09ZM3.52 9.77H14.45V10.16H3.52ZM85.94 9.77H95.70V35.55H85.94Z' +
  'M4.30 10.16H14.45V53.91H4.30ZM21.09 10.16H31.25V20.70H21.09Z' +
  'M69.14 10.16H78.91V20.31H69.14ZM69.14 20.31H78.52V20.70H69.14Z' +
  'M21.48 20.70H31.25V24.22H21.48ZM69.14 20.70H77.73V21.09H69.14Z' +
  'M21.09 24.22H31.25V35.94H21.09ZM85.55 35.55H95.70V35.94H85.55Z' +
  'M21.09 35.94H95.70V44.53H21.09ZM21.48 44.53H95.70V45.31H21.48Z' +
  'M21.88 45.31H95.70V45.70H21.88ZM22.27 45.70H95.70V46.09H22.27Z' +
  'M23.44 46.09H32.42V46.48H23.44ZM85.55 46.09H95.70V46.48H85.55Z' +
  'M85.94 46.48H95.70V89.84H85.94ZM4.30 53.91H78.52V54.30H4.30Z' +
  'M4.30 54.30H78.91V64.06H4.30ZM4.30 64.06H14.45V89.84H4.30Z' +
  'M69.14 64.06H78.91V90.23H69.14ZM21.48 79.30H30.08V79.69H21.48Z' +
  'M21.48 79.69H30.47V80.08H21.48ZM21.48 80.08H30.86V80.86H21.48Z' +
  'M21.48 80.86H31.25V81.25H21.48ZM21.09 81.25H31.25V88.67H21.09Z' +
  'M21.09 88.67H31.64V89.45H21.09ZM21.09 89.45H32.03V89.84H21.09Z' +
  'M3.52 89.84H14.45V90.23H3.52ZM21.09 89.84H37.11V90.23H21.09Z' +
  'M85.94 89.84H97.27V90.23H85.94ZM0.00 90.23H14.45V98.83H0.00Z' +
  'M21.09 90.23H78.91V95.31H21.09ZM85.94 90.23H100.00V99.22H85.94Z' +
  'M21.09 95.31H79.30V97.66H21.09ZM21.09 97.66H78.91V98.44H21.09Z' +
  'M21.48 98.44H78.91V99.22H21.48ZM0.00 98.83H14.06V99.22H0.00Z' +
  'M0.39 99.22H14.06V99.61H0.39ZM21.88 99.22H78.52V99.61H21.88Z' +
  'M86.33 99.22H99.61V99.61H86.33ZM0.78 99.61H13.67V100.00H0.78Z' +
  'M22.27 99.61H78.12V100.00H22.27ZM86.72 99.61H99.22V100.00H86.72Z';

// Wrapped as a data URI so it drops into the same slots an uploaded logo uses.
const HAJO_MARK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + '<path fill="' + HAJO.ink + '" d="' + HAJO_MARK_PATH + '"/></svg>');

// The letterhead artwork, in millimetres on a 210x297 page.
//
// These are the ORIGINAL's own vector paths. Canva exported the design as a
// 13 MB flattened raster — the same full-page JPEG drawn seventeen times, each
// clipped to one of these outlines — so the shapes were in the file all along
// as clipping geometry. Lifting them out gives the exact design in 1.3 KB,
// sharp at any size, instead of 13 MB of soft pixels.
//
// The source page is 216x303mm: A4 plus 3mm bleed. Coordinates therefore run
// past 0 and past 210/297, which is deliberate — that overflow is what keeps
// the bands bleeding off the paper edge rather than stopping just short of it.
const HAJO_FRAME_PATHS = [
  ['#E6E6E6', 'M3.98 286.53 L136.60 286.53 L146.98 300.54 L146.89 300.62 L3.98 300.62Z'],
  ['#CCCCCC', 'M3.98 289.12 L148.71 289.12 L159.08 303.13 L159.00 303.22 L3.98 303.22Z'],
  ['#282828', 'M215.29 293.49 L181.27 293.49 L190.13 303.13 L190.14 303.22 L215.29 303.22Z'],
  ['#F07100', 'M174.80 293.49 L167.09 293.49 L175.95 303.13 L175.96 303.22 L183.81 303.22Z'],
  ['#F07100', 'M-5.37 297.68 L-5.37 148.89 L3.51 157.04 L3.51 297.68Z'
            + 'M169.03 303.22 L-5.37 303.22 L-5.37 293.49 L159.63 293.49 L169.11 303.13Z'],
  ['#F07100', 'M4.82 144.39 L4.82 152.10 L-5.21 143.00 L-5.29 142.99 L-5.29 135.14Z'],
  ['#282828', 'M5.34 131.16 L5.34 138.87 L-5.21 129.17 L-5.29 129.16 L-5.29 121.30Z'],
  ['#F07100', 'M206.49 76.06 L206.49 3.51 L135.34 3.51 L126.53 -6.34 L209.75 -6.34 L209.75 -6.39 L215.29 -6.39 L215.29 82.23Z'],
];

// One SVG covering the whole sheet, sized by its container rather than by a
// height computed in millimetres.
//
// It was two bands with explicit mm heights, which measured correctly in the
// DOM and then printed 2.4% short — every path drifting further up the page the
// lower it sat. Sizing from the container removes the question: the box is a
// fixed 297mm anchored to the thead, the viewBox is the same 210x297, so the
// mapping is one-to-one and there is no length for the print layout to resolve
// differently.
//
// The paths run past 0 and past 210/297 — that is the original's 3mm bleed —
// and the SVG viewport clips them at the paper edge, which is exactly what
// trimming a bled sheet does.
function hajoArt() {
  return `<svg class="hj-art" aria-hidden="true" viewBox="0 0 210 297"
      preserveAspectRatio="none">${HAJO_FRAME_PATHS
        .map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('')}</svg>`;
}

/**
 * The letterhead: artwork, watermark and masthead.
 *
 * All three live in the FIXED layer, so a three-page invoice is three sheets of
 * letterhead. That is what pre-printed stationery does, and the alternative —
 * one branded page followed by plain ones — is exactly how a long invoice gives
 * itself away as having been generated rather than issued.
 *
 * The watermark and the logo are the tenant's own uploaded artwork, not a baked
 * asset, which is what keeps this a house style rather than a hardcoded company.
 */
function hajoSheet(C, logo) {
  // The tenant's own logo wins; the letterhead's mark stands in when there is
  // none, so the sheet is never delivered with a hole where the identity goes.
  const mark = logo || HAJO_MARK;
  return `
  <div class="hj-anchor"><div class="hj-sheet-art">
    ${hajoArt()}
    <img class="hj-watermark" src="${mark}" alt="" />
    <div class="hj-masthead">
      <img class="hj-logo" src="${mark}" alt="" />
      <div class="hj-wordmark">${esc(C.name)}</div>
      ${C.tagline ? `<div class="hj-tagline">${esc(C.tagline)}</div>` : ''}
    </div>
    ${hajoContacts()}
  </div></div>`;
}

/**
 * Document header. `rows` are the right-hand label/value pairs — Date, Ref and
 * whatever else the document type carries — so invoices and quotations share
 * one header without this file needing to know which is which.
 */
function hajoHeader({ C, title, client, rows, statusHtml }) {
  const metaRows = rows
    .filter(r => r && r.value)
    .map(r => `<div class="hj-meta-row">
        <span class="hj-meta-key">${esc(r.label)}</span>
        <span class="hj-meta-val">${esc(r.value)}</span>
      </div>`).join('');

  return `
  <div class="hj-head">
    <div class="hj-head-left">
      <div class="hj-doc-title">${esc(title)}</div>
      <div class="hj-account-label">Account:</div>
      <div class="hj-account">${esc(client?.name) || '—'}</div>
      ${statusHtml || ''}
    </div>
    <div class="hj-head-right">${metaRows}</div>
  </div>`;
}

// The contact strip is part of the LETTERHEAD, not of the tenant's settings.
//
// It is printed on hajosign's stationery in fixed ink. The customer holding a
// printed invoice and the customer opening the link they were sent have to see
// the same company, and settings drift — an old address, a personal mailbox,
// a website spelled differently from the one on the paper. The paper does not
// drift, so the screen copy follows the paper.
//
// Everything else on the document still comes from settings. This is only the
// identity block that is already committed to ink.
const HAJO_CONTACT = {
  phones: ['+961 71771441', '+961 79177441'],
  web:    ['www.hajosign.com', 'info@hajosign.com'],
  place:  ['Beirut - St. Michael Church', 'Fawaz Center - First floor'],
};

/** The contact strip: phone, web, address — three columns with orange icons. */
function hajoContacts() {
  const icon = d => `<svg class="hj-ico" viewBox="0 0 24 24" fill="none"
      stroke="${HAJO.orange}" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  const PHONE = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>';
  const GLOBE = '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
  const PIN = '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>';

  const { phones, web, place } = HAJO_CONTACT;

  const col = (svg, lines) => (lines.length ? `
    <div class="hj-foot-col">${icon(svg)}<div class="hj-foot-lines">
      ${lines.map(l => `<span>${esc(l)}</span>`).join('')}
    </div></div>` : '');

  if (!phones.length && !web.length && !place.length) return '';
  return `<div class="hj-foot">
    ${col(PHONE, phones)}${col(GLOBE, web)}${col(PIN, place)}
  </div>`;
}

// The page geometry, in millimetres. Every inset in this theme derives from it
// — the content padding on screen, the @page margins in print, and the offsets
// that pull the fixed artwork back out to the paper edge. Change a number here
// and all three follow.
//
// Printing a multi-page document is where letterheads usually come apart: page
// one looks right and page two arrives as a bare sheet, or with the table
// running underneath the corner artwork. Two separate things have to be true.
//
//   1. The frame and the contact strip are FIXED, so the browser paints them
//      on every sheet rather than once at the top of the flow.
//   2. The space they occupy is reserved by @page MARGINS, not by padding.
//      Padding on the content block indents only where the flow starts and
//      ends — page one's top and the last page's bottom — so with padding
//      alone, page two's first row sits under the corner art. A page margin
//      applies to every sheet, which is the only thing that actually reserves
//      the space on all of them.
//
// The consequence of (2) is that the fixed layers are then positioned inside
// the margin box, so reaching the paper edge means pulling each one back out by
// exactly the margin on that side.
// Content has to clear the artwork, and the artwork is measured, so these are
// too. The top margin clears the masthead (which ends at 42.2mm); the sides
// clear the left band and the top-right bracket's vertical leg (x >= 205.4mm);
// the bottom clears the contact strip and the bands beneath it.
const PAGE = { top: 54, side: 16, bottom: 32, footFromEdge: 15, footRightInset: 16 };

// ── The two numbers to turn when the print lands wrong on the real paper ─────
//
// PAGE.top (50mm) clears the letterhead this system DRAWS, and is measured
// against it. Pre-printed stationery is a separate number because it is a
// separate fact, and the two do NOT agree.
//
// Measured off the supplied print file (216x303mm — A4 plus 3mm bleed), the
// masthead's last ink is at 42.2mm from the trim top:
//
//     logo      11.7 .. 26.2 mm
//     wordmark  30.6 .. 34.6 mm
//     tagline   40.6 .. 42.2 mm
//
// By that arithmetic 50mm cleared it and this number should not exist. On the
// actual paper it did not: text was landing on the logo on invoices and work
// orders, which reserve exactly 50mm. So something puts the printed content
// higher up the sheet than the artwork's own geometry predicts — feed offset,
// the printer's unprintable border, or stock that differs from this file.
// Which of those hardly matters; the paper is the authority and the file is
// not, so this is set from what comes out of the printer.
//
// If it needs to move again: print one invoice, measure from the paper's top
// edge to the first line of text, and compare that with where the logo ends.
// The difference is what to add here.
const TOP_PREPRINTED = 62;    // mm, empirical; artwork alone would say ~50
const HJ_TYPE = 1.12;         // 1 = unchanged; 1.12 = twelve per cent larger

/** A shared-stylesheet size, scaled for this theme. */
const ts = (px) => `${Math.round(px * HJ_TYPE * 100) / 100}px`;

// Measured off the original at 2551x3579, expressed in mm on the A4 trim.
// The mark is drawn larger than the original artwork's 14.5mm: on a phone,
// which is where a sent invoice is actually read, the original was a smudge.
// The gaps below it are preserved exactly (4.4mm to the wordmark, 6.0mm to the
// tagline) so the block still reads as one lockup rather than three stacked
// things, and the whole masthead is lifted 1.7mm to buy the height back.
const MARK = {
  logoTop: 10.0, logoSize: 21.0,          // was 11.7 / 14.5
  wordTop: 35.4, wordHeight: 4.0, wordWidth: 56.4,
  tagTop: 45.4, tagHeight: 1.6,
  wmTop: 88.3, wmWidth: 110.9,      // centred on x, and 5.8mm above page centre
};

// Notes below are JS comments, not CSS ones: anything inside the template
// literal is shipped inside every invoice a customer receives, and a document
// is not the place to explain its own implementation.
//
// .hj-watermark — the original's watermark is #F2F2F2 on white, a 5% tint.
//   Greyscale is applied first so a coloured logo becomes the same flat grey
//   rather than a pale version of itself.
// .hj-wordmark / .hj-tagline — tracking is in em, not mm, and that is the
//   point: the original sets HAJOSIGN across 56.4mm, but hardcoding that width
//   would be right for an eight-letter name and wrong for every other. Measured
//   against the original at 4mm Inter Bold the tracking is 1.26em, which
//   reproduces 56.4mm here and keeps the letterspaced look for any name. The
//   negative margin cancels the trailing space that letter-spacing adds after
//   the final letter; without it the glyphs sit half a space left of centre,
//   which is visible on a centred masthead.
// .hj-art--top / --bot — offsets place each band so its own coordinates land
//   on the paper: the top band's viewBox starts 6.39mm above the trim and the
//   bottom band's ends 6.22mm below it, so each is pulled out by that much.
// .hj-inner > * — the reader's content sits above the artwork.
// thead th — the table is ruled and light, not a filled band, as on the
//   original.
//
// .hj-sheet — the letterhead rides in a table's thead and tfoot, because that
//   is the only mechanism browsers actually honour for repeating content on
//   every printed sheet. `position: fixed` looks like the obvious answer and is
//   not: Chrome lays a fixed element out once, against the first page, which
//   stranded the artwork at the foot of page one and the contact strip on page
//   two. A repeated thead/tfoot also RESERVES its own height on every sheet,
//   which is what stops a later page's first row printing over the masthead.
// .hj-anchor / .hj-sheet-art — EVERYTHING on the letterhead hangs off the
//   thead, because the thead is the one element guaranteed to sit at the top of
//   every sheet. The tfoot is not: on a short final page it lands directly
//   under the last row, which dragged the bottom bar and the contact strip into
//   the middle of the paper. So the tfoot is now a plain 32mm spacer that only
//   reserves room, and the artwork is placed against a 297mm box anchored to
//   the thead — top band, bottom band, watermark, masthead and contact strip
//   alike. The zero-height anchor keeps all of it out of the cell's own height.
const hajoCSS = `
.page { padding: 0 !important; position: relative; }

.page { display: block !important; }
.hj-sheet {
  width: 100%; border-collapse: collapse; table-layout: fixed;
  /* A table treats height as a MINIMUM, so this pins the tfoot to the foot of
     the sheet on a short invoice while still letting a long one grow across
     pages. Without it the contact strip floats directly under the last line,
     halfway up an otherwise empty page. */
  height: 297mm;
}
.hj-sheet > thead > tr > td,
.hj-sheet > tbody > tr > td,
.hj-sheet > tfoot > tr > td { padding: 0; border: none; vertical-align: top; }
.hj-sheet > thead > tr > td { height: ${PAGE.top}mm; }
.hj-sheet--preprinted > thead > tr > td { height: ${TOP_PREPRINTED}mm; }
.hj-sheet > tfoot > tr > td { height: ${PAGE.bottom}mm; vertical-align: bottom; }
.hj-inner { padding: 0 ${PAGE.side}mm; }

.hj-anchor { position: relative; height: 0; }
.hj-sheet-art {
  position: absolute; top: 0; left: 0; width: 100%; height: 297mm;
  pointer-events: none;
  /* Trims the bleed at the paper edge — and that is not just cosmetic. The
     artwork's paths deliberately run past the trim (to x 215.38, y 303.22),
     and although the SVG clips what it PAINTS, the paths still counted toward
     the document's scroll size. Chrome's print then shrank the whole page by
     210/215.11 to make it fit, so every measurement on the sheet came out 2.4%
     small and the bands sat wrong against the original. */
  overflow: hidden;
}
.hj-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.hj-watermark {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: ${MARK.wmTop}mm; width: ${MARK.wmWidth}mm;
  opacity: 0.05; filter: grayscale(1);
}

.hj-masthead {
  position: absolute; left: 0; right: 0; top: ${MARK.logoTop}mm;
  text-align: center; color: ${HAJO.ink};
}
.hj-logo { height: ${MARK.logoSize}mm; width: auto; object-fit: contain; display: block; margin: 0 auto; }
.hj-wordmark {
  margin-top: ${MARK.wordTop - MARK.logoTop - MARK.logoSize}mm;
  margin-right: -1.26em;
  font-size: ${MARK.wordHeight}mm; line-height: 1; font-weight: 700;
  letter-spacing: 1.26em; text-transform: uppercase;
}
.hj-tagline {
  margin-top: ${MARK.tagTop - MARK.wordTop - MARK.wordHeight}mm;
  margin-right: -1.74em;
  font-size: ${MARK.tagHeight}mm; line-height: 1; font-weight: 500;
  letter-spacing: 1.74em; text-transform: uppercase; color: ${HAJO.muted};
}

.hj-inner > * { position: relative; z-index: 1; }

.hj-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 7mm; }
.hj-doc-title {
  font-size: 15px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.4px; color: ${HAJO.ink};
}
.hj-account-label { font-size: 8px; font-weight: 700; color: ${HAJO.muted}; margin-top: 3px; }
.hj-account { font-size: 11px; font-weight: 600; color: ${HAJO.ink}; }
.hj-head-right { min-width: 62mm; }
.hj-meta-row { display: flex; gap: 8px; font-size: 9px; line-height: 1.7; }
.hj-meta-key { font-weight: 700; color: ${HAJO.ink}; min-width: 26mm; }
.hj-meta-val { color: ${HAJO.muted}; }

thead th {
  background: ${HAJO.headerBg}; color: ${HAJO.ink};
  border-top: 1px solid ${HAJO.rule}; border-bottom: 1px solid ${HAJO.rule};
  font-size: 7.5px; letter-spacing: 0.3px;
}
tbody td { border-bottom: 1px solid ${HAJO.rule}; }
.item-name { font-weight: 500; }

.totals-box { border-color: ${HAJO.rule}; }
.totals-row { border-color: ${HAJO.rule}; }
.totals-row.grand { background: ${HAJO.ink}; }
.section-heading, .band-label, .info-label { color: ${HAJO.orange}; }
.info-label { background: ${HAJO.ink}; }
.info-grid, .band, .sig-section { border-color: ${HAJO.rule}; }
.status-badge { border-radius: 2px; }

.hj-words {
  text-align: center; font-size: 9px; color: ${HAJO.ink};
  margin: 3mm 0 2mm; padding: 0 8mm; line-height: 1.5;
}

.hj-foot {
  position: absolute; left: ${PAGE.side}mm; right: ${PAGE.side}mm;
  bottom: ${PAGE.footFromEdge}mm;
  display: flex; justify-content: space-between; gap: 8mm;
  border-top: 1px solid ${HAJO.rule}; padding-top: 3mm;
  font-size: 8px; color: ${HAJO.ink};
}
.hj-foot-col { display: flex; align-items: flex-start; gap: 5px; }
.hj-ico { width: 11px; height: 11px; flex: none; margin-top: 1px; }
.hj-foot-lines { display: flex; flex-direction: column; line-height: 1.45; }

`;


// Scaled text. Every selector here also exists in SHARED_CSS at an unscaled
// size; these are scoped under .hj-inner, which no other template emits, so a
// change to the scale cannot restyle anybody else's documents. Kept as one
// block rather than sprinkled through hajoCSS so it is obvious what the scale
// touches and what it leaves alone.
const hajoTypeCSS = `
.hj-inner { font-size: ${ts(9.5)}; }
.hj-inner .company-name { font-size: ${ts(14)}; }
.hj-inner .company-meta { font-size: ${ts(8)}; }
.hj-inner .doc-title { font-size: ${ts(24)}; }
.hj-inner .doc-ref { font-size: ${ts(9.5)}; }
.hj-inner .doc-dates { font-size: ${ts(8.5)}; }
.hj-inner .client-name { font-size: ${ts(10.5)}; }
.hj-inner .client-line { font-size: ${ts(8.5)}; }
.hj-inner .meta-row { font-size: ${ts(8.5)}; }
.hj-inner thead th { font-size: ${ts(7)}; }
.hj-inner tbody td { font-size: ${ts(9)}; }
.hj-inner tbody td.barcode { font-size: ${ts(8.5)}; }
.hj-inner .item-desc { font-size: ${ts(8)}; }
.hj-inner .totals-row { font-size: ${ts(8.5)}; }
.hj-inner .totals-row.grand .k { font-size: ${ts(9)}; }
.hj-inner .hj-words { font-size: ${ts(9)}; }
`;

// The frame is drawn to the very edge of the sheet, which is right for a design
// sent to a commercial printer and wrong for the one on somebody's desk. No
// office printer reaches the paper edge — there is a hardware border of roughly
// 4-6mm it physically cannot mark — so printing this at full bleed loses the
// top band completely and clips the sides.
//
// So for print the whole letterhead is pulled in far enough to land inside that
// border. The frame arrives complete, with a white margin around it, which is
// what bleed artwork always looks like off a desktop printer. The flowed
// content is NOT scaled: it already sits well inside, and scaling it would undo
// the clearances that keep the text off the artwork.
//
// Screen keeps the full bleed, because a screen has no unprintable border.
const BLEED_SAFE = 0.94;      // 210mm -> 197.4mm, leaving 6.3mm each side

const hajoPrintCSS = `
@media print {
  @page { margin: 0; size: A4; }
  .page { padding: 0 !important; width: 100%; min-height: 0; margin: 0; }
  .doc-footer { display: none !important; }
  .hj-sheet-art {
    transform: scale(${BLEED_SAFE});
    transform-origin: 50% 50%;
  }
}
`;

export const THEMES = {
  hajosign: {
    id: 'hajosign',
    css: hajoCSS + hajoTypeCSS + hajoPrintCSS,
    sheet: hajoSheet,
    header: hajoHeader,
    // Wraps the flowed content so the padding that clears the artwork applies
    // to it and not to the fixed layers.
    open: '<div class="hj-inner">',
    close: '</div>',
    words: text => (text ? `<div class="hj-words">${esc(text)}</div>` : ''),
  },
};

/**
 * How a plain REPORT should print for this tenant — the statement of account
 * and everything else that goes through exportReportPDF.
 *
 * Those do not use a theme: they are a title, a table and a total, drawn by the
 * generic report builder. That was fine until the paper underneath them had a
 * letterhead already printed on it, at which point the first line of a
 * statement lands on top of the customer's own logo. They need the same
 * clearance the themed documents get, and the same slightly larger text, and
 * they need it from the same two numbers so all five document types move
 * together when somebody nudges them.
 *
 * Returns null for every tenant printing on blank paper — which must leave the
 * report builder's output exactly as it was.
 */
export function reportPrint(settings) {
  if (settings?.preprinted_stationery !== '1') return null;
  return { topMM: TOP_PREPRINTED, scale: HJ_TYPE };
}

/**
 * The theme for these settings, or null for the generic template.
 *
 * Null is the important case: it must produce byte-identical output to what the
 * system printed before themes existed, so introducing one company's letterhead
 * cannot quietly restyle everybody else's invoices.
 */
export function themeFor(settings) {
  const id = settings?.document_template;
  return (id && THEMES[id]) || null;
}
