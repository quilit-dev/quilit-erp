import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { toast } from '../../components/shared';
import { createPlanningProject, updatePlanningProject } from '../../api/client';
import { PROJ_STATUSES, PROJECT_COLORS, PROJ_STATUS_KEY } from './constants';

function ProjectForm({ initial, clients, srcProjects = [], onSave, onClose }) {
  const { t } = useLocale();
  const [form, setForm] = useState({
    name: '', description: '', color: '#4f8ef7',
    start_date: '', end_date: '', status: 'Active',
    ...(initial
      ? { ...initial, client_id: initial.client_id || '' }
      : { client_id: '' }),
  });
  const [saving, setSaving] = useState(false);
  // Creation source: type a brand-new project ('new') or pull the details from
  // an existing record in the operational Projects module ('import'). Only
  // offered when creating (not editing) and when source projects are available.
  const canImport = !initial?.id && srcProjects.length > 0;
  const [mode, setMode] = useState('new');
  const [srcId, setSrcId] = useState('');

  // Prefill the form from a chosen Projects-module record. Statuses differ
  // between the two modules, so status/color keep their planning defaults.
  function pickSource(id) {
    setSrcId(id);
    const p = srcProjects.find(x => String(x.id) === String(id));
    if (!p) return;
    setForm(f => ({
      ...f,
      name:        p.name || '',
      description: p.description || '',
      client_id:   p.client_id || '',
      start_date:  p.start_date || '',
      end_date:    p.end_date || '',
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (canImport && mode === 'import' && !srcId) {
      toast(t('planning.importProjectRequired'), 'error'); return;
    }
    if (!form.name.trim()) { toast(t('planning.projectNameRequired'), 'error'); return; }
    setSaving(true);
    try {
      const payload = { ...form, client_id: form.client_id || null };
      if (initial?.id) {
        await updatePlanningProject(initial.id, payload);
        toast(t('planning.projectUpdated'));
      } else {
        await createPlanningProject(payload);
        toast(t('planning.projectCreated'));
      }
      onSave();
    } catch (err) {
      toast(err.message || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form onSubmit={handleSubmit}>
      <div className="modal-body">
        {canImport && (
          <div className="form-group form-full">
            <div className="tabs" style={{ marginBottom: 4 }}>
              <button type="button" className={`tab-btn${mode === 'new' ? ' active' : ''}`}
                      onClick={() => { setMode('new'); setSrcId(''); }}>
                {t('planning.projModeNew')}
              </button>
              <button type="button" className={`tab-btn${mode === 'import' ? ' active' : ''}`}
                      onClick={() => setMode('import')}>
                {t('planning.projModeImport')}
              </button>
            </div>
          </div>
        )}
        {canImport && mode === 'import' && (
          <div className="form-group form-full">
            <label className="form-label">{t('planning.importProjectLabel')}</label>
            <select className="form-control" value={srcId} onChange={e => pickSource(e.target.value)}>
              <option value="">{t('planning.importProjectOption')}</option>
              {srcProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{t('planning.importProjectHint')}</div>
          </div>
        )}
        <div className="form-group form-full">
          <label className="form-label">{t('planning.projectName')} *</label>
          <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} required />
        </div>
        <div className="form-group form-full">
          <label className="form-label">{t('planning.projectDesc')}</label>
          <textarea className="form-control" rows={2} value={form.description || ''} onChange={e => set('description', e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('planning.projectClient')}</label>
            <select className="form-control" value={form.client_id} onChange={e => set('client_id', e.target.value)}>
              <option value="">{t('planning.noneOption')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.projectStatus')}</label>
            <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
              {PROJ_STATUSES.map(s => <option key={s} value={s}>{t(PROJ_STATUS_KEY[s])}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.startDate')}</label>
            <input type="date" className="form-control" value={form.start_date || ''} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('planning.endDate')}</label>
            <input type="date" className="form-control" value={form.end_date || ''} onChange={e => set('end_date', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">{t('planning.projectColor')}</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {PROJECT_COLORS.map(c => (
              <button key={c} type="button"
                onClick={() => set('color', c)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                  outline: form.color === c ? `3px solid ${c}` : '2px solid transparent',
                  outlineOffset: 2, boxShadow: form.color === c ? '0 0 0 2px var(--bg)' : 'none',
                  transition: 'all .15s',
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? t('common.saving') : (initial?.id ? t('common.save') : t('common.create'))}
        </button>
      </div>
    </form>
  );
}

// ─── Task Form ────────────────────────────────────────────────────────────────


export { ProjectForm };
