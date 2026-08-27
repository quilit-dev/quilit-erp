import { useState, useEffect, useCallback } from 'react';
import { getAttributeDefs, createAttributeDef, updateAttributeDef, deleteAttributeDef } from '../api/client';
import { Modal, ConfirmModal, toast } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

// Owner-defined inventory fields (custom attributes). This is a CRUD UI over
// attribute_defs — it never alters real DB columns, so it's safe for a
// non-technical owner: fields are descriptive/variant metadata, while the
// money/stock core (cost, price, quantity, barcode) stays fixed.
//
// Fields are created at scope_type='global' so they show in the New Product
// builder regardless of the chosen business type.

const TYPE_OPTIONS = [
  { value: 'enum',   key: 'fieldTypeDropdown' },
  { value: 'text',   key: 'fieldTypeText' },
  { value: 'number', key: 'fieldTypeNumber' },
];

// One-click templates so the owner gets going instantly.
const TEMPLATES = [
  { name: 'Size',    input_type: 'enum', is_variant_axis: true, options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  { name: 'Color',   input_type: 'enum', is_variant_axis: true, options: ['Black', 'White', 'Red', 'Blue', 'Green', 'Grey'] },
  { name: 'Storage', input_type: 'enum', is_variant_axis: true, options: ['64GB', '128GB', '256GB', '512GB', '1TB'] },
];

const EMPTY = { name: '', input_type: 'enum', is_variant_axis: true, optionsText: '', sort_order: 0 };

export default function InventoryFieldsManager({ canEdit }) {
  const { t } = useLocale();
  const [defs, setDefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);   // 'form' | 'delete'
  const [editId, setEditId] = useState(null);
  const [active, setActive] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getAttributeDefs()
      .then(d => setDefs(Array.isArray(d) ? d : []))
      .catch(() => setDefs([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  function openCreate() { setForm(EMPTY); setEditId(null); setModal('form'); }
  function openEdit(d) {
    setEditId(d.id);
    setForm({
      name: d.name, input_type: d.input_type || 'enum',
      is_variant_axis: !!d.is_variant_axis,
      optionsText: (d.options || []).join(', '),
      sort_order: d.sort_order || 0,
    });
    setModal('form');
  }

  function payloadFrom(f) {
    const options = f.input_type === 'enum'
      ? f.optionsText.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    return {
      scope_type: 'global', scope_value: null,
      name: f.name.trim(), input_type: f.input_type,
      options, is_variant_axis: f.input_type === 'enum' ? !!f.is_variant_axis : false,
      sort_order: Number(f.sort_order) || 0,
    };
  }

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast(t('settings.fieldNameRequired'), 'red'); return; }
    if (form.input_type === 'enum' && !form.optionsText.trim()) {
      toast(t('settings.fieldOptionsRequired'), 'red'); return;
    }
    setSaving(true);
    try {
      if (editId) await updateAttributeDef(editId, payloadFrom(form));
      else        await createAttributeDef(payloadFrom(form));
      toast(editId ? t('settings.fieldUpdated') : t('settings.fieldAdded'));
      setModal(null); load();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function addTemplate(tpl) {
    if (defs.some(d => d.name.toLowerCase() === tpl.name.toLowerCase())) {
      toast(t('settings.fieldExists'), 'red'); return;
    }
    try {
      await createAttributeDef({
        scope_type: 'global', scope_value: null, name: tpl.name,
        input_type: tpl.input_type, options: tpl.options,
        is_variant_axis: tpl.is_variant_axis, sort_order: 0,
      });
      toast(t('settings.fieldAdded')); load();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function remove() {
    try {
      await deleteAttributeDef(active.id);
      toast(t('settings.fieldDeleted'));
      setModal(null); load();
    } catch (err) { toast(err.message, 'red'); }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
        {t('settings.inventoryFieldsDesc')}
      </p>

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>{t('settings.addField')}</button>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('settings.quickAdd')}:</span>
          {TEMPLATES.map(tpl => (
            <button key={tpl.name} className="btn btn-secondary btn-sm" onClick={() => addTemplate(tpl)}>
              + {tpl.name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>…</div>
      ) : defs.length === 0 ? (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 13,
          border: '1px dashed var(--border)', borderRadius: 6 }}>
          {t('settings.noFieldsYet')}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('settings.fieldName')}</th>
                <th>{t('settings.fieldType')}</th>
                <th>{t('settings.fieldCreatesVariants')}</th>
                <th>{t('settings.fieldOptions')}</th>
                {canEdit && <th>{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {defs.map(d => (
                <tr key={d.id}>
                  <td className="td-primary">{d.name}</td>
                  <td>{t(`settings.${(TYPE_OPTIONS.find(o => o.value === d.input_type) || {}).key || 'fieldTypeText'}`)}</td>
                  <td>{d.is_variant_axis ? '✓' : '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                    {(d.options || []).join(', ') || '—'}
                  </td>
                  {canEdit && (
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(d)}>{t('common.edit')}</button>
                        <button className="btn btn-sm btn-danger" onClick={() => { setActive(d); setModal('delete'); }}>{t('common.delete')}</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'form' && (
        <Modal title={editId ? t('settings.editFieldTitle') : t('settings.addFieldTitle')} onClose={() => setModal(null)}>
          <form onSubmit={save}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t('settings.fieldName')}</label>
                <input className="form-control" required value={form.name}
                  onChange={e => set('name', e.target.value)} placeholder="e.g. Size, Color, Storage, Author" />
              </div>
              <div className="form-group">
                <label className="form-label">{t('settings.fieldType')}</label>
                <SearchSelect
                  className="form-control"
                  value={form.input_type}
                  onChange={v => set('input_type', v)}
                  options={(TYPE_OPTIONS).map(o => ({ value: o.value, label: t(`settings.${o.key}`) }))} />
              </div>
              {form.input_type === 'enum' && (
                <>
                  <div className="form-group">
                    <label className="form-label">{t('settings.fieldOptions')}</label>
                    <input className="form-control" value={form.optionsText}
                      onChange={e => set('optionsText', e.target.value)} placeholder="S, M, L, XL" />
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('settings.fieldOptionsHint')}</div>
                  </div>
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={form.is_variant_axis}
                        onChange={e => set('is_variant_axis', e.target.checked)} />
                      <span>{t('settings.fieldCreatesVariantsLabel')}</span>
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{t('settings.fieldCreatesVariantsHint')}</div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('common.saving') : (editId ? t('common.save') : t('settings.addField'))}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === 'delete' && active && (
        <ConfirmModal
          title={t('settings.deleteFieldTitle')}
          message={t('settings.deleteFieldConfirm', { name: active.name })}
          confirmLabel={t('common.delete')}
          confirmClass="btn-danger"
          onConfirm={remove}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
