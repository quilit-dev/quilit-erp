import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, EmptyState, Modal } from '../../components/shared';
import { getStockMovements } from '../../api/client';

function MovementsModal({ item, onClose }) {
  const { t, tCategory } = useLocale();
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
                  <td style={{ textTransform: 'capitalize' }}>{m.type}</td>
                  <td style={{ fontWeight: 600, color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {m.delta >= 0 ? '+' : ''}{m.delta}
                  </td>
                  <td>{m.qty_before}</td>
                  <td>{m.qty_after}</td>
                  <td style={{ color: 'var(--text-3)' }}>{m.note || m.reference || '—'}</td>
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
