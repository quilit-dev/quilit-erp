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
  ['#282828', 'M215.29 292.58 L180.43 292.58 L190.13 303.13 L190.14 303.22 L215.29 303.22Z'],
  ['#F07100', 'M173.96 292.58 L166.25 292.58 L175.95 303.13 L175.96 303.22 L183.81 303.22Z'],
  ['#F07100', 'M-5.37 297.68 L-5.37 148.89 L4.05 157.54 L4.05 297.68Z'
            + 'M169.03 303.22 L-5.37 303.22 L-5.37 292.58 L158.74 292.58 L169.11 303.13Z'],
  ['#F07100', 'M4.82 144.39 L4.82 152.10 L-5.21 143.00 L-5.29 142.99 L-5.29 135.14Z'],
  ['#282828', 'M5.34 131.16 L5.34 138.87 L-5.21 129.17 L-5.29 129.16 L-5.29 121.30Z'],
  ['#F07100', 'M205.43 75.32 L205.43 3.51 L135.34 3.51 L126.53 -6.34 L209.75 -6.34 '
            + 'L209.75 -6.39 L215.29 -6.39 L215.29 82.23Z'],
];

// The artwork is emitted as two bands — one anchored to the top of the sheet,
// one to the bottom — rather than one box stretched over the whole page.
//
// On screen a long invoice is a single tall page, and a full-height artwork
// layer would stretch with it: the diagonals would skew and the bottom bar
// would drift to the foot of a 400mm sheet. Anchoring each band to the paper
// edge it belongs to keeps the geometry true at any document length, which
// matters because the share page a customer opens is screen, not print.
//
// `top`/`bottom` are the y-range each band covers in the original's own
// coordinates, including the 3mm bleed that runs past the trim.
const HAJO_BANDS = [
  { cls: 'top', from: -6.39, to: 155, maxY: 155 },
  { cls: 'bot', from: 148, to: 303.22, minY: 148 },
];

function hajoArt() {
  return HAJO_BANDS.map(({ cls, from, to, minY, maxY }) => {
    const height = to - from;
    const paths = HAJO_FRAME_PATHS.filter(([, d]) => {
      const ys = d.match(/-?\d+\.?\d*/g).filter((_, i) => i % 2);
      const lo = Math.min(...ys.map(Number));
      const hi = Math.max(...ys.map(Number));
      return maxY !== undefined ? lo < maxY : hi > minY;
    });
    return `<svg class="hj-art hj-art--${cls}" aria-hidden="true"
      viewBox="0 ${from} 210 ${height}" preserveAspectRatio="none"
      style="height:${height}mm">${paths
        .map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('')}</svg>`;
  }).join('');
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
function hajoFrame(C, logo) {
  return `
  <div class="hj-frame">
    ${hajoArt()}
    ${logo ? `<img class="hj-watermark" src="${logo}" alt="" />` : ''}
    <div class="hj-masthead">
      ${logo ? `<img class="hj-logo" src="${logo}" alt="" />` : ''}
      <div class="hj-wordmark">${esc(C.name)}</div>
      ${C.tagline ? `<div class="hj-tagline">${esc(C.tagline)}</div>` : ''}
    </div>
  </div>`;
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

/** The contact strip: phone, web, address — three columns with orange icons. */
function hajoFooter(C) {
  const icon = d => `<svg class="hj-ico" viewBox="0 0 24 24" fill="none"
      stroke="${HAJO.orange}" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  const PHONE = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>';
  const GLOBE = '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
  const PIN = '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>';

  const phones = String(C.phone || '').split(/\s*[/|,]\s*/).filter(Boolean);
  const web = [C.website, C.email].filter(Boolean);
  const place = String(C.address || '').split(/\s*,\s*/).filter(Boolean);

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
const PAGE = { top: 50, side: 16, bottom: 32, footFromEdge: 15, footRightInset: 16 };

// Measured off the original at 2551x3579, expressed in mm on the A4 trim.
const MARK = {
  logoTop: 11.7, logoSize: 14.5,
  wordTop: 30.6, wordHeight: 4.0, wordWidth: 56.4,
  tagTop: 40.6, tagHeight: 1.6,
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
const hajoCSS = `
.page { padding: 0 !important; position: relative; }
.hj-inner { padding: ${PAGE.top}mm ${PAGE.side}mm ${PAGE.bottom}mm; display: flex; flex-direction: column; flex: 1 1 auto; }

.hj-frame { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
.hj-art { position: absolute; left: 0; width: 100%; }
.hj-art--top { top: -6.39mm; }
.hj-art--bot { bottom: -6.22mm; }
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
  position: absolute; left: ${PAGE.side}mm; right: ${PAGE.footRightInset}mm;
  bottom: ${PAGE.footFromEdge}mm;
  display: flex; justify-content: space-between; gap: 8mm;
  border-top: 1px solid ${HAJO.rule}; padding-top: 3mm;
  font-size: 8px; color: ${HAJO.ink}; z-index: 1;
}
.hj-foot-col { display: flex; align-items: flex-start; gap: 5px; }
.hj-ico { width: 11px; height: 11px; flex: none; margin-top: 1px; }
.hj-foot-lines { display: flex; flex-direction: column; line-height: 1.45; }

`;


const hajoPrintCSS = `
@media print {
  @page { margin: ${PAGE.top}mm ${PAGE.side}mm ${PAGE.bottom}mm; size: A4; }
  .page { padding: 0 !important; width: 100%; min-height: 0; }
  .hj-inner { padding: 0; }
  .hj-frame, .hj-foot { position: fixed; }
  .hj-frame {
    top: -${PAGE.top}mm; left: -${PAGE.side}mm;
    right: -${PAGE.side}mm; bottom: -${PAGE.bottom}mm;
  }
  .hj-foot {
    left: 0; right: ${PAGE.footRightInset - PAGE.side}mm;
    bottom: -${PAGE.bottom - PAGE.footFromEdge}mm; background: #fff;
  }
  .doc-footer { display: none !important; }
}
`;

export const THEMES = {
  hajosign: {
    id: 'hajosign',
    css: hajoCSS + hajoPrintCSS,
    frame: hajoFrame,
    header: hajoHeader,
    footer: hajoFooter,
    // Wraps the flowed content so the padding that clears the artwork applies
    // to it and not to the fixed layers.
    open: '<div class="hj-inner">',
    close: '</div>',
    words: text => (text ? `<div class="hj-words">${esc(text)}</div>` : ''),
  },
};

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
