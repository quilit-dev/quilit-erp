import { useState, useCallback } from 'react';
import { useData } from '../../hooks/useData';
import SearchSelect from '../../components/SearchSelect.jsx';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, ExportButton, toast,
} from '../../components/shared';
import {
  getCRMContacts, createCRMContact, updateCRMContact, deleteCRMContact,
  getCRMDropdownClients, getCRMLeads,
} from '../../api/client';

// ─── Contact Form ─────────────────────────────────────────────────────────────

function ContactForm({ initial, clients, leads, onSave, onClose, t }) {
  const [form, setForm] = useState({
    name: '', title: '', email: '', phone: '', is_primary: false, notes: '',
    client_id: '', lead_id: '',
    ...(initial ? { ...initial, is_primary: !!initial.is_primary } : {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

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
            <label className="form-label">{t('crm.contactName')} *</label>
            <input className="form-control" required value={form.name} onChange={f('name')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.title')}</label>
            <input className="form-control" value={form.title || ''} onChange={f('title')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.email')}</label>
            <input className="form-control" type="email" value={form.email || ''} onChange={f('email')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.phone')}</label>
            <input className="form-control" value={form.phone || ''} onChange={f('phone')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedClient')}</label>
            <SearchSelect
              className="form-control"
              value={form.client_id || ''}
              onChange={v => setForm(p => ({ ...p, client_id: v, lead_id: v ? '' : p.lead_id }))}
              placeholder={t('crm.selectClient')}
              options={(clients || []).map(c => ({ value: c.id, label: `${c.name}${c.company ? ` — ${c.company}` : ''}` }))} />
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
              options={((leads || [])).map(l => ({ value: l.id, label: `${l.name}${l.company ? ` — ${l.company}` : ''}` }))} />
          </div>
          <div className="form-group form-full" style={{ marginBottom: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.is_primary} onChange={e => setForm(p => ({ ...p, is_primary: e.target.checked }))} />
              <span className="form-label" style={{ marginBottom: 0 }}>{t('crm.isPrimary')}</span>
            </label>
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('crm.notes')}</label>
            <textarea className="form-control" rows={2} value={form.notes || ''} onChange={f('notes')} />
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

// ─── Contacts Tab ─────────────────────────────────────────────────────────────

function ContactsTab({ t }) {
  const [search, setSearch]     = useState('');
  const [modal, setModal]       = useState(null);
  const [selected, setSelected] = useState(null);

  const fetchContacts = useCallback(sig => getCRMContacts({ search }, sig), [search]);
  const { data: contacts, loading, error, reload } = useData(fetchContacts, [search]);
  const { data: clients } = useData(getCRMDropdownClients);
  const { data: leads }   = useData((s) => getCRMLeads({}, s));

  async function handleSave(data) {
    try {
      if (selected) { await updateCRMContact(selected.id, data); toast(t('crm.contactUpdated')); }
      else          { await createCRMContact(data);               toast(t('crm.contactCreated')); }
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleDelete() {
    try {
      await deleteCRMContact(selected.id);
      toast(t('crm.contactDeleted'));
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
              <input className="form-control search-input" placeholder={t('crm.searchContacts')} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {contacts && contacts.length > 0 && (
              <ExportButton
                data={contacts.map(c => ({
                  Name:    c.name,
                  Title:   c.title || '',
                  Email:   c.email || '',
                  Phone:   c.phone || '',
                  Client:  c.client_name || '',
                  Lead:    c.lead_name || '',
                  Primary: c.is_primary ? 'Yes' : 'No',
                  Notes:   c.notes || '',
                }))}
                filename="CRM_Contacts" sheetName="Contacts" />
            )}
            <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('form'); }}>
              {t('crm.addContact')}
            </button>
          </div>
        </div>

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         !contacts?.length ? <EmptyState message={t('crm.noContacts')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('crm.contactName')}</th>
                  <th>{t('crm.title')}</th>
                  <th>{t('crm.email')}</th>
                  <th>{t('crm.phone')}</th>
                  <th>{t('crm.linkedClient')}</th>
                  <th>{t('crm.linkedLead')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map(c => (
                  <tr key={c.id}>
                    <td className="td-primary">
                      {c.name}
                      {c.is_primary ? <span className="badge badge-blue" style={{ marginLeft: 6, fontSize: 10 }}>★ Primary</span> : null}
                    </td>
                    <td>{c.title || '—'}</td>
                    <td>{c.email || '—'}</td>
                    <td>{c.phone || '—'}</td>
                    <td>{c.client_name || '—'}</td>
                    <td>{c.lead_name || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(c); setModal('form'); }}>{t('common.edit')}</button>
                        <button className="btn btn-sm btn-danger"    onClick={() => { setSelected(c); setModal('delete'); }}>{t('common.delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal === 'form' && (
        <Modal title={selected ? t('crm.editContact') : t('crm.newContact')} onClose={() => { setModal(null); setSelected(null); }}>
          <ContactForm initial={selected} clients={clients || []} leads={leads || []}
            onSave={handleSave} onClose={() => { setModal(null); setSelected(null); }} t={t} />
        </Modal>
      )}
      {modal === 'delete' && selected && (
        <ConfirmModal title={t('crm.deleteContact')} message={t('crm.deleteContactMsg')}
          confirmLabel={t('common.delete')} confirmClass="btn-danger"
          onConfirm={handleDelete} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
    </div>
  );
}

export { ContactsTab };
