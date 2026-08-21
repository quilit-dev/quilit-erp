// Who is holding what, and the button to give it back.
//
// The system has always had a reserved figure. What it could never say is
// whose reservation it is — which is the question asked every single time
// somebody wants to release one, and the reason releasing used to be
// guesswork.
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getStockReservations, createStockReservation, releaseStockReservation, getClients,
} from '../api/client';
import { LoadingSpinner, NumberInput, toast, fmtDate } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

export default function StockReservations({ item, onChanged }) {
  const { t } = useLocale();
  const { can } = usePermissions();
  const canEdit = can('inventory', 'edit');

  const [rows, setRows] = useState(null);
  const [clients, setClients] = useState([]);
  const [adding, setAdding] = useState(false);
  const [clientId, setClientId] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getStockReservations({ inventory_id: item.id })
      .then(setRows)
      .catch(e => toast(e.message, 'red'));
  }, [item.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (adding && clients.length === 0) getClients().then(setClients).catch(() => {});
  }, [adding, clients.length]);

  // What is genuinely free. The server is the authority; this is the same
  // arithmetic so the form can refuse before the request goes out.
  const held = (rows || []).reduce((s, r) => s + (r.quantity || 0), 0);
  const available = item.available_quantity != null
    ? item.available_quantity
    : Math.round(((item.quantity || 0) - (item.reserved_quantity || 0)) * 1e6) / 1e6;

  const tooMuch = (parseFloat(qty) || 0) > available + 1e-6;

  async function save() {
    if (!clientId) { toast(t('reservations.needClient'), 'red'); return; }
    setBusy(true);
    try {
      await createStockReservation({
        inventory_id: item.id, client_id: Number(clientId),
        quantity: Number(qty), note: note.trim() || null,
      });
      toast(t('reservations.held'));
      setAdding(false); setClientId(''); setQty(''); setNote('');
      load(); onChanged?.();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  async function release(id) {
    try {
      await releaseStockReservation(id, {});
      toast(t('reservations.released'));
      load(); onChanged?.();
    } catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('reservations.title')}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)', marginInlineEnd: 'auto' }}>
          {t('reservations.availableOf', {
            available, total: item.quantity, unit: item.unit || '',
          })}
        </span>
        {canEdit && !adding && available > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={() => setAdding(true)}>
            ＋ {t('reservations.reserve')}
          </button>
        )}
      </div>

      {adding && (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="form-group">
            <label className="form-label">{t('common.client')} *</label>
            <select className="form-control" value={clientId}
              onChange={e => setClientId(e.target.value)}>
              <option value="">{t('reservations.chooseClient')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('common.quantity')} *</label>
            <NumberInput className="form-control" min="0" step="any" value={qty}
              onChange={e => setQty(e.target.value)} />
            {tooMuch && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 3 }}>
                {t('reservations.tooMuch', { available })}
              </div>
            )}
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('common.notes')}</label>
            <input className="form-control" value={note}
              onChange={e => setNote(e.target.value)} />
          </div>
          <div className="form-group form-full"
            style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-sm btn-primary" onClick={save}
              disabled={busy || tooMuch || !qty || !clientId}>
              {busy ? t('common.saving') : t('reservations.reserve')}
            </button>
          </div>
        </div>
      )}

      {rows === null ? <LoadingSpinner /> : rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 10 }}>
          {t('reservations.none')}
        </div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>{t('common.client')}</th>
                <th style={{ textAlign: 'right' }}>{t('common.quantity')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.notes')}</th>
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="td-primary">
                    {r.client_id ? (
                      <Link to={`/clients/${r.client_id}`}
                        style={{ color: 'var(--accent)' }}>{r.client_name}</Link>
                    ) : r.client_name || '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.quantity} {r.unit || ''}</td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td style={{ color: 'var(--text-3)' }}>{r.note || '—'}</td>
                  {canEdit && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-secondary"
                        onClick={() => release(r.id)}>
                        {t('reservations.release')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Manufacturing writes straight to the reserved figure and keeps no rows
          here, so the difference is material committed to confirmed production
          orders. Saying so beats leaving an unexplained gap. */}
      {(item.reserved_quantity || 0) - held > 1e-6 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
          {t('reservations.productionHolds', {
            qty: Math.round(((item.reserved_quantity || 0) - held) * 1e6) / 1e6,
          })}
        </div>
      )}
    </div>
  );
}
