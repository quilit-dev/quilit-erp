import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal } from '../../components/shared';
import { getStockMovements } from '../../api/client';
import { ExportButtons } from '../reports/charts';

function MovementsModal({ item, onClose }) {
  const { t, tEnumValue } = useLocale();
  const [movements, setMovements] = useState([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    getStockMovements(item.id)
      .then(setMovements)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [item.id]);

  // The same columns the table shows, plus the reference and the note apart
  // (the table shows one or the other), so the file is the full record.
  const columns = [
    { label: t('common.date'),         value: m => m.created_at?.slice(0, 16) || '', align: 'left'  },
    { label: t('common.type'),         value: m => tEnumValue(m.type),               align: 'left'  },
    { label: t('inventory.delta'),     value: m => m.delta,                          align: 'right' },
    { label: t('inventory.before'),    value: m => m.qty_before,                     align: 'right' },
    { label: t('inventory.after'),     value: m => m.qty_after,                      align: 'right' },
    { label: t('inventory.reference'), value: m => m.reference || '',                align: 'left'  },
    { label: t('inventory.noteRef'),   value: m => tEnumValue(m.note) || '',         align: 'left'  },
  ];
  const fileName = `stock_history_${String(item.name || item.id).replace(/[^\p{L}\p{N}]+/gu, '_')}`;

  return (
    <Modal title={t('inventory.stockHistory', { name: item.name })} onClose={onClose} size="modal-lg">
      {loading ? <LoadingSpinner /> : movements.length === 0 ? (
        <EmptyState message={t('inventory.noMovements')} />
      ) : (
        <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 16px 0' }}>
          <ExportButtons rows={movements} columns={columns} baseName={fileName}
            pdfTitle={t('inventory.stockHistory', { name: item.name })}
            subtitle={[item.sku, item.category].filter(Boolean).join(' · ')} t={t} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('common.type')}</th>
                <th>{t('inventory.delta')}</th>
                <th>{t('inventory.before')}</th>
                <th>{t('inventory.after')}</th>
                <th>{t('inventory.noteRef')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{m.created_at?.slice(0, 16)}</td>
                  {/* The movement kind is a fixed vocabulary written by the
                      server ('adjustment', 'transfer_out', 'qc_reject'), so it
                      belongs in the enum dictionary. Rendered raw it left the
                      one column in this table in English on an Arabic screen —
                      and showed 'Transfer_out' on an English one, because
                      capitalising a snake_case value is not a label. */}
                  <td>{tEnumValue(m.type)}</td>
                  <td style={{ fontWeight: 600, color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {m.delta >= 0 ? '+' : ''}{m.delta}
                  </td>
                  <td>{m.qty_before}</td>
                  <td>{m.qty_after}</td>
                  {/* Notes are mostly user text and PO/invoice references, which
                      must appear exactly as entered — but "Initial stock" is a
                      fixed phrase the server writes for an item's opening
                      balance, so it is the one note worth translating. The
                      dictionary passes anything it does not know through
                      unchanged, which is what makes this safe to apply to free
                      text. */}
                  <td style={{ color: 'var(--text-3)' }}>{tEnumValue(m.note) || m.reference || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Modal>
  );
}

export { MovementsModal };
