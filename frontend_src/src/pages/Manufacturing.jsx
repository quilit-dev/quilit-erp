import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useSettings } from '../hooks/useSettings.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, DualMoney, toast,
} from '../components/shared';
import {
  getBoms, getBom, getBomVersions, createBom, updateBom, createBomVersion, archiveBom,
  getProductionOrders, getProductionOrder, createProductionOrder, updateProductionOrder,
  confirmProductionOrder, startProductionOrder, completeProductionOrder,
  cancelProductionOrder, archiveProductionOrder, getManufacturingProducts,
  getManufacturingSummary,
} from '../api/client';

const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(v) || 0);

const OUTPUT_TYPES = ['finished', 'semi_finished'];

const ORDER_STATUS = {
  Draft:         { bg: '#F3F4F6', color: '#6B7280' },
  Confirmed:     { bg: '#EFF6FF', color: '#2563EB' },
  'In Progress': { bg: '#FFFBEB', color: '#D97706' },
  Completed:     { bg: '#ECFDF5', color: '#059669' },
  Cancelled:     { bg: '#FEF2F2', color: '#DC2626' },
};

function StatusPill({ status }) {
  const { t } = useLocale();
  const s = ORDER_STATUS[status] || ORDER_STATUS.Draft;
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 9px', borderRadius: 20, fontSize: 11,
      fontWeight: 600, whiteSpace: 'nowrap', background: s.bg, color: s.color,
    }}>{t(`manufacturing.st_${status.replace(/ /g, '')}`)}</span>
  );
}

function TypeTag({ type }) {
  const { t } = useLocale();
  if (!type) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10,
      background: 'var(--surface-2)', color: 'var(--text-3)',
    }}>{t(`manufacturing.ptype_${type}`)}</span>
  );
}

// ── Cost input with optional USD/LBP entry toggle ───────────────────────────
function CostInput({ valueUsd, onChange, placeholder }) {
  const { exchangeRate } = useSettings();
  const lbp = exchangeRate?.rate || 0;
  const [cur, setCur] = useState('USD');
  const [raw, setRaw] = useState(valueUsd == null ? '' : String(valueUsd));

  function emit(rawVal, currency) {
    const n = Number(rawVal || 0);
    onChange(currency === 'LBP' && lbp ? n / lbp : n);
  }
  function handle(v) { setRaw(v); emit(v, cur); }
  function switchCur(next) {
    const usd = cur === 'LBP' && lbp ? Number(raw || 0) / lbp : Number(raw || 0);
    const shown = next === 'LBP' && lbp ? Math.round(usd * lbp) : usd;
    setCur(next);
    setRaw(usd ? String(shown) : '');
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <input className="form-control" type="number" step="any" min="0"
        value={raw} placeholder={placeholder} onChange={e => handle(e.target.value)} />
      {lbp > 0 && (
        <select className="form-control" style={{ width: 70, flexShrink: 0 }}
          value={cur} onChange={e => switchCur(e.target.value)}>
          <option value="USD">USD</option>
          <option value="LBP">LBP</option>
        </select>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BOM MODAL — create / edit / new version
// ════════════════════════════════════════════════════════════════════════════
function BomModal({ mode, bom, products, onClose, onSaved }) {
  // mode: 'create' | 'edit' | 'version'
  const { t } = useLocale();
  const keyRef = useRef(0);
  const [name, setName]         = useState(bom?.name || '');
  const [outputId, setOutputId] = useState(bom?.output_inventory_id || '');
  const [yieldQty, setYieldQty] = useState(bom?.output_quantity ?? 1);
  const [labor, setLabor]       = useState(bom?.labor_cost ?? 0);
  const [overhead, setOverhead] = useState(bom?.overhead_cost ?? 0);
  const [active, setActive]     = useState(bom ? !!bom.is_active : true);
  const [revNote, setRevNote]   = useState('');
  const [lines, setLines] = useState(
    (bom?.components || []).map(c => ({
      key: ++keyRef.current,
      component_inventory_id: c.component_inventory_id,
      quantity: c.quantity,
      scrap_pct: c.scrap_pct || 0,
    })),
  );
  const [busy, setBusy] = useState(false);

  const outputs    = products.filter(p => !p.product_type || OUTPUT_TYPES.includes(p.product_type));
  const addLine    = () => setLines(ls => [...ls, { key: ++keyRef.current, component_inventory_id: '', quantity: 1, scrap_pct: 0 }]);
  const setLine    = (key, patch) => setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const delLine    = (key) => setLines(ls => ls.filter(l => l.key !== key));

  async function save() {
    if (!name.trim())  { toast(t('manufacturing.bomNameRequired'), 'red'); return; }
    if (!outputId)     { toast(t('manufacturing.outputRequired'), 'red'); return; }
    const comps = lines
      .filter(l => l.component_inventory_id && Number(l.quantity) > 0)
      .map(l => ({
        component_inventory_id: Number(l.component_inventory_id),
        quantity: Number(l.quantity),
        scrap_pct: Number(l.scrap_pct) || 0,
      }));
    if (comps.length === 0) { toast(t('manufacturing.componentsRequired'), 'red'); return; }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(), output_inventory_id: Number(outputId),
        output_quantity: Number(yieldQty) || 1,
        labor_cost: Number(labor) || 0, overhead_cost: Number(overhead) || 0,
        is_active: active, components: comps, revision_note: revNote.trim() || null,
      };
      if (mode === 'version')    { await createBomVersion(bom.id, payload); toast(t('manufacturing.versionCreated'), 'green'); }
      else if (mode === 'edit')  { await updateBom(bom.id, payload);        toast(t('manufacturing.bomUpdated'), 'green'); }
      else                       { await createBom(payload);               toast(t('manufacturing.bomCreated'), 'green'); }
      onSaved();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  const title = mode === 'version' ? t('manufacturing.newVersionTitle')
    : mode === 'edit' ? t('manufacturing.editBom') : t('manufacturing.newBom');

  return (
    <Modal title={title} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('manufacturing.bomName')}</label>
            <input className="form-control" value={name} autoFocus onChange={e => setName(e.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('manufacturing.outputProduct')}</label>
            <select className="form-control" value={outputId} onChange={e => setOutputId(e.target.value)}>
              <option value="">{t('manufacturing.selectProduct')}</option>
              {outputs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.batchYield')}</label>
            <input className="form-control" type="number" step="any" min="0.0001" value={yieldQty}
              onChange={e => setYieldQty(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.laborCost')}</label>
            <CostInput valueUsd={labor} onChange={setLabor} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.overheadCost')}</label>
            <CostInput valueUsd={overhead} onChange={setOverhead} />
          </div>
        </div>

        <h4 style={{ margin: '12px 0 6px', fontSize: 14 }}>{t('manufacturing.components')}</h4>
        <table className="table" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>{t('manufacturing.component')}</th>
              <th style={{ width: 110 }}>{t('manufacturing.componentQty')}</th>
              <th style={{ width: 100 }}>{t('manufacturing.scrapPct')}</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.key}>
                <td>
                  <select className="form-control" style={{ height: 32 }} value={l.component_inventory_id}
                    onChange={e => setLine(l.key, { component_inventory_id: e.target.value })}>
                    <option value="">{t('manufacturing.selectProduct')}</option>
                    {products.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.product_type ? ` · ${t(`manufacturing.ptype_${p.product_type}`)}` : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="form-control" style={{ height: 32 }} type="number" step="any" min="0"
                    value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                </td>
                <td>
                  <input className="form-control" style={{ height: 32 }} type="number" step="any" min="0" max="100"
                    value={l.scrap_pct} onChange={e => setLine(l.key, { scrap_pct: e.target.value })} />
                </td>
                <td>
                  <button className="icon-btn" onClick={() => delLine(l.key)} title={t('common.delete')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-secondary btn-sm" onClick={addLine}>{t('manufacturing.addComponent')}</button>

        {mode === 'version' && (
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">{t('manufacturing.revisionNote')}</label>
            <input className="form-control" value={revNote} onChange={e => setRevNote(e.target.value)}
              placeholder={t('manufacturing.revisionNotePlaceholder')} />
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10 }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          {t('manufacturing.active')}
        </label>
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

// ════════════════════════════════════════════════════════════════════════════
// BOM DETAIL — cost tree + version history
// ════════════════════════════════════════════════════════════════════════════
function BomDetailModal({ bomId, canEdit, canDelete, onClose, onEdit, onNewVersion, onArchived }) {
  const { t } = useLocale();
  const [bom, setBom]   = useState(null);
  const [vers, setVers] = useState([]);
  const [error, setError] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getBom(bomId).then(setBom).catch(e => setError(e.message));
    getBomVersions(bomId).then(setVers).catch(() => {});
  }, [bomId]);
  useEffect(() => { load(); }, [load]);

  return (
    <Modal title={bom ? `${bom.name} · v${bom.version}` : t('manufacturing.tabBoms')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!bom && !error && <LoadingSpinner />}
        {bom && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
              {t('manufacturing.outputProduct')}: <strong>{bom.output_name}</strong>
              {' '}<TypeTag type={bom.output_product_type} />
              {' · '}{t('manufacturing.batchYield')}: <strong>{num(bom.output_quantity)}</strong>
              {!bom.is_active && <span className="badge badge-red" style={{ marginInlineStart: 8 }}>{t('manufacturing.inactive')}</span>}
            </div>

            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>{t('manufacturing.component')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.effectiveQty')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.unitCost')}</th>
                  <th style={{ textAlign: 'end' }}>{t('manufacturing.lineCost')}</th>
                </tr>
              </thead>
              <tbody>
                {bom.components.map(c => (
                  <tr key={c.id}>
                    <td>
                      {c.component_name}
                      {c.is_subassembly && (
                        <span className="badge badge-accent" style={{ marginInlineStart: 6, fontSize: 10 }}>
                          {t('manufacturing.subassembly')}
                        </span>
                      )}
                      {c.scrap_pct > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)', marginInlineStart: 6 }}>
                          +{num(c.scrap_pct)}% {t('manufacturing.scrap')}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'end' }}>{num(c.effective_quantity)}</td>
                    <td style={{ textAlign: 'end' }}><DualMoney value={c.unit_cost} block={false} /></td>
                    <td style={{ textAlign: 'end' }}><DualMoney value={c.line_cost} block={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span><DualMoney value={bom.material_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.laborCost')}</span><DualMoney value={bom.labor_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}</span><DualMoney value={bom.overhead_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.batchCost')}</span><DualMoney value={bom.batch_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                <span>{t('manufacturing.unitCost')}</span>
                <span><DualMoney value={bom.unit_cost} block={false} /> {t('manufacturing.perUnit')}</span>
              </div>
            </div>

            {vers.length > 1 && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.versionHistory')}</h4>
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>
                    {vers.map(v => (
                      <tr key={v.id}>
                        <td style={{ fontWeight: 600 }}>v{v.version}</td>
                        <td>{v.is_active ? <span className="badge badge-green">{t('manufacturing.current')}</span> : ''}</td>
                        <td style={{ color: 'var(--text-3)' }}>{v.revision_note || '—'}</td>
                        <td style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{(v.created_at || '').slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {bom && canDelete && (
          <button className="btn btn-secondary btn-danger" onClick={() => setConfirmArchive(true)}>
            {t('manufacturing.archive')}
          </button>
        )}
        {bom && canEdit && <button className="btn btn-secondary" onClick={() => onEdit(bom)}>{t('common.edit')}</button>}
        {bom && canEdit && (
          <button className="btn btn-primary" onClick={() => onNewVersion(bom)}>{t('manufacturing.newVersion')}</button>
        )}
      </div>
      {confirmArchive && bom && (
        <ConfirmModal title={t('manufacturing.archive')}
          message={t('manufacturing.archiveBomConfirm', { name: bom.name })}
          confirmLabel={t('manufacturing.archive')} confirmClass="btn-danger"
          onCancel={() => setConfirmArchive(false)}
          onConfirm={async () => {
            try { await archiveBom(bom.id); toast(t('manufacturing.archived'), 'green'); onArchived(); }
            catch (e) { toast(e.message, 'red'); }
            setConfirmArchive(false);
          }} />
      )}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ORDER CREATE MODAL
// ════════════════════════════════════════════════════════════════════════════
function OrderModal({ boms, initialBom, onClose, onCreated }) {
  const { t } = useLocale();
  const usable = boms.filter(b => b.is_active);
  const [bomId, setBomId]   = useState(initialBom || usable[0]?.id || '');
  const [qty, setQty]       = useState(1);
  const [labor, setLabor]   = useState('');
  const [overhead, setOverhead] = useState('');
  const [notes, setNotes]   = useState('');
  const [busy, setBusy]     = useState(false);
  const bom = usable.find(b => String(b.id) === String(bomId));

  async function create() {
    if (!bomId) { toast(t('manufacturing.selectBom'), 'red'); return; }
    if (!(Number(qty) > 0)) { toast(t('manufacturing.qtyPositive'), 'red'); return; }
    setBusy(true);
    try {
      await createProductionOrder({
        bom_id: Number(bomId), quantity: Number(qty),
        labor_cost: labor === '' ? null : Number(labor),
        overhead_cost: overhead === '' ? null : Number(overhead),
        notes: notes.trim() || null,
      });
      toast(t('manufacturing.orderCreated'), 'green');
      onCreated();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('manufacturing.newOrder')} onClose={onClose}>
      <div className="modal-body">
        <div className="form-group">
          <label className="form-label">{t('manufacturing.bom')}</label>
          <select className="form-control" value={bomId} onChange={e => setBomId(e.target.value)}>
            <option value="">{t('manufacturing.selectBom')}</option>
            {usable.map(b => <option key={b.id} value={b.id}>{b.name} → {b.output_name} (v{b.version})</option>)}
          </select>
        </div>
        {bom && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>
            {t('manufacturing.unitCost')}: <DualMoney value={bom.unit_cost} block={false} /> {t('manufacturing.perUnit')}
          </p>
        )}
        <div className="form-group">
          <label className="form-label">{t('manufacturing.quantityToProduce')}</label>
          <input className="form-control" type="number" step="any" min="0.0001" value={qty}
            onChange={e => setQty(e.target.value)} autoFocus />
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('manufacturing.laborCostOverride')}</label>
            <CostInput valueUsd={labor === '' ? null : labor} onChange={v => setLabor(v)}
              placeholder={t('manufacturing.autoFromBom')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.overheadCostOverride')}</label>
            <CostInput valueUsd={overhead === '' ? null : overhead} onChange={v => setOverhead(v)}
              placeholder={t('manufacturing.autoFromBom')} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">{t('manufacturing.notes')}</label>
          <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !bomId} onClick={create}>
          {busy ? t('common.saving') : t('manufacturing.createOrder')}
        </button>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// COMPLETE MODAL — actual consumption, scrap and produced quantity
// ════════════════════════════════════════════════════════════════════════════
function CompleteModal({ order, onClose, onDone }) {
  const { t } = useLocale();
  const [produced, setProduced] = useState(order.quantity);
  const [labor, setLabor]       = useState(order.labor_cost ?? 0);
  const [overhead, setOverhead] = useState(order.overhead_cost ?? 0);
  const [rows, setRows] = useState(
    order.items.map(it => ({
      id: it.id, name: it.name, required: it.quantity_required,
      consumed: it.quantity_required, scrapped: 0,
    })),
  );
  const [busy, setBusy] = useState(false);

  const setRow = (id, patch) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));

  async function submit() {
    if (!(Number(produced) > 0)) { toast(t('manufacturing.qtyPositive'), 'red'); return; }
    setBusy(true);
    try {
      await completeProductionOrder(order.id, {
        quantity_produced: Number(produced),
        labor_cost: Number(labor) || 0,
        overhead_cost: Number(overhead) || 0,
        items: rows.map(r => ({
          id: r.id,
          quantity_consumed: Number(r.consumed) || 0,
          quantity_scrapped: Number(r.scrapped) || 0,
        })),
      });
      toast(t('manufacturing.orderCompleted'), 'green');
      onDone();
    } catch (e) { toast(e.message, 'red'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('manufacturing.completeTitle')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 0 }}>
          {t('manufacturing.completeHint')}
        </p>
        <table className="table" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>{t('manufacturing.component')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.planned')}</th>
              <th style={{ width: 120 }}>{t('manufacturing.consumed')}</th>
              <th style={{ width: 120 }}>{t('manufacturing.scrapped')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(r.required)}</td>
                <td>
                  <input className="form-control" style={{ height: 32 }} type="number" step="any" min="0"
                    value={r.consumed} onChange={e => setRow(r.id, { consumed: e.target.value })} />
                </td>
                <td>
                  <input className="form-control" style={{ height: 32 }} type="number" step="any" min="0"
                    value={r.scrapped} onChange={e => setRow(r.id, { scrapped: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.quantityProduced')}</label>
            <input className="form-control" type="number" step="any" min="0.0001" value={produced}
              onChange={e => setProduced(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.laborCost')}</label>
            <CostInput valueUsd={labor} onChange={setLabor} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.overheadCost')}</label>
            <CostInput valueUsd={overhead} onChange={setOverhead} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? t('common.saving') : t('manufacturing.complete')}
        </button>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ORDER DETAIL MODAL — lifecycle, material status, cost, variance
// ════════════════════════════════════════════════════════════════════════════
function OrderDetailModal({ orderId, canEdit, canDelete, onClose, onChanged }) {
  const { t, fmtDate } = useLocale();
  const [order, setOrder]   = useState(null);
  const [error, setError]   = useState(null);
  const [confirm, setConfirm] = useState(null);   // 'cancel' | null
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy]     = useState(false);

  const load = useCallback(() => {
    setError(null);
    getProductionOrder(orderId).then(setOrder).catch(e => setError(e.message));
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  async function act(fn, okMsg) {
    setBusy(true);
    try { await fn(); toast(okMsg, 'green'); setConfirm(null); load(); onChanged(); }
    catch (e) { toast(e.message, 'red'); setConfirm(null); }
    finally { setBusy(false); }
  }

  const status = order?.status;
  const isCompleted = status === 'Completed';

  return (
    <Modal title={order ? order.order_number : t('manufacturing.title')} onClose={onClose} size="modal-lg">
      <div className="modal-body">
        {error && <ErrorAlert message={error} onRetry={load} />}
        {!order && !error && <LoadingSpinner />}
        {order && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
              <StatusPill status={order.status} />
              <span>{order.output_name} <TypeTag type={order.output_product_type} /></span>
              <span style={{ color: 'var(--text-3)' }}>· {t('manufacturing.bomVersion', { v: order.bom_version || 1 })}</span>
              <span style={{ color: 'var(--text-3)' }}>· {fmtDate(order.created_at)}</span>
            </div>

            {order.notes && (
              <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>{order.notes}</p>
            )}

            {!isCompleted && status !== 'Cancelled' && (
              <div className={`alert alert-${order.can_build ? 'green' : 'red'}`} style={{ marginBottom: 10 }}>
                {order.can_build ? t('manufacturing.canBuild') : t('manufacturing.cannotBuild')}
              </div>
            )}

            <h4 style={{ margin: '4px 0 6px', fontSize: 14 }}>
              {isCompleted ? t('manufacturing.materialsUsed') : t('manufacturing.materialsPlan')}
            </h4>
            <div className="table-wrap">
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>{t('manufacturing.component')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.planned')}</th>
                    {!isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.onHand')}</th>}
                    {!isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.reserved')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.consumed')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.variance')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.scrapped')}</th>}
                    {isCompleted && <th style={{ textAlign: 'end' }}>{t('manufacturing.lineCost')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {order.items.map(it => (
                    <tr key={it.id}>
                      <td>
                        {it.name}
                        {it.scrap_pct > 0 && (
                          <span style={{ fontSize: 11, color: 'var(--text-3)', marginInlineStart: 6 }}>
                            +{num(it.scrap_pct)}% {t('manufacturing.scrap')}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'end' }}>{num(it.quantity_required)}</td>
                      {!isCompleted && (
                        <td style={{ textAlign: 'end', color: it.short ? 'var(--red)' : undefined }}>
                          {it.on_hand == null ? '—' : num(it.on_hand)}
                          {it.short && <span className="badge badge-red" style={{ marginInlineStart: 6 }}>{t('manufacturing.shortBadge')}</span>}
                        </td>
                      )}
                      {!isCompleted && <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(it.reserved)}</td>}
                      {isCompleted && <td style={{ textAlign: 'end' }}>{num(it.quantity_consumed)}</td>}
                      {isCompleted && (
                        <td style={{ textAlign: 'end',
                          color: it.variance > 0 ? 'var(--red)' : it.variance < 0 ? 'var(--green)' : 'var(--text-3)' }}>
                          {it.variance == null ? '—' : (it.variance > 0 ? '+' : '') + num(it.variance)}
                        </td>
                      )}
                      {isCompleted && <td style={{ textAlign: 'end', color: 'var(--text-3)' }}>{num(it.quantity_scrapped)}</td>}
                      {isCompleted && <td style={{ textAlign: 'end' }}><DualMoney value={it.line_cost} block={false} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span>
                <DualMoney value={order.materials_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.laborCost')}</span><DualMoney value={order.labor_cost} block={false} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}</span><DualMoney value={order.overhead_cost} block={false} />
              </div>
              {isCompleted && order.scrap_cost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--red)' }}>
                  <span>{t('manufacturing.scrapCost')}</span><DualMoney value={order.scrap_cost} block={false} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.totalCost')}</span><DualMoney value={order.total_cost} block={false} />
              </div>
              {isCompleted && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                    <span>{t('manufacturing.unitCost')}</span>
                    <span><DualMoney value={order.unit_cost} block={false} /> {t('manufacturing.perUnit')}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                    <span>{t('manufacturing.outputPlannedVsActual')}</span>
                    <span>{num(order.quantity)} → {num(order.quantity_produced)}
                      {order.output_variance != null && order.output_variance !== 0 && (
                        <span style={{ color: order.output_variance < 0 ? 'var(--red)' : 'var(--green)', marginInlineStart: 4 }}>
                          ({order.output_variance > 0 ? '+' : ''}{num(order.output_variance)})
                        </span>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>

            {order.movements && order.movements.length > 0 && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.stockMovements')}</h4>
                <table className="table" style={{ fontSize: 12 }}>
                  <tbody>
                    {order.movements.map(m => (
                      <tr key={m.id}>
                        <td>{m.item_name}</td>
                        <td style={{ color: 'var(--text-3)' }}>{m.note}</td>
                        <td style={{ textAlign: 'end', fontWeight: 600,
                          color: m.delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {m.delta >= 0 ? '+' : ''}{num(m.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {order.cancel_reason && status === 'Cancelled' && (
              <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>
                {t('manufacturing.cancelledReason', { reason: order.cancel_reason })}
              </p>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {order && canEdit && status === 'Draft' && (
          <button className="btn btn-primary" disabled={busy}
            onClick={() => act(() => confirmProductionOrder(order.id), t('manufacturing.orderConfirmed'))}>
            {t('manufacturing.confirm')}
          </button>
        )}
        {order && canEdit && status === 'Confirmed' && (
          <button className="btn btn-primary" disabled={busy}
            onClick={() => act(() => startProductionOrder(order.id), t('manufacturing.orderStarted'))}>
            {t('manufacturing.start')}
          </button>
        )}
        {order && canEdit && status === 'In Progress' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setCompleting(true)}>
            {t('manufacturing.complete')}
          </button>
        )}
        {order && canEdit && ['Draft', 'Confirmed', 'In Progress'].includes(status) && (
          <button className="btn btn-secondary btn-danger" disabled={busy} onClick={() => setConfirm('cancel')}>
            {t('manufacturing.cancel')}
          </button>
        )}
        {order && canDelete && (status === 'Completed' || status === 'Cancelled') && (
          <button className="btn btn-secondary" disabled={busy}
            onClick={() => act(() => archiveProductionOrder(order.id), t('manufacturing.archived'))}>
            {t('manufacturing.archive')}
          </button>
        )}
      </div>
      {completing && order && (
        <CompleteModal order={order} onClose={() => setCompleting(false)}
          onDone={() => { setCompleting(false); load(); onChanged(); }} />
      )}
      {confirm === 'cancel' && (
        <ConfirmModal title={t('manufacturing.cancel')} message={t('manufacturing.cancelConfirm')}
          confirmLabel={t('manufacturing.cancel')} confirmClass="btn-danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => act(() => cancelProductionOrder(order.id, null), t('manufacturing.orderCancelled'))} />
      )}
    </Modal>
  );
}

// ── Orders view ─────────────────────────────────────────────────────────────
function OrdersView({ canCreate, canEdit, canDelete, boms, refreshKey, bump }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows]   = useState(null);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getProductionOrders(statusFilter ? { status: statusFilter } : {})
      .then(setRows).catch(e => setError(e.message));
  }, [statusFilter]);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {canCreate && (
          <button className="btn btn-primary btn-sm" disabled={boms.filter(b => b.is_active).length === 0}
            onClick={() => setCreating(true)}>{t('manufacturing.newOrder')}</button>
        )}
        <select className="form-control" style={{ width: 170, height: 32, fontSize: 13 }}
          value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">{t('manufacturing.allStatuses')}</option>
          {['Draft', 'Confirmed', 'In Progress', 'Completed', 'Cancelled'].map(s => (
            <option key={s} value={s}>{t(`manufacturing.st_${s.replace(/ /g, '')}`)}</option>
          ))}
        </select>
      </div>
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('manufacturing.noOrders')} icon="🏭" />}
      {rows && rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('manufacturing.orderNumber')}</th>
                  <th>{t('manufacturing.product')}</th>
                  <th>{t('manufacturing.qty')}</th>
                  <th>{t('manufacturing.status')}</th>
                  <th>{t('manufacturing.totalCost')}</th>
                  <th>{t('common.date')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(o => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.order_number}</td>
                    <td>{o.output_name}</td>
                    <td>{num(o.quantity_produced ?? o.quantity)}</td>
                    <td><StatusPill status={o.status} /></td>
                    <td>{o.status === 'Completed' ? <DualMoney value={o.total_cost} block={false} /> : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(o.created_at)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDetailId(o.id)}>
                        {t('manufacturing.viewOrder')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {creating && (
        <OrderModal boms={boms} onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); bump(); }} />
      )}
      {detailId && (
        <OrderDetailModal orderId={detailId} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)} onChanged={() => { load(); bump(); }} />
      )}
    </div>
  );
}

// ── BOMs view ───────────────────────────────────────────────────────────────
function BomsView({ canCreate, canEdit, canDelete, products, refreshKey, bump }) {
  const { t } = useLocale();
  const [rows, setRows]   = useState(null);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);   // {mode, bom} | null
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getBoms().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div>
      {canCreate && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ mode: 'create' })}>
            {t('manufacturing.newBom')}
          </button>
        </div>
      )}
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('manufacturing.noBoms')} icon="📋" />}
      {rows && rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('manufacturing.bomName')}</th>
                  <th>{t('manufacturing.outputProduct')}</th>
                  <th>{t('manufacturing.version')}</th>
                  <th>{t('manufacturing.components')}</th>
                  <th>{t('manufacturing.batchCost')}</th>
                  <th>{t('manufacturing.unitCost')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(b => (
                  <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(b.id)}>
                    <td><strong>{b.name}</strong>{!b.is_active &&
                      <span className="badge badge-red" style={{ marginInlineStart: 6 }}>{t('manufacturing.inactive')}</span>}</td>
                    <td>{b.output_name} <TypeTag type={b.output_product_type} /></td>
                    <td>v{b.version}</td>
                    <td>{b.component_count}</td>
                    <td><DualMoney value={b.batch_cost} block={false} /></td>
                    <td><DualMoney value={b.unit_cost} block={false} /></td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDetailId(b.id)}>
                        {t('common.view')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {modal && (
        <BomModal mode={modal.mode} bom={modal.bom} products={products}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); bump(); }} />
      )}
      {detailId && (
        <BomDetailModal bomId={detailId} canEdit={canEdit} canDelete={canDelete}
          onClose={() => setDetailId(null)}
          onEdit={(bom) => { setDetailId(null); setModal({ mode: 'edit', bom }); }}
          onNewVersion={(bom) => { setDetailId(null); setModal({ mode: 'version', bom }); }}
          onArchived={() => { setDetailId(null); load(); bump(); }} />
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function Manufacturing() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('orders');
  const [products, setProducts] = useState([]);
  const [boms, setBoms] = useState([]);
  const [summary, setSummary] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const canView   = can('manufacturing', 'view');
  const canCreate = can('manufacturing', 'create');
  const canEdit   = can('manufacturing', 'edit');
  const canDelete = can('manufacturing', 'delete');

  const reloadRefs = useCallback(() => {
    getManufacturingProducts().then(setProducts).catch(() => {});
    getBoms().then(setBoms).catch(() => {});
    getManufacturingSummary().then(setSummary).catch(() => {});
  }, []);
  useEffect(() => { reloadRefs(); }, [reloadRefs]);

  const bump = () => { setRefreshKey(k => k + 1); reloadRefs(); };

  const tabs = [
    { key: 'orders', label: t('manufacturing.tabOrders') },
    { key: 'boms',   label: t('manufacturing.tabBoms') },
  ];

  if (!canView) return <EmptyState message={t('manufacturing.subtitle')} icon="🔒" />;

  const kpis = summary ? [
    { label: t('manufacturing.kpiBoms'),       value: summary.boms },
    { label: t('manufacturing.st_Draft'),      value: summary.draft },
    { label: t('manufacturing.st_Confirmed'),  value: summary.confirmed },
    { label: t('manufacturing.st_InProgress'), value: summary.in_progress },
    { label: t('manufacturing.kpiReserved'),   value: summary.reserved_value, money: true },
    { label: t('manufacturing.kpiCompletedValue'), value: summary.completed_value, money: true },
  ] : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{t('manufacturing.title')}</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map(tb => (
            <button key={tb.key}
              className={`btn btn-sm ${view === tb.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView(tb.key)}>
              {tb.label}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '0 0 16px' }}>{t('manufacturing.subtitle')}</p>

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 10, marginBottom: 18 }}>
          {kpis.map(k => (
            <div key={k.label} className="stat-card" style={{ padding: '12px 14px' }}>
              <div className="stat-label" style={{ fontSize: 11 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                {k.money ? <DualMoney value={k.value} block={false} /> : k.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'orders' && (
        <OrdersView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          boms={boms} refreshKey={refreshKey} bump={bump} />
      )}
      {view === 'boms' && (
        <BomsView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete}
          products={products} refreshKey={refreshKey} bump={bump} />
      )}
    </div>
  );
}
