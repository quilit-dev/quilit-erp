/**
 * Credit note (إشعار دائن) and debit note (إشعار مدين).
 *
 * The documents a return leaves behind. A credit note goes to the customer:
 * what they brought back, against which invoice, and how it was settled ---
 * taken off what they owed, refunded, or held as credit. A debit note goes to
 * the supplier: what was sent back, against which purchase, and what they owe
 * for it.
 *
 * Same bilingual layout and letterhead as the receipt voucher. The figures are
 * the server's, never recomputed here, so the paper always says what the books
 * say.
 */
import { SHARED_CSS, buildCompany, fmtDate, printHTML,
         getLogoDataURL, getSettings } from './exportUtils';
import { themeFor } from './documentThemes';
import { amountInWords } from './numberToWords';
import { RV_CSS, row, stack } from './receiptVoucher';

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const n = v => Number(v) || 0;
const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = v => `${fmt.format(n(v))} USD`;
const qty = v => String(+n(v).toFixed(3));

const RN_CSS = `
.rn-items { width: 100%; border-collapse: collapse; margin-top: 6mm; }
.rn-items th, .rn-items td { border: 1px solid currentColor; padding: 1.8mm 2.5mm; font-size: 9px; }
.rn-items th { font-weight: 700; text-align: center; }
.rn-items td.r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rn-items td.c { text-align: center; }
.rn-sum { margin-top: 4mm; margin-left: auto; width: 62%; border-collapse: collapse; }
.rn-sum td { padding: 1.4mm 2.5mm; font-size: 9.5px; border-bottom: 1px solid rgba(0,0,0,.15); }
.rn-sum td.r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rn-sum tr.rn-total td { font-weight: 700; font-size: 11px; border-top: 1.5px solid currentColor; border-bottom: none; }
.rn-void { margin-top: 4mm; padding: 2mm 3mm; border: 1.5px solid #dc2626; color: #dc2626; font-weight: 700; text-align: center; }
`;

const CONDITION = {
  restock: ['Back in stock', 'أعيدت إلى المخزون'],
  damaged: ['Damaged', 'تالفة'],
  none:    ['—', '—'],
};

function sheet(theme, C, logoDataURL, bodyHtml) {
  return (!theme)
    ? `<div class="page">${bodyHtml}</div>`
    : `<div class="page">
  <table class="hj-sheet${C.preprinted ? ' hj-sheet--preprinted' : ''}">
    <thead><tr><td>${C.preprinted ? '' : theme.sheet(C, logoDataURL)}</td></tr></thead>
    <tbody><tr><td>${theme.open}${bodyHtml}${theme.close}</td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;
}

function settlementRows(note, isSale) {
  const rows = [];
  const applied = isSale ? note.applied_to_invoice : note.applied_to_purchase;
  if (n(applied) > 0) {
    rows.push(isSale
      ? [stack('Taken off the invoice balance', 'خُصم من رصيد الفاتورة'), money(applied)]
      : [stack('Taken off what we owe', 'خُصم من المستحق للمورد'), money(applied)]);
  }
  if (n(note.refunded) > 0) {
    rows.push([stack(`Refunded — ${esc(note.refund_method || 'Cash')}`, 'مبلغ مسترد'), money(note.refunded)]);
  }
  if (n(note.credited) > 0) {
    rows.push(isSale
      ? [stack('Held as customer credit', 'رصيد دائن للزبون'), money(note.credited)]
      : [stack('Held as credit with the supplier', 'رصيد لدى المورد'), money(note.credited)]);
  }
  return rows.map(([k, v]) => `<tr><td>${k}</td><td class="r">${v}</td></tr>`).join('');
}

/**
 * `note` is a credit note (`kind === 'sales'`) or debit note (`'purchases'`)
 * as GET /api/returns/{kind}/{id} returns it.
 */
export function buildReturnNoteHTML(note, kind, settings, logoDataURL = null) {
  const C     = buildCompany(settings);
  const theme = themeFor(settings);
  const isSale = kind === 'sales';
  const items = note.items || [];

  const head = isSale
    ? `<th>#</th><th>${stack('Item', 'الصنف')}</th><th>${stack('Qty', 'الكمية')}</th>
       <th>${stack('Unit', 'سعر الوحدة')}</th><th>${stack('Net', 'الصافي')}</th>
       <th>${stack('VAT', 'الضريبة')}</th><th>${stack('Condition', 'الحالة')}</th>`
    : `<th>#</th><th>${stack('Item', 'الصنف')}</th><th>${stack('Qty', 'الكمية')}</th>
       <th>${stack('Unit', 'سعر الوحدة')}</th><th>${stack('Net', 'الصافي')}</th>
       <th>${stack('VAT', 'الضريبة')}</th>`;
  const body = items.map((it, i) => {
    const unit = isSale ? it.unit_net : it.unit_price;
    const cond = CONDITION[it.condition] || CONDITION.none;
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="c">${qty(it.quantity)}${it.unit ? ` ${esc(it.unit)}` : ''}</td>
      <td class="r">${money(unit)}</td>
      <td class="r">${money(it.net)}</td>
      <td class="r">${money(it.tax_amount)}</td>
      ${isSale ? `<td class="c">${stack(cond[0], cond[1])}</td>` : ''}
    </tr>`;
  }).join('');

  const party = isSale
    ? row('Customer', 'الزبون', esc(note.client_name || 'Walk-in customer'))
    : row('Supplier', 'المورد', esc(note.supplier || ''));
  const against = isSale
    ? row('Against invoice', 'عن الفاتورة', esc(note.invoice_number || ''))
    : row('Against purchase', 'عن طلب الشراء', esc(note.po_number || ''));

  const bodyHtml = `
<div class="rv">
  <div class="rv-title">
    <span class="rv-ar">${isSale ? 'إشعار دائن' : 'إشعار مدين'}</span>
    <span class="rv-en">${isSale ? 'Credit Note' : 'Debit Note'}</span>
  </div>

  <div class="rv-head">
    <div class="rv-meta">
      <div><span class="rv-key">No. <i>رقم</i></span><strong>${esc(note.return_number || '—')}</strong></div>
      <div><span class="rv-key">Date <i>التاريخ</i></span>${fmtDate(note.return_date)}</div>
    </div>
    <div class="rv-amount">
      <div class="rv-fig">${money(note.total)}</div>
      <div class="rv-date">${fmtDate(note.return_date)}</div>
    </div>
  </div>

  <div class="rv-line">
    ${party}
    ${against}
    ${row('The sum of', 'مبلغ وقدره', `<span class="rv-words">${esc(amountInWords(n(note.total), 'USD'))}</span>`)}
    ${note.reason ? row('Reason', 'السبب', esc(note.reason)) : ''}
  </div>

  <table class="rn-items">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>

  <table class="rn-sum">
    <tr><td>${stack('Net', 'الصافي')}</td><td class="r">${money(note.subtotal)}</td></tr>
    <tr><td>${stack('VAT', 'الضريبة')}</td><td class="r">${money(note.tax_total)}</td></tr>
    <tr class="rn-total"><td>${stack('Total', 'المجموع')}</td><td class="r">${money(note.total)}</td></tr>
    ${settlementRows(note, isSale)}
  </table>

  ${note.voided_at ? `<div class="rn-void">VOID — ملغى · ${esc(note.void_reason || '')}</div>` : ''}

  <div class="rv-signs">
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Prepared By</span><span class="rv-ar">أعدها</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">${isSale ? 'Customer Signature' : 'Supplier Signature'}</span>
      <span class="rv-ar">${isSale ? 'توقيع الزبون' : 'توقيع المورد'}</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Manager Sign</span><span class="rv-ar">توقيع المدير</span></div>
  </div>

  <div class="rv-printed">Printed ${fmtDate(new Date().toISOString())} · ${esc(C.name || '')}</div>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(note.return_number || '')}</title>
<style>${SHARED_CSS}${theme ? theme.css : ''}${RV_CSS}${RN_CSS}</style></head><body>
${sheet(theme, C, logoDataURL, bodyHtml)}
</body></html>`;
}

export async function printReturnNote(note, kind) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  printHTML(buildReturnNoteHTML(note, kind, settings, logoDataURL),
            `${note.return_number || 'Return'}.pdf`);
}
