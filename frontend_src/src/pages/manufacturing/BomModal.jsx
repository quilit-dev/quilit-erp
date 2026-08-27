import { useState, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { createBom, updateBom, createBomVersion, getResources } from '../../api/client';
import { OUTPUT_TYPES, CostInput } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

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
            <SearchSelect
              className="form-control"
              value={outputId}
              onChange={v => setOutputId(v)}
              placeholder={t('manufacturing.selectProduct')}
              options={(outputs).map(p => ({ value: p.id, label: p.name }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.batchYield')}</label>
            <NumberInput className="form-control" step="1" min="1" value={yieldQty}
              onChange={e => setYieldQty(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('manufacturing.standardHours')}
              <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
                {t('manufacturing.standardHoursHint')}</span>
            </label>
            <NumberInput className="form-control" step="any" min="0" value={stdHours}
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
                  <SearchSelect
                    className="form-control"
                    style={{ height: 32 }}
                    value={l.component_inventory_id}
                    onChange={v => setLine(l.key, { component_inventory_id: v })}
                    placeholder={t('manufacturing.selectProduct')}
                    options={(products || []).map(p => ({ value: p.id, label: `${p.name}${p.product_type ? ` · ${t(`manufacturing.ptype_${p.product_type}`)}` : ''}` }))} />
                </td>
                <td>
                  <NumberInput className="form-control" style={{ height: 32 }} step="1" min="1"
                    value={l.quantity} onChange={e => setLine(l.key, { quantity: e.target.value })} />
                </td>
                <td>
                  <NumberInput className="form-control" style={{ height: 32 }} step="any" min="0" max="100"
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
                <td><SearchSelect
                      className="form-control"
                      style={{ height: 32 }}
                      value={r.resource_id}
                      onChange={v => pickResource(r.key, v)}
                      placeholder={t('manufacturing.inlineResource')}
                      options={(resourceList).map(m => ({ value: m.id, label: `${m.name} ($${m.hourly_rate}/h)` }))} /></td>
                <td><input className="form-control" style={{ height: 32 }} value={r.name}
                  onChange={e => setResRow(r.key, { name: e.target.value, resource_id: '' })}
                  placeholder={t('manufacturing.resourceName')} /></td>
                <td><NumberInput className="form-control" style={{ height: 32 }} min="0" step="any"
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

export { BomModal };
