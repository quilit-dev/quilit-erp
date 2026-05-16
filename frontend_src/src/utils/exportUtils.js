/**
 * exportUtils.js — PDF & Excel export for Quotations and Invoices.
 *
 * Settings honoured:
 *   tax_enabled        — master switch; hides all tax when off
 *   default_tax_rate   — % applied to each line and rolled into totals
 *   show_tax_col       — adds a per-line "Tax" column to PDF & Excel item tables
 *   show_discount_col  — adds a per-line "Discount" column to PDF & Excel item tables
 *                        (uses item.discount_pct if present, else document-level discount_pct)
 */
import * as XLSX from 'xlsx';

// ─── Formatters ────────────────────────────────────────────────────────────────
const fmtCurrency = (v, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(v) || 0);

let USD = (v) => fmtCurrency(v, 'USD');

const fmtDate = (d) => {
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
async function getLogoDataURL() {
  try {
    const resp = await fetch(`/logo.png?_=${Date.now()}`, { cache: 'no-store' });
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
function printHTML(htmlString, filename) {
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
const SHARED_CSS = `
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
async function getSettings() {
  try {
    const res = await fetch('/api/settings/', { credentials: 'include' });
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

// ─── Auto-save document snapshot ──────────────────────────────────────────────
async function saveDocumentSnapshot(recordType, record, title, htmlContent) {
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

function buildCompany(s) {
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
    paymentDays:     parseInt(s.payment_terms_days || '15', 10),
    // ── Tax settings ──────────────────────────────────────────────────────
    taxRate:         parseFloat(s.default_tax_rate   || '0'),
    taxOn:           s.tax_enabled         === '1',
    // ── Column visibility (Document Settings toggles) ─────────────────────
    showTaxCol:      s.show_tax_col        === '1',   // per-line Tax column
    showDiscountCol: s.show_discount_col   === '1',   // per-line Discount column
  };
}

// ─── Per-line computation ──────────────────────────────────────────────────────
// discountPct: item-level override first, then document-level fallback (0 = no discount)
function lineCalc(item, taxRate, taxOn, docDiscountPct) {
  const qty       = Number(item.quantity)   || 0;
  const unitPrice = Number(item.unit_price) || 0;
  const gross     = qty * unitPrice;
  const disc      = Number(item.discount_pct ?? docDiscountPct ?? 0);
  const discAmt   = gross * (disc / 100);
  const net       = gross - discAmt;
  const taxAmt    = taxOn ? net * (taxRate / 100) : 0;
  const lineTotal = net + taxAmt;
  return { qty, unitPrice, gross, disc, discAmt, net, taxAmt, lineTotal };
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

  // Shrink description to make room for extra columns
  const descW = hasDis && hasTax ? '34%' : (hasDis || hasTax) ? '40%' : '48%';
  const colSpan = 5 + (hasDis ? 1 : 0) + (hasTax ? 1 : 0);

  const thead = `<thead><tr>
    <th style="width:5%">#</th>
    <th style="width:${descW}">Description</th>
    <th style="width:8%" class="r">Qty</th>
    <th style="width:14%" class="r">Unit Price</th>
    ${hasDis ? `<th style="width:10%" class="r">Discount</th>` : ''}
    ${hasTax ? `<th style="width:10%" class="r">Tax (${C.taxRate}%)</th>` : ''}
    <th style="width:14%" class="r">Amount</th>
  </tr></thead>`;

  if (!items?.length) {
    return `${thead}<tbody><tr><td colspan="${colSpan}" style="text-align:center;color:#94a3b8;padding:14px;font-style:italic">No line items added</td></tr></tbody>`;
  }

  const rows = items.map((item, i) => {
    const { qty, unitPrice, disc, discAmt, taxAmt, lineTotal } =
      lineCalc(item, C.taxRate, taxOn, docDiscountPct);
    return `<tr>
      <td class="seq">${i + 1}</td>
      <td><div class="item-name">${item.name || '—'}</div>${item.description ? `<div class="item-desc">${item.description}</div>` : ''}</td>
      <td class="r">${qty.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
      <td class="r">${USD(unitPrice)}</td>
      ${hasDis ? `<td class="r" style="color:#d97706">${disc > 0 ? `${disc}%<br><span style="font-size:8px">(${USD(discAmt)})</span>` : '—'}</td>` : ''}
      ${hasTax ? `<td class="r" style="color:#1B4F72">${taxAmt > 0 ? USD(taxAmt) : '—'}</td>` : ''}
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
    ${taxOn ? `<div class="totals-row"><span class="k">Tax (${C.taxRate}%)</span><span class="v">${USD(totalTax)}</span></div>` : ''}
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

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATION PDF
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportQuotationPDF(quotation) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const C = buildCompany(settings);
  USD = (v) => fmtCurrency(v, C.currency);

  const items          = quotation.items || [];
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

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Quotation ${docNo}</title><style>${SHARED_CSS}</style></head><body>
<div class="page">
  <div class="doc-header">
    <div>${logo}<div class="company-name">${C.name}</div><div class="company-meta">${companyDetails(C)}</div></div>
    <div style="text-align:right">
      <div class="doc-title">Quotation</div>
      <div class="doc-ref">${docNo}</div>
      <div class="doc-dates">Issued: <strong>${issueDate}</strong> • Valid: <strong>${validUntil}</strong><br>Terms: <strong>Net ${C.paymentDays} Days</strong> • Currency: <strong>${C.currency}</strong></div>
      <div class="status-badge" style="${statusStyle}">${status}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-col"><div class="info-label">Prepared For</div>${clientHTML(client)}</div>
    <div class="info-col">
      <div class="info-label">Document Info</div>
      ${quotation.project_name ? `<div class="meta-row"><span class="meta-key">Project</span><span>${quotation.project_name}</span></div>` : ''}
      <div class="meta-row"><span class="meta-key">Ref</span><span>${docNo}</span></div>
      <div class="meta-row"><span class="meta-key">Issued</span><span>${issueDate}</span></div>
      <div class="meta-row"><span class="meta-key">Expires</span><span>${validUntil}</span></div>
      ${taxOn ? `<div class="meta-row"><span class="meta-key">Tax Rate</span><span>${C.taxRate}%</span></div>` : ''}
    </div>
  </div>

  <table>${itemTableHTML(items, C, docDiscountPct)}</table>

  ${totalsBoxHTML(subtotal, totalDiscount, totalTax, grandTotal, C)}

  <div class="band amber"><span class="band-label">Valid Until:</span> ${validUntil} (${C.paymentDays} days from issue). Prices are subject to change thereafter.</div>
  ${quotation.notes ? `<div class="band"><span class="band-label">Notes:</span> ${quotation.notes}</div>` : ''}
  <div class="band"><span class="band-label">Terms and Conditions:</span> All prices in ${C.currency}. Payment due Net ${C.paymentDays} days. Quotation binding upon written acceptance. Goods remain property of ${C.name} until paid in full. Scope changes may affect pricing.</div>
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
  </div>

  <div class="content-spacer"></div>
  <div class="doc-footer">
    <div class="footer-left"><strong>${C.name}</strong><br>${C.address}${C.phone ? ` • ${C.phone}` : ''}</div>
    <div style="text-align:center;font-size:7px;color:#9ca3af">Confidential • ${docNo} • ${new Date().toLocaleDateString()}</div>
    <div style="text-align:right">${C.email}${C.vat ? `<br>${C.vat}` : ''}</div>
  </div>
</div></body></html>`;

  await saveDocumentSnapshot('quotation', quotation, `Quotation ${docNo}`, html);
  printHTML(html, `Quotation_${docNo}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE PDF
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportInvoicePDF(invoice) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const C = buildCompany(settings);
  USD = (v) => fmtCurrency(v, C.currency);

  const items          = invoice.items    || [];
  const payments       = invoice.payments || [];
  const docDiscountPct = Number(invoice.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);

  const paid    = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
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

  const paymentRows = payments.map((p, i) =>
    `<tr>
      <td class="seq">${i + 1}</td>
      <td>${fmtDate(p.paid_at)}</td>
      <td>${p.method || '—'}</td>
      <td>${p.note   || '—'}</td>
      <td class="r" style="color:var(--green)">${USD(p.amount)}</td>
    </tr>`
  ).join('');

  const extraTotalsRows = `
    <div class="totals-row"><span class="k">Paid</span><span class="v green">${USD(paid)}</span></div>
    <div class="totals-row"><span class="k">Balance</span><span class="v ${balance === 0 ? 'green' : 'red'}">${USD(balance)}</span></div>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invoice ${docNo}</title><style>${SHARED_CSS}</style></head><body>
<div class="page">
  <div class="doc-header">
    <div>${logo}<div class="company-name">${C.name}</div><div class="company-meta">${companyDetails(C)}</div></div>
    <div style="text-align:right">
      <div class="doc-title">Invoice</div>
      <div class="doc-ref">${docNo}</div>
      <div class="doc-dates">Date: <strong>${fmtDate(invDate)}</strong> • Due: <strong>${fmtDate(dueDate)}</strong><br>${invoice.quote_number ? `Quote Ref: <strong>${invoice.quote_number}</strong> • ` : ''}Terms: <strong>Net ${C.paymentDays} Days</strong> • ${C.currency}</div>
      <div class="status-badge" style="${statusStyle}">${status}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-col"><div class="info-label">Bill To</div>${clientHTML(client)}</div>
    <div class="info-col">
      <div class="info-label">Invoice Details</div>
      ${invoice.project_name ? `<div class="meta-row"><span class="meta-key">Project</span><span>${invoice.project_name}</span></div>` : ''}
      <div class="meta-row"><span class="meta-key">No.</span><span>${docNo}</span></div>
      <div class="meta-row"><span class="meta-key">Issued</span><span>${fmtDate(invDate)}</span></div>
      <div class="meta-row"><span class="meta-key">Due</span><span>${fmtDate(dueDate)}</span></div>
      ${taxOn ? `<div class="meta-row"><span class="meta-key">Tax Rate</span><span>${C.taxRate}%</span></div>` : ''}
    </div>
  </div>

  <table>${itemTableHTML(items, C, docDiscountPct)}</table>

  ${totalsBoxHTML(subtotal, totalDiscount, totalTax, grandTotal, C, extraTotalsRows)}

  ${isPaid
    ? `<div class="band green"><span class="band-label">✓ Paid in Full:</span> Settled. Thank you for your prompt payment.</div>`
    : isOverdue
      ? `<div class="band amber"><span class="band-label">⚠ Overdue:</span> ${USD(balance)} was due on ${fmtDate(dueDate)}. Please remit immediately to avoid service interruption.</div>`
      : `<div class="band"><span class="band-label">Due:</span> ${USD(balance)} by ${fmtDate(dueDate)} (Net ${C.paymentDays} days).</div>`
  }
  ${invoice.notes ? `<div class="band"><span class="band-label">Notes:</span> ${invoice.notes}</div>` : ''}
  ${paymentInstructions(C)}

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

  ${C.footer ? `<div class="band"><span class="band-label">Note:</span> ${C.footer}</div>` : ''}
  <div class="content-spacer"></div>
  <div class="doc-footer">
    <div class="footer-left"><strong>${C.name}</strong><br>${C.address}${C.phone ? ` • ${C.phone}` : ''}</div>
    <div style="text-align:center;font-size:7px;color:#9ca3af">Confidential • ${docNo} • ${new Date().toLocaleDateString()}</div>
    <div style="text-align:right">${C.email}${C.vat ? `<br>${C.vat}` : ''}</div>
  </div>
</div></body></html>`;

  await saveDocumentSnapshot('invoice', invoice, `Invoice ${docNo}`, html);
  printHTML(html, `Invoice_${docNo}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCEL — shared helpers
// ═══════════════════════════════════════════════════════════════════════════════
function excelItemsSheet(items, C, docDiscountPct, cur) {
  const taxOn  = C.taxOn && C.taxRate > 0;
  const hasDis = C.showDiscountCol;
  const hasTax = C.showTaxCol && taxOn;

  const headers = [
    '#', 'Description', 'Qty', `Unit Price (${cur})`,
    ...(hasDis ? ['Discount %', `Discount Amt (${cur})`] : []),
    ...(hasTax ? [`Tax (${C.taxRate}%) (${cur})`]         : []),
    `Line Total (${cur})`,
  ];

  const rows = (items || []).map((item, idx) => {
    const { qty, unitPrice, disc, discAmt, taxAmt, lineTotal } =
      lineCalc(item, C.taxRate, taxOn, docDiscountPct);
    return [
      idx + 1, item.name, qty, unitPrice,
      ...(hasDis ? [disc, discAmt] : []),
      ...(hasTax ? [taxAmt]        : []),
      lineTotal,
    ];
  });

  // Helper: build a summary row with correct number of blank cells
  const summaryRow = (label, value) => [
    '', '', '',
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
    summaryRow('SUBTOTAL', subtotal),
    ...(hasDis && totalDiscount > 0 ? [summaryRow('DISCOUNT', -totalDiscount)] : []),
    ...(taxOn ? [summaryRow(`TAX (${C.taxRate}%)`, totalTax)] : []),
    summaryRow('GRAND TOTAL', grandTotal),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATION EXCEL
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportQuotationExcel(quotation) {
  const s = await getSettings();
  const C = buildCompany(s);
  const items          = quotation.items || [];
  const docDiscountPct = Number(quotation.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);
  const cur   = C.currency;
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
    ['Notes',       quotation.notes || ''],
    [],
    ['Subtotal',    subtotal],
    ...(C.showDiscountCol && totalDiscount > 0 ? [['Discount', -totalDiscount]] : []),
    ...(taxOn ? [['Tax Rate (%)', C.taxRate], ['Tax Amount', totalTax]] : []),
    ['GRAND TOTAL', grandTotal],
  ];

  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  const ws2 = XLSX.utils.aoa_to_sheet(excelItemsSheet(items, C, docDiscountPct, cur));
  ws1['!cols'] = [{ wch: 18 }, { wch: 34 }];
  ws2['!cols'] = [{ wch: 4 }, { wch: 38 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
  XLSX.utils.book_append_sheet(wb, ws2, 'Items');
  XLSX.writeFile(wb, `${quotation.quote_number || 'Quotation'}_export.xlsx`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE EXCEL
// ═══════════════════════════════════════════════════════════════════════════════
export async function exportInvoiceExcel(invoice) {
  const s = await getSettings();
  const C = buildCompany(s);
  const items          = invoice.items    || [];
  const payments       = invoice.payments || [];
  const docDiscountPct = Number(invoice.discount_pct || 0);
  const { subtotal, totalDiscount, totalTax, grandTotal } = aggregateLines(items, C, docDiscountPct);
  const paid    = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const balance = Math.max(0, grandTotal - paid);
  const cur     = C.currency;
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
    ['Notes',     invoice.notes || ''],
    [],
    ['Subtotal',    subtotal],
    ...(C.showDiscountCol && totalDiscount > 0 ? [['Discount', -totalDiscount]] : []),
    ...(taxOn ? [['Tax Rate (%)', C.taxRate], ['Tax Amount', totalTax]] : []),
    ['Total',       grandTotal],
    ['Paid',        paid],
    ['Balance Due', balance],
  ];

  const payRows = payments.length ? [
    ['#', 'Date', `Amount (${cur})`, 'Method', 'Note'],
    ...payments.map((p, i) => [i + 1, fmtShort(p.paid_at), Number(p.amount), p.method || '', p.note || '']),
    [],
    ['', 'TOTAL PAID',  paid,    '', ''],
    ['', 'BALANCE DUE', balance, '', ''],
  ] : [];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelItemsSheet(items, C, docDiscountPct, cur)), 'Items');
  if (payRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(payRows), 'Payments');
  XLSX.writeFile(wb, `${invoice.invoice_number || 'Invoice'}_export.xlsx`);
}
