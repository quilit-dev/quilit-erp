/**
 * Receipt voucher — سند قبض.
 *
 * The numbered slip a customer is handed when they pay. It states what has been
 * received against one invoice TO DATE, so it is a single document that gets
 * reprinted as instalments arrive rather than a new one per printing — the
 * number comes from the server and never changes for a given invoice.
 *
 * Because it is reprintable, a copy must be checkable on its own: it carries the
 * payments it covers and the date it was printed, so an older copy in a
 * customer's file is visibly a subset of a newer one rather than a competing
 * claim about the same money.
 *
 * Labels are bilingual literals rather than `t()` lookups, deliberately. The
 * point is that Arabic and English appear TOGETHER — a locale-driven lookup
 * gives one or the other, which is not the same document.
 */
import {
  SHARED_CSS, buildCompany, currencyContext, fmtDate, printHTML,
  getLogoDataURL, getSettings, saveDocumentSnapshot,
} from './exportUtils';
import { themeFor } from './documentThemes';
import { amountInWords } from './numberToWords';

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// The two languages are laid out the way the printed pads do it, and the layout
// IS the separation: English reads in from the left, Arabic reads in from the
// right, and the dotted fill sits between them. Setting the two adjacent
// instead — which is what a naive "label in both languages" helper produces —
// runs them together as "رقمNo." with nothing to tell a reader where one stops.

/**
 * A form line: English label, the filled value, Arabic label.
 *
 * The value sits CENTRED on its own dotted rule rather than tucked against the
 * English label. On a form whose two labels are of unequal length in every row,
 * left-aligning the values leaves them scattered at whatever x the label
 * happened to end — the eye has no column to run down. Centring gives the
 * filled data one axis, and it is where a hand-filled pad puts it too.
 */
const row = (en, ar, value = '') => `
  <div class="rv-row">
    <span class="rv-label">${en}</span>
    <span class="rv-fill">${value}</span>
    <span class="rv-label rv-ar">${ar}</span>
  </div>`;

/** English over Arabic — for headings and cells, where a line has no width to spare. */
const stack = (en, ar) =>
  `<span class="rv-en">${en}</span><span class="rv-ar-sub">${ar}</span>`;

const RV_CSS = `
.rv { padding: 0; }
.rv-title { text-align: center; margin-bottom: 7mm; }
.rv-title .rv-ar { display: block; font-size: 15px; font-weight: 700; }
.rv-title .rv-en {
  display: block; font-size: 12px; font-weight: 700;
  letter-spacing: 1px; text-transform: uppercase; margin-top: 1mm;
}
.rv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
.rv-meta > div + div { margin-top: 1.5mm; }
.rv-meta { font-size: 10px; line-height: 2; }
.rv-meta .rv-key { font-weight: 700; display: inline-block; min-width: 30mm; }
/* The amount, boxed — the one figure a reader looks for first. */
.rv-amount {
  border: 1.5px solid currentColor; padding: 3mm 6mm; text-align: center;
  min-width: 58mm;
}
.rv-amount .rv-fig { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.rv-amount .rv-date { font-size: 9px; margin-top: 1mm; }

/* Spacing between the lines is a GAP, not line-height. A tall line-height pads
   each row's own box, which pushed every rule far from the text above it while
   leaving consecutive rows touching — measured at 0.1mm apart. A normal
   line-height keeps a value and its rule together; the gap separates the rows. */
.rv-line {
  margin-top: 8mm; font-size: 10px; line-height: 1.45;
  display: flex; flex-direction: column; gap: 4.5mm;
}
.rv-line .rv-label { font-weight: 700; white-space: nowrap; }
/* The rule and the value are ONE element: the dots span the whole gap between
   the labels and the value centres within it, so an empty line and a filled one
   are the same shape. Two elements — a value then a separate run of dots —
   is what pushed every value hard against its label. */
.rv-fill {
  flex: 1 1 auto; min-width: 20mm; margin: 0 2.5mm;
  text-align: center; font-weight: 600;
  border-bottom: 1px dotted currentColor; padding-bottom: 0.6mm;
}
.rv-row { display: flex; align-items: flex-end; gap: 2mm; }
/* Arabic set alongside English, never touching it: a small gap and lighter
   weight so the pair reads as one label in two languages rather than a run-on. */
.rv-label i, .rv-key i, .rv-against i {
  font-style: normal; font-weight: 400; margin-inline-start: 1.5mm; opacity: 0.75;
}
.rv-label.rv-ar { font-weight: 400; opacity: 0.8; }
.rv-ar-sub {
  display: block; font-weight: 400; font-size: 0.85em; opacity: 0.75; margin-top: 0.3mm;
}
.rv-words { font-weight: 600; }

.rv-against {
  margin-top: 9mm; border: 1px solid currentColor; padding: 2.5mm 4mm;
  font-size: 9px; display: flex; justify-content: space-between; gap: 6mm;
}
.rv-against span strong { font-weight: 700; }

.rv-payments { margin-top: 7mm; }
.rv-payments table { width: 100%; border-collapse: collapse; }
/* Cells centre for the same reason the form lines do — except the amount, which
   stays right so the figures line up on their decimal and can be added down the
   column by eye. */
.rv-payments th, .rv-payments td {
  border: 1px solid currentColor; padding: 2.2mm 2.5mm; font-size: 9px;
  text-align: center;
}
.rv-payments th { font-weight: 700; }
.rv-payments td.r, .rv-payments th.r { text-align: right; }
/* The total line on a payment covering several invoices: the figure a
   customer checks against what they handed over. */
.rv-payments tr.rv-total td { border-top: 0.6pt solid currentColor; }

.rv-signs { display: flex; justify-content: space-between; gap: 8mm; margin-top: 16mm; }
.rv-sign { flex: 1 1 0; text-align: center; font-size: 9px; }
.rv-sign .rv-rule { border-top: 1px dotted currentColor; margin-bottom: 1.5mm; }
.rv-sign .rv-en { display: block; font-weight: 700; }
.rv-sign .rv-ar { display: block; font-weight: 400; opacity: 0.8; }

.rv-printed { margin-top: 8mm; text-align: center; font-size: 7.5px; opacity: 0.75; }
`;

/**
 * The voucher as an HTML string.
 *
 * `invoice` is the full record (client, payments); `voucher` is `{ number }`
 * from the server. `opts` is the same display-currency shape the invoice
 * exporter takes.
 */
export function buildReceiptVoucherHTML(invoice, voucher, settings, logoDataURL = null, opts = {}) {
  const C     = buildCompany(settings);
  const CC    = currencyContext(C, opts);
  const theme = themeFor(settings);

  const payments = (invoice.payments || []).slice().sort(
    (a, b) => String(a.paid_at || '').localeCompare(String(b.paid_at || '')));
  const paid  = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const total = Number(invoice.amount) || 0;
  const balance = Math.max(0, total - paid);

  // The words describe the figure the voucher PRINTS, which is the converted
  // one. Spelling the stored amount instead is how an invoice came to read
  // "Twenty Lebanese Pounds only" over a balance of LBP 1,780,000.
  const words = amountInWords(CC.conv(paid), CC.code);

  const printedAt = new Date().toISOString();
  const methods = [...new Set(payments.map(p => p.method).filter(Boolean))];
  const client  = invoice.client?.name || invoice.client_name || '';
  const forWhat = [
    `Invoice ${esc(invoice.invoice_number || '—')}`,
    invoice.project_name ? esc(invoice.project_name) : '',
  ].filter(Boolean).join(' — ');

  const paymentsTable = payments.length > 1 ? `
  <div class="rv-payments">
    <table>
      <thead><tr>
        <th>${stack('Date', 'التاريخ')}</th>
        <th>${stack('Method', 'طريقة الدفع')}</th>
        <th class="r">${stack('Amount', 'المبلغ')}</th>
      </tr></thead>
      <tbody>${payments.map(p => `<tr>
        <td>${fmtDate(p.paid_at)}</td>
        <td>${esc(p.method || '—')}</td>
        <td class="r">${CC.money(p.amount)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>` : '';

  const bodyHtml = `
<div class="rv">
  <div class="rv-title">
    <span class="rv-ar">سند قبض</span>
    <span class="rv-en">Receipt Voucher</span>
  </div>

  <div class="rv-head">
    <div class="rv-meta">
      <div><span class="rv-key">No. <i>رقم</i></span><strong>${esc(voucher?.number || '—')}</strong></div>
      <div><span class="rv-key">Date <i>التاريخ</i></span>${fmtDate(printedAt)}</div>
    </div>
    <div class="rv-amount">
      <div class="rv-fig">${CC.money(paid)}</div>
      <div class="rv-date">${fmtDate(printedAt)}</div>
    </div>
  </div>

  <div class="rv-line">
    ${row('Received from Mr./Messrs', 'استلمنا من السيد / السادة', esc(client))}
    ${row('The sum of', 'مبلغ وقدره',
          `<span class="rv-words">${esc(words)}</span>`)}
    ${row('Cash / Cheque No.', 'نقداً / بموجب شيك رقم',
          methods.length ? esc(methods.join(', ')) : '')}
    ${row('Bank', 'بنك')}
    ${row('Cheque dated', 'تاريخ الشيك')}
    ${row('For', 'وذلك عن', forWhat)}
  </div>

  <div class="rv-against">
    <span>Invoice total <i>قيمة الفاتورة</i> <strong>${CC.money(total)}</strong></span>
    <span>Paid <i>المدفوع</i> <strong>${CC.money(paid)}</strong></span>
    <span>Balance <i>الرصيد</i> <strong>${CC.money(balance)}</strong></span>
  </div>

  ${paymentsTable}

  <div class="rv-signs">
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Prepared By</span><span class="rv-ar">أعدها</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Received By</span><span class="rv-ar">المستلم</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Manager Sign</span><span class="rv-ar">توقيع المدير</span></div>
  </div>

  <div class="rv-printed">
    Printed ${fmtDate(printedAt)} — covering ${payments.length}
    ${payments.length === 1 ? 'payment' : 'payments'}
  </div>
</div>`;

  // Wrapped in the same sheet the invoice uses, so a tenant with a letterhead
  // gets it here too — and one printing on pre-printed stationery gets the data
  // alone, with the margins that keep it clear of the design.
  const sheet = (!theme)
    ? `<div class="page">${bodyHtml}</div>`
    : `<div class="page">
  <table class="hj-sheet">
    <thead><tr><td>${C.preprinted ? '' : theme.sheet(C, logoDataURL)}</td></tr></thead>
    <tbody><tr><td>${theme.open}${bodyHtml}${theme.close}</td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Receipt ${esc(voucher?.number || '')}</title>
<style>${SHARED_CSS}${theme ? theme.css : ''}${RV_CSS}</style></head><body>
${sheet}
</body></html>`;

  return { html, number: voucher?.number || '' };
}

/** Fetch what the template needs and open the print dialog. */
export async function printReceiptVoucher(invoice, voucher, opts = {}) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const { html, number } = buildReceiptVoucherHTML(
    invoice, voucher, settings, logoDataURL, opts);
  await saveDocumentSnapshot('invoice', invoice, `Receipt ${number}`, html);
  printHTML(html, `Receipt_${number}.pdf`);
}


/**
 * Receipt voucher for one CUSTOMER payment — سند قبض.
 *
 * The same slip, for the thing the customer actually did. They hand over one
 * sum for "the account"; the system settles their oldest invoices first and
 * splits it into one row per invoice. The per-invoice voucher above can only
 * describe one of those, so a customer paying across five invoices went home
 * with either five slips or none.
 *
 * This names every invoice the money reached, in the order it was applied, and
 * carries the same server-issued number on every reprint.
 */
export function buildPaymentVoucherHTML(payment, settings, logoDataURL = null,
                                        opts = {}) {
  const C     = buildCompany(settings);
  const CC    = currencyContext(C, opts);
  const theme = themeFor(settings);

  const allocated = payment.allocated || [];
  const total     = Number(payment.amount) || 0;
  const printedAt = new Date().toISOString();
  const client    = payment.client?.name || payment.client_name || '';

  // The words describe the figure the voucher PRINTS, which is the converted
  // one — the same rule the per-invoice voucher follows.
  const words = amountInWords(CC.conv(total), CC.code);

  // What they paid in, when that was not the company currency. A receipt that
  // shows only the USD equivalent is not a receipt for what was handed over.
  const tendered = payment.currency && payment.currency !== C.currency
    ? `${esc(payment.currency)} ${Number(payment.paid_amount || 0).toLocaleString()}`
    : '';

  const forWhat = allocated.length === 1
    ? `Invoice ${esc(allocated[0].invoice_number || '—')}`
    : `${allocated.length} invoices — see below`;

  const table = allocated.length ? `
  <div class="rv-payments">
    <table>
      <thead><tr>
        <th>${stack('Invoice', 'الفاتورة')}</th>
        <th class="r">${stack('Applied', 'المسدد')}</th>
      </tr></thead>
      <tbody>${allocated.map(a => `<tr>
        <td>${esc(a.invoice_number || '—')}</td>
        <td class="r">${CC.money(a.applied)}</td>
      </tr>`).join('')}
      <tr class="rv-total">
        <td><strong>${stack('Total', 'المجموع')}</strong></td>
        <td class="r"><strong>${CC.money(total)}</strong></td>
      </tr></tbody>
    </table>
  </div>` : '';

  const bodyHtml = `
<div class="rv">
  <div class="rv-title">
    <span class="rv-ar">سند قبض</span>
    <span class="rv-en">Receipt Voucher</span>
  </div>

  <div class="rv-head">
    <div class="rv-meta">
      <div><span class="rv-key">No. <i>رقم</i></span><strong>${esc(payment.number || '—')}</strong></div>
      <div><span class="rv-key">Date <i>التاريخ</i></span>${fmtDate(payment.created_at || printedAt)}</div>
    </div>
    <div class="rv-amount">
      <div class="rv-fig">${CC.money(total)}</div>
      <div class="rv-date">${fmtDate(payment.created_at || printedAt)}</div>
    </div>
  </div>

  <div class="rv-line">
    ${row('Received from Mr./Messrs', 'استلمنا من السيد / السادة', esc(client))}
    ${row('The sum of', 'مبلغ وقدره',
          `<span class="rv-words">${esc(words)}</span>`)}
    ${row('Cash / Cheque No.', 'نقداً / بموجب شيك رقم', esc(payment.method || ''))}
    ${tendered ? row('Tendered', 'المبلغ المقبوض', tendered) : row('Bank', 'بنك')}
    ${row('For', 'وذلك عن', forWhat)}
  </div>

  ${table}

  <div class="rv-signs">
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Prepared By</span><span class="rv-ar">أعدها</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Received By</span><span class="rv-ar">المستلم</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Manager Sign</span><span class="rv-ar">توقيع المدير</span></div>
  </div>

  <div class="rv-printed">
    Printed ${fmtDate(printedAt)} — covering ${allocated.length}
    ${allocated.length === 1 ? 'invoice' : 'invoices'}
  </div>
</div>`;

  const sheet = (!theme)
    ? `<div class="page">${bodyHtml}</div>`
    : `<div class="page">
  <table class="hj-sheet">
    <thead><tr><td>${C.preprinted ? '' : theme.sheet(C, logoDataURL)}</td></tr></thead>
    <tbody><tr><td>${theme.open}${bodyHtml}${theme.close}</td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Receipt ${esc(payment.number || '')}</title>
<style>${SHARED_CSS}${theme ? theme.css : ''}${RV_CSS}</style></head><body>
${sheet}
</body></html>`;

  return { html, number: payment.number || '' };
}

/** Fetch what the template needs and open the print dialog. */
export async function printPaymentVoucher(payment, opts = {}) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const { html, number } = buildPaymentVoucherHTML(payment, settings, logoDataURL, opts);
  await saveDocumentSnapshot('client', { id: payment.client?.id, ...payment },
                             `Receipt ${number}`, html);
  printHTML(html, `Receipt_${number}.pdf`);
}
