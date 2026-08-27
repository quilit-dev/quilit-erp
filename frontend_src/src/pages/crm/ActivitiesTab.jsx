import { useState, useCallback } from 'react';
import { useData } from '../../hooks/useData';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, toast, fmtDate,
} from '../../components/shared';
import {
  getCRMActivities, createCRMActivity, updateCRMActivity,
  toggleActivityDone, deleteCRMActivity, getCRMDropdownClients, getCRMLeads,
} from '../../api/client';
import { isOverdue, ACT_TYPE_BADGE, ACT_ICON, ACT_TYPES } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

// ─── Activity Form ────────────────────────────────────────────────────────────


function ActivityForm({ initial, clients, leads, onSave, onClose, t }) {
  const [form, setForm] = useState({
    type: 'call', subject: '', description: '', due_date: '', outcome: '',
    client_id: '', lead_id: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  // SearchSelect hands over the value itself, not an event.
  const fv = k => v => setForm(p => ({ ...p, [k]: v }));

  const typeLabel = { call: t('crm.typeCall'), email: t('crm.typeEmail'), meeting: t('crm.typeMeeting'), task: t('crm.typeTask'), note: t('crm.typeNote') };

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        ...form,
        client_id: form.client_id ? Number(form.client_id) : null,
        lead_id:   form.lead_id   ? Number(form.lead_id)   : null,
      });
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('crm.activityType')}</label>
            <SearchSelect className="form-control" value={form.type} onChange={fv('type')}
              options={ACT_TYPES.map(tp => ({ value: tp, label: typeLabel[tp] }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.dueDate')}</label>
            <input className="form-control" type="date" value={form.due_date || ''} onChange={f('due_date')} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('crm.subject')} *</label>
            <input className="form-control" required value={form.subject} onChange={f('subject')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedClient')}</label>
            <SearchSelect
              className="form-control"
              value={form.client_id || ''}
              onChange={v => setForm(p => ({ ...p, client_id: v, lead_id: v ? '' : p.lead_id }))}
              placeholder={t('crm.selectClient')}
              options={(clients || []).map(c => ({ value: c.id, label: c.name }))} />
          </div>
          <div className="form-group">
            <label className="form-label">
              {t('crm.linkedLead')}
              <span style={{ color:'var(--text-3)', marginLeft:6, fontSize:11, fontStyle:'italic' }}>
                {t('common.insteadOfClient')}
              </span>
            </label>
            <SearchSelect
              className="form-control"
              value={form.lead_id || ''}
              onChange={v => setForm(p => ({ ...p, lead_id: v, client_id: v ? '' : p.client_id }))}
              placeholder={t('crm.selectLead')}
              options={((leads || [])).map(l => ({ value: l.id, label: l.name }))} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('crm.description')}</label>
            <textarea className="form-control" rows={2} value={form.description || ''} onChange={f('description')} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('crm.outcome')}</label>
            <input className="form-control" value={form.outcome || ''} onChange={f('outcome')} placeholder="Result / follow-up note…" />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : initial ? t('common.save') : t('common.create')}
        </button>
      </div>
    </form>
  );
}

// ─── Activities Tab ───────────────────────────────────────────────────────────

function ActivitiesTab({ t }) {
  const [search, setSearch]     = useState('');
  const [typeFilter, setType]   = useState('');
  const [doneFilter, setDone]   = useState('');
  const [modal, setModal]       = useState(null);
  const [selected, setSelected] = useState(null);

  const fetchActivities = useCallback(sig => {
    const p = {};
    if (search) p.search = search;
    if (typeFilter) p.type = typeFilter;
    if (doneFilter) p.done = doneFilter;
    return getCRMActivities(p, sig);
  }, [search, typeFilter, doneFilter]);

  const { data: activities, loading, error, reload } = useData(fetchActivities, [search, typeFilter, doneFilter]);
  const { data: clients } = useData(getCRMDropdownClients);
  const { data: leads }   = useData((s) => getCRMLeads({}, s));

  const typeLabel = { call: t('crm.typeCall'), email: t('crm.typeEmail'), meeting: t('crm.typeMeeting'), task: t('crm.typeTask'), note: t('crm.typeNote') };

  async function handleSave(data) {
    try {
      if (selected) { await updateCRMActivity(selected.id, data); toast(t('crm.activityUpdated')); }
      else          { await createCRMActivity(data);               toast(t('crm.activityCreated')); }
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleToggle(a) {
    try { await toggleActivityDone(a.id); reload(); }
    catch (e) { toast(e.message, 'red'); }
  }

  async function handleDelete() {
    try {
      await deleteCRMActivity(selected.id);
      toast(t('crm.activityDeleted'));
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <div className="search-bar" style={{ margin: 0, flex: 1 }}>
            <div className="search-input-wrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input className="form-control search-input" placeholder={t('crm.searchActivities')} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <SearchSelect
              className="form-control"
              style={{ width: 140 }}
              value={typeFilter}
              onChange={v => setType(v)}
              placeholder={t('crm.allTypes')}
              options={(ACT_TYPES).map(tp => ({ value: tp, label: typeLabel[tp] }))} />
            <SearchSelect
              className="form-control"
              style={{ width: 120 }}
              value={doneFilter}
              onChange={v => setDone(v)}
              placeholder={t('crm.allDone')}
              options={[{ value: 'false', label: t('crm.onlyOpen') }, { value: 'true', label: t('crm.onlyDone') }]} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('form'); }}>
            {t('crm.addActivity')}
          </button>
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         !activities?.length ? <EmptyState message={t('crm.noActivities')} /> : (
          <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activities.map(a => {
              const done    = !!a.done_at;
              const overdue = !done && isOverdue(a.due_date);
              return (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  borderLeft: `3px solid ${overdue ? 'var(--red)' : done ? 'var(--green)' : 'var(--border)'}`,
                  background: 'var(--surface)', opacity: done ? 0.7 : 1,
                }}>
                  <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{ACT_ICON[a.type] || '📌'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, textDecoration: done ? 'line-through' : 'none', color: 'var(--text)' }}>{a.subject}</span>
                      <span className={`badge badge-${ACT_TYPE_BADGE[a.type] || 'gray'}`}>{typeLabel[a.type] || a.type}</span>
                      {done    && <span className="badge badge-green">✓ {t('crm.done')}</span>}
                      {overdue && <span className="badge badge-red">Overdue</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                      {a.client_name || a.lead_name || '—'}
                      {a.due_date && ` · ${t('crm.dueDate')}: ${fmtDate(a.due_date)}`}
                      {a.outcome  && ` · ${a.outcome}`}
                    </div>
                    {a.description && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{a.description}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleToggle(a)}>
                      {done ? t('crm.markUndone') : t('crm.markDone')}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(a); setModal('form'); }}>{t('common.edit')}</button>
                    <button className="btn btn-sm btn-danger"    onClick={() => { setSelected(a); setModal('delete'); }}>{t('common.delete')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modal === 'form' && (
        <Modal title={selected ? t('crm.editActivity') : t('crm.newActivity')} onClose={() => { setModal(null); setSelected(null); }}>
          <ActivityForm initial={selected} clients={clients || []} leads={leads || []}
            onSave={handleSave} onClose={() => { setModal(null); setSelected(null); }} t={t} />
        </Modal>
      )}
      {modal === 'delete' && selected && (
        <ConfirmModal title={t('crm.deleteActivity')} message={t('crm.deleteActivityMsg')}
          confirmLabel={t('common.delete')} confirmClass="btn-danger"
          onConfirm={handleDelete} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
    </div>
  );
}

export { ActivitiesTab };
