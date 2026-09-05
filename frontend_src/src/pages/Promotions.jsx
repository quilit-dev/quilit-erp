import { useState, useEffect, useCallback } from 'react';
import {
  getPromotions, createPromotion, updatePromotion, togglePromotion, archivePromotion,
  getUsedCategories, getInventory,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, toast, NumberInput,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const STATUS_COLOR = {
  live:      { bg: 'var(--affirm-tint)', color: 'var(--affirm)' },
  scheduled: { bg: 'var(--info-tint)', color: 'var(--info-ink)' },
  expired:   { bg: 'var(--surface-2)', color: 'var(--text-3)' },
  used_up:   { bg: 'var(--caution-tint)', color: 'var(--caution-ink)' },
  paused:    { bg: 'var(--surface-2)', color: 'var(--text-3)' },
};

const EMPTY = {
  name: '', scope_type: 'all', scope_value: '',
  discount_value: 10, start_date: '', end_date: '', max_quantity: '', active: true,
};

export default function Promotions() {
  const { t, tCategory } = useLocale();
  const [promos, setPromos]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [categories, setCategories]     = useState([]);
  const [items, setItems]               = useState([]);
  const [modal, setModal]     = useState(null);   // 'form' | 'archive'
  const [editId, setEditId]   = useState(null);
  const [active, setActiveRow] = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [saving, setSaving]   = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getPromotions(showArchived ? { archived: 'only' } : {})
      .then(d => setPromos(Array.isArray(d) ? d : []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [showArchived]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getUsedCategories().then(c => setCategories(Array.isArray(c) ? c : [])).catch(() => {});
    getInventory().then(i => setItems(Array.isArray(i) ? i : [])).catch(() => {});
  }, []);

  function openCreate() { setForm(EMPTY); setEditId(null); setModal('form'); }
  function openEdit(p) {
    setEditId(p.id);
    setForm({
      name: p.name, scope_type: p.scope_type, scope_value: p.scope_value || '',
      discount_value: p.discount_value, start_date: p.start_date || '', end_date: p.end_date || '',
      max_quantity: p.max_quantity ?? '', active: !!p.active,
    });
    setModal('form');
  }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('promotions.nameRequired'), 'red'); return; }
    const payload = {
      name: form.name.trim(), scope_type: form.scope_type,
      scope_value: form.scope_type === 'all' ? null : (form.scope_value || ''),
      discount_value: Number(form.discount_value) || 0,
      start_date: form.start_date || null, end_date: form.end_date || null,
      max_quantity: form.max_quantity === '' || form.max_quantity == null ? null : Number(form.max_quantity),
      active: !!form.active,
    };
    setSaving(true);
    try {
      if (editId) await updatePromotion(editId, payload);
      else        await createPromotion(payload);
      toast(editId ? t('promotions.updated') : t('promotions.created'));
      setModal(null); load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function toggle(p) {
    try { await togglePromotion(p.id); load(); }
    catch (err) { toast(err.message, 'red'); }
  }
  async function doArchive() {
    try { await archivePromotion(active.id); toast(t('promotions.archived')); setModal(null); load(); }
    catch (err) { toast(err.message, 'red'); }
  }

  function targetLabel(p) {
    if (p.scope_type === 'all') return t('promotions.targetAll');
    if (p.scope_type === 'category') return `${t('promotions.category')}: ${p.scope_value}`;
    const it = items.find(i => String(i.id) === String(p.scope_value));
    return `${t('promotions.item')}: ${it ? (it.name) : `#${p.scope_value}`}`;
  }
  function windowLabel(p) {
    if (!p.start_date && !p.end_date) return t('promotions.always');
    return `${p.start_date || '…'} → ${p.end_date || '…'}`;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('promotions.title')}</h1>
          <p className="page-subtitle">{t('promotions.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
          <button className="btn btn-primary" onClick={openCreate}>{t('promotions.addPromo')}</button>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={load} /> :
         promos.length === 0 ? <EmptyState message={t('promotions.none')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('promotions.name')}</th>
                  <th>{t('promotions.target')}</th>
                  <th style={{ textAlign: 'right' }}>{t('promotions.discount')}</th>
                  <th>{t('promotions.window')}</th>
                  <th>{t('promotions.cap')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {promos.map(p => {
                  const s = STATUS_COLOR[p.status] || STATUS_COLOR.paused;
                  return (
                    <tr key={p.id} className={p.archived_at ? 'row-archived' : undefined}>
                      <td className="td-primary">{p.name}</td>
                      <td>{targetLabel(p)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.discount_value}%</td>
                      <td style={{ fontSize: 12 }}>{windowLabel(p)}</td>
                      <td style={{ fontSize: 12 }}>
                        {p.max_quantity == null ? t('promotions.noCap')
                          : `${p.used_quantity} / ${p.max_quantity}`}
                      </td>
                      <td>
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 20,
                          fontSize: 11, fontWeight: 600, background: s.bg, color: s.color }}>
                          {t(`promotions.status_${p.status}`)}
                        </span>
                      </td>
                      <td>
                        {!p.archived_at && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-sm btn-secondary" onClick={() => toggle(p)}>
                              {p.active ? t('promotions.pause') : t('promotions.resume')}
                            </button>
                            <button className="btn btn-sm btn-secondary" onClick={() => openEdit(p)}>{t('common.edit')}</button>
                            <button className="btn btn-sm btn-danger" onClick={() => { setActiveRow(p); setModal('archive'); }}>{t('common.archive')}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal === 'form' && (
        <Modal title={editId ? t('promotions.editTitle') : t('promotions.addTitle')} onClose={() => setModal(null)}>
          <form onSubmit={save}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t('promotions.name')}</label>
                <input className="form-control" required value={form.name}
                  onChange={e => set('name', e.target.value)} placeholder="e.g. Eid 15% off" />
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('promotions.appliesTo')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.scope_type}
                    onChange={v => set('scope_type', v)}
                    options={[{ value: 'all', label: t('promotions.targetAll') }, { value: 'category', label: t('promotions.aCategory') }, { value: 'item', label: t('promotions.anItem') }]} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('promotions.discountPct')}</label>
                  <NumberInput className="form-control" step="any" min="0" max="100"
                    value={form.discount_value} onChange={e => set('discount_value', e.target.value)} />
                </div>
              </div>

              {form.scope_type === 'category' && (
                <div className="form-group">
                  <label className="form-label">{t('promotions.category')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.scope_value}
                    onChange={v => set('scope_value', v)}
                    placeholder={t('promotions.selectCategory')}
                    options={(categories).map(c => ({ value: c, label: tCategory(c) }))} />
                </div>
              )}
              {form.scope_type === 'item' && (
                <div className="form-group">
                  <label className="form-label">{t('promotions.item')}</label>
                  <SearchSelect
                    className="form-control"
                    value={form.scope_value}
                    onChange={v => set('scope_value', v)}
                    placeholder={t('promotions.selectItem')}
                    options={(items || []).map(i => ({ value: i.id, label: `${i.name}${i.variant_label ? ` — ${i.variant_label}` : ''}` }))} />
                </div>
              )}

              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">{t('promotions.startDate')} <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.optional')}</span></label>
                  <input type="date" className="form-control" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('promotions.endDate')} <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.optional')}</span></label>
                  <input type="date" className="form-control" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">{t('promotions.maxQty')} <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.optional')}</span></label>
                <NumberInput className="form-control" step="1" min="0"
                  placeholder={t('promotions.maxQtyPlaceholder')}
                  value={form.max_quantity} onChange={e => set('max_quantity', e.target.value)} />
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('promotions.maxQtyHint')}</div>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
                  <span>{t('promotions.activeNow')}</span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : (editId ? t('common.save') : t('promotions.addPromo'))}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === 'archive' && active && (
        <ConfirmModal
          title={t('promotions.archiveTitle')}
          message={t('promotions.archiveConfirm', { name: active.name })}
          confirmLabel={t('common.archive')}
          confirmClass="btn-danger"
          onConfirm={doArchive}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
