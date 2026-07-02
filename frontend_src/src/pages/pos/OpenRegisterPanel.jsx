import { useState, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useWarehouses } from '../../hooks/useWarehouses';
import { toast, NumberInput } from '../../components/shared';
import { openPosSession } from '../../api/client';

function OpenRegisterPanel({ onOpened }) {
  const { t } = useLocale();
  const [floatUsd, setFloatUsd] = useState('0');
  const [floatLbp, setFloatLbp] = useState('0');
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState(false);
  // Cashier picks which warehouse this register sells out of. Auto-selects
  // their default once it loads. Hidden when only one warehouse exists (no
  // choice to make), so the existing single-warehouse UX is unchanged.
  const { warehouses, defaultId } = useWarehouses();
  useEffect(() => {
    if (defaultId && !warehouseId) setWarehouseId(defaultId);
  }, [defaultId, warehouseId]);

  async function open() {
    setBusy(true);
    try {
      await openPosSession({
        opening_float:     parseFloat(floatUsd) || 0,
        opening_float_lbp: parseFloat(floatLbp) || 0,
        warehouse_id:      warehouseId ? parseInt(warehouseId) : null,
      });
      toast(t('pos.sessionOpened'), 'green');
      onOpened();
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 440, margin: '48px auto', overflow: 'hidden' }}>
      {/* Hero header — centred icon, title, prompt. Padded block, hairline
          rule beneath so it reads as a header band rather than crowding
          the form. */}
      <div style={{
        textAlign: 'center',
        padding: '28px 28px 22px',
        borderBottom: '1px solid var(--rule)',
        background: 'var(--surface-2)',
      }}>
        <div style={{
          width: 56, height: 56, margin: '0 auto 14px',
          borderRadius: 999,
          background: 'var(--accent-tint)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M6 7V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/>
            <line x1="6" y1="12" x2="10" y2="12"/>
            <circle cx="17" cy="15" r="1.5"/>
          </svg>
        </div>
        <h3 style={{
          margin: 0,
          fontFamily: 'var(--font-display)', fontWeight: 700,
          fontSize: 19, letterSpacing: '-0.02em', color: 'var(--text)',
        }}>{t('pos.openRegister')}</h3>
        <p style={{
          margin: '6px auto 0', maxWidth: 300,
          color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.5,
        }}>{t('pos.openRegisterPrompt')}</p>
      </div>

      {/* Form body — a real flex column with consistent gaps, so nothing
          stacks flush against its neighbour or the card edge. */}
      <div style={{
        padding: 24,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {warehouses.length > 1 && (
          <div className="form-group">
            <label className="form-label">{t('warehouses.sellingFrom')}</label>
            <select className="form-control" value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}{w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">{t('pos.openingFloat')} (USD)</label>
          <NumberInput className="form-control" step="any" min="0" value={floatUsd}
            onChange={e => setFloatUsd(e.target.value)} autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">{t('pos.openingFloat')} (LBP)</label>
          <NumberInput className="form-control" step="any" min="0" value={floatLbp}
            onChange={e => setFloatLbp(e.target.value)} />
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 4 }}
          disabled={busy} onClick={open}>
          {busy ? t('common.saving') : t('pos.openRegister')}
        </button>
      </div>
    </div>
  );
}


export { OpenRegisterPanel };
