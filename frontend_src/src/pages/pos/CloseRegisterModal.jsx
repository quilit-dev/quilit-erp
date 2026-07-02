import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { closePosSession } from '../../api/client';
import { num } from './pricing';

function CloseRegisterModal({ session, onClose, onClosed }) {
  const { t, fmt, tCategory } = useLocale();
  const [countUsd, setCountUsd] = useState('');
  const [countLbp, setCountLbp] = useState('');
  const [busy, setBusy] = useState(false);

  async function close() {
    if (countUsd === '' || isNaN(parseFloat(countUsd))) { toast(t('pos.closingCount'), 'red'); return; }
    setBusy(true);
    try {
      const res = await closePosSession({
        closing_count:     parseFloat(countUsd),
        closing_count_lbp: countLbp === '' ? 0 : parseFloat(countLbp),
      });
      const ok = Math.abs(res.variance) < 0.01 && Math.abs(res.variance_lbp) < 1;
      toast(`${t('pos.sessionClosed')} — ${t('pos.variance')} USD ${fmt(res.variance)}`
            + ` · LBP ${num(res.variance_lbp)}`, ok ? 'green' : 'yellow');
      onClosed();
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('pos.closeRegister')} onClose={onClose}>
      <div className="modal-body">
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
          {t('pos.openingFloat')}: <strong>{fmt(session.opening_float)}</strong>
          {' / '}<strong>{num(session.opening_float_lbp)} LBP</strong>
          {' · '}{t('pos.salesCount')}: <strong>{session.sales_count ?? 0}</strong>
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('pos.closingCount')} (USD)</label>
            <NumberInput className="form-control" step="any" min="0" value={countUsd}
              onChange={e => setCountUsd(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pos.closingCount')} (LBP)</label>
            <NumberInput className="form-control" step="any" min="0" value={countLbp}
              placeholder="0" onChange={e => setCountLbp(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={close}>
          {busy ? t('common.saving') : t('pos.closeRegister')}
        </button>
      </div>
    </Modal>
  );
}

// ── Receipt modal ───────────────────────────────────────────────────────────
// Designed to look like a real thermal-printer slip: narrow column,
// monospace digits, dotted dividers, condensed item list. Includes
// print-only CSS so the browser's Print dialog produces just the receipt
// strip — no app chrome, no nav, no buttons.

export { CloseRegisterModal };
