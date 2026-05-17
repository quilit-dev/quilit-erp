import { useState } from 'react';
import { toast } from '../components/shared';

/**
 * Shared per-row export handler for record list pages (quotations, invoices).
 * Fetches the full record, attaches its client, then runs the PDF/Excel exporter.
 *
 *   const { exportLoading, handleExport } = useRecordExport({
 *     fetchFull:   getQuotation,
 *     exportPDF:   exportQuotationPDF,
 *     exportExcel: exportQuotationExcel,
 *     getClients:  () => clients,
 *   });
 *
 * `exportLoading` maps record id → 'pdf' | 'excel' | null while a job runs.
 */
export function useRecordExport({ fetchFull, exportPDF, exportExcel, getClients }) {
  const [exportLoading, setExportLoading] = useState({});

  async function handleExport(record, type) {
    setExportLoading(prev => ({ ...prev, [record.id]: type }));
    try {
      const full      = await fetchFull(record.id);
      const clientObj = (getClients?.() || []).find(c => c.id === full.client_id) || null;
      const enriched  = { ...full, client: clientObj };

      if (type === 'pdf') {
        await exportPDF(enriched);
        toast('PDF ready — use your browser\'s Save as PDF option.');
      } else {
        exportExcel(enriched);
        toast('Excel file downloaded.');
      }
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'red');
    } finally {
      setExportLoading(prev => ({ ...prev, [record.id]: null }));
    }
  }

  return { exportLoading, handleExport };
}
