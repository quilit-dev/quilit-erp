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

// Sampled from the supplied letterhead. Kept in one block so matching the
// original exactly later is a change to six values, not a hunt through the CSS.
const HAJO = {
  orange: '#F0821E',
  ink: '#1A1A1A',
  rule: '#DCDCDC',
  watermark: '#F1F1F1',
  muted: '#6B6B6B',
  headerBg: '#F7F7F7',
};

/**
 * The letterhead itself: corner chevrons, edge accents and the centred
 * watermark. Fixed rather than flowed, so a document that runs to three pages
 * is three sheets of letterhead — not one branded page followed by two blank
 * ones, which is how a multi-page invoice usually gives itself away.
 */
function hajoFrame(logo) {
  const corner = (pos, flip) => `
    <svg class="hj-corner hj-corner--${pos}" viewBox="0 0 120 120" aria-hidden="true"
         style="${flip}">
      <path d="M120 0 L120 26 L26 26 L26 120 L0 120 L0 0 Z" fill="${HAJO.orange}"/>
      <path d="M120 34 L120 52 L52 52 L52 120 L34 120 L34 34 Z" fill="${HAJO.ink}"/>
    </svg>`;

  return `
  <div class="hj-frame" aria-hidden="true">
    ${corner('tr', 'transform:scaleX(-1)')}
    ${corner('br', 'transform:scale(-1,-1)')}
    <div class="hj-edge hj-edge--ink"></div>
    <div class="hj-edge hj-edge--orange"></div>
    ${logo ? `<img class="hj-watermark" src="${logo}" alt="" />` : ''}
  </div>`;
}

/** Masthead: logo, letterspaced company name, tagline — centred, as supplied. */
function hajoMasthead(C, logo) {
  return `
  <div class="hj-masthead">
    ${logo ? `<img class="hj-logo" src="${logo}" alt="" />` : ''}
    <div class="hj-wordmark">${esc(C.name)}</div>
    ${C.tagline ? `<div class="hj-tagline">${esc(C.tagline)}</div>` : ''}
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
const PAGE = { top: 26, side: 16, bottom: 30, footFromEdge: 9, footRightInset: 22 };

const hajoCSS = `
.page { padding: 0 !important; position: relative; }
.hj-inner { padding: ${PAGE.top}mm ${PAGE.side}mm ${PAGE.bottom}mm; display: flex; flex-direction: column; flex: 1 1 auto; }

.hj-frame { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
.hj-corner { position: absolute; width: 30mm; height: 30mm; }
.hj-corner--tr { top: 0; right: 0; }
.hj-corner--br { bottom: 0; right: 0; }
.hj-edge { position: absolute; left: 0; width: 6mm; }
.hj-edge--ink    { top: 44%; height: 14mm; background: ${HAJO.ink}; }
.hj-edge--orange { top: 58%; height: 20mm; background: ${HAJO.orange}; }
.hj-watermark {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 105mm; opacity: 0.05; filter: grayscale(1);
}

/* Everything the reader sees sits above the artwork. */
.hj-inner > * { position: relative; z-index: 1; }

.hj-masthead { text-align: center; margin-bottom: 9mm; }
.hj-logo { height: 46px; width: auto; object-fit: contain; margin-bottom: 4px; }
.hj-wordmark {
  font-size: 17px; font-weight: 800; letter-spacing: 6px;
  text-transform: uppercase; color: ${HAJO.ink};
}
.hj-tagline {
  font-size: 7px; font-weight: 600; letter-spacing: 4.5px; text-transform: uppercase;
  color: ${HAJO.muted}; margin-top: 3px;
}

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

/* The table is ruled and light, not a filled blue band — as on the original. */
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
  /* Pulled out to the paper edge on all four sides. */
  .hj-frame {
    top: -${PAGE.top}mm; left: -${PAGE.side}mm;
    right: -${PAGE.side}mm; bottom: -${PAGE.bottom}mm;
  }
  .hj-foot {
    left: 0; right: ${PAGE.footRightInset - PAGE.side}mm;
    bottom: -${PAGE.bottom - PAGE.footFromEdge}mm; background: #fff;
  }
  /* The generic template pins its own footer; this theme replaces it. */
  .doc-footer { display: none !important; }
}
`;

export const THEMES = {
  hajosign: {
    id: 'hajosign',
    css: hajoCSS + hajoPrintCSS,
    frame: hajoFrame,
    masthead: hajoMasthead,
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
