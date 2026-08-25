/**
 * The work order — the sheet a technician takes to site.
 *
 * Not an invoice, and deliberately shaped differently. An invoice tells a
 * customer what to pay; this tells a technician what to do and gives them
 * somewhere to write what they actually did. So it carries the reported fault
 * and the machine's identifying details in full, and it prints ruled space for
 * work done, parts used and two signatures — because the copy that comes back
 * from site is the record of the visit.
 *
 * It is a FORM while the job is open. The office fills in the fault and prints
 * it; the technician writes the work carried out on the dotted lines and the
 * parts used in the grid; the office types both onto the job afterwards and
 * closes it. So nothing already recorded is printed into those sections — a
 * line that arrives filled in is a line nobody writes on, and the sheet that
 * comes back would say what the office guessed rather than what happened.
 *
 * Once the job is completed the same template prints the record instead: what
 * was actually done, and the parts and charges with their prices.
 *
 * Prices are omitted unless the job is already completed. A technician handing
 * this to a customer mid-visit should not be quoting figures that have not been
 * agreed; once the work is done and priced, the same sheet doubles as the
 * customer's copy.
 *
 * Built on the same document pipeline as the invoice and quotation exports, so
 * a tenant with a letterhead gets it here too, and one printing on pre-printed
 * stationery gets the data alone.
 */
import {
  SHARED_CSS, buildCompany, currencyContext, fmtDate, printHTML,
  getLogoDataURL, getSettings, saveDocumentSnapshot,
} from './exportUtils';
import { themeFor } from './documentThemes';

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Bilingual the way the receipt voucher is, and for the same reason: the two
// languages have to appear TOGETHER. A locale-driven t() lookup gives one or
// the other, which is a different document — and this one is filled in by a
// technician on site and read by a customer signing it, who are not reliably
// the same reader. So the labels are literals, set the way the printed pads
// do it: Arabic alongside the English in a lighter weight, or beneath it where
// a line has no width to spare.

/** English label with its Arabic set alongside, never touching it. */
const lbl = (en, ar) => `${en} <i>${ar}</i>`;

// The two fixed lists this sheet carries. Same reason the labels are
// literals: the technician filling it in and the customer signing it are not
// reliably the same reader, so the VALUES print in both languages too. Kept
// here rather than read from the locale because this file builds a string, not
// a component — there is no hook to call, and the document is one document
// whichever language the app happens to be in. Anything not listed (a value
// added later) prints as stored rather than disappearing.
const VALUE_AR = {
  Installation: 'تركيب', Maintenance: 'صيانة', Repair: 'إصلاح',
  Inspection: 'فحص', Low: 'منخفضة', Normal: 'عادية', High: 'عالية',
};
const val = v => (v ? (VALUE_AR[v] ? lbl(esc(v), VALUE_AR[v]) : esc(v)) : '');

/** English over Arabic — for table headings, where a line has no width. */
const stack = (en, ar) =>
  `<span class="wo-en">${en}</span><span class="wo-ar-sub">${ar}</span>`;

const WO_CSS = `
.wo-title { text-align: center; margin-bottom: 6mm; }
.wo-title .wo-ar { display: block; font-size: 15px; font-weight: 700; }
.wo-title .wo-en { display: block; font-size: 12px; font-weight: 700;
                   letter-spacing: 1px; text-transform: uppercase; margin-top: 1mm; }
/* Arabic beside English, in a lighter weight and set off by a small gap, so
   the pair reads as one label in two languages rather than a run-on. */
.wo i { font-style: normal; font-weight: 400; margin-inline-start: 1.5mm;
        opacity: 0.75; }
.wo-en { display: block; font-weight: 700; }
.wo-ar-sub { display: block; font-weight: 400; font-size: 0.85em;
             opacity: 0.75; margin-top: 0.3mm; }
.wo-meta { display: flex; justify-content: space-between; gap: 8mm;
           font-size: 10px; margin-bottom: 5mm; }
.wo-meta div span { display: inline-block; min-width: 38mm; font-weight: 700; }
/* The machine, boxed: on site this is the first thing to check against the
   plate, so it should be findable without reading the whole sheet. */
.wo-equip { border: 1px solid currentColor; padding: 3mm 4mm; font-size: 10px;
            margin-bottom: 5mm; }
.wo-equip h4 { margin: 0 0 1.5mm; font-size: 10px; text-transform: uppercase;
               letter-spacing: 0.5px; }
.wo-equip .row { display: flex; gap: 6mm; flex-wrap: wrap; }
.wo-equip .row div { min-width: 40mm; }
.wo-fault { font-size: 10px; margin-bottom: 5mm; }
.wo-fault h4 { margin: 0 0 1.5mm; font-size: 10px; text-transform: uppercase; }
.wo-table { width: 100%; border-collapse: collapse; font-size: 9.5px;
            margin-bottom: 5mm; }
.wo-table th, .wo-table td { border: 1px solid currentColor; padding: 2mm 2.5mm; }
.wo-table th { text-align: left; font-weight: 700; }
.wo-table td.r, .wo-table th.r { text-align: right; }
/* Ruled space. The lines are the point: this is where the visit gets written
   up, and a blank box invites a cramped scrawl in one corner. Dotted, because
   a solid rule reads as a field that has been filled in and ruled off. */
.wo-write { margin-bottom: 5mm; font-size: 10px; }
.wo-write h4 { margin: 0 0 2mm; font-size: 10px; text-transform: uppercase; }
.wo-rule { border-bottom: 1px dotted currentColor; height: 8mm; }
/* Parts used, written on site. A grid rather than lines: a part is a name and
   a quantity, and asking for both in one ruled line gets one of them. */
.wo-blank { width: 100%; border-collapse: collapse; font-size: 9.5px;
            margin-bottom: 5mm; }
.wo-blank th, .wo-blank td { border: 1px dotted currentColor; padding: 0 2.5mm; }
.wo-blank th { border-bottom: 1px solid currentColor; text-align: left;
               font-weight: 700; padding: 2mm 2.5mm; text-transform: uppercase;
               letter-spacing: 0.5px; }
.wo-blank td { height: 8mm; }
.wo-blank .q { width: 24mm; text-align: right; }
.wo-note { font-size: 8.5px; text-align: center; margin-top: 4mm;
           opacity: 0.75; }
.wo-signs { display: flex; justify-content: space-between; gap: 10mm;
            margin-top: 12mm; font-size: 9px; }
.wo-sign { flex: 1 1 0; text-align: center; }
.wo-sign .line { border-top: 1px dotted currentColor; margin-bottom: 1.5mm; }
.wo-sign .wo-en { font-size: 9px; }
`;

/** Empty ruled lines for handwriting. */
const ruled = (n) => Array.from({ length: n },
  () => '<div class="wo-rule"></div>').join('');

/** An empty grid the technician fills in: `cols` headings, `n` blank rows. */
const blankGrid = (cols, n) => `
  <table class="wo-blank">
    <thead><tr>${cols.map(c =>
      `<th${c.q ? ' class="q"' : ''}>${stack(c.label, c.ar)}</th>`).join('')}</tr></thead>
    <tbody>
      ${Array.from({ length: n }, () => `<tr>${cols.map(c =>
        `<td${c.q ? ' class="q"' : ''}></td>`).join('')}</tr>`).join('')}
    </tbody>
  </table>`;

export function buildWorkOrderHTML(job, settings, logoDataURL = null, opts = {}) {
  const C = buildCompany(settings);
  const CC = currencyContext(C, opts);
  const theme = themeFor(settings);

  const done = job.status === 'Completed';
  const lines = job.lines || [];
  const parts = lines.filter(l => l.line_type === 'part');
  const charges = lines.filter(l => l.line_type === 'charge');
  const eq = job.equipment || {};

  const linesTable = lines.length ? `
  <table class="wo-table">
    <thead><tr>
      <th>${stack('Item', 'البند')}</th>
      <th class="r">${stack('Qty', 'الكمية')}</th>
      ${done ? `<th class="r">${stack('Unit', 'سعر الوحدة')}</th>
                <th class="r">${stack('Total', 'الإجمالي')}</th>` : ''}
    </tr></thead>
    <tbody>
      ${[...parts, ...charges].map(l => `<tr>
        <td>${esc(l.name)}</td>
        <td class="r">${l.quantity}</td>
        ${done ? `<td class="r">${CC.money(l.unit_price)}</td>
                  <td class="r">${CC.money((l.quantity || 0) * (l.unit_price || 0))}</td>` : ''}
      </tr>`).join('')}
    </tbody>
    ${done ? `<tfoot><tr>
      <td colspan="3" class="r"><strong>${lbl('Total', 'الإجمالي')}</strong></td>
      <td class="r"><strong>${CC.money(job.total)}</strong></td>
    </tr></tfoot>` : ''}
  </table>` : '';

  const body = `
<div class="wo">
  <div class="wo-title">
    <span class="wo-ar">أمر عمل</span>
    <span class="wo-en">Work Order</span>
  </div>

  <div class="wo-meta">
    <div>
      <div><span>${lbl('Job No.', 'رقم المهمة')}</span>${esc(job.job_number || '')}</div>
      <div><span>${lbl('Type', 'النوع')}</span>${val(job.job_type)}</div>
      <div><span>${lbl('Priority', 'الأولوية')}</span>${val(job.priority)}</div>
    </div>
    <div>
      <div><span>${lbl('Customer', 'العميل')}</span>${esc(job.client_name || '')}</div>
      <div><span>${lbl('Scheduled', 'الموعد')}</span>${job.scheduled_date ? fmtDate(job.scheduled_date) : '—'}</div>
      <div><span>${lbl('Technician', 'الفني')}</span>${esc(job.assigned_name || '—')}</div>
    </div>
  </div>

  ${eq.name ? `
  <div class="wo-equip">
    <h4>${lbl('Equipment', 'المعدّة')}</h4>
    <div class="row">
      <div><strong>${esc(eq.name)}</strong></div>
      ${eq.model ? `<div><strong>${lbl('Model', 'الطراز')}</strong> ${esc(eq.model)}</div>` : ''}
      ${eq.serial_number ? `<div><strong>${lbl('Serial', 'الرقم التسلسلي')}</strong> ${esc(eq.serial_number)}</div>` : ''}
    </div>
  </div>` : ''}

  ${job.reported_fault ? `
  <div class="wo-fault">
    <h4>${lbl('Reported fault', 'العطل المُبلّغ عنه')}</h4>
    <div>${esc(job.reported_fault)}</div>
  </div>` : ''}

  ${lines.length ? `<div class="wo-write"><h4>${done
    ? lbl('Parts and charges', 'القطع والأجور')
    : lbl('Parts issued from stores', 'القطع المصروفة من المستودع')}</h4></div>` : ''}
  ${linesTable}

  ${/* Two documents from one template. Until the job is completed this is a
        FORM: the office fills in the fault, the technician writes the visit up
        on site, and the office types it back onto the job afterwards — so
        anything recorded so far is deliberately left off, because a line that
        is already printed is a line nobody writes on. Once completed it is the
        record, and prints what was actually done. */ ''}
  <div class="wo-write">
    <h4>${lbl('Work carried out', 'العمل المنفَّذ')}</h4>
    ${done && job.work_done ? `<div>${esc(job.work_done)}</div>` : ruled(6)}
  </div>

  ${done ? '' : `<div class="wo-write">
    <h4>${lbl('Parts used', 'القطع المستعملة')}</h4>
    ${blankGrid([{ label: 'Part / description', ar: 'القطعة / الوصف' },
                 { label: 'Qty', ar: 'الكمية', q: true }], 6)}
  </div>`}

  <div class="wo-signs">
    <div class="wo-sign"><div class="line"></div>
      ${stack('Technician', 'الفني')}</div>
    <div class="wo-sign"><div class="line"></div>
      ${stack('Customer signature', 'توقيع العميل')}</div>
    <div class="wo-sign"><div class="line"></div>
      ${stack('Date', 'التاريخ')}</div>
  </div>

  ${done ? '' : `<div class="wo-note">
    <div>Return this sheet to the office. The work carried out and the parts
      used are entered on the job before it is closed.</div>
    <div dir="rtl">أعد هذه الورقة إلى المكتب. يُدخل العمل المنفَّذ والقطع
      المستعملة على المهمة قبل إقفالها.</div>
  </div>`}
</div>`;

  // Same sheet wrapper as every other printed document, so a tenant letterhead
  // and the pre-printed-stationery setting both apply without extra work here.
  const sheet = (!theme)
    ? `<div class="page">${body}</div>`
    : `<div class="page">
  <table class="hj-sheet">
    <thead><tr><td>${C.preprinted ? '' : theme.sheet(C, logoDataURL)}</td></tr></thead>
    <tbody><tr><td>${theme.open}${body}${theme.close}</td></tr></tbody>
    <tfoot><tr><td></td></tr></tfoot>
  </table>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Work Order ${esc(job.job_number || '')}</title>
<style>${SHARED_CSS}${theme ? theme.css : ''}${WO_CSS}</style></head><body>
${sheet}
</body></html>`;
}

export async function printWorkOrder(job, opts = {}) {
  const [logoDataURL, settings] = await Promise.all([getLogoDataURL(), getSettings()]);
  const html = buildWorkOrderHTML(job, settings, logoDataURL, opts);
  await saveDocumentSnapshot('service_job', job, `Work Order ${job.job_number}`, html);
  printHTML(html, `WorkOrder_${job.job_number}.pdf`);
}
