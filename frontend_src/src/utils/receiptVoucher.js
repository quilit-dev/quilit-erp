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

/** A form line: English label, the value and its dots, Arabic label. */
const row = (en, ar, value = '', { dots = true } = {}) => `
  <div class="rv-row">
    <span class="rv-label">${en}</span>
    ${value ? `<span class="rv-fill">${value}</span>` : ''}
    ${dots ? DOTS : ''}
    <span class="rv-label rv-ar">${ar}</span>
  </div>`;

/** English over Arabic — for headings and cells, where a line has no width to spare. */
const stack = (en, ar) =>
  `<span class="rv-en">${en}</span><span class="rv-ar-sub">${ar}</span>`;

/** A run of dots for something filled in by hand. */
const DOTS = '<span class="rv-dots"></span>';

const RV_CSS = `
.rv { padding: 0; }
.rv-title { text-align: center; margin-bottom: 7mm; }
.rv-title .rv-ar { display: block; font-size: 15px; font-weight: 700; }
.rv-title .rv-en {
  display: block; font-size: 12px; font-weight: 700;
  letter-spacing: 1px; text-transform: uppercase; margin-top: 1mm;
}
.rv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
.rv-meta { font-size: 10px; line-height: 2; }
.rv-meta .rv-key { font-weight: 700; display: inline-block; min-width: 30mm; }
/* The amount, boxed — the one figure a reader looks for first. */
.rv-amount {
  border: 1.5px solid currentColor; padding: 3mm 6mm; text-align: center;
  min-width: 58mm;
}
.rv-amount .rv-fig { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.rv-amount .rv-date { font-size: 9px; margin-top: 1mm; }

.rv-line { margin-top: 6mm; font-size: 10px; line-height: 1.9; }
.rv-line .rv-label { font-weight: 700; white-space: nowrap; }
.rv-fill { font-weight: 600; }
.rv-dots {
  display: inline-block; flex: 1 1 auto; min-width: 20mm;
  border-bottom: 1px dotted currentColor; margin: 0 2mm;
  transform: translateY(-1mm);
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
  margin-top: 6mm; border: 1px solid currentColor; padding: 2.5mm 4mm;
  font-size: 9px; display: flex; justify-content: space-between; gap: 6mm;
}
.rv-against span strong { font-weight: 700; }

.rv-payments { margin-top: 5mm; }
.rv-payments table { width: 100%; border-collapse: collapse; }
.rv-payments th, .rv-payments td {
  border: 1px solid currentColor; padding: 1.5mm 2.5mm; font-size: 9px; text-align: left;
}
.rv-payments th { font-weight: 700; }
.rv-payments td.r, .rv-payments th.r { text-align: right; }

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
