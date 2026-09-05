import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../hooks/useData';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, toast, fmtDate, SelectOther, NumberInput,
} from '../../components/shared';
import {
  getCRMLeads, createCRMLead, updateCRMLead, archiveCRMLead,
  unarchiveCRMLead, convertCRMLead, getCRMDropdownUsers,
} from '../../api/client';
import ImportWizard from '../../components/ImportWizard';
import { fmtCurr, LEAD_STATUS_BADGE, LEAD_STATUSES, LEAD_SOURCES } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

// ─── Lead Form ────────────────────────────────────────────────────────────────


function LeadForm({ initial, users, onSave, onClose, t }) {
  const [form, setForm] = useState({
    name: '', company: '', email: '', phone: '', source: '', status: 'New',
    score: 0, estimated_value: '', expected_close: '', assigned_to: '', notes: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  // SearchSelect hands over the value itself, not an event.
  const fv = k => v => setForm(p => ({ ...p, [k]: v }));

  const sourceLabel = { web: t('crm.sourceWeb'), referral: t('crm.sourceReferral'), cold_call: t('crm.sourceColdCall'), social: t('crm.sourceSocial'), other: t('crm.sourceOther') };
  const statusLabel = { New: t('crm.statusNew'), Contacted: t('crm.statusContacted'), Qualified: t('crm.statusQualified'), Proposal: t('crm.statusProposal'), Negotiation: t('crm.statusNegotiation'), Won: t('crm.statusWon'), Lost: t('crm.statusLost') };

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        ...form,
        score: Number(form.score) || 0,
        estimated_value: Number(form.estimated_value) || 0,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
      });
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('crm.leadName')} *</label>
            <input className="form-control" required value={form.name} onChange={f('name')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.company')}</label>
            <input className="form-control" value={form.company || ''} onChange={f('company')} />
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
            <label className="form-label">{t('crm.source')}</label>
            <SelectOther
              value={form.source || ''}
              onChange={v => setForm(p => ({ ...p, source: v }))}
              includeNone
              options={LEAD_SOURCES.filter(s => s !== 'other').map(s => ({ value: s, label: sourceLabel[s] }))}
              otherLabel={t('crm.sourceOther')}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.status')}</label>
            <SearchSelect className="form-control" value={form.status || 'New'} onChange={fv('status')}
              options={LEAD_STATUSES.map(s => ({ value: s, label: statusLabel[s] }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.estimatedValue')} ($)</label>
            <NumberInput className="form-control" min="0" value={form.estimated_value || ''} onChange={f('estimated_value')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.expectedClose')}</label>
            <input className="form-control" type="date" value={form.expected_close || ''} onChange={f('expected_close')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.score')} (0–100)</label>
            <NumberInput className="form-control" min="0" max="100" value={form.score || 0} onChange={f('score')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.assignedTo')}</label>
            <SearchSelect className="form-control" value={form.assigned_to || ''} onChange={fv('assigned_to')}
              placeholder={t('crm.selectUser')}
              options={(users || []).map(u => ({ value: u.id, label: u.full_name || u.username }))} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">{t('crm.notes')}</label>
            <textarea className="form-control" rows={3} value={form.notes || ''} onChange={f('notes')} />
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

// ─── Leads Tab ────────────────────────────────────────────────────────────────

function LeadsTab({ t }) {
  const navigate = useNavigate();
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [modal, setModal]         = useState(null);
  const [selected, setSelected]   = useState(null);
  const [converting, setConverting] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchLeads = useCallback(sig => {
    const p = {};
    if (search) p.search = search;
    if (statusFilter) p.status = statusFilter;
    if (showArchived) p.archived = 'only';
    return getCRMLeads(p, sig);
  }, [search, statusFilter, showArchived]);

  const { data: leads, loading, error, reload } = useData(fetchLeads, [search, statusFilter, showArchived]);
  const { data: users } = useData(getCRMDropdownUsers);

  const statusLabel = { New: t('crm.statusNew'), Contacted: t('crm.statusContacted'), Qualified: t('crm.statusQualified'), Proposal: t('crm.statusProposal'), Negotiation: t('crm.statusNegotiation'), Won: t('crm.statusWon'), Lost: t('crm.statusLost') };

  async function handleSave(data) {
    try {
      if (selected) { await updateCRMLead(selected.id, data); toast(t('crm.leadUpdated')); }
      else          { await createCRMLead(data);               toast(t('crm.leadCreated')); }
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleArchive() {
    try {
      await archiveCRMLead(selected.id);
      toast(t('crm.leadArchived'));
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleUnarchive() {
    try {
      await unarchiveCRMLead(selected.id);
      toast(t('crm.leadRestored'));
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleConvert() {
    setConverting(true);
    try {
      const res = await convertCRMLead(selected.id, {});
      toast(t('crm.leadConverted'));
      setModal(null); setSelected(null); reload();
      navigate(`/clients/${res.client_id}`);
    } catch (e) { toast(e.message, 'red'); }
    finally { setConverting(false); }
  }

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <div className="search-bar" style={{ margin: 0, flex: 1, gap: 8 }}>
            <div className="search-input-wrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input className="form-control search-input" placeholder={t('crm.searchLeads')} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <SearchSelect
              className="form-control"
              style={{ width: 160 }}
              value={statusFilter}
              onChange={v => setStatus(v)}
              placeholder={t('crm.allStatuses')}
              options={(LEAD_STATUSES).map(s => ({ value: s, label: statusLabel[s] }))} />
            <label className="archived-toggle">
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} />
              {t('common.showArchived')}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {leads && leads.length > 0 && (
              <ExportButton
                data={leads.map(l => ({
                  Lead:           l.name,
                  Company:        l.company || '',
                  Source:         l.source || '',
                  Status:         l.status,
                  Estimated_Value: l.estimated_value || 0,
                  Expected_Close: l.expected_close || '',
                  Assigned_To:    l.assigned_name || '',
                  Converted:      l.client_id ? 'Yes' : 'No',
                  Email:          l.email || '',
                  Phone:          l.phone || '',
                }))}
                filename="CRM_Leads" sheetName="Leads" />
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => setImporting(true)}>⬆ {t('imports.importBtn')}</button>
            <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('form'); }}>
              {t('crm.addLead')}
            </button>
          </div>
        </div>

        {importing && (
          <ImportWizard entity="leads" title={`${t('imports.importBtn')} — ${t('crm.leads')}`}
            onClose={() => setImporting(false)} onDone={reload} />
        )}

        {loading ? <LoadingSpinner /> :
         error   ? <ErrorAlert message={error} onRetry={reload} /> :
         !leads?.length ? <EmptyState message={t('crm.noLeads')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('crm.leadName')}</th>
                  <th>{t('crm.company')}</th>
                  <th>{t('crm.source')}</th>
                  <th>{t('crm.status')}</th>
                  <th>{t('crm.estimatedValue')}</th>
                  <th>{t('crm.expectedClose')}</th>
                  <th>{t('crm.assignedTo')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {leads.map(l => {
                  const isArchived = !!l.archived_at;
                  return (
                  <tr key={l.id} className={isArchived ? 'row-archived' : undefined}>
                    <td className="td-primary">
                      {l.name}
                      {l.client_id && !isArchived && <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 10 }}>{t('crm.alreadyConverted')}</span>}
                      {isArchived && <span className="badge badge-gray" style={{ marginInlineStart: 8 }}>{t('common.archivedBadge')}</span>}
                    </td>
                    <td>{l.company || '—'}</td>
                    <td>{l.source || '—'}</td>
                    <td><span className={`badge badge-${LEAD_STATUS_BADGE[l.status] || 'gray'}`}>{statusLabel[l.status] || l.status}</span></td>
                    <td>{l.estimated_value ? fmtCurr(l.estimated_value) : '—'}</td>
                    <td>{fmtDate(l.expected_close)}</td>
                    <td>{l.assigned_name || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {isArchived ? (
                          <button className="btn btn-sm btn-secondary" style={{ color: 'var(--affirm-ink)', whiteSpace: 'nowrap' }}
                            onClick={() => { setSelected(l); setModal('restore'); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                        ) : (
                          <>
                            <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(l); setModal('form'); }}>{t('common.edit')}</button>
                            {!l.client_id
                              ? <button className="btn btn-sm btn-primary" onClick={() => { setSelected(l); setModal('convert'); }}>{t('crm.convertToClient')}</button>
                              : <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/clients/${l.client_id}`)}>{t('crm.viewClient')}</button>
                            }
                            <button className="btn btn-sm btn-danger" onClick={() => { setSelected(l); setModal('archive'); }}>{t('common.archive')}</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(modal === 'form') && (
        <Modal title={selected ? t('crm.editLead') : t('crm.newLead')} onClose={() => { setModal(null); setSelected(null); }} size="lg">
          <LeadForm initial={selected} users={users || []} onSave={handleSave} onClose={() => { setModal(null); setSelected(null); }} t={t} />
        </Modal>
      )}
      {modal === 'archive' && selected && (
        <ConfirmModal title={t('crm.archiveLead')} message={t('crm.archiveLeadMsg')}
          confirmLabel={t('common.archive')} confirmClass="btn-danger"
          onConfirm={handleArchive} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
      {modal === 'restore' && selected && (
        <ConfirmModal message={t('common.restoreConfirm')}
          confirmLabel={t('common.restore')}
          onConfirm={handleUnarchive} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
      {modal === 'convert' && selected && (
        <ConfirmModal title={t('crm.convertTitle')} message={t('crm.convertDesc')}
          confirmLabel={converting ? t('crm.converting') : t('crm.convertBtn')} confirmClass="btn-primary"
          onConfirm={handleConvert} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
    </div>
  );
}

export { LeadsTab };
