/**
 * Salary receipt — إيصال راتب.
 *
 * The slip an employee is handed with their pay, and signs. It carries the
 * working, not just the figure: what was earned (salary or hours × rate,
 * overtime, bonuses, allowances), what was taken off (tax, NSSF, insurance,
 * lateness, any advance being recovered), and the net that changed hands.
 *
 * The lines add up by construction. Earnings sum to the gross the server
 * computed, and the net is gross less every deduction listed --- the same
 * formula as `_compute_payroll_line` --- so a receipt can never show figures
 * that do not reach the amount paid.
 *
 * Same bilingual layout and letterhead as the receipt voucher; the number is
 * derived from the payroll line on the server, so a reprint carries the same
 * number as the original.
 */
import { SHARED_CSS, buildCompany, fmtDate, printHTML,
         getLogoDataURL, getSettings } from './exportUtils';
import { themeFor } from './documentThemes';
import { amountInWords } from './numberToWords';
import { RV_CSS, row, stack } from './receiptVoucher';

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const n = v => Number(v) || 0;

/** Money in the salary's own currency. LBP has no cents worth printing. */
function moneyIn(ccy) {
  const dp = ccy === 'LBP' ? 0 : 2;
  const f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return v => `${f.format(n(v))} ${esc(ccy)}`;
}

const SR_CSS = `
.sr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 7mm; }
.sr-grid table { width: 100%; border-collapse: collapse; }
.sr-grid th, .sr-grid td { border: 1px solid currentColor; padding: 1.8mm 2.5mm; font-size: 9px; }
.sr-grid th { font-weight: 700; text-align: center; }
.sr-grid td.r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sr-grid tr.sr-sum td { font-weight: 700; }
.sr-grid .sr-note { display: block; font-size: 8px; opacity: 0.75; }
.sr-net {
  margin-top: 5mm; border: 1.5px solid currentColor; padding: 2.5mm 4mm;
  display: flex; justify-content: space-between; align-items: center; font-size: 11px;
}
.sr-net strong { font-size: 14px; font-variant-numeric: tabular-nums; }
`;

/**
 * The receipt as HTML. `line` is a payroll line from the run detail (it
 * carries `receipt_number`, `paid_on` and `paid_method`); `run` is the run.
 */
export function buildSalaryReceiptHTML(line, run, settings, logoDataURL = null) {
  const C     = buildCompany(settings);
  const theme = themeFor(settings);
  const ccy   = (line.salary_currency || 'USD').toUpperCase();
  const money = moneyIn(ccy);

  const hourly = n(line.hourly_rate) > 0 || n(line.hours_worked) > 0;
  const earnings = [
    hourly
      ? { en: 'Hours worked', ar: 'ساعات العمل', v: line.base_salary,
          note: `${n(line.hours_worked)} h × ${money(line.hourly_rate)}` }
      : { en: 'Basic salary', ar: 'الراتب الأساسي', v: line.base_salary },
    { en: 'Overtime', ar: 'ساعات إضافية', v: line.overtime_amount,
      note: n(line.overtime_hours) ? `${n(line.overtime_hours)} h` : '' },
    { en: 'Bonuses', ar: 'مكافآت', v: line.bonuses },
    { en: 'Attendance bonus', ar: 'مكافأة الحضور', v: line.attendance_bonus },
    { en: 'Transport allowance', ar: 'بدل نقل', v: line.transport_allowance,
      note: n(line.attended_days) ? `${n(line.attended_days)} days` : '' },
  ].filter((e, i) => i === 0 || n(e.v) !== 0);

  const deductions = [
    { en: 'Income tax', ar: 'ضريبة الدخل', v: line.tax_amount },
    { en: 'NSSF (employee)', ar: 'الضمان الاجتماعي', v: line.nssf_employee },
    { en: 'Insurance', ar: 'التأمين', v: line.insurance_employee },
    { en: 'Late deduction', ar: 'حسم التأخير', v: line.late_deduction,
      note: n(line.late_days) ? `${n(line.late_days)} days late` : '' },
    { en: 'Other deductions', ar: 'حسومات أخرى', v: line.deductions },
    { en: 'Advance recovered', ar: 'استرداد سلفة', v: line.advance_recovery },
  ].filter(d => n(d.v) !== 0);

  const gross = earnings.reduce((s, e) => s + n(e.v), 0);
  const taken = deductions.reduce((s, d) => s + n(d.v), 0);
  const net   = n(line.net_amount);
  const paidOn = line.paid_on || new Date().toISOString();

  const cells = rows => rows.map(r => `<tr>
      <td>${stack(esc(r.en), esc(r.ar))}${r.note ? `<span class="sr-note">${esc(r.note)}</span>` : ''}</td>
      <td class="r">${money(r.v)}</td></tr>`).join('');

  const bodyHtml = `
<div class="rv">
  <div class="rv-title">
    <span class="rv-ar">إيصال راتب</span>
    <span class="rv-en">Salary Receipt</span>
  </div>

  <div class="rv-head">
    <div class="rv-meta">
      <div><span class="rv-key">No. <i>رقم</i></span><strong>${esc(line.receipt_number || '—')}</strong></div>
      <div><span class="rv-key">Date <i>التاريخ</i></span>${fmtDate(paidOn)}</div>
      <div><span class="rv-key">Period <i>الفترة</i></span>${fmtDate(run.period_start)} → ${fmtDate(run.period_end)}</div>
    </div>
    <div class="rv-amount">
      <div class="rv-fig">${money(net)}</div>
      <div class="rv-date">${fmtDate(paidOn)}</div>
    </div>
  </div>

  <div class="rv-line">
    ${row('Paid to Mr./Ms.', 'دفعنا إلى السيد / السيدة',
          esc(line.employee_name) + (line.employee_code ? ` (${esc(line.employee_code)})` : ''))}
    ${row('Position', 'الوظيفة',
          esc([line.job_title, line.department_name].filter(Boolean).join(' · ')))}
    ${row('The sum of', 'مبلغ وقدره', `<span class="rv-words">${esc(amountInWords(net, ccy))}</span>`)}
    ${row('Paid by', 'طريقة الدفع', esc(line.paid_method || ''))}
    ${row('For', 'وذلك عن', `Salary ${fmtDate(run.period_start)} → ${fmtDate(run.period_end)}`)}
  </div>

  <div class="sr-grid">
    <table>
      <thead><tr><th colspan="2">${stack('Earnings', 'المستحقات')}</th></tr></thead>
      <tbody>${cells(earnings)}
        <tr class="sr-sum"><td>${stack('Gross', 'الإجمالي')}</td><td class="r">${money(gross)}</td></tr>
      </tbody>
    </table>
    <table>
      <thead><tr><th colspan="2">${stack('Deductions', 'الحسومات')}</th></tr></thead>
      <tbody>${deductions.length ? cells(deductions)
        : `<tr><td colspan="2" style="text-align:center">—</td></tr>`}
        <tr class="sr-sum"><td>${stack('Total deductions', 'مجموع الحسومات')}</td><td class="r">${money(taken)}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="sr-net">
    <span>${stack('Net pay', 'صافي الراتب')}</span>
    <strong>${money(net)}</strong>
  </div>

  <div class="rv-signs">
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Prepared By</span><span class="rv-ar">أعدها</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Employee Signature</span><span class="rv-ar">توقيع الموظف</span></div>
    <div class="rv-sign"><div class="rv-rule"></div>
      <span class="rv-en">Manager Sign</span><span class="rv-ar">توقيع المدير</span></div>
  </div>

  <div class="rv-printed">Printed ${fmtDate(new Date().toISOString())} · ${esc(C.name || '')}</div>
</div>`;

  const sheet = (!theme)
    ? `<div class="page">${bodyHtml}</div>`
    : `<div class="page">
  <table class="hj-sheet${C.preprinted ? ' hj-sheet--preprinted' : ''}">
    <thead><tr><td>${C.preprinted ? '' : theme.sheet(C, logoDataURL)}</td></tr></thead>
    <tbody><tr><td>${theme.open}${bodyHtml}${theme.close}</td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Salary ${esc(line.receipt_number || '')}</title>
<style>${SHARED_CSS}${theme ? theme.css : ''}${RV_CSS}${SR_CSS}</style></head><body>
${sheet}
</body></html>`;
  return { html, gross, deductions: taken, net };
}

/** Fetch what the template needs and open the print dialog. */
export async function printSalaryReceipt(line, run) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const { html } = buildSalaryReceiptHTML(line, run, settings, logoDataURL);
  printHTML(html, `Salary_${line.receipt_number || line.id}.pdf`);
}
