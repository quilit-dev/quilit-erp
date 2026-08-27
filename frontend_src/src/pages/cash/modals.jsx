// Drawer create/edit + Open Day + Close Day modals.
import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput, BranchField } from '../../components/shared';
import {
  createCashDrawer, updateCashDrawer,
  openCashReconciliation, closeCashReconciliation,
} from '../../api/client';
import { today, money, VarianceTag } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

// ── Drawer add/edit modal ───────────────────────────────────────────────────
function DrawerModal({ drawer, onClose, onSaved }) {
  const { t } = useLocale();
  const isEdit = !!drawer;
  const [name, setName] = useState(drawer?.name || '');
  const [active, setActive] = useState(drawer ? !!drawer.is_active : true);
  const [autoCapture, setAutoCapture] = useState(drawer ? !!drawer.auto_capture : false);
  const [branchId, setBranchId] = useState(drawer?.branch_id ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { toast(t('cash.drawerName'), 'red'); return; }
    setBusy(true);
    try {
      const payload = { name: name.trim(), is_active: active, auto_capture: autoCapture, branch_id: branchId || null };
      if (isEdit) { await updateCashDrawer(drawer.id, payload); toast(t('cash.drawerUpdated'), 'green'); }
      else        { await createCashDrawer(payload);            toast(t('cash.drawerCreated'), 'green'); }
      onSaved();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={isEdit ? t('cash.editDrawer') : t('cash.addDrawer')} onClose={onClose}>
      <div className="modal-body">
        <div className="form-group">
          <label className="form-label">{t('cash.drawerName')}</label>
          <input className="form-control" value={name} autoFocus onChange={e => setName(e.target.value)} />
        </div>
        <BranchField value={branchId} onChange={setBranchId} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          {t('cash.active')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={autoCapture} onChange={e => setAutoCapture(e.target.checked)} />
          {t('cash.autoCapture')}
        </label>
        <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('cash.autoCaptureHint')}</p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

// ── Open-day modal ──────────────────────────────────────────────────────────
function OpenDayModal({ drawers, presetDrawerId, onClose, onOpened }) {
  const { t } = useLocale();
  const active = drawers.filter(d => d.is_active);
  const [drawerId, setDrawerId] = useState(presetDrawerId || (active[0]?.id ?? ''));
  const [date, setDate] = useState(today());
  const [openingUsd, setOpeningUsd] = useState('');
  const [openingLbp, setOpeningLbp] = useState('');
  const [busy, setBusy] = useState(false);

  async function open() {
    if (!drawerId) { toast(t('cash.drawer'), 'red'); return; }
    setBusy(true);
    try {
      await openCashReconciliation({
        drawer_id: Number(drawerId),
        business_date: date,
        opening_balance:     openingUsd === '' ? null : Number(openingUsd),
        opening_balance_lbp: openingLbp === '' ? null : Number(openingLbp),
      });
      toast(t('cash.reconOpened'), 'green');
      onOpened();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('cash.openReconciliation')} onClose={onClose}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('cash.drawer')}</label>
            <SearchSelect
              className="form-control"
              value={drawerId}
              onChange={v => setDrawerId(v)}
              options={(active).map(d => ({ value: d.id, label: d.name }))} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('cash.businessDate')}</label>
            <input type="date" className="form-control" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.openingBalance')} (USD)</label>
            <NumberInput step="any" min="0" className="form-control" value={openingUsd}
              placeholder="0" onChange={e => setOpeningUsd(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.openingBalance')} (LBP)</label>
            <NumberInput step="any" min="0" className="form-control" value={openingLbp}
              placeholder="0" onChange={e => setOpeningLbp(e.target.value)} />
          </div>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('cash.openingBalanceHint')}</p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !drawerId} onClick={open}>
          {busy ? t('common.saving') : t('cash.openDay')}
        </button>
      </div>
    </Modal>
  );
}

// ── Close-day modal ─────────────────────────────────────────────────────────
function CloseDayModal({ recon, onClose, onClosed }) {
  const { t } = useLocale();
  const [countedUsd, setCountedUsd] = useState('');
  const [countedLbp, setCountedLbp] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const expUsd = recon.expected_cash ?? recon.figures?.usd?.expected ?? 0;
  const expLbp = recon.expected_cash_lbp ?? recon.figures?.lbp?.expected ?? 0;
  const varUsd = countedUsd === '' ? null : Number((Number(countedUsd) - expUsd).toFixed(2));
  const varLbp = countedLbp === '' ? null : Number((Number(countedLbp) - expLbp).toFixed(2));

  async function close() {
    if (countedUsd === '' || isNaN(Number(countedUsd))) { toast(t('cash.countedCash'), 'red'); return; }
    setBusy(true);
    try {
      const res = await closeCashReconciliation(recon.id, {
        counted_cash:     Number(countedUsd),
        counted_cash_lbp: countedLbp === '' ? 0 : Number(countedLbp),
        note: note.trim() || null,
      });
      const ok = Math.abs(res.variance) < 0.01 && Math.abs(res.variance_lbp) < 1;
      toast(t('cash.reconClosed'), ok ? 'green' : 'yellow');
      onClosed();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('cash.closeReconciliation')} onClose={onClose}>
      <div className="modal-body">
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>{t('cash.countPrompt')}</p>
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th></th><th style={{ textAlign: 'end' }}>USD</th><th style={{ textAlign: 'end' }}>LBP</th></tr></thead>
          <tbody>
            <tr>
              <td>{t('cash.expectedCash')}</td>
              <td style={{ textAlign: 'end' }}><strong>{money(expUsd, 'USD')}</strong></td>
              <td style={{ textAlign: 'end' }}><strong>{money(expLbp, 'LBP')}</strong></td>
            </tr>
          </tbody>
        </table>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('cash.countedCash')} (USD)</label>
            <NumberInput step="any" min="0" className="form-control" value={countedUsd}
              autoFocus onChange={e => setCountedUsd(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.countedCash')} (LBP)</label>
            <NumberInput step="any" min="0" className="form-control" value={countedLbp}
              placeholder="0" onChange={e => setCountedLbp(e.target.value)} />
          </div>
        </div>
        {(varUsd != null || varLbp != null) && (
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', gap: 18 }}>
            <span>{t('cash.variance')} USD: <VarianceTag value={varUsd} currency="USD" /></span>
            <span>{t('cash.variance')} LBP: <VarianceTag value={varLbp} currency="LBP" /></span>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">{t('cash.description')}</label>
          <input className="form-control" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={close}>
          {busy ? t('common.saving') : t('cash.closeDay')}
        </button>
      </div>
    </Modal>
  );
}

export { DrawerModal, OpenDayModal, CloseDayModal };
