import { useState } from 'react';
import { useData } from '../../hooks/useData';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  ExportButton, toast, fmtDate, NumberInput,
} from '../../components/shared';
import {
  getCRMDeals, createCRMDeal, updateCRMDeal, updateDealStage,
  archiveCRMDeal, unarchiveCRMDeal, getCRMDropdownClients,
  getCRMDropdownQuotations, getCRMDropdownUsers, getCRMLeads,
} from '../../api/client';
import { fmtCurr, DEAL_STAGES } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

// ─── Deal Form ────────────────────────────────────────────────────────────────


function DealForm({ initial, clients, quotations, users, leads, onSave, onClose, t }) {
  const [form, setForm] = useState({
    title: '', client_id: '', lead_id: '', quotation_id: '',
    stage: 'Qualification', value: '', probability: 0,
    expected_close: '', assigned_to: '', notes: '',
    ...(initial || {}),
  });
  const [saving, setSaving] = useState(false);
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  // SearchSelect hands over the value itself, not an event.
  const fv = k => v => setForm(p => ({ ...p, [k]: v }));

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
          <div className="form-group">
            <label className="form-label">{t('crm.stage')}</label>
            <SearchSelect className="form-control" value={form.stage || 'Qualification'} onChange={fv('stage')}
              options={DEAL_STAGES.map(s => ({ value: s, label: stageLabel[s] }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.value')} ($)</label>
            <NumberInput className="form-control" min="0" value={form.value || ''} onChange={f('value')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.probability')}</label>
            <NumberInput className="form-control" min="0" max="100" value={form.probability || 0} onChange={f('probability')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.expectedClose')}</label>
            <input className="form-control" type="date" value={form.expected_close || ''} onChange={f('expected_close')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.linkedQuotation')}</label>
            <SearchSelect className="form-control" value={form.quotation_id || ''} onChange={fv('quotation_id')}
              placeholder={t('crm.selectQuotation')}
              options={(quotations || []).map(q => ({ value: q.id, label: q.client_name, hint: q.quote_number }))} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('crm.assignedTo')}</label>
            <SearchSelect className="form-control" value={form.assigned_to || ''} onChange={fv('assigned_to')}
              placeholder={t('crm.selectUser')}
              options={(users || []).map(u => ({ value: u.id, label: u.full_name || u.username }))} />
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
  const [showArchived, setShowArchived] = useState(false);

  const { data: deals, loading, error, reload } = useData(
    (s) => getCRMDeals(showArchived ? { archived: 'only' } : {}, s),
    [showArchived],
  );
  const { data: clients }    = useData(getCRMDropdownClients);
  const { data: quotations } = useData(getCRMDropdownQuotations);
  const { data: users }      = useData(getCRMDropdownUsers);
  const { data: leads }      = useData((s) => getCRMLeads({}, s));

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

  async function handleUnarchive(deal) {
    try {
      await unarchiveCRMDeal(deal.id);
      toast(t('crm.dealRestored')); reload();
    } catch (e) { toast(e.message, 'red'); }
  }

  // The board only ever shows ACTIVE deals; archived ones surface as a flat
  // restore list when "Show archived" is on (a kanban column per stage would
  // mix inert cards into the live pipeline).
  const activeDeals   = (deals || []).filter(d => !d.archived_at);
  const archivedDeals = (deals || []).filter(d =>  d.archived_at);
  const byStage = {};
  DEAL_STAGES.forEach(s => { byStage[s] = []; });
  activeDeals.forEach(d => { if (byStage[d.stage]) byStage[d.stage].push(d); });
  const totalPipeline = activeDeals.filter(d => !['Won', 'Lost'].includes(d.stage)).reduce((a, d) => a + (d.value || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          <strong>{t('crm.totalPipelineValue')}:</strong> {fmtCurr(totalPipeline)}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {deals && deals.length > 0 && (
            <ExportButton
              data={deals.map(d => ({
                Deal:            d.name,
                Client:          d.client_name || '',
                Stage:           d.stage,
                Value:           d.value || 0,
                Probability:     d.probability ?? '',
                Expected_Close:  d.expected_close || '',
                Assigned_To:     d.assigned_name || '',
                Quotation:       d.quotation_number || '',
                Lost_Reason:     d.lost_reason || '',
                Created:         fmtDate(d.created_at),
              }))}
              filename="CRM_Deals" sheetName="Pipeline" />
          )}
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)} />
            {t('common.showArchived')}
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => { setSelected(null); setModal('create'); }}>
            {t('crm.addDeal')}
          </button>
        </div>
      </div>

      {showArchived && (
        <div className="card" style={{ marginBottom: 16, padding: 0 }}>
          <div className="card-header"><strong>{t('common.archivedBadge')}</strong></div>
          {archivedDeals.length === 0
            ? <div style={{ padding: 16, color: 'var(--text-3)', fontSize: 13 }}>{t('crm.noArchivedDeals')}</div>
            : (
            <div className="table-wrap"><table><tbody>
              {archivedDeals.map(d => (
                <tr key={d.id} className="row-archived">
                  <td className="td-primary">{d.title}</td>
                  <td>{d.client_name || d.lead_name || '—'}</td>
                  <td className="fw-600">{fmtCurr(d.value)}</td>
                  <td style={{ textAlign: 'end' }}>
                    <button className="btn btn-sm btn-secondary" style={{ color: 'var(--affirm-ink)', whiteSpace: 'nowrap' }}
                      onClick={() => handleUnarchive(d)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('common.restore')}</button>
                  </td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </div>
      )}

      {loading ? <LoadingSpinner /> :
       error   ? <ErrorAlert message={error} onRetry={reload} /> :
       !activeDeals.length ? <EmptyState message={t('crm.noDeals')} /> : (
        <div className="kanban-board" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, overflowX: 'auto', minWidth: 0 }}>
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
          confirmLabel={t('common.archive')} confirmClass="btn-danger"
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

export { PipelineTab };
