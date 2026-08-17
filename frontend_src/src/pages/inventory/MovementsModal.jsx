import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal } from '../../components/shared';
import { getStockMovements } from '../../api/client';

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

  return (
    <Modal title={t('inventory.stockHistory', { name: item.name })} onClose={onClose} size="modal-lg">
      {loading ? <LoadingSpinner /> : movements.length === 0 ? (
        <EmptyState message={t('inventory.noMovements')} />
      ) : (
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
      )}
    </Modal>
  );
}

export { MovementsModal };
