import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, ExportButton, toast } from '../components/shared';
import {
  getCashDrawers, createCashDrawer, updateCashDrawer, getCashSummary,
  getCashReconciliations, getCashReconciliation, openCashReconciliation,
  addCashMovement, deleteCashMovement, closeCashReconciliation, reopenCashReconciliation,
} from '../api/client';

const today = () => new Date().toISOString().slice(0, 10);

// USD and LBP are formatted — and shown — strictly separately. They are never
// added together: a drawer holds two independent physical cash balances.
const _usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
const _lbp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = (v, ccy) => ccy === 'LBP'
  ? `${_lbp.format(Number(v) || 0)} LBP`
  : _usd.format(Number(v) || 0);

function VarianceTag({ value, currency }) {
  const { t } = useLocale();
  if (value == null) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const balanced = Math.abs(value) < (currency === 'LBP' ? 1 : 0.01);
  const color = balanced ? 'var(--green)' : 'var(--red)';
  const word = balanced ? t('cash.balanced') : value > 0 ? t('cash.over') : t('cash.short');
  return (
    <span style={{ color, fontWeight: 600 }}>
      {money(value, currency)}{!balanced && ` (${word})`}
    </span>
  );
}

// ── Drawer add/edit modal ───────────────────────────────────────────────────
function DrawerModal({ drawer, onClose, onSaved }) {
  const { t } = useLocale();
  const isEdit = !!drawer;
  const [name, setName] = useState(drawer?.name || '');
  const [active, setActive] = useState(drawer ? !!drawer.is_active : true);
  const [autoCapture, setAutoCapture] = useState(drawer ? !!drawer.auto_capture : false);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { toast(t('cash.drawerName'), 'red'); return; }
    setBusy(true);
    try {
      const payload = { name: name.trim(), is_active: active, auto_capture: autoCapture };
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
            <select className="form-control" value={drawerId} onChange={e => setDrawerId(e.target.value)}>
              {active.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('cash.businessDate')}</label>
            <input type="date" className="form-control" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.openingBalance')} (USD)</label>
            <input type="number" step="any" min="0" className="form-control" value={openingUsd}
              placeholder="0" onChange={e => setOpeningUsd(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.openingBalance')} (LBP)</label>
            <input type="number" step="any" min="0" className="form-control" value={openingLbp}
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
            <input type="number" step="any" min="0" className="form-control" value={countedUsd}
              autoFocus onChange={e => setCountedUsd(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('cash.countedCash')} (LBP)</label>
            <input type="number" step="any" min="0" className="form-control" value={countedLbp}
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

const CATS = {
  in:  ['Float', 'Sale', 'Transfer In', 'Other'],
  out: ['Payout', 'Bank Deposit', 'Supplier Payment', 'Transfer Out', 'Other'],
};

// ── Reconciliation detail modal ─────────────────────────────────────────────
function ReconDetailModal({ reconId, canCreate, canEdit, canDelete, onClose, onChanged }) {
  const { t, fmtDate } = useLocale();
  const [rec, setRec] = useState(null);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [dir, setDir] = useState('in');
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Float');
  const [desc, setDesc] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getCashReconciliation(reconId).then(setRec).catch(e => setError(e.message));
  }, [reconId]);
  useEffect(() => { load(); }, [load]);

  async function addMv() {
    if (amount === '' || Number(amount) <= 0) { toast(t('cash.amount'), 'red'); return; }
    setAdding(true);
    try {
      await addCashMovement(reconId, {
        direction: dir, currency, amount: Number(amount),
        category, description: desc.trim() || null,
      });
      toast(t('cash.movementAdded'), 'green');
      setAmount(''); setDesc('');
      load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setAdding(false); }
  }

  async function removeMv(mid) {
    try { await deleteCashMovement(reconId, mid); toast(t('cash.movementRemoved'), 'green'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  async function reopen() {
    try {
      await reopenCashReconciliation(reconId);
      toast(t('cash.reconReopened'), 'green');
      setConfirmReopen(false); load(); onChanged();
    } catch (e) { toast(e.message, 'red'); setConfirmReopen(false); }
  }

  const isOpen = rec?.status === 'open';
  const fu = rec?.figures?.usd || {};
  const fl = rec?.figures?.lbp || {};

  // label | USD value | LBP value
  const Row = ({ label, u, l, bold, signed }) => (
    <tr>
      <td style={bold ? { fontWeight: 700 } : undefined}>{label}</td>
      <td style={{ textAlign: 'end', ...(bold ? { fontWeight: 700 } : {}) }}>
        {signed ? (signed === '+' ? '+' : '−') : ''}{money(u, 'USD')}
      </td>
      <td style={{ textAlign: 'end', ...(bold ? { fontWeight: 700 } : {}) }}>
        {signed ? (signed === '+' ? '+' : '−') : ''}{money(l, 'LBP')}
      </td>
    </tr>
  );

  return (
    <Modal title={rec ? `${rec.drawer_name} · ${rec.business_date}` : t('cash.title')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!rec && !error && <LoadingSpinner />}
        {rec && (
          <>
            <div style={{ marginBottom: 10 }}>
              <span className={`badge badge-${isOpen ? 'green' : 'gray'}`}>
                {isOpen ? t('cash.statusOpen') : t('cash.statusClosed')}
              </span>
              {rec.auto_capture && (
                <span className="badge badge-blue" style={{ marginInlineStart: 6 }}>{t('cash.autoCapture')}</span>
              )}
            </div>

            {/* Two separate balances — never summed */}
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr><th></th><th style={{ textAlign: 'end' }}>USD</th><th style={{ textAlign: 'end' }}>LBP</th></tr>
              </thead>
              <tbody>
                <Row label={t('cash.openingBalance')} u={fu.opening}    l={fl.opening} />
                <Row label={t('cash.autoIn')}         u={fu.auto_in}    l={fl.auto_in}  signed="+" />
                <Row label={t('cash.autoOut')}        u={fu.auto_out}   l={fl.auto_out} signed="-" />
                <Row label={t('cash.manualIn')}       u={fu.manual_in}  l={fl.manual_in}  signed="+" />
                <Row label={t('cash.manualOut')}      u={fu.manual_out} l={fl.manual_out} signed="-" />
                <Row label={t('cash.expectedCash')}   u={rec.expected_cash} l={rec.expected_cash_lbp} bold />
                {rec.status === 'closed' && (
                  <>
                    <Row label={t('cash.countedCash')} u={rec.counted_cash} l={rec.counted_cash_lbp} />
                    <tr>
                      <td style={{ fontWeight: 700 }}>{t('cash.variance')}</td>
                      <td style={{ textAlign: 'end' }}><VarianceTag value={rec.variance} currency="USD" /></td>
                      <td style={{ textAlign: 'end' }}><VarianceTag value={rec.variance_lbp} currency="LBP" /></td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>

            {/* Movements */}
            <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('cash.movements')}</h4>
            {(rec.movements || []).length === 0 && (
              <p style={{ color: 'var(--text-3)', fontSize: 13 }}>—</p>
            )}
            {(rec.movements || []).length > 0 && (
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr><th>{t('cash.direction')}</th><th>{t('cash.currency')}</th><th>{t('cash.category')}</th>
                      <th>{t('cash.description')}</th><th style={{ textAlign: 'end' }}>{t('cash.amount')}</th><th></th></tr>
                </thead>
                <tbody>
                  {rec.movements.map(m => (
                    <tr key={m.id}>
                      <td>
                        <span className={`badge badge-${m.direction === 'in' ? 'green' : 'red'}`}>
                          {m.direction === 'in' ? t('cash.cashIn') : t('cash.cashOut')}
                        </span>
                      </td>
                      <td>{m.currency || 'USD'}</td>
                      <td>{m.category || '—'}</td>
                      <td>{m.description || '—'}</td>
                      <td style={{ textAlign: 'end' }}>{money(m.amount, m.currency)}</td>
                      <td>
                        {isOpen && canEdit && (
                          <button className="icon-btn" title={t('common.delete')} onClick={() => removeMv(m.id)}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Add movement */}
            {isOpen && canCreate && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end',
                            marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.direction')}</label>
                  <select className="form-control" style={{ height: 32 }} value={dir}
                    onChange={e => { setDir(e.target.value); setCategory(CATS[e.target.value][0]); }}>
                    <option value="in">{t('cash.cashIn')}</option>
                    <option value="out">{t('cash.cashOut')}</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.currency')}</label>
                  <select className="form-control" style={{ height: 32 }} value={currency}
                    onChange={e => setCurrency(e.target.value)}>
                    <option value="USD">USD</option>
                    <option value="LBP">LBP</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{t('cash.category')}</label>
                  <select className="form-control" style={{ height: 32 }} value={category}
                    onChange={e => setCategory(e.target.value)}>
                    {CATS[dir].map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 110 }}>
                  <label className="form-label">{t('cash.description')}</label>
                  <input className="form-control" style={{ height: 32 }} value={desc}
                    onChange={e => setDesc(e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0, width: 110 }}>
                  <label className="form-label">{t('cash.amount')}</label>
                  <input type="number" step="any" min="0" className="form-control" style={{ height: 32 }}
                    value={amount} onChange={e => setAmount(e.target.value)} />
                </div>
                <button className="btn btn-secondary btn-sm" disabled={adding} onClick={addMv}>
                  {t('cash.addMovement')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {rec && isOpen && canEdit && (
          <button className="btn btn-primary" onClick={() => setClosing(true)}>{t('cash.closeDay')}</button>
        )}
        {rec && !isOpen && canDelete && (
          <button className="btn btn-secondary" onClick={() => setConfirmReopen(true)}>{t('cash.reopen')}</button>
        )}
      </div>
      {closing && rec && (
        <CloseDayModal recon={rec} onClose={() => setClosing(false)}
          onClosed={() => { setClosing(false); load(); onChanged(); }} />
      )}
      {confirmReopen && (
        <ConfirmModal title={t('cash.reopen')} message={t('cash.reopenConfirm')}
          confirmLabel={t('cash.reopen')}
          onCancel={() => setConfirmReopen(false)} onConfirm={reopen} />
      )}
    </Modal>
  );
}

// ── Today view ──────────────────────────────────────────────────────────────
// ── Today view ──────────────────────────────────────────────────────────────
//
// KPI strip at the top summarises today across all drawers. Below it, a
// generously-sized card per drawer in a responsive grid — each card has a
// status pill, the expected USD + LBP as side-by-side stat blocks, an
// optional variance row when closed, and a primary action at the foot.
function TodayView({ canCreate, onOpenDay, openDetail, refreshKey }) {
  const { t } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getCashSummary(today()).then(setData).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!data) return <LoadingSpinner />;
  if (data.drawers.length === 0) {
    return (
      <div className="cash-empty-hero">
        <div className="cash-empty-hero-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2"/>
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        </div>
        <div className="cash-empty-hero-title">{t('cash.noDrawersTitle')}</div>
        <p className="cash-empty-hero-sub">{t('cash.noDrawersHint')}</p>
      </div>
    );
  }

  // KPI roll-ups across every drawer for today. Open drawers contribute to
  // "expected on hand"; closed drawers with a non-zero variance contribute
  // to "anomalies"; not-started drawers are flagged separately.
  const drawers = data.drawers;
  const openCount    = drawers.filter(d => d.reconciliation?.status === 'open').length;
  const idleCount    = drawers.filter(d => !d.reconciliation).length;
  const expectedUsd  = drawers.reduce((s, d) => s + (Number(d.reconciliation?.expected_cash)     || 0), 0);
  const expectedLbp  = drawers.reduce((s, d) => s + (Number(d.reconciliation?.expected_cash_lbp) || 0), 0);
  const anomalies    = drawers.filter(d =>
    d.reconciliation?.status === 'closed' &&
    ((Math.abs(Number(d.reconciliation.variance) || 0) > 0.005) ||
     (Math.abs(Number(d.reconciliation.variance_lbp) || 0) > 0.5))
  ).length;

  return (
    <>
      {/* KPI strip — what's happening with cash right now */}
      <div className="cash-kpi-strip">
        <div className="stat-card">
          <div className="stat-label">{t('cash.openDrawers')}</div>
          <div className="stat-value">{openCount} / {drawers.length}</div>
          <div className="stat-sub">{idleCount > 0
            ? t('cash.notStartedCount', { count: idleCount })
            : t('cash.allStarted')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.expectedOnHand')} USD</div>
          <div className="stat-value">{money(expectedUsd, 'USD')}</div>
          <div className="stat-sub">{t('cash.acrossDrawers', { n: drawers.length })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.expectedOnHand')} LBP</div>
          <div className="stat-value">{money(expectedLbp, 'LBP')}</div>
          <div className="stat-sub">{t('cash.acrossDrawers', { n: drawers.length })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.todayAnomalies')}</div>
          <div className="stat-value" style={{
            color: anomalies > 0 ? 'var(--negate)' : 'var(--affirm)',
          }}>
            {anomalies > 0 ? anomalies : '—'}
          </div>
          <div className="stat-sub">
            {anomalies > 0 ? t('cash.varianceFound') : t('cash.noVariance')}
          </div>
        </div>
      </div>

      {/* Drawer cards */}
      <div className="cash-drawers-grid">
        {drawers.map(({ drawer, reconciliation }) => {
          // Card state class drives the accent rail + status badge variant.
          let state = 'idle';
          if (reconciliation?.status === 'open')   state = 'open';
          if (reconciliation?.status === 'closed') state = 'closed';
          const varUsd = Number(reconciliation?.variance) || 0;
          const varLbp = Number(reconciliation?.variance_lbp) || 0;
          const hasVariance = Math.abs(varUsd) > 0.005 || Math.abs(varLbp) > 0.5;
          return (
            <div key={drawer.id} className={`cash-drawer-card is-${state}`}>
              <div className="cash-drawer-head">
                <div className="cash-drawer-name">
                  <span className="cash-drawer-name-icon" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="6" width="20" height="12" rx="2"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  </span>
                  <span className="truncate">{drawer.name}</span>
                </div>
                <span className={`cash-drawer-status ${state}`}>
                  <span className="dot" />
                  {state === 'open'   ? t('cash.statusOpen')
                  : state === 'closed' ? t('cash.statusClosed')
                  : t('cash.notStarted')}
                </span>
              </div>

              <div className="cash-drawer-body">
                {!reconciliation ? (
                  <div style={{ padding: '6px 2px', color: 'var(--text-3)', fontSize: 13, lineHeight: 1.55 }}>
                    {t('cash.notStartedHint')}
                  </div>
                ) : (
                  <>
                    <div className="cash-stat-pair">
                      <div className="cash-stat">
                        <div className="cash-stat-label">USD</div>
                        <div className="cash-stat-value">{money(reconciliation.expected_cash, 'USD')}</div>
                      </div>
                      <div className="cash-stat">
                        <div className="cash-stat-label">LBP</div>
                        <div className="cash-stat-value">{money(reconciliation.expected_cash_lbp, 'LBP')}</div>
                      </div>
                    </div>
                    {reconciliation.status === 'closed' && (
                      <div className={`cash-variance-row ${hasVariance ? 'bad' : 'good'}`}>
                        <span className="cash-variance-label">{t('cash.variance')}</span>
                        <span className="cash-variance-value">
                          {hasVariance
                            ? `${varUsd ? money(varUsd, 'USD') : '—'} · ${varLbp ? money(varLbp, 'LBP') : '—'}`
                            : t('cash.balanced')}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {!!drawer.auto_capture && (
                  <div style={{
                    marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10.5,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    color: 'var(--accent)',
                  }}>
                    ⚡ {t('cash.autoCapture')}
                  </div>
                )}
              </div>

              <div className="cash-drawer-foot">
                {!reconciliation && canCreate && (
                  <button className="btn btn-primary btn-sm" onClick={() => onOpenDay(drawer.id)}>
                    {t('cash.openDay')}
                  </button>
                )}
                {reconciliation && (
                  <button className="btn btn-secondary btn-sm" onClick={() => openDetail(reconciliation.id)}>
                    {t('cash.viewDay')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── History view ────────────────────────────────────────────────────────────
function HistoryView({ drawers, openDetail, refreshKey }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [date, setDate] = useState('');
  const [drawerId, setDrawerId] = useState('');

  const load = useCallback(() => {
    setError(null);
    const params = {};
    if (date) params.date = date;
    if (drawerId) params.drawer_id = drawerId;
    getCashReconciliations(params).then(setRows).catch(e => setError(e.message));
  }, [date, drawerId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const exportData = (rows || []).map(r => ({
    Drawer:           r.drawer_name,
    Business_Date:    fmtDate(r.business_date),
    Status:           r.status === 'open' ? 'Open' : 'Closed',
    Expected_USD:     r.expected_cash || 0,
    Expected_LBP:     r.expected_cash_lbp || 0,
    Counted_USD:      r.counted_cash || 0,
    Counted_LBP:      r.counted_cash_lbp || 0,
    Variance_USD:     r.variance || 0,
    Variance_LBP:     r.variance_lbp || 0,
  }));

  return (
    <div>
      <div className="cash-filter-bar">
        <span className="cash-filter-bar-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          {t('common.filters') || 'Filters'}
        </span>
        <input type="date" className="form-control" style={{ width: 160 }} value={date}
          onChange={e => setDate(e.target.value)} />
        <select className="form-control" style={{ width: 180 }} value={drawerId}
          onChange={e => setDrawerId(e.target.value)}>
          <option value="">{t('cash.drawers')}</option>
          {drawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {rows && (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)',
            letterSpacing: '0.04em',
          }}>
            {rows.length} {t('cash.reconciliations') || 'reconciliations'}
          </span>
        )}
        {rows && rows.length > 0 && (
          <div style={{ marginInlineStart: 'auto' }}>
            <ExportButton data={exportData} filename="Cash_Reconciliations" sheetName="Reconciliations" />
          </div>
        )}
      </div>
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('cash.noReconciliations')} />}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t('cash.drawer')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.status')}</th>
                <th>{t('cash.expectedCash')} USD</th>
                <th>{t('cash.expectedCash')} LBP</th>
                <th>{t('cash.variance')} USD</th>
                <th>{t('cash.variance')} LBP</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.drawer_name}</td>
                  <td>{fmtDate(r.business_date)}</td>
                  <td>
                    <span className={`badge badge-${r.status === 'open' ? 'green' : 'gray'}`}>
                      {r.status === 'open' ? t('cash.statusOpen') : t('cash.statusClosed')}
                    </span>
                  </td>
                  <td>{money(r.expected_cash, 'USD')}</td>
                  <td>{money(r.expected_cash_lbp, 'LBP')}</td>
                  <td><VarianceTag value={r.variance} currency="USD" /></td>
                  <td><VarianceTag value={r.variance_lbp} currency="LBP" /></td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openDetail(r.id)}>
                      {t('cash.viewDay')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Drawers view ────────────────────────────────────────────────────────────
function DrawersView({ canCreate, canEdit, drawers, reload }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(null);

  return (
    <div>
      {canCreate && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>{t('cash.addDrawer')}</button>
        </div>
      )}
      {drawers.length === 0 && <EmptyState message={t('cash.noDrawers')} icon="🗄️" />}
      {drawers.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>{t('cash.drawerName')}</th><th>{t('cash.active')}</th>
                  <th>{t('cash.autoCapture')}</th><th></th></tr>
            </thead>
            <tbody>
              {drawers.map(d => (
                <tr key={d.id}>
                  <td><strong>{d.name}</strong></td>
                  <td>
                    <span className={`badge badge-${d.is_active ? 'green' : 'gray'}`}>
                      {d.is_active ? t('cash.active') : '—'}
                    </span>
                  </td>
                  <td>{d.auto_capture ? <span className="badge badge-blue">{t('cash.autoCapture')}</span> : '—'}</td>
                  <td>
                    {canEdit && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(d)}>
                        {t('common.edit')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <DrawerModal drawer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function Cash() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('today');
  const [drawers, setDrawers] = useState([]);
  const [openDayFor, setOpenDayFor] = useState(undefined);
  const [detailId, setDetailId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const canView   = can('cash', 'view');
  const canCreate = can('cash', 'create');
  const canEdit   = can('cash', 'edit');
  const canDelete = can('cash', 'delete');

  const loadDrawers = useCallback(() => {
    getCashDrawers().then(setDrawers).catch(() => {});
  }, []);
  useEffect(() => { loadDrawers(); }, [loadDrawers]);

  const refresh = () => setRefreshKey(k => k + 1);

  const tabs = [
    { key: 'today',   label: t('cash.tabToday') },
    { key: 'history', label: t('cash.tabHistory') },
    { key: 'drawers', label: t('cash.tabDrawers') },
  ];

  if (!canView) return <EmptyState message={t('cash.subtitle')} icon="🔒" />;

  return (
    <div>
      {/* Workspace-style page header with title + subtitle on the left and
          the "Open Day" primary action on the right. */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('cash.title')}</h1>
          <p className="page-subtitle">{t('cash.subtitle')}</p>
        </div>
        <div className="page-actions">
          {canCreate && (
            <button className="btn btn-primary" onClick={() => setOpenDayFor(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              {t('cash.openDay')}
            </button>
          )}
        </div>
      </div>

      {/* Workspace tabs — clean underline style, consistent with the rest
          of the modules. */}
      <div className="tabs">
        {tabs.map(tb => (
          <button key={tb.key}
            className={`tab-btn${view === tb.key ? ' active' : ''}`}
            onClick={() => setView(tb.key)}>
            {tb.label}
          </button>
        ))}
      </div>

      {view === 'today' && (
        <TodayView canCreate={canCreate} onOpenDay={(id) => setOpenDayFor(id)}
          openDetail={setDetailId} refreshKey={refreshKey} />
      )}
      {view === 'history' && (
        <HistoryView drawers={drawers} openDetail={setDetailId} refreshKey={refreshKey} />
      )}
      {view === 'drawers' && (
        <DrawersView canCreate={canCreate} canEdit={canEdit} drawers={drawers} reload={loadDrawers} />
      )}

      {openDayFor !== undefined && (
        <OpenDayModal drawers={drawers} presetDrawerId={openDayFor}
          onClose={() => setOpenDayFor(undefined)}
          onOpened={() => { setOpenDayFor(undefined); refresh(); }} />
      )}
      {detailId && (
        <ReconDetailModal reconId={detailId}
          canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)} onChanged={refresh} />
      )}
    </div>
  );
}
