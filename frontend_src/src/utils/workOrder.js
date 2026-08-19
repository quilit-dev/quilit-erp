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

const WO_CSS = `
.wo-title { text-align: center; font-size: 15px; font-weight: 800;
            letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6mm; }
.wo-meta { display: flex; justify-content: space-between; gap: 8mm;
           font-size: 10px; margin-bottom: 5mm; }
.wo-meta div span { display: inline-block; min-width: 24mm; font-weight: 700; }
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
   up, and a blank box invites a cramped scrawl in one corner. */
.wo-write { margin-bottom: 5mm; font-size: 10px; }
.wo-write h4 { margin: 0 0 2mm; font-size: 10px; text-transform: uppercase; }
.wo-rule { border-bottom: 1px solid currentColor; height: 7mm; }
.wo-signs { display: flex; justify-content: space-between; gap: 10mm;
            margin-top: 12mm; font-size: 9px; }
.wo-sign { flex: 1 1 0; text-align: center; }
.wo-sign .line { border-top: 1px dotted currentColor; margin-bottom: 1.5mm; }
`;

/** Empty ruled lines for handwriting. */
const ruled = (n) => Array.from({ length: n },
  () => '<div class="wo-rule"></div>').join('');

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
      <th>Item</th>
      <th class="r">Qty</th>
      ${done ? '<th class="r">Unit</th><th class="r">Total</th>' : ''}
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
      <td colspan="3" class="r"><strong>Total</strong></td>
      <td class="r"><strong>${CC.money(job.total)}</strong></td>
    </tr></tfoot>` : ''}
  </table>` : '';

  const body = `
<div class="wo">
  <div class="wo-title">Work Order</div>

  <div class="wo-meta">
    <div>
      <div><span>Job No.</span>${esc(job.job_number || '')}</div>
      <div><span>Type</span>${esc(job.job_type || '')}</div>
      <div><span>Priority</span>${esc(job.priority || '')}</div>
    </div>
    <div>
      <div><span>Customer</span>${esc(job.client_name || '')}</div>
      <div><span>Scheduled</span>${job.scheduled_date ? fmtDate(job.scheduled_date) : '—'}</div>
      <div><span>Technician</span>${esc(job.assigned_name || '—')}</div>
    </div>
  </div>

  ${eq.name ? `
  <div class="wo-equip">
    <h4>Equipment</h4>
    <div class="row">
      <div><strong>${esc(eq.name)}</strong></div>
      ${eq.model ? `<div>Model: ${esc(eq.model)}</div>` : ''}
      ${eq.serial_number ? `<div>Serial: ${esc(eq.serial_number)}</div>` : ''}
    </div>
  </div>` : ''}

  ${job.reported_fault ? `
  <div class="wo-fault">
    <h4>Reported fault</h4>
    <div>${esc(job.reported_fault)}</div>
  </div>` : ''}

  ${linesTable}

  <div class="wo-write">
    <h4>Work carried out</h4>
    ${job.work_done ? `<div>${esc(job.work_done)}</div>` : ''}
    ${ruled(job.work_done ? 2 : 5)}
  </div>

  <div class="wo-write">
    <h4>Additional parts used</h4>
    ${ruled(3)}
  </div>

  <div class="wo-signs">
    <div class="wo-sign"><div class="line"></div>Technician</div>
    <div class="wo-sign"><div class="line"></div>Customer signature</div>
    <div class="wo-sign"><div class="line"></div>Date</div>
  </div>
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
