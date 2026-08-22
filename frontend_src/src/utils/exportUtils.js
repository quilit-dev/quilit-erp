/**
 * exportUtils.js — PDF & Excel export for Quotations and Invoices.
 *
 * Settings honoured:
 *   tax_enabled        — master switch; hides all tax when off
 *   default_tax_rate   — % applied to each line and rolled into totals
 *   show_tax_col       — adds a per-line "Tax" column to PDF & Excel item tables
 *   show_discount_col  — adds a per-line "Discount" column to PDF & Excel item tables
 *                        (uses item.discount_pct if present, else document-level discount_pct)
 *   show_barcode_col   — adds a per-line "Barcode" column, resolved server-side
 *                        through the line's inventory link
 *   show_total_words   — spells the grand total out beneath the totals box
 *   preprinted_stationery — the company's paper already carries its letterhead,
 *                        so the design is left off the company's own export.
 *                        Never set on the share link: the customer has no such
 *                        paper, so their copy keeps the design.
 *   document_template  — which letterhead to print on. READ-ONLY: resolved from
 *                        the tenant in backend/vendor_config.py, never settable
 *                        by a tenant, because a letterhead is a company's
 *                        identity and not a preference.
 */
// A handful of these are exported for receiptVoucher.js, which is a second
// document built on the same sheet: same CSS, same company block, same currency
// context, same print path. Re-deriving any of that there is how two documents
// from one system start disagreeing about the date format or the rate.
import * as XLSX from 'xlsx';
import DOMPurify from 'dompurify';
import { themeFor } from './documentThemes';
import { amountInWords } from './numberToWords';

// Open a stored document snapshot in a new window for viewing / printing.
// The HTML is sanitised first: snapshots are persisted server-side and any
// authenticated user can save one, so the stored markup is untrusted. Legit
// snapshots are pure markup + inline CSS (no scripts), so stripping scripts,
// event handlers and javascript: URLs preserves print fidelity while
// neutralising stored XSS.
export function openSafeHtmlDocument(html) {
  const clean = DOMPurify.sanitize(html || '', { WHOLE_DOCUMENT: true });
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(clean);
  w.document.close();
}

// ─── Formatters ────────────────────────────────────────────────────────────────
// Currencies with no minor unit in circulation. Printing "12,172,000.00" on a
// Lebanese invoice is not a rounding preference — there is nothing the ".00"
// could refer to, and it makes every figure two characters harder to read on a
// document whose totals already run to eight digits.
const ZERO_DECIMAL = new Set([
  'LBP', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'UGX', 'RWF', 'XAF', 'XOF',
  'XPF', 'KMF', 'DJF', 'GNF', 'MGA', 'VUV',
]);

/** Decimal places to print for a currency: 0 where it has no minor unit. */
export const decimalsFor = code => (ZERO_DECIMAL.has(String(code || '').toUpperCase()) ? 0 : 2);

export const fmtCurrency = (v, currency = 'USD', decimals) => {
  const dp = decimals === undefined ? decimalsFor(currency) : decimals;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  }).format(Number(v) || 0);
};

// `USD` is the document money formatter. Despite the name it formats whichever
// currency the export is rendered in — it is reassigned per-export so an LBP
// export converts and formats in LBP. See currencyContext().
let USD = (v) => fmtCurrency(v, 'USD');

// Resolve how money is shown for one export. The document is always stored in
// the base currency (USD); when the user picked the LBP view AND an admin rate
// exists, amounts are converted at that rate for display only.
export function currencyContext(C, opts) {
  const useLbp = opts?.displayCurrency === 'LBP' && Number(opts?.exchangeRate?.rate) > 0;
  const rate   = useLbp ? Number(opts.exchangeRate.rate) : 1;
  const code   = useLbp ? (opts.exchangeRate.secondary || 'LBP') : C.currency;
  // Driven by the currency, not by which view is showing. The converted view
  // already dropped decimals for LBP; a company whose BASE currency is LBP was
  // still getting "LBP 12,172,000.00" on every line.
  const dec    = decimalsFor(code);
  return {
    useLbp, rate, code,
    money: (v) => fmtCurrency((Number(v) || 0) * rate, code, dec),
    conv:  (v) => (Number(v) || 0) * rate,
  };
}

/**
 * A document prints in the currency it was agreed in.
 *
 * An invoice raised in euro says EUR 5,000, not the $5,500 the company carries
 * it at — that dollar figure is for the company's own books and means nothing
 * to the customer holding the paper. The record carries both, so this simply
 * chooses the customer's side and hands back lines priced in it.
 *
 * Returns null when the document is in the company's own currency, which is
 * every document raised before currencies existed and most of them after.
 * Callers fall back to what they always did.
 */
export function inTransactionCurrency(doc, items, C) {
  const code = String(doc?.currency || '').toUpperCase();
  if (!code || code === (C?.currency || 'USD')) return null;
  // Without per-line agreed prices the lines and the total would disagree,
  // and a document whose lines do not add up to its total is worse than one
  // printed in the wrong currency.
  const priced = (items || []).map(it => (
    it?.txn_unit_price == null ? null : {
      ...it,
      unit_price: it.txn_unit_price,
      tax_amount: it.txn_tax_amount != null ? it.txn_tax_amount : it.tax_amount,
    }
  ));
  if (priced.some(p => p === null)) return null;
  return { code, items: priced };
}

export const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};
const fmtShort = fmtDate;

function addDays(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Logo loader ───────────────────────────────────────────────────────────────
// Exported because the client-facing share page needs the SAME resolution, not
// a bare `/logo.png` in the markup. This returns null when there is no logo (or
// the path answers with something that is not an image), and the templates omit
// the <img> entirely on null — hand them a plain URL instead and a tenant with
// no logo uploaded gets a broken-image icon captioned "logo" on the document
// their customer opens.
export async function getLogoDataURL() {
  try {
    // /api/settings/logo, NOT the static /logo.png. The static file is one
    // shared path for the whole server, so on a multi-tenant deployment it
    // served whichever customer uploaded last; the API route reads the logo
    // from the requesting tenant's own database. It is unauthenticated, so
    // this works on the client-facing share page too.
    const resp = await fetch(`/api/settings/logo?_=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror  = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

// ─── Print engine ──────────────────────────────────────────────────────────────
export function printHTML(htmlString, filename) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(htmlString);
  iframe.contentDocument.close();
  iframe.onload = () => {
    try {
      iframe.contentWindow.document.title = filename;
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }
  };
}

// ─── Shared CSS ────────────────────────────────────────────────────────────────
export const SHARED_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --brand: #1B4F72; --brand-subtle: #EBF5FB;
  --text: #0f172a; --text-mid: #374151; --text-muted: #64748b;
  --border: #e2e8f0; --bg-alt: #f8fafc;
  --green: #15803d; --red: #dc2626; --amber: #d97706;
}
body {
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 9.5px; color: var(--text); line-height: 1.35;
  background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page {
  width: 210mm; min-height: 297mm; margin: 0 auto;
  padding: 9mm 11mm 18mm; display: flex; flex-direction: column;
  position: relative; background: #fff;
}
.content-spacer { flex: 1 1 auto; }
.doc-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  padding-bottom: 8px; border-bottom: 2.5px solid var(--brand); margin-bottom: 10px;
}
.company-logo { height: 30px; width: auto; margin-bottom: 3px; object-fit: contain; }
.company-name { font-size: 14px; font-weight: 700; color: var(--brand); letter-spacing: -0.2px; }
.company-meta { font-size: 8px; color: var(--text-muted); margin-top: 2px; line-height: 1.35; }
.doc-title { font-size: 24px; font-weight: 800; color: var(--brand); text-transform: uppercase; letter-spacing: 1px; }
.doc-ref { font-size: 9.5px; font-weight: 600; color: var(--text-mid); margin: 2px 0 4px; }
.doc-dates { font-size: 8.5px; color: var(--text-muted); line-height: 1.4; }
.doc-dates strong { color: var(--text); font-weight: 600; }
.status-badge {
  display: inline-block; padding: 2px 9px; border-radius: 10px;
  font-size: 7px; font-weight: 700; text-transform: uppercase;
  margin-top: 5px; letter-spacing: 0.6px; border: 1px solid transparent;
}
.info-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0;
  margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
}
.info-col { padding: 7px 9px; }
.info-col:first-child { border-right: 1px solid var(--border); }
.info-label {
  font-size: 6.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  color: #fff; background: var(--brand); padding: 2px 7px; margin: -7px -9px 5px;
}
.client-name { font-size: 10.5px; font-weight: 700; margin-bottom: 2px; }
.client-line { font-size: 8.5px; color: var(--text-muted); line-height: 1.35; }
.meta-row { display: flex; justify-content: space-between; font-size: 8.5px; line-height: 1.4; padding: 1px 0; }
.meta-key { font-weight: 600; color: var(--text-mid); min-width: 78px; }
.section-heading {
  font-size: 8px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
  color: var(--brand); margin: 5px 0 3px; padding-bottom: 2px; border-bottom: 1px solid var(--border);
}
table { width: 100%; border-collapse: collapse; margin-bottom: 5px; table-layout: fixed; page-break-inside: avoid; }
thead th {
  background: var(--brand); color: #fff; font-size: 7px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.4px; padding: 4px 5px; text-align: left;
}
thead th.r { text-align: right; }
tbody td { padding: 3.5px 5px; font-size: 9px; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody td.r { text-align: right; }
tbody td.num { font-weight: 600; font-variant-numeric: tabular-nums; }
tbody td.seq { color: var(--text-muted); font-weight: 500; }
/* Tabular figures and no wrap: a barcode broken across two lines cannot be
   read back, and it is the one field on the row meant to be matched digit for
   digit against a label on a shelf. */
tbody td.barcode { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 8.5px; }
.item-name { font-weight: 600; }
.item-desc { font-size: 8px; color: var(--text-muted); margin-top: 1px; }
.totals-wrap { display: flex; justify-content: flex-end; margin: 3px 0 8px; }
.totals-box { width: 215px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.totals-row { display: flex; justify-content: space-between; padding: 3px 9px; font-size: 8.5px; border-bottom: 1px solid var(--border); }
.totals-row:last-child { border-bottom: none; }
.totals-row .k { color: var(--text-muted); }
.totals-row .v { font-weight: 600; font-variant-numeric: tabular-nums; }
.totals-row.grand { background: var(--brand); color: #fff; padding: 5px 9px; }
.totals-row.grand .k { font-size: 9px; font-weight: 700; }
.totals-row.grand .v { font-size: 10px; font-weight: 800; }
.totals-row .v.green { color: var(--green); }
.totals-row .v.red   { color: var(--red); }
.band {
  margin-bottom: 5px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 3px;
  font-size: 8.5px; line-height: 1.35; color: var(--text-mid); page-break-inside: avoid;
}
.band-label { font-weight: 700; color: var(--brand); display: inline; }
.band.amber { border-color: #fde68a; background: #fffbeb; }
.band.amber .band-label { color: var(--amber); }
.band.slate { background: var(--bg-alt); }
.band.green { border-color: #bbf7d0; background: #f0fdf4; }
.band.green .band-label { color: var(--green); }
.sig-section {
  margin: 5px 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; page-break-inside: avoid;
}
.sig-header {
  background: var(--bg-alt); padding: 3px 8px; font-size: 6.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.8px; color: var(--brand);
  border-bottom: 1px solid var(--border);
}
.sig-body { padding: 6px 8px; font-size: 8px; color: var(--text-muted); line-height: 1.35; }
.sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 5px; }
.sig-title { font-size: 7px; font-weight: 600; margin-bottom: 14px; }
.sig-line { border-top: 1px solid #cbd5e1; padding-top: 2px; font-size: 7.5px; color: var(--text-muted); }
.doc-footer {
  margin-top: auto; padding: 5px 0 3px; border-top: 1.5px solid var(--border);
  display: flex; justify-content: space-between; align-items: flex-end;
  font-size: 7.5px; color: var(--text-muted); line-height: 1.35;
}
.footer-left strong { color: var(--text); font-weight: 600; }
@media print {
  @page { margin: 8mm; size: A4; }
  body { background: #fff; }
  .page { padding: 0; min-height: 0; width: 100%; }
  .doc-footer {
    position: fixed; bottom: 8mm; left: 10mm; right: 10mm;
    background: #fff; padding: 4px 0; border-top: 1.5px solid var(--border); margin: 0;
  }
  .page { padding-bottom: 16mm; }
}
`;

// ─── Settings loader ───────────────────────────────────────────────────────────
export async function getSettings() {
  try {
    const res = await fetch('/api/settings/', { credentials: 'include' });
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

// ─── Auto-save document snapshot ──────────────────────────────────────────────
export async function saveDocumentSnapshot(recordType, record, title, htmlContent) {
  try {
    const body = {
      record_type:  recordType,
      record_id:    record.id,
      client_id:    record.client_id   || null,
      project_id:   record.project_id  || null,
      title,
      html_content: htmlContent,
    };
    await fetch('/api/documents/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    // Non-fatal — document saving failure should never block the print dialog
  }
}

export function buildCompany(s) {
  return {
    name:            s.company_name       || 'My Company',
    tagline:         s.company_tagline    || '',
    address:         [s.company_address, s.company_city, s.company_country].filter(Boolean).join(', '),
    phone:           s.company_phone      || '',
    email:           s.company_email      || '',
    website:         s.company_website    || '',
    vat:             s.company_tax_number   ? `Tax No: ${s.company_tax_number}`  : '',
    regNo:           s.company_reg_number   ? `Reg. No: ${s.company_reg_number}` : '',
    bankName:        s.bank_name           || '',
    bankAccount:     s.bank_account        || '',
    bankIBAN:        s.bank_iban           || '',
    bankSwift:       s.bank_swift          || '',
    currency:        s.default_currency    || 'USD',
    footer:          s.footer_text         || '',
    terms:           s.invoice_terms       || '',
    paymentDays:     parseInt(s.payment_terms_days || '15', 10),
    // ── Tax settings ──────────────────────────────────────────────────────
    taxRate:         parseFloat(s.default_tax_rate   || '0'),
    taxOn:           s.tax_enabled         === '1',
    // ── Column visibility (Document Settings toggles) ─────────────────────
    showTaxCol:      s.show_tax_col        === '1',   // per-line Tax column
    showDiscountCol: s.show_discount_col   === '1',   // per-line Discount column
    showBarcodeCol:  s.show_barcode_col    === '1',   // per-line Barcode column
    showTotalWords:  s.show_total_words    === '1',   // total spelled out
    // The company prints onto paper that already carries its letterhead.
    preprinted:      s.preprinted_stationery === '1',
  };
}

// ─── Per-line computation ──────────────────────────────────────────────────────
// discountPct: item-level override first, then document-level fallback (0 = no discount)
// Tax: each line carries its own `tax_rate` snapshot; legacy lines with none
// fall back to the company default rate.
function lineCalc(item, taxRate, taxOn, docDiscountPct) {
  const qty       = Number(item.quantity)   || 0;
  const unitPrice = Number(item.unit_price) || 0;
  const gross     = qty * unitPrice;
  const disc      = Number(item.discount_pct ?? docDiscountPct ?? 0);
  const discAmt   = gross * (disc / 100);
  const net       = gross - discAmt;
  const hasLineRate = item.tax_rate !== undefined && item.tax_rate !== null;
  const rate      = hasLineRate ? Number(item.tax_rate) : (taxOn ? taxRate : 0);
  const taxAmt    = rate > 0 ? net * (rate / 100) : 0;
  const lineTotal = net + taxAmt;
  return { qty, unitPrice, gross, disc, discAmt, net, taxAmt, lineTotal, rate };
}

function aggregateLines(items, C, docDiscountPct = 0) {
  const taxOn = C.taxOn && C.taxRate > 0;
  let subtotal = 0, totalDiscount = 0, totalTax = 0, grandTotal = 0;
  for (const item of (items || [])) {
    const r = lineCalc(item, C.taxRate, taxOn, docDiscountPct);
    subtotal      += r.gross;
    totalDiscount += r.discAmt;
    totalTax      += r.taxAmt;
    grandTotal    += r.lineTotal;
  }
  return { subtotal, totalDiscount, totalTax, grandTotal };
}

// ─── PDF: items table ──────────────────────────────────────────────────────────
function itemTableHTML(items, C, docDiscountPct = 0) {
  const taxOn  = C.taxOn && C.taxRate > 0;
  const hasDis = C.showDiscountCol;
  const hasTax = C.showTaxCol && taxOn;
  const hasBar = C.showBarcodeCol;

  // Shrink description to make room for extra columns. Barcode takes its 12%
  // from here for the same reason the other two do — the row has to stay on one
  // line, and a wrapped description is what pushes an invoice onto a second page.
  const extras = (hasDis ? 1 : 0) + (hasTax ? 1 : 0);
  const descW  = (extras === 2 ? 34 : extras === 1 ? 40 : 48) - (hasBar ? 12 : 0);
  const colSpan = 5 + extras + (hasBar ? 1 : 0);

  const thead = `<thead><tr>
    <th style="width:5%">#</th>
    ${hasBar ? `<th style="width:12%">Barcode</th>` : ''}
    <th style="width:${descW}%">Description</th>
    <th style="width:8%" class="r">Qty</th>
    <th style="width:14%" class="r">Unit Price</th>
    ${hasDis ? `<th style="width:10%" class="r">Discount</th>` : ''}
    ${hasTax ? `<th style="width:10%" class="r">Tax</th>` : ''}
    <th style="width:14%" class="r">Amount</th>
  </tr></thead>`;

  if (!items?.length) {
    return `${thead}<tbody><tr><td colspan="${colSpan}" style="text-align:center;color:#94a3b8;padding:14px;font-style:italic">No line items added</td></tr></tbody>`;
  }

  const rows = items.map((item, i) => {
    const { qty, unitPrice, disc, discAmt, taxAmt, lineTotal, rate } =
      lineCalc(item, C.taxRate, taxOn, docDiscountPct);
    return `<tr>
      <td class="seq">${i + 1}</td>
      ${hasBar ? `<td class="barcode">${item.barcode || '—'}</td>` : ''}
      <td><div class="item-name">${item.name || '—'}</div>${item.description ? `<div class="item-desc">${item.description}</div>` : ''}</td>
      <td class="r">${qty.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
      <td class="r">${USD(unitPrice)}</td>
      ${hasDis ? `<td class="r" style="color:#d97706">${disc > 0 ? `${disc}%<br><span style="font-size:8px">(${USD(discAmt)})</span>` : '—'}</td>` : ''}
      ${hasTax ? `<td class="r" style="color:#1B4F72">${taxAmt > 0 ? `${rate}%<br><span style="font-size:8px">(${USD(taxAmt)})</span>` : '—'}</td>` : ''}
      <td class="r num">${USD(lineTotal)}</td>
    </tr>`;
  }).join('');

  return `${thead}<tbody>${rows}</tbody>`;
}

// ─── PDF: totals box ───────────────────────────────────────────────────────────
// Tax is always declared in totals when taxOn (legal requirement), regardless of showTaxCol.
// Discount row only appears when showDiscountCol is enabled and there's actually a discount.
function totalsBoxHTML(subtotal, totalDiscount, totalTax, grandTotal, C, extraRows = '') {
  const taxOn = C.taxOn && C.taxRate > 0;
  return `
  <div class="totals-wrap"><div class="totals-box">
    <div class="totals-row"><span class="k">Subtotal</span><span class="v">${USD(subtotal)}</span></div>
    ${C.showDiscountCol && totalDiscount > 0 ? `<div class="totals-row"><span class="k">Discount</span><span class="v" style="color:#d97706">(${USD(totalDiscount)})</span></div>` : ''}
    ${totalTax > 0 ? `<div class="totals-row"><span class="k">Tax</span><span class="v">${USD(totalTax)}</span></div>` : ''}
    <div class="totals-row grand"><span class="k">Grand Total</span><span class="v">${USD(grandTotal)}</span></div>
    ${extraRows}
  </div></div>`;
}

// ─── Shared HTML helpers ───────────────────────────────────────────────────────
function clientHTML(client) {
  if (!client?.name) return `<div class="client-name" style="color:#94a3b8;font-style:italic">No client specified</div>`;
  const lines = [];
  if (client.company && client.company !== client.name) lines.push(`<div class="client-line">${client.company}</div>`);
  if (client.address) lines.push(`<div class="client-line">${client.address}</div>`);
  if (client.city || client.country) lines.push(`<div class="client-line">${[client.city, client.country].filter(Boolean).join(', ')}</div>`);
  if (client.phone) lines.push(`<div class="client-line">Tel: ${client.phone}</div>`);
  if (client.email) lines.push(`<div class="client-line">${client.email}</div>`);
  return `<div class="client-name">${client.name}</div>${lines.join('')}`;
}

function companyDetails(C) {
  return [C.address, C.phone ? `Tel: ${C.phone}` : '', C.email, C.website, C.vat, C.regNo].filter(Boolean).join(' • ');
}

function paymentInstructions(C) {
  const rows = [];
  if (C.bankName)    rows.push(`<strong>Bank:</strong> ${C.bankName}`);
  if (C.bankAccount) rows.push(`<strong>Acc:</strong> ${C.bankAccount}`);
  if (C.bankIBAN)    rows.push(`<strong>IBAN:</strong> ${C.bankIBAN}`);
  if (C.bankSwift)   rows.push(`<strong>SWIFT:</strong> ${C.bankSwift}`);
  if (!rows.length) return '';
  return `<div class="band slate"><span class="band-label">Bank Details:</span> ${rows.join(' | ')}</div>`;
}

// ─── Theme composition ─────────────────────────────────────────────────────────
// A themed document swaps three things: the letterhead artwork (which carries
// the masthead), the document header, and the footer. Everything between them — the table, the totals, the
// bands — is the same markup either way, so a theme cannot change what the
// document SAYS, only how it looks. That is the property worth having: a
// letterhead is presentation, and no company's design should be able to alter
// the figures on its own invoices.
function docShell(theme, { C, logo, title, client, rows, statusHtml, defaultHeader, defaultInfo, body, defaultFooter }) {
  if (!theme) {
    // Byte-identical to the pre-theme output. Adding one company's letterhead
    // must not restyle everybody else's documents.
    return `<div class="page">
  ${defaultHeader}

  ${defaultInfo}

  ${body}
  <div class="content-spacer"></div>
  ${defaultFooter}
</div>`;
  }

  // A table, not divs. thead and tfoot are the only things a browser reliably
  // repeats on every printed sheet, and they reserve their own height on each —
  // so the letterhead prints on page three of a long invoice, and page three's
  // first row cannot land on top of it. The whole letterhead hangs off the
  // thead; the tfoot is an empty spacer that only reserves the foot margin.
  //
  // On pre-printed stationery the thead carries nothing but that reservation.
  // The paper already has the letterhead on it, so printing the design again
  // would lay ink over ink — and no printer feeds a sheet within a tenth of a
  // millimetre, so the second impression would sit slightly off the first and
  // show as a doubled edge. The MARGINS stay exactly the same either way, which
  // is what keeps the text landing in the blank area the design leaves free.
  const sheet = C.preprinted ? '' : theme.sheet(C, logo);

  return `<div class="page">
  <table class="hj-sheet">
    <thead><tr><td>${sheet}</td></tr></thead>
    <tbody><tr><td>
      ${theme.open}
        ${theme.header({ C, title, client, rows, statusHtml })}
        ${body}
      ${theme.close}
    </td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;
}

/** The grand total in words, when the company has asked for it. */
// `total` is in the document's BASE currency, like every other figure here, and
// is converted through CC exactly as the totals box converts it. Taking the
// currency context rather than a bare code is deliberate: passing the code
// alone let the words be spelled from the unconverted number while the box
// printed the converted one, so an invoice showing a balance of LBP 1,780,000
// read "Twenty Lebanese Pounds only" underneath — the right currency, the wrong
// amount, which is the precise failure this line exists to make impossible.
function totalWordsHTML(theme, total, CC, C) {
  if (!C.showTotalWords) return '';
  const words = amountInWords(CC.conv(total), CC.code);
  if (!words) return '';
  return theme
    ? theme.words(words)
    : `<div class="band slate"><span class="band-label">Amount in words:</span> ${words}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATION PDF
// ═══════════════════════════════════════════════════════════════════════════════
/** The quotation document as an HTML string — see buildInvoiceHTML. */
export function buildQuotationHTML(quotation, settings, logoDataURL = null, opts = {}) {
  const C  = buildCompany(settings);
  const txn = inTransactionCurrency(quotation, quotation.items || [], C);
  const CC  = txn
    ? { useLbp: false, rate: 1, code: txn.code,
        money: (v) => fmtCurrency(Number(v) || 0, txn.code),
        conv:  (v) => Number(v) || 0 }
    : currencyContext(C, opts);
  USD = CC.money;

  const items          = txn ? txn.items : (quotation.items || []);
  const docDiscountPct = Number(quotation.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);

  const status = quotation.status || 'Draft';
  const statusStyle = ({
    Draft:    'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1',
    Sent:     'background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe',
    Accepted: 'background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0',
    Rejected: 'background:#fef2f2;color:#dc2626;border:1px solid #fecaca',
  })[status] || 'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1';

  const client     = quotation.client || (quotation.client_name ? { name: quotation.client_name } : null);
  const docNo      = quotation.quote_number || '—';
  const issueDate  = fmtDate(quotation.created_at);
  const validUntil = fmtDate(addDays(quotation.created_at, C.paymentDays));
  const logo       = logoDataURL ? `<img src="${logoDataURL}" class="company-logo" alt="logo" />` : '';
  const taxOn      = C.taxOn && C.taxRate > 0;
  const rateNote   = CC.useLbp
    ? `<div class="band slate"><span class="band-label">Currency Note:</span> Amounts are shown in ${CC.code}, converted from ${C.currency} at 1 ${C.currency} = ${CC.rate.toLocaleString('en-US')} ${CC.code}.</div>`
    : '';

  const theme = themeFor(settings);

  const body = `<table>${itemTableHTML(items, C, docDiscountPct)}</table>

  ${totalsBoxHTML(subtotal, totalDiscount, totalTax, grandTotal, C)}
  ${totalWordsHTML(theme, grandTotal, CC, C)}
  ${rateNote}

  <div class="band amber"><span class="band-label">Valid Until:</span> ${validUntil} (${C.paymentDays} days from issue). Prices are subject to change thereafter.</div>
  ${quotation.notes ? `<div class="band"><span class="band-label">Notes:</span> ${quotation.notes}</div>` : ''}
  <div class="band"><span class="band-label">Terms and Conditions:</span> All prices in ${CC.code}. Payment due Net ${C.paymentDays} days. Quotation binding upon written acceptance. Goods remain property of ${C.name} until paid in full. Scope changes may affect pricing.</div>
  ${paymentInstructions(C)}
  ${C.footer ? `<div class="band"><span class="band-label">Note:</span> ${C.footer}</div>` : ''}

  <div class="sig-section">
    <div class="sig-header">Acceptance & Authorization</div>
    <div class="sig-body">By signing, the undersigned accepts all terms, pricing, and conditions herein. This document authorizes proceeding with the described scope.
      <div class="sig-grid">
        <div><div class="sig-title">Client Signature & Name</div><div class="sig-line">Signature: _______________ Date: ____/____/______</div></div>
        <div><div class="sig-title">Authorized by ${C.name}</div><div class="sig-line">Signature: _______________ Date: ____/____/______</div></div>
      </div>
    </div>
  </div>`;

  const shell = docShell(theme, {
    C, logo: logoDataURL, title: 'Quotation', client, body,
    statusHtml: `<div class="status-badge" style="${statusStyle}">${status}</div>`,
    rows: [
      { label: 'Date',     value: issueDate },
      { label: 'Ref',      value: docNo },
      { label: 'Valid until', value: validUntil },
      { label: 'Terms',    value: `Net ${C.paymentDays} days` },
      { label: 'Currency', value: CC.code },
      { label: 'Project',  value: quotation.project_name || '' },
    ],
    defaultHeader: `<div class="doc-header">
    <div>${logo}<div class="company-name">${C.name}</div><div class="company-meta">${companyDetails(C)}</div></div>
    <div style="text-align:right">
      <div class="doc-title">Quotation</div>
      <div class="doc-ref">${docNo}</div>
      <div class="doc-dates">Issued: <strong>${issueDate}</strong> • Valid: <strong>${validUntil}</strong><br>Terms: <strong>Net ${C.paymentDays} Days</strong> • Currency: <strong>${CC.code}</strong></div>
      <div class="status-badge" style="${statusStyle}">${status}</div>
    </div>
  </div>`,
    defaultInfo: `<div class="info-grid">
    <div class="info-col"><div class="info-label">Prepared For</div>${clientHTML(client)}</div>
    <div class="info-col">
      <div class="info-label">Document Info</div>
      ${quotation.project_name ? `<div class="meta-row"><span class="meta-key">Project</span><span>${quotation.project_name}</span></div>` : ''}
      <div class="meta-row"><span class="meta-key">Ref</span><span>${docNo}</span></div>
      <div class="meta-row"><span class="meta-key">Issued</span><span>${issueDate}</span></div>
      <div class="meta-row"><span class="meta-key">Expires</span><span>${validUntil}</span></div>
    </div>
  </div>`,
    defaultFooter: `<div class="doc-footer">
    <div class="footer-left"><strong>${C.name}</strong><br>${C.address}${C.phone ? ` • ${C.phone}` : ''}</div>
    <div style="text-align:center;font-size:7px;color:#9ca3af">Confidential • ${docNo} • ${new Date().toLocaleDateString()}</div>
    <div style="text-align:right">${C.email}${C.vat ? `<br>${C.vat}` : ''}</div>
  </div>`,
  });

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Quotation ${docNo}</title><style>${SHARED_CSS}${theme ? theme.css : ''}</style></head><body>
${shell}
</body></html>`;

  return { html, docNo };
}

export async function exportQuotationPDF(quotation, opts = {}) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const { html, docNo } = buildQuotationHTML(quotation, settings, logoDataURL, opts);
  await saveDocumentSnapshot('quotation', quotation, `Quotation ${docNo}`, html);
  printHTML(html, `Quotation_${docNo}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE PDF
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * The invoice document as an HTML string.
 *
 * Split out from exportInvoicePDF so the CLIENT's share link can render the very
 * same document the supplier prints. Previously the public page had its own
 * simplified layout, so the copy a customer opened looked nothing like the one
 * they were told had been sent.
 *
 * Takes `settings` and `logoDataURL` as arguments rather than fetching them:
 * the public page has no session and cannot call the authenticated endpoints.
 */
export function buildInvoiceHTML(invoice, settings, logoDataURL = null, opts = {}) {
  const C  = buildCompany(settings);
  // A document raised in another currency prints in that one. The company's
  // "show everything in pounds" toggle is a view over ITS OWN figures and does
  // not apply — converting a euro invoice through a pound rate would produce a
  // number nobody agreed to.
  const txn = inTransactionCurrency(invoice, invoice.items || [], C);
  const CC  = txn
    ? { useLbp: false, rate: 1, code: txn.code,
        money: (v) => fmtCurrency(Number(v) || 0, txn.code),
        conv:  (v) => Number(v) || 0 }
    : currencyContext(C, opts);
  USD = CC.money;

  const items          = txn ? txn.items : (invoice.items || []);
  const payments       = invoice.payments || [];
  const docDiscountPct = Number(invoice.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);

  // What the customer has paid, in the money they paid it in.
  const paid    = payments.reduce(
    (s, p) => s + (Number(txn ? (p.txn_amount ?? p.amount) : p.amount) || 0), 0);
  const balance = Math.max(0, grandTotal - paid);
  const isPaid  = balance < 0.01;
  const status  = invoice.payment_status || (isPaid ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid');

  const statusStyle = ({
    Unpaid:  'background:#fef2f2;color:#dc2626;border:1px solid #fecaca',
    Partial: 'background:#fffbeb;color:#d97706;border:1px solid #fde68a',
    Paid:    'background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0',
  })[status] || 'background:#fef2f2;color:#dc2626;border:1px solid #fecaca';

  const client    = invoice.client || (invoice.client_name ? { name: invoice.client_name } : null);
  const docNo     = invoice.invoice_number || '—';
  const invDate   = invoice.created_at || new Date().toISOString();
  const dueDate   = invoice.due_date || addDays(invDate, C.paymentDays);
  const isOverdue = !isPaid && new Date(dueDate) < new Date();
  const logo      = logoDataURL ? `<img src="${logoDataURL}" class="company-logo" alt="logo" />` : '';
  const taxOn     = C.taxOn && C.taxRate > 0;
  const rateNote  = CC.useLbp
    ? `<div class="band slate"><span class="band-label">Currency Note:</span> Amounts are shown in ${CC.code}, converted from ${C.currency} at 1 ${C.currency} = ${CC.rate.toLocaleString('en-US')} ${CC.code}.</div>`
    : '';

  const paymentRows = payments.map((p, i) =>
    `<tr>
      <td class="seq">${i + 1}</td>
      <td>${fmtDate(p.paid_at)}</td>
      <td>${p.method || '—'}</td>
      <td>${p.note   || '—'}</td>
      <td class="r" style="color:var(--green)">${USD(p.amount)}</td>
    </tr>`
  ).join('');

  // The agreed schedule, when there is one. The customer's own arrangement is
  // the thing they most need from an invoice on a plan: what is due next, and
  // whether they are behind. It goes in the SHARED template so it reaches the
  // printed PDF and the share link alike -- a schedule the customer cannot see
  // when they print the document is half a feature.
  //
  // The server derives each row's status from the payments listed below it, so
  // the two blocks on this page cannot contradict each other.
  const plan = invoice.installments || [];
  const overdueRows = plan.filter(r => r.status === 'Overdue');
  const planRows = plan.map(r =>
    `<tr>
      <td class="seq">${r.seq}</td>
      <td${r.status === 'Overdue' ? ' style="color:#dc2626;font-weight:600"' : ''}>${fmtDate(r.due_date)}</td>
      <td class="r">${USD(r.amount)}</td>
      <td class="r" style="color:var(--green)">${USD(r.paid)}</td>
      <td class="r"${Number(r.remaining) > 0.005 ? '' : ' style="color:var(--green)"'}>${USD(r.remaining)}</td>
    </tr>`
  ).join('');
  const nextUnpaid = plan.find(r => Number(r.remaining) > 0.005);
  const planNote = overdueRows.length
    ? `<div class="band amber"><span class="band-label">&#9888; Overdue:</span> ${overdueRows.length} instalment${overdueRows.length > 1 ? 's' : ''} totalling ${USD(overdueRows.reduce((s, r) => s + Number(r.remaining || 0), 0))} ${overdueRows.length > 1 ? 'are' : 'is'} past due.</div>`
    : nextUnpaid
      ? `<div class="band"><span class="band-label">Next instalment:</span> ${USD(nextUnpaid.remaining)} by ${fmtDate(nextUnpaid.due_date)}.</div>`
      : '';

  const extraTotalsRows = `
    <div class="totals-row"><span class="k">Paid</span><span class="v green">${USD(paid)}</span></div>
    <div class="totals-row"><span class="k">Balance</span><span class="v ${balance === 0 ? 'green' : 'red'}">${USD(balance)}</span></div>`;

  const theme = themeFor(settings);

  const body = `<table>${itemTableHTML(items, C, docDiscountPct)}</table>

  ${totalsBoxHTML(subtotal, totalDiscount, totalTax, grandTotal, C, extraTotalsRows)}
  ${totalWordsHTML(theme, grandTotal, CC, C)}
  ${rateNote}

  ${isPaid
    ? `<div class="band green"><span class="band-label">✓ Paid in Full:</span> Settled. Thank you for your prompt payment.</div>`
    : plan.length
      // Under a plan the balance is not owed on one date, and the invoice's own
      // due_date is the LAST instalment. Saying "$12,000 due by December" beside
      // a schedule of twelve monthly payments contradicts it, so the plan's own
      // note below carries the message instead.
      ? ''
      : isOverdue
        ? `<div class="band amber"><span class="band-label">⚠ Overdue:</span> ${USD(balance)} was due on ${fmtDate(dueDate)}. Please remit immediately to avoid service interruption.</div>`
        : `<div class="band"><span class="band-label">Due:</span> ${USD(balance)} by ${fmtDate(dueDate)} (Net ${C.paymentDays} days).</div>`
  }
  ${invoice.notes ? `<div class="band"><span class="band-label">Notes:</span> ${invoice.notes}</div>` : ''}
  ${paymentInstructions(C)}

  ${plan.length ? `
  <div class="section-heading">Payment Plan</div>
  <table>
    <thead><tr>
      <th style="width:5%">#</th><th style="width:25%">Due</th>
      <th style="width:23%" class="r">Amount</th><th style="width:23%" class="r">Paid</th>
      <th style="width:24%" class="r">Balance</th>
    </tr></thead>
    <tbody>${planRows}</tbody>
  </table>
  ${planNote}` : ''}

  ${payments.length ? `
  <div class="section-heading">Payment History</div>
  <table>
    <thead><tr>
      <th style="width:5%">#</th><th style="width:20%">Date</th>
      <th style="width:18%">Method</th><th style="width:37%">Reference / Note</th>
      <th style="width:20%" class="r">Amount</th>
    </tr></thead>
    <tbody>${paymentRows}</tbody>
  </table>` : ''}

  ${C.terms ? `
  <div class="section-heading">Terms &amp; Conditions</div>
  <div class="band" style="white-space:pre-wrap;display:block">${escape(C.terms)}</div>` : ''}
  ${C.footer ? `<div class="band"><span class="band-label">Note:</span> ${C.footer}</div>` : ''}`;

  const shell = docShell(theme, {
    C, logo: logoDataURL, title: 'Sales Invoice', client, body,
    statusHtml: `<div class="status-badge" style="${statusStyle}">${status}</div>`,
    rows: [
      { label: 'Date',     value: fmtDate(invDate) },
      { label: 'Ref',      value: docNo },
      { label: 'Due',      value: fmtDate(dueDate) },
      { label: 'Terms',    value: `Net ${C.paymentDays} days` },
      { label: 'Currency', value: CC.code },
      { label: 'Quote Ref', value: invoice.quote_number || '' },
      { label: 'Project',  value: invoice.project_name || '' },
    ],
    defaultHeader: `<div class="doc-header">
    <div>${logo}<div class="company-name">${C.name}</div><div class="company-meta">${companyDetails(C)}</div></div>
    <div style="text-align:right">
      <div class="doc-title">Invoice</div>
      <div class="doc-ref">${docNo}</div>
      <div class="doc-dates">Date: <strong>${fmtDate(invDate)}</strong> • Due: <strong>${fmtDate(dueDate)}</strong><br>${invoice.quote_number ? `Quote Ref: <strong>${invoice.quote_number}</strong> • ` : ''}Terms: <strong>Net ${C.paymentDays} Days</strong> • ${CC.code}</div>
      <div class="status-badge" style="${statusStyle}">${status}</div>
    </div>
  </div>`,
    defaultInfo: `<div class="info-grid">
    <div class="info-col"><div class="info-label">Bill To</div>${clientHTML(client)}</div>
    <div class="info-col">
      <div class="info-label">Invoice Details</div>
      ${invoice.project_name ? `<div class="meta-row"><span class="meta-key">Project</span><span>${invoice.project_name}</span></div>` : ''}
      <div class="meta-row"><span class="meta-key">No.</span><span>${docNo}</span></div>
      <div class="meta-row"><span class="meta-key">Issued</span><span>${fmtDate(invDate)}</span></div>
      <div class="meta-row"><span class="meta-key">Due</span><span>${fmtDate(dueDate)}</span></div>
    </div>
  </div>`,
    defaultFooter: `<div class="doc-footer">
    <div class="footer-left"><strong>${C.name}</strong><br>${C.address}${C.phone ? ` • ${C.phone}` : ''}</div>
    <div style="text-align:center;font-size:7px;color:#9ca3af">Confidential • ${docNo} • ${new Date().toLocaleDateString()}</div>
    <div style="text-align:right">${C.email}${C.vat ? `<br>${C.vat}` : ''}</div>
  </div>`,
  });

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invoice ${docNo}</title><style>${SHARED_CSS}${theme ? theme.css : ''}</style></head><body>
${shell}
</body></html>`;

  return { html, docNo };
}

export async function exportInvoicePDF(invoice, opts = {}) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const { html, docNo } = buildInvoiceHTML(invoice, settings, logoDataURL, opts);
  await saveDocumentSnapshot('invoice', invoice, `Invoice ${docNo}`, html);
  printHTML(html, `Invoice_${docNo}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCEL — shared helpers
// ═══════════════════════════════════════════════════════════════════════════════
function excelItemsSheet(items, C, docDiscountPct, CC) {
  const taxOn  = C.taxOn && C.taxRate > 0;
  const hasDis = C.showDiscountCol;
  const hasTax = C.showTaxCol && taxOn;
  const cur    = CC.code;

  // The spreadsheet carries the same columns as the printed document. Two
  // exports of one invoice that disagree on which columns exist is the sort of
  // thing that gets noticed halfway through a reconciliation.
  const hasBar = C.showBarcodeCol;

  const headers = [
    '#', ...(hasBar ? ['Barcode'] : []), 'Description', 'Qty', `Unit Price (${cur})`,
    ...(hasDis ? ['Discount %', `Discount Amt (${cur})`] : []),
    ...(hasTax ? [`Tax (${cur})`]                         : []),
    `Line Total (${cur})`,
  ];

  const rows = (items || []).map((item, idx) => {
    const { qty, unitPrice, disc, discAmt, taxAmt, lineTotal } =
      lineCalc(item, C.taxRate, taxOn, docDiscountPct);
    return [
      idx + 1,
      // As text: a barcode with a leading zero is not a number, and Excel would
      // eat the zero and leave a code that scans as a different product.
      ...(hasBar ? [item.barcode ? String(item.barcode) : ''] : []),
      item.name, qty, CC.conv(unitPrice),
      ...(hasDis ? [disc, CC.conv(discAmt)] : []),
      ...(hasTax ? [CC.conv(taxAmt)]        : []),
      CC.conv(lineTotal),
    ];
  });

  // Helper: build a summary row with correct number of blank cells
  const summaryRow = (label, value) => [
    '', '', '',
    ...(hasBar ? [''] : []),
    label,
    ...(hasDis ? ['', ''] : []),
    ...(hasTax ? ['']     : []),
    value,
  ];

  const { subtotal, totalDiscount, totalTax, grandTotal } =
    aggregateLines(items, C, docDiscountPct);

  const blank = new Array(headers.length).fill('');
  return [
    headers,
    ...rows,
    blank,
    summaryRow('SUBTOTAL', CC.conv(subtotal)),
    ...(hasDis && totalDiscount > 0 ? [summaryRow('DISCOUNT', CC.conv(-totalDiscount))] : []),
    ...(totalTax > 0 ? [summaryRow('TAX', CC.conv(totalTax))] : []),
    summaryRow('GRAND TOTAL', CC.conv(grandTotal)),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATION EXCEL
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportQuotationExcel(quotation, opts = {}) {
  const s = await getSettings();
  const C  = buildCompany(s);
  const CC = currencyContext(C, opts);
  const items          = quotation.items || [];
  const docDiscountPct = Number(quotation.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);
  const cur   = CC.code;
  const taxOn = C.taxOn && C.taxRate > 0;

  const summary = [
    [`${C.name} — Quotation`], [],
    ['Ref',         quotation.quote_number],
    ['Status',      quotation.status],
    ['Client',      quotation.client_name || quotation.client?.name || ''],
    ['Project',     quotation.project_name || ''],
    ['Issued',      fmtShort(quotation.created_at)],
    ['Valid Until', fmtShort(addDays(quotation.created_at, C.paymentDays))],
    ['Terms',       `Net ${C.paymentDays} days`],
    ['Currency',    cur],
    ...(CC.useLbp ? [['Exchange Rate', `1 ${C.currency} = ${CC.rate.toLocaleString('en-US')} ${cur}`]] : []),
    ['Notes',       quotation.notes || ''],
    [],
    ['Subtotal',    CC.conv(subtotal)],
    ...(C.showDiscountCol && totalDiscount > 0 ? [['Discount', CC.conv(-totalDiscount)]] : []),
    ...(totalTax > 0 ? [['Tax', CC.conv(totalTax)]] : []),
    ['GRAND TOTAL', CC.conv(grandTotal)],
  ];

  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  const ws2 = XLSX.utils.aoa_to_sheet(excelItemsSheet(items, C, docDiscountPct, CC));
  ws1['!cols'] = [{ wch: 18 }, { wch: 34 }];
  ws2['!cols'] = [{ wch: 4 }, { wch: 38 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
  XLSX.utils.book_append_sheet(wb, ws2, 'Items');
  XLSX.writeFile(wb, `${quotation.quote_number || 'Quotation'}_export.xlsx`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE EXCEL
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportInvoiceExcel(invoice, opts = {}) {
  const s = await getSettings();
  const C  = buildCompany(s);
  const CC = currencyContext(C, opts);
  const items          = invoice.items    || [];
  const payments       = invoice.payments || [];
  const docDiscountPct = Number(invoice.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);
  const paid    = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const balance = Math.max(0, grandTotal - paid);
  const cur     = CC.code;
  const taxOn   = C.taxOn && C.taxRate > 0;

  const summary = [
    [`${C.name} — Invoice`], [],
    ['No.',       invoice.invoice_number],
    ['Quote Ref', invoice.quote_number    || ''],
    ['Status',    invoice.payment_status  || 'Unpaid'],
    ['Client',    invoice.client_name     || invoice.client?.name || ''],
    ['Project',   invoice.project_name    || ''],
    ['Issued',    fmtShort(invoice.created_at)],
    ['Due',       invoice.due_date ? fmtShort(invoice.due_date) : fmtShort(addDays(invoice.created_at, C.paymentDays))],
    ['Terms',     `Net ${C.paymentDays} days`],
    ['Currency',  cur],
    ...(CC.useLbp ? [['Exchange Rate', `1 ${C.currency} = ${CC.rate.toLocaleString('en-US')} ${cur}`]] : []),
    ['Notes',     invoice.notes || ''],
    [],
    ['Subtotal',    CC.conv(subtotal)],
    ...(C.showDiscountCol && totalDiscount > 0 ? [['Discount', CC.conv(-totalDiscount)]] : []),
    ...(totalTax > 0 ? [['Tax', CC.conv(totalTax)]] : []),
    ['Total',       CC.conv(grandTotal)],
    ['Paid',        CC.conv(paid)],
    ['Balance Due', CC.conv(balance)],
  ];

  const payRows = payments.length ? [
    ['#', 'Date', `Amount (${cur})`, 'Method', 'Note'],
    ...payments.map((p, i) => [i + 1, fmtShort(p.paid_at), CC.conv(p.amount), p.method || '', p.note || '']),
    [],
    ['', 'TOTAL PAID',  CC.conv(paid),    '', ''],
    ['', 'BALANCE DUE', CC.conv(balance), '', ''],
  ] : [];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelItemsSheet(items, C, docDiscountPct, CC)), 'Items');
  if (payRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(payRows), 'Payments');
  XLSX.writeFile(wb, `${invoice.invoice_number || 'Invoice'}_export.xlsx`);
}


// ════════════════════════════════════════════════════════════════════════════
// GENERIC REPORT PDF
// ════════════════════════════════════════════════════════════════════════════
// Used by the Reports module to print any tabular dataset as a clean,
// branded PDF. Mirrors the Excel export contract — same `columns` array shape
// — so the call sites stay symmetric.
//
//   exportReportPDF({
//     title:    'Financial Report',
//     subtitle: 'Q1 2026 · all departments',  // optional
//     filename: 'financial_report.pdf',
//     columns:  [{ label, value(row), align?, width? }, ...],
//     rows:     [...],
//     totals:   { label, columns: { colIndex: value } },  // optional footer row
//     meta:     { ... }   // optional key/value pairs rendered above the table
//   })

export async function exportReportPDF({
  title,
  subtitle = '',
  filename,
  columns,
  rows,
  totals = null,
  meta = null,
}) {
  // Resolve company branding from settings — same lookup the document
  // exports use, so report headers match invoices/quotations visually.
  const [settings, logoSrc] = await Promise.all([getSettings(), getLogoDataURL()]);
  const companyName = (settings.company_name || 'Company').toString();
  const companySub = [settings.company_city, settings.company_country]
    .filter(Boolean).join(', ');
  const dateLabel = new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  const headerHTML = `
    <header class="rpt-hdr">
      ${logoSrc ? `<img class="rpt-logo" src="${logoSrc}" alt="logo" />` : ''}
      <div class="rpt-co">
        <div class="rpt-co-name">${escape(companyName)}</div>
        ${companySub ? `<div class="rpt-co-sub">${escape(companySub)}</div>` : ''}
      </div>
      <div class="rpt-doc">
        <div class="rpt-doc-title">${escape(title)}</div>
        ${subtitle ? `<div class="rpt-doc-sub">${escape(subtitle)}</div>` : ''}
        <div class="rpt-doc-date">${escape(dateLabel)}</div>
      </div>
    </header>
  `;

  const metaHTML = meta && Object.keys(meta).length
    ? `<div class="rpt-meta">
         ${Object.entries(meta).map(([k, v]) =>
           `<div class="rpt-meta-cell"><span class="rpt-meta-k">${escape(k)}</span><span class="rpt-meta-v">${escape(String(v ?? '—'))}</span></div>`
         ).join('')}
       </div>`
    : '';

  const colHTML = columns.map(c =>
    `<col style="${c.width ? `width:${c.width};` : ''}" />`).join('');
  const theadHTML = `<tr>${columns.map(c =>
    `<th class="rpt-th rpt-${c.align || 'left'}">${escape(c.label)}</th>`
  ).join('')}</tr>`;
  const tbodyHTML = (rows || []).map(r => `<tr>${columns.map(c => {
    const v = c.value(r);
    return `<td class="rpt-td rpt-${c.align || 'left'}">${formatCell(v)}</td>`;
  }).join('')}</tr>`).join('');

  const tfootHTML = totals
    ? `<tr class="rpt-totals">${columns.map((c, i) => {
        if (i === 0 && totals.label) {
          return `<td class="rpt-td rpt-left rpt-bold">${escape(totals.label)}</td>`;
        }
        const v = totals.columns?.[i];
        return `<td class="rpt-td rpt-${c.align || 'left'} rpt-bold">${
          v == null ? '' : formatCell(v)
        }</td>`;
      }).join('')}</tr>`
    : '';

  const emptyHTML = (rows || []).length === 0
    ? `<div class="rpt-empty">No data available for this report.</div>`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escape(filename || title)}</title>
<style>
  ${SHARED_CSS}
  body { padding: 18px 22px; }
  .rpt-hdr {
    display: flex; align-items: center; gap: 14px;
    padding-bottom: 12px; margin-bottom: 14px;
    border-bottom: 2px solid var(--brand);
  }
  .rpt-logo { width: 44px; height: 44px; object-fit: contain; }
  .rpt-co { flex: 1; }
  .rpt-co-name { font-size: 14px; font-weight: 700; color: var(--text); letter-spacing: -.2px; }
  .rpt-co-sub  { font-size: 9.5px; color: var(--text-muted); margin-top: 1px; }
  .rpt-doc { text-align: right; }
  .rpt-doc-title { font-size: 16px; font-weight: 700; color: var(--brand); letter-spacing: -.3px; }
  .rpt-doc-sub   { font-size: 9.5px; color: var(--text-mid); margin-top: 2px; }
  .rpt-doc-date  { font-size: 9px; color: var(--text-muted); margin-top: 2px; }
  .rpt-meta { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 12px; padding: 8px 10px;
              background: var(--bg-alt); border: 1px solid var(--border); border-radius: 4px; }
  .rpt-meta-cell { display: flex; flex-direction: column; gap: 1px; min-width: 100px; }
  .rpt-meta-k { font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-muted); font-weight: 600; }
  .rpt-meta-v { font-size: 10.5px; color: var(--text); font-weight: 600; }
  table.rpt-tbl { width: 100%; border-collapse: collapse; font-size: 9.5px; }
  .rpt-th { background: var(--brand); color: #fff; font-weight: 600;
            padding: 6px 8px; text-transform: uppercase; letter-spacing: .3px; font-size: 8.5px; }
  .rpt-td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  tbody tr:nth-child(even) .rpt-td { background: var(--bg-alt); }
  .rpt-left   { text-align: left; }
  .rpt-right  { text-align: right; font-variant-numeric: tabular-nums; }
  .rpt-center { text-align: center; }
  .rpt-bold   { font-weight: 700; color: var(--text); }
  .rpt-totals .rpt-td {
    border-top: 2px solid var(--brand); border-bottom: none;
    background: var(--brand-subtle); padding: 7px 8px;
  }
  .rpt-empty { padding: 24px; text-align: center; color: var(--text-muted); font-style: italic;
               border: 1px dashed var(--border); border-radius: 4px; }
  @media print { @page { margin: 14mm 12mm; size: A4 portrait; } body { padding: 0; } }
</style>
</head><body>
  ${headerHTML}
  ${metaHTML}
  ${rows && rows.length ? `
    <table class="rpt-tbl">
      <colgroup>${colHTML}</colgroup>
      <thead>${theadHTML}</thead>
      <tbody>${tbodyHTML}</tbody>
      ${tfootHTML ? `<tfoot>${tfootHTML}</tfoot>` : ''}
    </table>` : emptyHTML}
</body></html>`;

  printHTML(html, filename || `${title}.pdf`);
}

// Small helpers used by the report PDF.
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatCell(v) {
  if (v == null) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return escape(v.toLocaleString(undefined, {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    }));
  }
  return escape(String(v));
}
