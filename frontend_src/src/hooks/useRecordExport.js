import { useState } from 'react';
import { toast } from '../components/shared';

/**
 * Shared per-row Excel export for record list pages (quotations, invoices).
 *
 * PDF is NOT here. Invoices and quotations are rendered by the server
 * (backend/pdf_render.py) and linked directly, because a browser-printed
 * document cannot reach a mobile app, an email attachment or a client's share
 * link — and two templates meant the customer's copy could differ from the one
 * on screen. This hook now only does the spreadsheet.
 *
 *   const { exportLoading, handleExport } = useRecordExport({
 *     fetchFull:   getQuotation,
 *     exportExcel: exportQuotationExcel,
 *     getClients:  () => clients,
 *     getExportOpts: () => ({ displayCurrency, exchangeRate }),
 *   });
 *
 * `getExportOpts` (optional) supplies per-export options — e.g. the display
 * currency — passed as the 2nd argument to the exporter.
 * `exportLoading` maps record id → 'pdf' | 'excel' | null while a job runs.
 */
export function useRecordExport({ fetchFull, exportExcel, getClients, getExportOpts }) {
  const [exportLoading, setExportLoading] = useState({});

  async function handleExport(record, type) {
    setExportLoading(prev => ({ ...prev, [record.id]: type }));
    try {
      const full      = await fetchFull(record.id);
      const clientObj = (getClients?.() || []).find(c => c.id === full.client_id) || null;
      const enriched  = { ...full, client: clientObj };
      const opts      = getExportOpts?.() || {};

      // Excel only. PDF is a direct link to the server renderer, so it never
      // reaches this hook — see the note at the top.
      exportExcel(enriched, opts);
      toast('Excel file downloaded.');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'red');
    } finally {
      setExportLoading(prev => ({ ...prev, [record.id]: null }));
    }
  }

  return { exportLoading, handleExport };
}
