import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, fmt, fmtDate, toast } from '../../components/shared';
import { getApplicant, changeApplicantStatus, uploadApplicantFile, deleteApplicantFile,
         applicantFileURL, getApplicantOffers, changeOfferStatus, archiveOffer, getOfferPrintData } from '../../api/client';
import { TERMINAL, FILE_KINDS, APP_BADGE, PIPELINE_KEY, INT_TYPE_KEY, INT_STATUS_KEY,
         INT_DECISION_KEY, FILE_KIND_KEY, OFFER_STATUS_TEXT_KEY, OFFER_CT_KEY, OFFER_STATUS_BADGE , tEnum } from './constants';
import { InterviewForm } from './InterviewForm';
import { ConvertForm } from './ConvertForm';
import { OfferForm } from './OfferForm';
import { Field, Section, FileSlot } from './primitives';

function ApplicantDetail({ appId, canEdit, canDelete, positions, onClose, onChanged }) {
  const { t } = useLocale();
  const [app, setApp]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [busy, setBusy]       = useState(false);
  const [showInterview, setShowInterview] = useState(false);
  const [editInterview, setEditInterview] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [acceptReason, setAcceptReason] = useState('');
  const [converting, setConverting] = useState(false);

  // Pre-employment offer letters. Loaded lazily after the applicant detail
  // resolves so the modal opens fast even when an applicant has several
  // historical offers attached.
  const [offers, setOffers] = useState([]);
  const [showOffer, setShowOffer] = useState(false);
  const [editOffer, setEditOffer] = useState(null);
  const [archivingOffer, setArchivingOffer] = useState(null);

  const reloadOffers = useCallback(async () => {
    try { setOffers(await getApplicantOffers(appId)); }
    catch { /* non-fatal — the section will render empty */ }
  }, [appId]);
  useEffect(() => { reloadOffers(); }, [reloadOffers]);

  async function printOffer(offerId) {
    try {
      const data = await getOfferPrintData(offerId);
      printOfferHTML(data.offer, data.company, data.lebanon);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function transitionOffer(offerId, status, declined_reason = null) {
    try {
      await changeOfferStatus(offerId, { status, declined_reason });
      await reloadOffers();
      // Per-status toast key so translations can read naturally in both languages.
      toast(t(`recruitment.offerToast_${status}`));
    } catch (err) { toast(err.message, 'error'); }
  }

  async function doArchiveOffer(offer) {
    setArchivingOffer(null);
    try {
      await archiveOffer(offer.id);
      toast(t('recruitment.offerArchived'));
      await reloadOffers();
    } catch (err) { toast(err.message, 'error'); }
  }

  const fileInputRef = useRef(null);
  const fileKindRef  = useRef('cv');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setApp(await getApplicant(appId)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  async function advance(to, note = null, reason = null) {
    setBusy(true);
    try {
      await changeApplicantStatus(appId, { new_status: to, note, reason });
      await load(); onChanged();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function handleUpload(kind, file) {
    if (!file) return;
    // Accept PDF + Word. Office files sometimes report an empty/octet-stream
    // MIME type, so fall back to the extension (matches the backend check).
    const okType = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(file.type);
    const okExt = /\.(pdf|docx?)$/i.test(file.name || '');
    if (!okType && !okExt) {
      toast(t('recruitment.pdfOnly'), 'error'); return;
    }
    setBusy(true);
    try {
      await uploadApplicantFile(appId, kind, file);
      toast(t('recruitment.fileUploaded')); await load();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  async function handleDeleteFile(fileId) {
    try { await deleteApplicantFile(fileId); toast(t('recruitment.fileDeleted')); await load(); }
    catch (err) { toast(err.message, 'error'); }
  }

  if (loading) return <Modal title={t('recruitment.detailTitleApplicant')} onClose={onClose} size="modal-lg"><div className="modal-body"><LoadingSpinner /></div></Modal>;
  if (error || !app) return <Modal title={t('recruitment.detailTitleApplicant')} onClose={onClose} size="modal-lg"><div className="modal-body"><ErrorAlert message={error || t('recruitment.notFound')} onRetry={load} /></div></Modal>;

  const isTerminal = TERMINAL.has(app.status);
  const cv = (app.files || []).find(f => f.kind === 'cv');
  const otherFiles = (app.files || []).filter(f => f.kind !== 'cv');

  return (
    <Modal title={`${app.full_name}${app.position_title ? ` — ${app.position_title}` : ''}`}
           onClose={onClose} size="modal-lg">
      <div className="modal-body">

        {/* Status + quick actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
          <span className={`badge badge-${APP_BADGE[app.status] || 'gray'}`} style={{ fontSize: 13, padding: '4px 10px' }}>
            {tEnum(t, PIPELINE_KEY, app.status)}
          </span>
          {!isTerminal && canEdit && (
            <>
              {nextStatus(app.status) && (
                <button className="btn btn-sm btn-primary" disabled={busy}
                  onClick={() => advance(nextStatus(app.status))}>
                  {t('recruitment.moveTo', { next: tEnum(t, PIPELINE_KEY, nextStatus(app.status)) })}
                </button>
              )}
              {app.status !== 'Accepted' && (
                <button className="btn btn-sm btn-success" disabled={busy}
                  onClick={() => { setAccepting(true); setAcceptReason(''); }}>
                  {t('recruitment.accept')}
                </button>
              )}
              <button className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => { setRejecting(true); setRejectReason(''); }}>
                {t('recruitment.reject')}
              </button>
            </>
          )}
          {app.status === 'Accepted' && !app.converted_employee_id && canEdit && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => setConverting(true)}>
              {t('recruitment.onboardAsEmployee')}
            </button>
          )}
          {app.converted_employee_id && (
            <span className="badge badge-green">
              {t('recruitment.onboarded', { code: app.converted_employee_code })}
            </span>
          )}
        </div>

        {/* Profile */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 22 }}>
          <Field label={t('recruitment.fEmail')}      value={app.email || '—'} />
          <Field label={t('recruitment.fPhone')}      value={app.phone || '—'} />
          <Field label={t('recruitment.fSource')}     value={app.source || '—'} />
          <Field label={t('recruitment.fPosition')}   value={app.position_title || '—'} />
          <Field label={t('recruitment.fDepartment')} value={app.department_name || '—'} />
          <Field label={t('recruitment.fExpected')}   value={app.expected_salary ? fmt(app.expected_salary) : '—'} />
          {app.offered_salary && (
            <Field label={t('recruitment.fOffered')} value={<strong>{fmt(app.offered_salary)}</strong>} />
          )}
          <Field label={t('recruitment.fRating')}     value={app.rating ? '★'.repeat(app.rating) : '—'} />
          <Field label={t('recruitment.fApplied')}    value={fmtDate(app.applied_at)} />
        </div>

        {app.notes && (
          <Section title={t('recruitment.sectionNotes')}>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{app.notes}</div>
          </Section>
        )}

        {/* Hire / rejection rationale — surfaced separately from the audit
            trail so reviewers see *why* a decision was made at a glance. */}
        {app.status === 'Accepted' && app.accepted_reason && (
          <Section title={t('recruitment.sectionWhyAccepted')}>
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--radius)',
              background: 'var(--green-light)', color: 'var(--green)',
              fontSize: 13,
            }}>
              {app.accepted_reason}
            </div>
          </Section>
        )}
        {app.status === 'Rejected' && app.rejected_reason && (
          <Section title={t('recruitment.sectionWhyRejected')}>
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--radius)',
              background: 'var(--red-light)', color: 'var(--red)',
              fontSize: 13,
            }}>
              {app.rejected_reason}
            </div>
          </Section>
        )}

        {/* Files (CV + attachments) */}
        <Section title={t('recruitment.sectionDocs')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FileSlot
              label={t('recruitment.cvLabel')} file={cv} canEdit={canEdit}
              onPick={() => { fileKindRef.current = 'cv'; fileInputRef.current?.click(); }}
              onDelete={() => handleDeleteFile(cv.id)}
              urlFn={applicantFileURL} />
            {canEdit && (
              <div style={{ padding: 12, border: '1px dashed var(--border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
                  Other documents
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {FILE_KINDS.filter(k => k !== 'cv').map(k => (
                    <button key={k} className="btn btn-sm btn-secondary" disabled={busy}
                      onClick={() => { fileKindRef.current = k; fileInputRef.current?.click(); }}>
                      + {tEnum(t, FILE_KIND_KEY, k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {otherFiles.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {otherFiles.map(f => (
                <div key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', fontSize: 13,
                }}>
                  <span style={{ flex: 1 }}>
                    <strong>{tEnum(t, FILE_KIND_KEY, f.kind)}</strong> · {f.filename}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {(f.size_bytes / 1024).toFixed(0)} KB
                  </span>
                  <a className="btn btn-sm btn-secondary" href={applicantFileURL(f.id)}
                     target="_blank" rel="noopener noreferrer">{t('recruitment.view')}</a>
                  {canEdit && <button className="btn btn-sm btn-danger" onClick={() => handleDeleteFile(f.id)}>{t('recruitment.delete')}</button>}
                </div>
              ))}
            </div>
          )}
          <input ref={fileInputRef} type="file"
                 accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                 style={{ display: 'none' }}
                 onChange={e => { handleUpload(fileKindRef.current, e.target.files?.[0]); e.target.value = ''; }} />
        </Section>

        {/* Interviews */}
        <Section title={t('recruitment.sectionInterviews')} right={canEdit && (
          <button className="btn btn-sm btn-secondary" onClick={() => setShowInterview(true)}>{t('recruitment.scheduleBtn')}</button>
        )}>
          {(app.interviews || []).length === 0 ? (
            <EmptyState message={t('recruitment.noInterviewsYet')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.intColType')}</th>
                    <th>{t('recruitment.intColWhen')}</th>
                    <th>{t('recruitment.intColInterviewer')}</th>
                    <th>{t('recruitment.colStatus')}</th>
                    <th>{t('recruitment.intColScore')}</th>
                    <th>{t('recruitment.intColDecision')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {app.interviews.map(iv => (
                    <tr key={iv.id}>
                      <td>{tEnum(t, INT_TYPE_KEY, iv.interview_type)}</td>
                      <td>{fmtDate(iv.scheduled_at)}</td>
                      <td>{iv.interviewer_user_name || iv.interviewer_name || '—'}</td>
                      <td><span className={`badge badge-${iv.status === 'Completed' ? 'green' : iv.status === 'Cancelled' ? 'red' : 'yellow'}`}>{tEnum(t, INT_STATUS_KEY, iv.status)}</span></td>
                      <td>{iv.score != null ? `${iv.score}/10` : '—'}</td>
                      <td>{iv.decision ? tEnum(t, INT_DECISION_KEY, iv.decision) : '—'}</td>
                      <td>
                        {canEdit && <button className="btn btn-sm btn-secondary" onClick={() => setEditInterview(iv)}>{t('recruitment.actionEdit')}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Offer letters / pre-employment contracts */}
        <Section
          title={t('recruitment.sectionOffers')}
          right={canEdit && app.status !== 'Rejected' && app.status !== 'Withdrawn' && (
            <button className="btn btn-sm btn-primary"
                    onClick={() => { setEditOffer(null); setShowOffer(true); }}>
              {t('recruitment.addOffer')}
            </button>
          )}
        >
          {offers.length === 0 ? (
            <EmptyState
              icon="📄"
              message={app.status === 'Accepted'
                ? t('recruitment.noOffersAccepted')
                : t('recruitment.noOffersOther')}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('recruitment.offerColNumber')}</th>
                    <th>{t('recruitment.offerColType')}</th>
                    <th>{t('recruitment.offerColStatus')}</th>
                    <th>{t('recruitment.offerColStart')}</th>
                    <th style={{ textAlign: 'right' }}>{t('recruitment.offerColSalary')}</th>
                    <th>{t('recruitment.offerColActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.map(o => (
                    <tr key={o.id}>
                      <td className="text-mono">{o.offer_number || `#${o.id}`}</td>
                      <td>{tEnum(t, OFFER_CT_KEY, o.contract_type)}</td>
                      <td>
                        <span className={`badge badge-${OFFER_STATUS_BADGE[o.status] || 'gray'}`}>
                          {tEnum(t, OFFER_STATUS_TEXT_KEY, o.status)}
                        </span>
                      </td>
                      <td>{fmtDate(o.start_date)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {Number(o.salary || 0).toLocaleString('en-US', {
                          style: 'currency', currency: o.salary_currency || 'USD',
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button className="btn btn-sm btn-secondary"
                                  onClick={() => printOffer(o.id)}>
                            {t('recruitment.offerActionPrint')}
                          </button>
                          {/* mailto: opens the user's email client with a body
                              describing the attached PDF. We don't auto-attach
                              because mailto: can't carry attachments — the user
                              attaches the PDF they just downloaded. */}
                          {o.status !== 'Declined' && o.status !== 'Expired' && app.email && (
                            <a className="btn btn-sm btn-secondary"
                               href={mailtoOffer(o, app)}>
                              {t('recruitment.offerActionEmail')}
                            </a>
                          )}
                          {canEdit && o.status === 'Draft' && (
                            <>
                              <button className="btn btn-sm btn-secondary"
                                      onClick={() => { setEditOffer(o); setShowOffer(true); }}>
                                {t('recruitment.actionEdit')}
                              </button>
                              <button className="btn btn-sm btn-primary"
                                      onClick={() => transitionOffer(o.id, 'Sent')}>
                                {t('recruitment.offerActionMarkSent')}
                              </button>
                            </>
                          )}
                          {canEdit && o.status === 'Sent' && (
                            <>
                              <button className="btn btn-sm btn-success"
                                      onClick={() => transitionOffer(o.id, 'Accepted')}>
                                {t('recruitment.offerActionAccepted')}
                              </button>
                              <button className="btn btn-sm btn-danger"
                                      onClick={() => {
                                        const reason = window.prompt(t('recruitment.offerDeclinePrompt'), '');
                                        if (reason !== null) transitionOffer(o.id, 'Declined', reason || 'Declined');
                                      }}>
                                {t('recruitment.offerActionDeclined')}
                              </button>
                            </>
                          )}
                          {canDelete && (
                            <button className="btn btn-sm btn-danger"
                                    onClick={() => setArchivingOffer(o)}
                                    title={t('recruitment.actionArchive')}>
                              🗑
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Status history */}
        <Section title={t('recruitment.sectionHistory')}>
          {(app.status_history || []).length === 0 ? <EmptyState message="—" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {app.status_history.map(h => (
                <div key={h.id} style={{
                  padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', fontSize: 12,
                }}>
                  <div><strong>{h.old_status ? tEnum(t, PIPELINE_KEY, h.old_status) : '—'} → {tEnum(t, PIPELINE_KEY, h.new_status)}</strong></div>
                  <div style={{ color: 'var(--text-3)', marginTop: 2 }}>
                    {fmtDate(h.created_at)}{h.changed_by_name ? ` · ${t('recruitment.historyBy', { who: h.changed_by_name })}` : ''}
                    {h.note ? ` · ${h.note}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('recruitment.close')}</button>
      </div>

      {showInterview && (
        <InterviewForm
          appId={appId}
          onClose={() => setShowInterview(false)}
          onSaved={() => { setShowInterview(false); load(); onChanged(); }}
        />
      )}
      {editInterview && (
        <InterviewForm
          appId={appId}
          existing={editInterview}
          onClose={() => setEditInterview(null)}
          onSaved={() => { setEditInterview(null); load(); onChanged(); }}
        />
      )}
      {accepting && (
        <ConfirmModal
          title={t('recruitment.acceptTitle')}
          message={(
            <div>
              <p style={{ marginBottom: 10 }}>
                {/* Dangerously-set so the <strong> wrapping the name renders.
                    Safe — we control the format string and the name is escaped
                    server-side before reaching the DB. */}
                <span dangerouslySetInnerHTML={{
                  __html: t('recruitment.acceptPrompt', { name: `<strong>${(app.full_name || '').replace(/</g, '&lt;')}</strong>` }),
                }} />
              </p>
              <label className="form-label">{t('recruitment.acceptReason')}</label>
              <input className="form-control" placeholder={t('recruitment.acceptReasonPh')}
                value={acceptReason} onChange={e => setAcceptReason(e.target.value)} />
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
                {t('recruitment.acceptHint')}
              </p>
            </div>
          )}
          confirmLabel={t('recruitment.acceptConfirm')}
          confirmClass="btn-success"
          onConfirm={async () => {
            await advance('Accepted', null, acceptReason || null);
            setAccepting(false);
          }}
          onCancel={() => setAccepting(false)}
        />
      )}
      {rejecting && (
        <ConfirmModal
          title={t('recruitment.rejectTitle')}
          message={(
            <div>
              <p style={{ marginBottom: 10 }}>
                <span dangerouslySetInnerHTML={{
                  __html: t('recruitment.rejectPrompt', { name: `<strong>${(app.full_name || '').replace(/</g, '&lt;')}</strong>` }),
                }} />
              </p>
              <label className="form-label">{t('recruitment.rejectReason')}</label>
              <input className="form-control" placeholder={t('recruitment.rejectReasonPh')}
                value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            </div>
          )}
          confirmLabel={t('recruitment.rejectConfirm')}
          confirmClass="btn-danger"
          onConfirm={async () => {
            await advance('Rejected', null, rejectReason || t('recruitment.rejectDefault'));
            setRejecting(false);
          }}
          onCancel={() => setRejecting(false)}
        />
      )}
      {converting && (
        <ConvertForm
          applicant={app}
          positions={positions}
          onClose={() => setConverting(false)}
          onConverted={async () => { setConverting(false); await load(); onChanged(); }}
        />
      )}
      {showOffer && (
        <OfferForm
          appId={appId}
          applicant={app}
          existing={editOffer}
          onClose={() => setShowOffer(false)}
          onSaved={() => { setShowOffer(false); reloadOffers(); }}
        />
      )}
      {archivingOffer && (
        <ConfirmModal
          title={t('recruitment.offerArchiveTitle')}
          message={t('recruitment.offerArchivePrompt', { number: archivingOffer.offer_number })}
          confirmLabel={t('recruitment.offerArchiveConfirm')}
          confirmClass="btn-danger"
          onConfirm={() => doArchiveOffer(archivingOffer)}
          onCancel={() => setArchivingOffer(null)}
        />
      )}
    </Modal>
  );
}

function nextStatus(current) {
  const order = ['Applied', 'Screening', 'Interview', 'Technical Test'];
  const i = order.indexOf(current);
  return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
}


// ── Interview create / edit ────────────────────────────────────────────────

export { ApplicantDetail };
