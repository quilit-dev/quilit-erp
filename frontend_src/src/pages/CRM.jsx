import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocale } from '../hooks/useLocale.jsx';
import { useData } from '../hooks/useData';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, toast, fmtDate,
} from '../components/shared';
import {
  getCRMDashboard, getCRMLeads, createCRMLead, updateCRMLead, archiveCRMLead, convertCRMLead,
  getCRMContacts, createCRMContact, updateCRMContact, deleteCRMContact,
  getCRMActivities, createCRMActivity, updateCRMActivity, toggleActivityDone, deleteCRMActivity,
  getCRMDeals, createCRMDeal, updateCRMDeal, updateDealStage, archiveCRMDeal,
  getCRMDropdownClients, getCRMDropdownQuotations, getCRMDropdownUsers,
} from '../api/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtCurr(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function isOverdue(due) {
  if (!due) return false;
  return new Date(due + 'T00:00:00') < new Date(new Date().toDateString());
}

// ─── Status → badge color maps ───────────────────────────────────────────────

const LEAD_STATUS_BADGE = {
  New: 'blue', Contacted: 'yellow', Qualified: 'green',
  Proposal: 'accent', Negotiation: 'orange', Won: 'green', Lost: 'red',
};
const DEAL_STAGE_BADGE = {
  Qualification: 'blue', Proposal: 'accent', Negotiation: 'orange',
  Won: 'green', Lost: 'red',
};
const ACT_TYPE_BADGE = {
  call: 'blue', email: 'accent', meeting: 'green', task: 'yellow', note: 'gray',
};
const ACT_ICON = { call: '📞', email: '✉️', meeting: '🤝', task: '✅', note: '📝' };

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

const PIPELINE_STAGES = ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'];

function DashboardTab({ t }) {
  const { data, loading, error, reload } = useData(getCRMDashboard);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={reload} />;
  if (!data)   return null;

  const stageMap = Object.fromEntries((data.pipeline_by_stage || []).map(r => [r.stage, r]));
  const stageAccent = { Qualification: 'var(--blue)', Proposal: 'var(--accent)', Negotiation: 'var(--orange)', Won: 'var(--green)', Lost: 'var(--red)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="stat-card" style={{ '--card-accent': 'var(--blue)' }}>
          <div className="stat-label">{t('crm.openLeads')}</div>
          <div className="stat-value" style={{ color: 'var(--blue)' }}>{data.open_leads}</div>
          <div className="stat-sub">{t('crm.totalLeads')}: {data.total_leads}</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--accent)' }}>
          <div className="stat-label">{t('crm.pipelineValue')}</div>
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{fmtCurr(data.pipeline_value)}</div>
          <div className="stat-sub">{data.open_deals} {t('crm.openDeals').toLowerCase()}</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--green)' }}>
          <div className="stat-label">{t('crm.wonDeals')}</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>{fmtCurr(data.won_deals_value)}</div>
          <div className="stat-sub">{t('crm.conversionRate')}: {data.conversion_rate}%</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': data.overdue_activities > 0 ? 'var(--red)' : 'var(--green)' }}>
          <div className="stat-label">{t('crm.overdueActivities')}</div>
          <div className="stat-value" style={{ color: data.overdue_activities > 0 ? 'var(--red)' : 'var(--text)' }}>{data.overdue_activities}</div>
          <div className="stat-sub">{t('crm.activitiesToday')}: {data.activities_today}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Pipeline by stage */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontWeight: 700, fontSize: 13 }}>{t('crm.pipelineByStage')}</span>
          </div>
          <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {PIPELINE_STAGES.map(stage => {
              const s = stageMap[stage];
              return (
                <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`badge badge-${DEAL_STAGE_BADGE[stage]}`}>{stage}</span>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-3)' }}>
                    {s ? `${s.count} deal${s.count !== 1 ? 's' : ''}` : '—'}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: s ? stageAccent[stage] : 'var(--text-3)' }}>
                    {s ? fmtCurr(s.total_value) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent activities */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontWeight: 700, fontSize: 13 }}>{t('crm.recentActivities')}</span>
          </div>
          <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!data.recent_activities.length && (
              <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>{t('crm.noActivities')}</p>
            )}
            {data.recent_activities.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>{ACT_ICON[a.type] || '📌'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.subject}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.client_name || a.lead_name || '—'}</div>
                </div>
                {a.done_at && <span className="badge badge-green" style={{ fontSize: 10 }}>✓</span>}
                {!a.done_at && a.due_date && isOverdue(a.due_date) && <span className="badge badge-red" style={{ fontSize: 10 }}>Late</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Lead Form ────────────────────────────────────────────────────────────────

const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
const LEAD_SOURCES  = ['web', 'referral', 'cold_call', 'social', 'other'];

function LeadForm({ initial, users, onSave, onClose, t }) {
  const [form, setForm] = useState({
    name: '', company: '', email: '', phone: '', source: '', status: 'New',
    score: 0, estimated_value: '', expected_close: '', assigned_to: '', notes: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

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
            <select className="form-control" value={form.source || ''} onChange={f('source')}>
              <option value="">—</option>
              {LEAD_SOURCES.map(s => <option key={s} value={s}>{sourceLabel[s]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.status')}</label>
            <select className="form-control" value={form.status || 'New'} onChange={f('status')}>
              {LEAD_STATUSES.map(s => <option key={s} value={s}>{statusLabel[s]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.estimatedValue')} ($)</label>
            <input className="form-control" type="number" min="0" value={form.estimated_value || ''} onChange={f('estimated_value')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.expectedClose')}</label>
            <input className="form-control" type="date" value={form.expected_close || ''} onChange={f('expected_close')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.score')} (0–100)</label>
            <input className="form-control" type="number" min="0" max="100" value={form.score || 0} onChange={f('score')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.assignedTo')}</label>
            <select className="form-control" value={form.assigned_to || ''} onChange={f('assigned_to')}>
              <option value="">{t('crm.selectUser')}</option>
              {(users || []).map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
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
  const [modal, setModal]         = useState(null);
  const [selected, setSelected]   = useState(null);
  const [converting, setConverting] = useState(false);

  const fetchLeads = useCallback(sig => {
    const p = {};
    if (search) p.search = search;
    if (statusFilter) p.status = statusFilter;
    return getCRMLeads(p, sig);
  }, [search, statusFilter]);

  const { data: leads, loading, error, reload } = useData(fetchLeads);
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
            <select className="form-control" style={{ width: 160 }} value={statusFilter} onChange={e => setStatus(e.target.value)}>
              <option value="">{t('crm.allStatuses')}</option>
              {LEAD_STATUSES.map(s => <option key={s} value={s}>{statusLabel[s]}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('form'); }}>
            {t('crm.addLead')}
          </button>
        </div>

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
                {leads.map(l => (
                  <tr key={l.id}>
                    <td className="td-primary">
                      {l.name}
                      {l.client_id && <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 10 }}>{t('crm.alreadyConverted')}</span>}
                    </td>
                    <td>{l.company || '—'}</td>
                    <td>{l.source || '—'}</td>
                    <td><span className={`badge badge-${LEAD_STATUS_BADGE[l.status] || 'gray'}`}>{statusLabel[l.status] || l.status}</span></td>
                    <td>{l.estimated_value ? fmtCurr(l.estimated_value) : '—'}</td>
                    <td>{fmtDate(l.expected_close)}</td>
                    <td>{l.assigned_name || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(l); setModal('form'); }}>{t('common.edit')}</button>
                        {!l.client_id
                          ? <button className="btn btn-sm btn-primary" onClick={() => { setSelected(l); setModal('convert'); }}>{t('crm.convertToClient')}</button>
                          : <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/clients/${l.client_id}`)}>{t('crm.viewClient')}</button>
                        }
                        <button className="btn btn-sm btn-danger" onClick={() => { setSelected(l); setModal('archive'); }}>Archive</button>
                      </div>
                    </td>
                  </tr>
                ))}
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
          confirmLabel="Archive" confirmClass="btn-danger"
          onConfirm={handleArchive} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
      {modal === 'convert' && selected && (
        <ConfirmModal title={t('crm.convertTitle')} message={t('crm.convertDesc')}
          confirmLabel={converting ? t('crm.converting') : t('crm.convertBtn')} confirmClass="btn-primary"
          onConfirm={handleConvert} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
    </div>
  );
}

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
            <select className="form-control" value={form.client_id || ''} onChange={f('client_id')}>
              <option value="">{t('crm.selectClient')}</option>
              {(clients || []).map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` — ${c.company}` : ''}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedLead')}</label>
            <select className="form-control" value={form.lead_id || ''} onChange={f('lead_id')}>
              <option value="">{t('crm.selectLead')}</option>
              {(leads || []).map(l => <option key={l.id} value={l.id}>{l.name}{l.company ? ` — ${l.company}` : ''}</option>)}
            </select>
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
  const { data: contacts, loading, error, reload } = useData(fetchContacts);
  const { data: clients } = useData(getCRMDropdownClients);
  const { data: leads }   = useData(getCRMLeads);

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
          <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('form'); }}>
            {t('crm.addContact')}
          </button>
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

// ─── Activity Form ────────────────────────────────────────────────────────────

const ACT_TYPES = ['call', 'email', 'meeting', 'task', 'note'];

function ActivityForm({ initial, clients, leads, onSave, onClose, t }) {
  const [form, setForm] = useState({
    type: 'call', subject: '', description: '', due_date: '', outcome: '',
    client_id: '', lead_id: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

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
            <select className="form-control" value={form.type} onChange={f('type')}>
              {ACT_TYPES.map(tp => <option key={tp} value={tp}>{typeLabel[tp]}</option>)}
            </select>
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
            <select className="form-control" value={form.client_id || ''} onChange={f('client_id')}>
              <option value="">{t('crm.selectClient')}</option>
              {(clients || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedLead')}</label>
            <select className="form-control" value={form.lead_id || ''} onChange={f('lead_id')}>
              <option value="">{t('crm.selectLead')}</option>
              {(leads || []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
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

  const { data: activities, loading, error, reload } = useData(fetchActivities);
  const { data: clients } = useData(getCRMDropdownClients);
  const { data: leads }   = useData(getCRMLeads);

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
            <select className="form-control" style={{ width: 140 }} value={typeFilter} onChange={e => setType(e.target.value)}>
              <option value="">{t('crm.allTypes')}</option>
              {ACT_TYPES.map(tp => <option key={tp} value={tp}>{typeLabel[tp]}</option>)}
            </select>
            <select className="form-control" style={{ width: 120 }} value={doneFilter} onChange={e => setDone(e.target.value)}>
              <option value="">{t('crm.allDone')}</option>
              <option value="false">{t('crm.onlyOpen')}</option>
              <option value="true">{t('crm.onlyDone')}</option>
            </select>
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

// ─── Deal Form ────────────────────────────────────────────────────────────────

const DEAL_STAGES = ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'];

function DealForm({ initial, clients, quotations, users, leads, onSave, onClose, t }) {
  const [form, setForm] = useState({
    title: '', client_id: '', lead_id: '', quotation_id: '',
    stage: 'Qualification', value: '', probability: 0,
    expected_close: '', assigned_to: '', notes: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  const stageLabel = { Qualification: t('crm.stageQualification'), Proposal: t('crm.stageProposal'), Negotiation: t('crm.stageNegotiation'), Won: t('crm.stageWon'), Lost: t('crm.stageLost') };

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        ...form,
        client_id:    form.client_id    ? Number(form.client_id)    : null,
        lead_id:      form.lead_id      ? Number(form.lead_id)      : null,
        quotation_id: form.quotation_id ? Number(form.quotation_id) : null,
        assigned_to:  form.assigned_to  ? Number(form.assigned_to)  : null,
        value:       Number(form.value)       || 0,
        probability: Number(form.probability) || 0,
      });
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('crm.dealTitle')} *</label>
            <input className="form-control" required value={form.title} onChange={f('title')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedClient')}</label>
            <select className="form-control" value={form.client_id || ''} onChange={f('client_id')}>
              <option value="">{t('crm.selectClient')}</option>
              {(clients || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedLead')}</label>
            <select className="form-control" value={form.lead_id || ''} onChange={f('lead_id')}>
              <option value="">{t('crm.selectLead')}</option>
              {(leads || []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.stage')}</label>
            <select className="form-control" value={form.stage || 'Qualification'} onChange={f('stage')}>
              {DEAL_STAGES.map(s => <option key={s} value={s}>{stageLabel[s]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.value')} ($)</label>
            <input className="form-control" type="number" min="0" value={form.value || ''} onChange={f('value')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.probability')}</label>
            <input className="form-control" type="number" min="0" max="100" value={form.probability || 0} onChange={f('probability')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.expectedClose')}</label>
            <input className="form-control" type="date" value={form.expected_close || ''} onChange={f('expected_close')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedQuotation')}</label>
            <select className="form-control" value={form.quotation_id || ''} onChange={f('quotation_id')}>
              <option value="">{t('crm.selectQuotation')}</option>
              {(quotations || []).map(q => <option key={q.id} value={q.id}>{q.quote_number} — {q.client_name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.assignedTo')}</label>
            <select className="form-control" value={form.assigned_to || ''} onChange={f('assigned_to')}>
              <option value="">{t('crm.selectUser')}</option>
              {(users || []).map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
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

// ─── Pipeline Tab ─────────────────────────────────────────────────────────────

function PipelineTab({ t }) {
  const [modal, setModal]       = useState(null);
  const [selected, setSelected] = useState(null);
  const [lostReason, setLostReason] = useState('');
  const [pendingStage, setPendingStage] = useState(null);

  const { data: deals, loading, error, reload } = useData(getCRMDeals);
  const { data: clients }    = useData(getCRMDropdownClients);
  const { data: quotations } = useData(getCRMDropdownQuotations);
  const { data: users }      = useData(getCRMDropdownUsers);
  const { data: leads }      = useData(getCRMLeads);

  const stageLabel = { Qualification: t('crm.stageQualification'), Proposal: t('crm.stageProposal'), Negotiation: t('crm.stageNegotiation'), Won: t('crm.stageWon'), Lost: t('crm.stageLost') };
  const stageAccentVar = { Qualification: 'var(--blue)', Proposal: 'var(--accent)', Negotiation: 'var(--orange)', Won: 'var(--green)', Lost: 'var(--red)' };

  async function handleSaveDeal(data) {
    try {
      if (selected && modal === 'edit') { await updateCRMDeal(selected.id, data); toast(t('crm.dealUpdated')); }
      else                              { await createCRMDeal(data);               toast(t('crm.dealCreated')); }
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleMoveStage(deal, stage) {
    if (stage === 'Lost') { setSelected(deal); setPendingStage(stage); setLostReason(''); setModal('lost'); return; }
    try { await updateDealStage(deal.id, { stage }); reload(); }
    catch (e) { toast(e.message, 'red'); }
  }

  async function handleConfirmLost() {
    try {
      await updateDealStage(selected.id, { stage: 'Lost', lost_reason: lostReason });
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function handleArchive() {
    try {
      await archiveCRMDeal(selected.id);
      toast(t('crm.dealArchived'));
      setModal(null); setSelected(null); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  const byStage = {};
  DEAL_STAGES.forEach(s => { byStage[s] = []; });
  (deals || []).forEach(d => { if (byStage[d.stage]) byStage[d.stage].push(d); });
  const totalPipeline = (deals || []).filter(d => !['Won', 'Lost'].includes(d.stage)).reduce((a, d) => a + (d.value || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          <strong>{t('crm.totalPipelineValue')}:</strong> {fmtCurr(totalPipeline)}
        </span>
        <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('create'); }}>
          {t('crm.addDeal')}
        </button>
      </div>

      {loading ? <LoadingSpinner /> :
       error   ? <ErrorAlert message={error} onRetry={reload} /> :
       !deals?.length ? <EmptyState message={t('crm.noDeals')} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, overflowX: 'auto', minWidth: 0 }}>
          {DEAL_STAGES.map(stage => (
            <div key={stage} style={{ minWidth: 180 }}>
              {/* Column header */}
              <div style={{ marginBottom: 10, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderTop: `3px solid ${stageAccentVar[stage]}`, borderRadius: 'var(--radius)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)' }}>{stageLabel[stage]}</span>
                  <span className="badge badge-gray">{byStage[stage].length}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, fontWeight: 600 }}>
                  {fmtCurr(byStage[stage].reduce((a, d) => a + (d.value || 0), 0))}
                </div>
              </div>

              {/* Deal cards */}
              {byStage[stage].length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '16px 0' }}>—</div>
              )}
              {byStage[stage].map(deal => (
                <div key={deal.id} className="card" style={{ padding: '12px 14px', marginBottom: 8 }}>
                  <div className="td-primary" style={{ fontSize: 13, marginBottom: 3, lineHeight: 1.3 }}>{deal.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>{deal.client_name || deal.lead_name || '—'}</div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: stageAccentVar[stage], marginBottom: 6 }}>{fmtCurr(deal.value)}</div>

                  {deal.probability > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${deal.probability}%`, background: stageAccentVar[stage], borderRadius: 4 }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{deal.probability}% probability</div>
                    </div>
                  )}

                  {deal.expected_close && (
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 8 }}>
                      Close: {fmtDate(deal.expected_close)}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(deal); setModal('edit'); }} style={{ fontSize: 11 }}>
                      {t('common.edit')}
                    </button>
                    {stage !== 'Won' && stage !== 'Lost' && (
                      <>
                        {DEAL_STAGES.indexOf(stage) < 2 && (
                          <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
                            onClick={() => handleMoveStage(deal, DEAL_STAGES[DEAL_STAGES.indexOf(stage) + 1])}>
                            →
                          </button>
                        )}
                        <button className="btn btn-sm btn-primary" style={{ fontSize: 11, background: 'var(--green)', borderColor: 'var(--green)' }}
                          onClick={() => handleMoveStage(deal, 'Won')}>W</button>
                        <button className="btn btn-sm btn-danger" style={{ fontSize: 11 }}
                          onClick={() => handleMoveStage(deal, 'Lost')}>L</button>
                      </>
                    )}
                    <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
                      onClick={() => { setSelected(deal); setModal('archive'); }}>
                      ⋯
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {(modal === 'create' || modal === 'edit') && (
        <Modal title={modal === 'edit' ? t('crm.editDeal') : t('crm.newDeal')} onClose={() => { setModal(null); setSelected(null); }} size="lg">
          <DealForm initial={modal === 'edit' ? selected : null} clients={clients || []} quotations={quotations || []}
            users={users || []} leads={leads || []}
            onSave={handleSaveDeal} onClose={() => { setModal(null); setSelected(null); }} t={t} />
        </Modal>
      )}
      {modal === 'archive' && selected && (
        <ConfirmModal title={t('crm.archiveDeal')} message={t('crm.archiveDealMsg')}
          confirmLabel="Archive" confirmClass="btn-danger"
          onConfirm={handleArchive} onCancel={() => { setModal(null); setSelected(null); }} />
      )}
      {modal === 'lost' && selected && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModal(null)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <span className="modal-title">{t('crm.markLost')}</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
                Mark <strong>{selected.title}</strong> as Lost?
              </p>
              <div className="form-group">
                <label className="form-label">{t('crm.lostReason')}</label>
                <input className="form-control" value={lostReason} onChange={e => setLostReason(e.target.value)} placeholder="Optional…" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setModal(null); setSelected(null); }}>{t('common.cancel')}</button>
              <button className="btn btn-danger" onClick={handleConfirmLost}>Confirm Lost</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main CRM Page ────────────────────────────────────────────────────────────

const TABS = [
  { key: 'dashboard',  labelKey: 'crm.dashboard'  },
  { key: 'pipeline',   labelKey: 'crm.deals'       },
  { key: 'leads',      labelKey: 'crm.leads'       },
  { key: 'contacts',   labelKey: 'crm.contacts'    },
  { key: 'activities', labelKey: 'crm.activities'  },
];

export default function CRM() {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState('dashboard');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('crm.title')}</h1>
          <p className="page-subtitle">{t('crm.subtitle')}</p>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(tab => (
          <button key={tab.key}
            className={`tab-btn${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}>
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        {activeTab === 'dashboard'  && <DashboardTab  t={t} />}
        {activeTab === 'pipeline'   && <PipelineTab   t={t} />}
        {activeTab === 'leads'      && <LeadsTab       t={t} />}
        {activeTab === 'contacts'   && <ContactsTab    t={t} />}
        {activeTab === 'activities' && <ActivitiesTab  t={t} />}
      </div>
    </div>
  );
}
