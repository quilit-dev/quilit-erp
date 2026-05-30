import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useSettings } from '../hooks/useSettings.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  DisplayCurrencyToggle, ExportButton, fmt, secondaryAmount, toast,
} from '../components/shared';
import {
  getBoms, getBom, getBomVersions, createBom, updateBom, createBomVersion, archiveBom,
  getProductionOrders, getProductionOrder, createProductionOrder, updateProductionOrder,
  confirmProductionOrder, startProductionOrder, completeProductionOrder,
  cancelProductionOrder, archiveProductionOrder, getManufacturingProducts,
  getManufacturingSummary,
  getResources, createResource, updateResource, archiveResource,
  getQCInspections, getQCInspection, resolveQC, getManufacturingAnalytics,
} from '../api/client';

const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(v) || 0);

// Single-currency money display — shows USD or LBP based on the page-header
// DisplayCurrencyToggle. Replaces DualMoney here so the user sees one figure
// at a time instead of "USD ≈ LBP" stacked together.
function Money({ value }) {
  const { exchangeRate, displayCurrency } = useSettings();
  if (displayCurrency === 'LBP' && exchangeRate?.rate) {
    return <span>{secondaryAmount(value, exchangeRate)}</span>;
  }
  return <span>{fmt(value)}</span>;
}

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
  const [qcReq, setQcReq]       = useState(bom ? !!bom.qc_required : false);
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
  const [stdHours, setStdHours] = useState(bom?.standard_hours ?? 0);
  const [resourceList, setResourceList] = useState([]);   // master list
  useEffect(() => { getResources({ active: true }).then(setResourceList).catch(() => {}); }, []);
  const [res, setRes] = useState(
    (bom?.resources || []).map(r => ({
      key: ++keyRef.current, resource_id: r.resource_id || '',
      name: r.name || '', hourly_rate: r.hourly_rate ?? 0,
    })),
  );

  const outputs    = products.filter(p => !p.product_type || OUTPUT_TYPES.includes(p.product_type));
  const addLine    = () => setLines(ls => [...ls, { key: ++keyRef.current, component_inventory_id: '', quantity: 1, scrap_pct: 0 }]);
  const setLine    = (key, patch) => setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const delLine    = (key) => setLines(ls => ls.filter(l => l.key !== key));
  const addRes     = () => setRes(rs => [...rs, { key: ++keyRef.current, resource_id: '', name: '', hourly_rate: 0 }]);
  const setResRow  = (key, patch) => setRes(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));
  const delRes     = (key) => setRes(rs => rs.filter(r => r.key !== key));
  // Picking a master resource snaps in its name + rate (still editable inline).
  const pickResource = (key, idStr) => {
    const m = resourceList.find(x => String(x.id) === String(idStr));
    setResRow(key, m ? { resource_id: m.id, name: m.name, hourly_rate: m.hourly_rate }
                     : { resource_id: '' });
  };
  const rateSum = res.reduce((s, r) => s + (Number(r.hourly_rate) || 0), 0);

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
        is_active: active, qc_required: qcReq, components: comps, revision_note: revNote.trim() || null,
        standard_hours: Number(stdHours) || 0,
        resources: res
          .filter(r => r.resource_id || (r.name || '').trim())
          .map(r => ({
            resource_id: r.resource_id ? Number(r.resource_id) : null,
            name: (r.name || '').trim() || null,
            hourly_rate: r.hourly_rate === '' || r.hourly_rate == null ? null : Number(r.hourly_rate),
          })),
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
            <input className="form-control" type="number" step="1" min="1" value={yieldQty}
              onChange={e => setYieldQty(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.standardHours')}
              <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
                {t('manufacturing.standardHoursHint')}</span>
            </label>
            <input className="form-control" type="number" step="any" min="0" value={stdHours}
              onChange={e => setStdHours(e.target.value)} placeholder="0" />
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
                  <input className="form-control" style={{ height: 32 }} type="number" step="1" min="1"
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

        <h4 style={{ margin: '18px 0 4px', fontSize: 14 }}>{t('manufacturing.resources')}</h4>
        <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '0 0 6px' }}>{t('manufacturing.resourcesHint')}</p>
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr>
            <th style={{ width: 200 }}>{t('manufacturing.resourceFromList')}</th>
            <th>{t('manufacturing.resourceName')}</th>
            <th style={{ width: 120 }}>{t('manufacturing.hourlyRate')}</th>
            <th style={{ width: 32 }}></th>
          </tr></thead>
          <tbody>
            {res.map(r => (
              <tr key={r.key}>
                <td><select className="form-control" style={{ height: 32 }} value={r.resource_id}
                  onChange={e => pickResource(r.key, e.target.value)}>
                  <option value="">{t('manufacturing.inlineResource')}</option>
                  {resourceList.map(m => <option key={m.id} value={m.id}>{m.name} (${m.hourly_rate}/h)</option>)}
                </select></td>
                <td><input className="form-control" style={{ height: 32 }} value={r.name}
                  onChange={e => setResRow(r.key, { name: e.target.value, resource_id: '' })}
                  placeholder={t('manufacturing.resourceName')} /></td>
                <td><input className="form-control" style={{ height: 32 }} type="number" min="0" step="any"
                  value={r.hourly_rate} onChange={e => setResRow(r.key, { hourly_rate: e.target.value })} /></td>
                <td><button className="icon-btn" onClick={() => delRes(r.key)} title={t('common.delete')}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-secondary btn-sm" onClick={addRes}>{t('manufacturing.addResource')}</button>
        {res.length > 0 ? (
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '6px 0 0' }}>
            {t('manufacturing.resourceFormula', { sum: rateSum.toFixed(2) })}
          </p>
        ) : (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="form-group">
              <label className="form-label">{t('manufacturing.laborCost')} <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 11 }}>{t('manufacturing.flatFallback')}</span></label>
              <CostInput valueUsd={labor} onChange={setLabor} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('manufacturing.overheadCost')} <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 11 }}>{t('manufacturing.flatFallback')}</span></label>
              <CostInput valueUsd={overhead} onChange={setOverhead} />
            </div>
          </div>
        )}

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
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={qcReq} onChange={e => setQcReq(e.target.checked)} />
          {t('manufacturing.qcRequired')}
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('manufacturing.qcRequiredHint')}</span>
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
                    <td style={{ textAlign: 'end' }}><Money value={c.unit_cost} /></td>
                    <td style={{ textAlign: 'end' }}><Money value={c.line_cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {bom.resources && bom.resources.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12.5 }}>
                <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>
                  {t('manufacturing.resources')} · {t('manufacturing.standardHours')}: {num(bom.standard_hours)}
                </div>
                {bom.resources.map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{r.name}</span><span><Money value={r.hourly_rate} />/h</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span><Money value={bom.material_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}</span><Money value={bom.conversion_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.batchCost')}</span><Money value={bom.batch_cost} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                <span>{t('manufacturing.unitCost')}</span>
                <span><Money value={bom.unit_cost} /> {t('manufacturing.perUnit')}</span>
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
  const [priority, setPriority] = useState('Normal');
  const [dueDate, setDueDate]   = useState('');
  const [startDate, setStartDate] = useState('');
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
        priority, due_date: dueDate || null, planned_start_date: startDate || null,
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
            {t('manufacturing.unitCost')}: <Money value={bom.unit_cost} /> {t('manufacturing.perUnit')}
          </p>
        )}
        <div className="form-group">
          <label className="form-label">{t('manufacturing.quantityToProduce')}</label>
          <input className="form-control" type="number" step="1" min="1" value={qty}
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
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('manufacturing.priority')}</label>
            <select className="form-control" value={priority} onChange={e => setPriority(e.target.value)}>
              {['Low', 'Normal', 'High', 'Urgent'].map(p =>
                <option key={p} value={p}>{t(`manufacturing.prio_${p}`)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.dueDate')}</label>
            <input className="form-control" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.plannedStart')}</label>
            <input className="form-control" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
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
  const remaining = order.remaining != null ? order.remaining : order.quantity;
  const usesResources = (order.resources || []).length > 0;
  const [partial, setPartial]   = useState(false);
  const [produced, setProduced] = useState(remaining);
  const [hours, setHours]       = useState('');
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
        production_hours: hours === '' ? undefined : Number(hours),
        labor_cost: Number(labor) || 0,
        overhead_cost: Number(overhead) || 0,
        close: !partial,
        items: rows.map(r => ({
          id: r.id,
          quantity_consumed: Number(r.consumed) || 0,
          quantity_scrapped: Number(r.scrapped) || 0,
        })),
      });
      toast(partial ? t('manufacturing.partialRecorded') : t('manufacturing.orderCompleted'), 'green');
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
                  <input className="form-control" style={{ height: 32 }} type="number" step="1" min="0"
                    value={r.consumed} onChange={e => setRow(r.id, { consumed: e.target.value })} />
                </td>
                <td>
                  <input className="form-control" style={{ height: 32 }} type="number" step="1" min="0"
                    value={r.scrapped} onChange={e => setRow(r.id, { scrapped: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.quantityProduced')}</label>
            <input className="form-control" type="number" step="1" min="1" value={produced}
              onChange={e => setProduced(e.target.value)} />
          </div>
          {usesResources ? (
            <div className="form-group">
              <label className="form-label">{t('manufacturing.productionHours')}
                <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
                  {t('manufacturing.productionHoursHint')}</span>
              </label>
              <input className="form-control" type="number" step="any" min="0" value={hours}
                onChange={e => setHours(e.target.value)} placeholder={t('manufacturing.standardIfBlank')} />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.laborCost')}</label>
                <CostInput valueUsd={labor} onChange={setLabor} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.overheadCost')}</label>
                <CostInput valueUsd={overhead} onChange={setOverhead} />
              </div>
            </>
          )}
        </div>
        {usesResources && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
            {t('manufacturing.resourcesOnOrder')}: {order.resources.map(r => `${r.name} ($${r.hourly_rate}/h)`).join(' · ')}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
          <input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />
          {t('manufacturing.partialRun')}
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('manufacturing.partialRunHint')}</span>
        </label>
        {order.quantity_completed > 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '6px 0 0' }}>
            {t('manufacturing.alreadyProduced', { done: num(order.quantity_completed), planned: num(order.quantity) })}
          </p>
        )}
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
                      {isCompleted && <td style={{ textAlign: 'end' }}><Money value={it.line_cost} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('manufacturing.materialsCost')}</span>
                <Money value={order.materials_cost} />
              </div>
              {/* Per-resource overhead breakdown (with frozen hours) when present. */}
              {(order.resources || []).filter(r => r.cost > 0).map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                  <span>{r.name}{r.hours ? ` · ${num(r.hours)}h` : ''}</span><Money value={r.cost} />
                </div>
              ))}
              {order.labor_cost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                  <span>{t('manufacturing.laborCost')}</span><Money value={order.labor_cost} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('manufacturing.overheadCost')}{order.production_hours ? ` · ${num(order.production_hours)}h` : ''}</span>
                <Money value={order.overhead_cost} />
              </div>
              {isCompleted && order.scrap_cost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--red)' }}>
                  <span>{t('manufacturing.scrapCost')}</span><Money value={order.scrap_cost} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 2 }}>
                <span>{t('manufacturing.totalCost')}</span><Money value={order.total_cost} />
              </div>
              {isCompleted && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                    <span>{t('manufacturing.unitCost')}</span>
                    <span><Money value={order.unit_cost} /> {t('manufacturing.perUnit')}</span>
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

            {((order.produced_lots && order.produced_lots.length > 0) ||
              (order.consumed_lots && order.consumed_lots.length > 0)) && (
              <>
                <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>{t('manufacturing.lots')}</h4>
                {order.produced_lots && order.produced_lots.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>{t('manufacturing.producedLots')}</div>
                    {order.produced_lots.map(l => (
                      <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                        <span className="text-mono">{l.lot_number}</span>
                        <span style={{ color: 'var(--text-2)' }}>
                          {num(l.original_quantity)}{l.expiry_date ? ` · ${t('manufacturing.exp')} ${l.expiry_date}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {order.consumed_lots && order.consumed_lots.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>{t('manufacturing.consumedLots')}</div>
                    <table className="table" style={{ fontSize: 12 }}><tbody>
                      {order.consumed_lots.map((l, i) => (
                        <tr key={i}>
                          <td>{l.item_name}</td>
                          <td className="text-mono">{l.lot_number}</td>
                          <td style={{ textAlign: 'end' }}>{num(l.quantity)}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                )}
              </>
            )}

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
  const [schedule, setSchedule] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(() => {
    setError(null);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    if (schedule) params.sort = 'schedule';
    getProductionOrders(params).then(setRows).catch(e => setError(e.message));
  }, [statusFilter, schedule]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const exportData = (rows || []).map(o => ({
    Order:      o.order_number,
    Product:    o.output_name,
    Quantity:   o.quantity_produced ?? o.quantity,
    Status:     o.status,
    Total_Cost: o.status === 'Completed' ? (o.total_cost || 0) : '',
    Created:    fmtDate(o.created_at),
  }));

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
        <button className={`btn btn-sm ${schedule ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSchedule(s => !s)} title={t('manufacturing.scheduleHint')}>
          🗓 {t('manufacturing.scheduleView')}
        </button>
        {rows && rows.length > 0 && (
          <div style={{ marginInlineStart: 'auto' }}>
            <ExportButton data={exportData} filename="Production_Orders" sheetName="Orders" />
          </div>
        )}
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
                  <th>{t('manufacturing.priority')}</th>
                  <th>{t('manufacturing.dueDate')}</th>
                  <th>{t('manufacturing.status')}</th>
                  <th>{t('manufacturing.totalCost')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(o => {
                  const open = !['Completed', 'Cancelled'].includes(o.status);
                  const overdue = o.due_date && o.due_date < today && open;
                  const prioCls = { Urgent: 'badge-red', High: 'badge-yellow', Low: 'badge-muted' }[o.priority] || 'badge-accent';
                  return (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.order_number}</td>
                    <td>{o.output_name}</td>
                    <td>{num(o.quantity_produced ?? o.quantity)}
                      {o.quantity_completed > 0 && o.quantity_completed < o.quantity && open && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}> ({num(o.quantity_completed)}/{num(o.quantity)})</span>
                      )}
                    </td>
                    <td>{o.priority && o.priority !== 'Normal'
                      ? <span className={`badge ${prioCls}`}>{t(`manufacturing.prio_${o.priority}`)}</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap', color: overdue ? 'var(--red)' : undefined, fontWeight: overdue ? 600 : undefined }}>
                      {o.due_date || '—'}{overdue ? ` ⚠` : ''}
                    </td>
                    <td><StatusPill status={o.status} /></td>
                    <td>{o.status === 'Completed' ? <Money value={o.total_cost} /> : '—'}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDetailId(o.id)}>
                        {t('manufacturing.viewOrder')}
                      </button>
                    </td>
                  </tr>
                  );
                })}
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
                    <td><Money value={b.batch_cost} /></td>
                    <td><Money value={b.unit_cost} /></td>
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
    { key: 'qc',     label: t('manufacturing.tabQC') },
    { key: 'resources', label: t('manufacturing.tabResources') },
    { key: 'analytics', label: t('manufacturing.tabAnalytics') },
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <DisplayCurrencyToggle />
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
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '0 0 16px' }}>{t('manufacturing.subtitle')}</p>

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 10, marginBottom: 18 }}>
          {kpis.map(k => (
            <div key={k.label} className="stat-card" style={{ padding: '12px 14px' }}>
              <div className="stat-label" style={{ fontSize: 11 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                {k.money ? <Money value={k.value} /> : k.value}
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
      {view === 'qc' && (
        <QCView canEdit={canEdit} bump={bump} />
      )}
      {view === 'resources' && (
        <ResourcesView canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />
      )}
      {view === 'analytics' && <AnalyticsView />}
    </div>
  );
}

// ── Manufacturing analytics view ─────────────────────────────────────────────
function AnalyticsView() {
  const { t } = useLocale();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getManufacturingAnalytics({ start, end })
      .then(setData).catch(e => toast(e.message, 'red')).finally(() => setLoading(false));
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const Kpi = ({ label, children }) => (
    <div className="stat-card" style={{ padding: '12px 14px' }}>
      <div className="stat-label" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{children}</div>
    </div>
  );
  const Row = ({ label, children, strong }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  fontWeight: strong ? 700 : 400, padding: '2px 0' }}>
      <span style={{ color: strong ? undefined : 'var(--text-2)' }}>{label}</span><span>{children}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('manufacturing.dateRange')}:</span>
        <input type="date" className="form-control" style={{ width: 150, height: 32 }} value={start} onChange={e => setStart(e.target.value)} />
        <span>–</span>
        <input type="date" className="form-control" style={{ width: 150, height: 32 }} value={end} onChange={e => setEnd(e.target.value)} />
      </div>

      {loading || !data ? <LoadingSpinner /> : data.summary.orders === 0 ? (
        <EmptyState message={t('manufacturing.noAnalytics')} icon="📊" />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 18 }}>
            <Kpi label={t('manufacturing.ordersCompleted')}>{data.summary.orders}</Kpi>
            <Kpi label={t('manufacturing.unitsProduced')}>{num(data.summary.units)}</Kpi>
            <Kpi label={t('manufacturing.totalCost')}><Money value={data.summary.total_cost} /></Kpi>
            <Kpi label={t('manufacturing.avgUnitCost')}><Money value={data.summary.avg_unit_cost} /></Kpi>
            <Kpi label={t('manufacturing.efficiency')}>{data.time_efficiency.efficiency_pct != null ? `${data.time_efficiency.efficiency_pct}%` : '—'}</Kpi>
            <Kpi label={t('manufacturing.onTimePct')}>{data.on_time.on_time_pct != null ? `${data.on_time.on_time_pct}%` : '—'}</Kpi>
            <Kpi label={t('manufacturing.qcPassRate')}>{data.qc.pass_rate != null ? `${data.qc.pass_rate}%` : '—'}</Kpi>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.costBreakdown')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.materialsCost')}><Money value={data.summary.materials} /></Row>
                {data.summary.labor > 0 && <Row label={t('manufacturing.laborCost')}><Money value={data.summary.labor} /></Row>}
                <Row label={t('manufacturing.overheadCost')}><Money value={data.summary.overhead} /></Row>
                {data.summary.scrap > 0 && <Row label={t('manufacturing.scrapCost')}><Money value={data.summary.scrap} /></Row>}
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                  <Row label={t('manufacturing.totalCost')} strong><Money value={data.summary.total_cost} /></Row>
                </div>
              </div>
            </div>

            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.costVariance')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.standardCost')}><Money value={data.cost_variance.standard} /></Row>
                <Row label={t('manufacturing.actualCost')}><Money value={data.cost_variance.actual} /></Row>
                <Row label={t('manufacturing.variance')} strong>
                  <span style={{ color: data.cost_variance.variance > 0 ? 'var(--red)' : 'var(--green)' }}>
                    <Money value={data.cost_variance.variance} />
                    {data.cost_variance.variance_pct != null ? ` (${data.cost_variance.variance_pct}%)` : ''}
                  </span>
                </Row>
              </div>
            </div>

            <div className="card"><div className="card-header"><span className="card-title">{t('manufacturing.timeEfficiency')}</span></div>
              <div style={{ padding: '10px 16px' }}>
                <Row label={t('manufacturing.plannedHours')}>{num(data.time_efficiency.planned_hours)}</Row>
                <Row label={t('manufacturing.actualHours')}>{num(data.time_efficiency.actual_hours)}</Row>
                <Row label={t('manufacturing.efficiency')} strong>{data.time_efficiency.efficiency_pct != null ? `${data.time_efficiency.efficiency_pct}%` : '—'}</Row>
              </div>
            </div>
          </div>

          {data.cost_variance.top.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header"><span className="card-title">{t('manufacturing.topVariance')}</span></div>
              <div className="table-wrap">
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr>
                    <th>{t('manufacturing.orderNumber')}</th><th>{t('manufacturing.product')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.standardCost')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.actualCost')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.variance')}</th>
                  </tr></thead>
                  <tbody>
                    {data.cost_variance.top.map(v => (
                      <tr key={v.order_number}>
                        <td className="text-mono">{v.order_number}</td>
                        <td>{v.product}</td>
                        <td style={{ textAlign: 'end' }}><Money value={v.standard_cost} /></td>
                        <td style={{ textAlign: 'end' }}><Money value={v.actual_cost} /></td>
                        <td style={{ textAlign: 'end', color: v.variance > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                          <Money value={v.variance} />{v.variance_pct != null ? ` (${v.variance_pct}%)` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.time_efficiency.by_resource.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header"><span className="card-title">{t('manufacturing.resourceCostBreakdown')}</span></div>
              <div className="table-wrap">
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr>
                    <th>{t('manufacturing.resourceName')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.hours')}</th>
                    <th style={{ textAlign: 'end' }}>{t('manufacturing.cost')}</th>
                  </tr></thead>
                  <tbody>
                    {data.time_efficiency.by_resource.map((r, i) => (
                      <tr key={i}>
                        <td>{r.resource}</td>
                        <td style={{ textAlign: 'end' }}>{num(r.hours)}</td>
                        <td style={{ textAlign: 'end' }}><Money value={r.cost} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Quality Control view ─────────────────────────────────────────────────────
function QCView({ canEdit, bump }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('Pending');
  const [resolveId, setResolveId] = useState(null);

  const load = useCallback(() => {
    getQCInspections(filter ? { status: filter } : {}).then(setRows).catch(e => toast(e.message, 'red'));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const STATUSES = ['Pending', 'Passed', 'Partial', 'Failed', ''];
  if (!rows) return <LoadingSpinner />;
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="card-title">{t('manufacturing.tabQC')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {STATUSES.map(s => (
            <button key={s || 'all'} className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(s)}>{s ? t('manufacturing.qcStatus_' + s) : t('common.all')}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('manufacturing.noInspections')}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('manufacturing.order')}</th><th>{t('manufacturing.outputProduct')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.qcQuantity')}</th>
              <th>{t('common.status')}</th><th>{t('common.date')}</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(q => (
                <tr key={q.id}>
                  <td className="text-mono">{q.order_number}</td>
                  <td className="td-primary">{q.output_name}</td>
                  <td style={{ textAlign: 'end' }}>{num(q.quantity)}
                    {q.status !== 'Pending' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}> ({num(q.passed_qty)}✓ / {num(q.rejected_qty)}✗)</span>}</td>
                  <td><span className={`badge badge-${q.status === 'Passed' ? 'green' : q.status === 'Failed' ? 'red' : q.status === 'Partial' ? 'yellow' : 'gray'}`}>{t('manufacturing.qcStatus_' + q.status)}</span></td>
                  <td>{fmtDate(q.created_at)}</td>
                  <td style={{ textAlign: 'end' }}>
                    {q.status === 'Pending' && canEdit
                      ? <button className="btn btn-sm btn-primary" onClick={() => setResolveId(q.id)}>{t('manufacturing.inspect')}</button>
                      : <button className="btn btn-sm btn-secondary" onClick={() => setResolveId(q.id)}>{t('common.view') || 'View'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resolveId && (
        <QCResolveModal qcId={resolveId} canEdit={canEdit}
          onClose={() => setResolveId(null)}
          onDone={() => { setResolveId(null); load(); bump(); }} />
      )}
    </div>
  );
}

function QCResolveModal({ qcId, canEdit, onClose, onDone }) {
  const { t } = useLocale();
  const [qc, setQc] = useState(null);
  const [passed, setPassed] = useState('');
  const [rejected, setRejected] = useState('');
  const [rework, setRework] = useState('');
  const [defects, setDefects] = useState([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(0);

  useEffect(() => {
    getQCInspection(qcId).then(q => {
      setQc(q);
      if (q.status === 'Pending') { setPassed(String(q.quantity)); setRejected('0'); }
    }).catch(e => toast(e.message, 'red'));
  }, [qcId]);

  if (!qc) return <Modal title={t('manufacturing.tabQC')} onClose={onClose}><div className="modal-body"><LoadingSpinner /></div></Modal>;

  const pending = qc.status === 'Pending';
  const total = Number(qc.quantity);
  const p = Number(passed) || 0, r = Number(rejected) || 0, rw = Number(rework) || 0;
  const balanced = Math.abs(p + r - total) < 1e-6 && rw <= r;

  async function submit() {
    setBusy(true);
    try {
      await resolveQC(qcId, {
        passed_qty: p, rejected_qty: r, rework_qty: rw, notes,
        defects: defects.filter(d => (d.reason || '').trim()).map(d => ({ reason: d.reason.trim(), quantity: Number(d.quantity) || 0, notes: d.notes })),
      });
      toast(t('manufacturing.qcResolved')); onDone();
    } catch (e) { toast(e.message, 'red'); } finally { setBusy(false); }
  }

  return (
    <Modal title={`${t('manufacturing.inspect')} · ${qc.order_number}`} onClose={onClose}>
      <div className="modal-body">
        <p style={{ fontSize: 13, marginTop: 0 }}>
          <strong>{qc.output_name}</strong> · {t('manufacturing.qcQuantity')}: {num(qc.quantity)} {qc.output_unit || ''} · <Money value={qc.unit_cost} />/u
        </p>
        {pending && canEdit ? (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcPassed')}</label>
                <input type="number" min="0" step="1" className="form-control" value={passed}
                  onChange={e => { setPassed(e.target.value); const v = total - (Number(e.target.value) || 0); setRejected(String(v >= 0 ? v : 0)); }} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcRejected')}</label>
                <input type="number" min="0" step="1" className="form-control" value={rejected}
                  onChange={e => setRejected(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcRework')}</label>
                <input type="number" min="0" step="1" className="form-control" value={rework}
                  onChange={e => setRework(e.target.value)} placeholder="0" />
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: balanced ? 'var(--text-3)' : 'var(--red)', margin: '4px 0 0' }}>
              {balanced ? t('manufacturing.qcReworkHint') : t('manufacturing.qcMustBalance', { total: num(total) })}
            </p>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 4px' }}>
              <h4 style={{ margin: 0, fontSize: 14 }}>{t('manufacturing.defects')}</h4>
              <button className="btn btn-sm btn-secondary" onClick={() => setDefects(d => [...d, { key: ++keyRef.current, reason: '', quantity: '' }])}>{t('manufacturing.addDefect')}</button>
            </div>
            {defects.map((d, i) => (
              <div key={d.key} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="form-control" style={{ flex: 2 }} placeholder={t('manufacturing.defectReason')}
                  value={d.reason} onChange={e => setDefects(ds => ds.map((x, j) => j === i ? { ...x, reason: e.target.value } : x))} />
                <input className="form-control" style={{ width: 90 }} type="number" min="0" placeholder={t('manufacturing.qcQuantity')}
                  value={d.quantity} onChange={e => setDefects(ds => ds.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
                <button className="icon-btn" onClick={() => setDefects(ds => ds.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}

            <div className="form-group" style={{ marginTop: 10 }}>
              <label className="form-label">{t('manufacturing.notes') || 'Notes'}</label>
              <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13 }}>
            <p>{t('common.status')}: <span className={`badge badge-${qc.status === 'Passed' ? 'green' : qc.status === 'Failed' ? 'red' : 'yellow'}`}>{t('manufacturing.qcStatus_' + qc.status)}</span></p>
            <p>{t('manufacturing.qcPassed')}: {num(qc.passed_qty)} · {t('manufacturing.qcRejected')}: {num(qc.rejected_qty)} · {t('manufacturing.qcRework')}: {num(qc.rework_qty)}</p>
            {qc.scrap_cost > 0 && <p>{t('manufacturing.scrapCost')}: <Money value={qc.scrap_cost} /></p>}
            {(qc.defects || []).length > 0 && (
              <ul style={{ margin: '6px 0', paddingInlineStart: 18 }}>
                {qc.defects.map(d => <li key={d.id}>{d.reason} — {num(d.quantity)}{d.notes ? ` (${d.notes})` : ''}</li>)}
              </ul>
            )}
            {qc.notes && <p style={{ color: 'var(--text-3)' }}>{qc.notes}</p>}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {pending && canEdit && (
          <button className="btn btn-primary" disabled={!balanced || busy} onClick={submit}>
            {busy ? t('common.saving') : t('manufacturing.qcResolve')}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ── Resources view ───────────────────────────────────────────────────────────
function ResourcesView({ canCreate, canEdit, canDelete }) {
  const { t } = useLocale();
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(null);   // resource being edited / created
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(() => getResources().then(setRows).catch(e => toast(e.message, 'red')), []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    try {
      const body = {
        name: modal.name, cost_type: 'per_hour',
        hourly_rate: Number(modal.hourly_rate) || 0,
        is_active: modal.is_active !== false, notes: modal.notes,
      };
      if (modal.id) await updateResource(modal.id, body);
      else await createResource(body);
      toast(`${modal.name} ✓`); setModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }
  async function doArchive(r) {
    setConfirmDel(null);
    try { await archiveResource(r.id); load(); } catch (e) { toast(e.message, 'red'); }
  }

  if (!rows) return <LoadingSpinner />;
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="card-title">{t('manufacturing.tabResources')}</span>
        {canCreate && <button className="btn btn-sm btn-primary"
          onClick={() => setModal({ name: '', hourly_rate: 0, is_active: true })}>
          ＋ {t('manufacturing.newResource')}</button>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 16px 8px' }}>{t('manufacturing.resourcesIntro')}</p>
      {rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
          {t('manufacturing.noResources')}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('manufacturing.resourceName')}</th>
              <th>{t('manufacturing.costType')}</th>
              <th style={{ textAlign: 'end' }}>{t('manufacturing.hourlyRate')}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="td-primary">{r.name}</td>
                  <td style={{ color: 'var(--text-3)' }}>{t('manufacturing.perHour')}</td>
                  <td style={{ textAlign: 'end' }}><Money value={r.hourly_rate} />/h</td>
                  <td style={{ textAlign: 'end' }}>
                    {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setModal({ ...r })}>{t('common.edit')}</button>}
                    {canDelete && <button className="btn btn-sm btn-danger" style={{ marginInlineStart: 6 }} onClick={() => setConfirmDel(r)}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? t('common.edit') : t('manufacturing.newResource')} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group form-full">
                <label className="form-label">{t('manufacturing.resourceName')}</label>
                <input className="form-control" value={modal.name} autoFocus
                  onChange={e => setModal(m => ({ ...m, name: e.target.value }))}
                  placeholder={t('manufacturing.resourceNamePlaceholder')} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.hourlyRate')} / h</label>
                <input type="number" min="0" step="0.01" className="form-control"
                  value={modal.hourly_rate} onChange={e => setModal(m => ({ ...m, hourly_rate: e.target.value }))} />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={save} disabled={!modal.name}>{t('common.save')}</button>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmModal title={t('manufacturing.archive')} confirmClass="btn-danger" confirmLabel={t('manufacturing.archive')}
          message={confirmDel.name} onConfirm={() => doArchive(confirmDel)} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}
