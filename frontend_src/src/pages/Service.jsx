/**
 * Service — maintenance, installation and repair jobs.
 *
 * Two tabs because the module has two nouns: the JOBS being done, and the
 * customer EQUIPMENT they are done on. Equipment is a record rather than a text
 * field on the job, so a machine accumulates a history you can read back.
 *
 * Status is driven by one endpoint per transition rather than a status dropdown.
 * That mirrors the backend deliberately: completing a job consumes stock and
 * posts its cost, so it is an action with consequences, not a field to edit.
 */
import { useState } from 'react';
import { useData } from '../hooks/useData';
import {
  getServiceJobs, getServiceJob, startServiceJob, completeServiceJob,
  reopenServiceJob, invoiceServiceJob,
  getServiceEquipment, getServiceEquipmentOne, getClients,
} from '../api/client';
import {
  LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal,
  fmt, fmtDate, toast,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';
import JobForm from './service/JobForm.jsx';
import EquipmentForm from './service/EquipmentForm.jsx';
import { printWorkOrder } from '../utils/workOrder';

const STATUS_COLOR = {
  Draft: 'gray', Scheduled: 'blue', 'In Progress': 'yellow',
  Completed: 'green', Cancelled: 'red',
};

export default function Service() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('jobs');
  const [modal, setModal] = useState(null);
  const [active, setActive] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const jobs = useData(() => getServiceJobs(statusFilter ? { status: statusFilter } : {}),
                       [statusFilter]);
  const equipment = useData(getServiceEquipment, []);
  const clients = useData(getClients, []);

  const reload = () => { jobs.reload(); equipment.reload(); };

  async function open(id) {
    try {
      setActive(await getServiceJob(id));
      setModal('detail');
    } catch (err) { toast(err.message, 'red'); }
  }

  /** Every transition goes through here so the confirm, the toast and the
   *  reload are identical whichever button was pressed. */
  async function transition(fn, id, successMsg) {
    try {
      await fn(id);
      toast(successMsg);
      reload();
      if (active?.id === id) setActive(await getServiceJob(id));
    } catch (err) {
      toast(err.message, 'red');
    }
  }

  const busy = jobs.loading || equipment.loading;
  const error = jobs.error || equipment.error;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('service.title')}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="tabs">
            <button className={`tab ${view === 'jobs' ? 'active' : ''}`}
                    onClick={() => setView('jobs')}>{t('service.jobs')}</button>
            <button className={`tab ${view === 'equipment' ? 'active' : ''}`}
                    onClick={() => setView('equipment')}>{t('service.equipment')}</button>
          </div>
          {view === 'jobs' && can('service', 'create') && (
            <button className="btn btn-primary"
                    onClick={() => { setActive(null); setModal('job'); }}>
              {t('service.newJob')}
            </button>
          )}
          {view === 'equipment' && can('service', 'create') && (
            <button className="btn btn-primary"
                    onClick={() => { setActive(null); setModal('equipment'); }}>
              {t('service.newEquipment')}
            </button>
          )}
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={reload} />}
      {busy && <LoadingSpinner />}

      {!busy && view === 'jobs' && (
        <>
          <div className="filters">
            <select className="form-control" value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {['Draft', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'].map(s => (
                <option key={s} value={s}>{t(`service.status${s.replace(/\s/g, '')}`)}</option>
              ))}
            </select>
          </div>
          {!jobs.data?.length ? <EmptyState message={t('service.noJobs')} /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('service.jobNumber')}</th>
                    <th>{t('common.client')}</th>
                    <th>{t('service.equipment')}</th>
                    <th>{t('service.jobType')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('service.scheduledDate')}</th>
                    <th>{t('service.assignedTo')}</th>
                    <th className="r">{t('common.total')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map(j => (
                    <tr key={j.id}>
                      <td><button className="link" onClick={() => open(j.id)}>{j.job_number}</button></td>
                      <td>{j.client_name}</td>
                      <td>{j.equipment_name || <span className="muted">—</span>}</td>
                      <td>{j.job_type}</td>
                      <td><span className={`badge badge-${STATUS_COLOR[j.status] || 'gray'}`}>
                        {t(`service.status${(j.status || '').replace(/\s/g, '')}`)}
                      </span></td>
                      <td>{j.scheduled_date ? fmtDate(j.scheduled_date) : <span className="muted">—</span>}</td>
                      <td>{j.assigned_name || <span className="muted">{t('service.unassigned')}</span>}</td>
                      <td className="r">{fmt(j.total)}</td>
                      <td>
                        {/* Invoiced state is derived from the invoice, so it
                            stays correct when one is voided. */}
                        {j.status === 'Completed' && (
                          <span className={`badge badge-${j.invoice_id ? 'green' : 'yellow'}`}>
                            {j.invoice_id ? t('service.billed') : t('service.unbilled')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!busy && view === 'equipment' && (
        !equipment.data?.length ? <EmptyState message={t('service.noEquipment')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.client')}</th>
                  <th>{t('service.manufacturer')}</th>
                  <th>{t('service.model')}</th>
                  <th>{t('service.serialNumber')}</th>
                  <th>{t('service.location')}</th>
                  <th className="r">{t('service.jobs')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {equipment.data.map(e => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>{e.client_name}</td>
                    <td>{e.manufacturer || <span className="muted">—</span>}</td>
                    <td>{e.model || <span className="muted">—</span>}</td>
                    <td>{e.serial_number || <span className="muted">—</span>}</td>
                    <td>{e.location || <span className="muted">—</span>}</td>
                    <td className="r">{e.job_count}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-secondary" onClick={async () => {
                          try {
                            setActive(await getServiceEquipmentOne(e.id));
                            setModal('equipmentDetail');
                          } catch (err) { toast(err.message, 'red'); }
                        }}>{t('service.serviceHistory')}</button>
                        {can('service', 'edit') && (
                          <button className="btn btn-sm btn-secondary"
                                  onClick={() => { setActive(e); setModal('equipment'); }}>
                            {t('common.edit')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {modal === 'job' && (
        <Modal title={active ? t('service.jobs') : t('service.newJob')}
               onClose={() => setModal(null)} size="modal-lg">
          <JobForm
            job={active}
            clients={clients.data || []}
            onDone={() => { setModal(null); reload(); }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal === 'equipment' && (
        <Modal title={active ? t('common.edit') : t('service.newEquipment')}
               onClose={() => setModal(null)}>
          <EquipmentForm
            equipment={active}
            clients={clients.data || []}
            onDone={() => { setModal(null); reload(); }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal === 'equipmentDetail' && active && (
        <Modal title={active.name} onClose={() => setModal(null)} size="modal-lg">
          <div className="detail-grid">
            <div><label>{t('common.client')}</label><span>{active.client_name}</span></div>
            <div><label>{t('service.manufacturer')}</label><span>{active.manufacturer || '—'}</span></div>
            <div><label>{t('service.model')}</label><span>{active.model || '—'}</span></div>
            <div><label>{t('service.serialNumber')}</label><span>{active.serial_number || '—'}</span></div>
            <div><label>{t('service.installDate')}</label><span>{active.install_date ? fmtDate(active.install_date) : '—'}</span></div>
            <div><label>{t('service.location')}</label><span>{active.location || '—'}</span></div>
          </div>
          <h3 style={{ marginTop: 20 }}>{t('service.serviceHistory')}</h3>
          {!active.jobs?.length ? <EmptyState message={t('service.noJobs')} /> : (
            <table>
              <thead><tr>
                <th>{t('service.jobNumber')}</th><th>{t('service.jobType')}</th>
                <th>{t('common.status')}</th><th>{t('service.completedAt')}</th>
                <th className="r">{t('common.total')}</th>
              </tr></thead>
              <tbody>
                {active.jobs.map(j => (
                  <tr key={j.id}>
                    <td>{j.job_number}</td>
                    <td>{j.job_type}</td>
                    <td>{t(`service.status${(j.status || '').replace(/\s/g, '')}`)}</td>
                    <td>{j.completed_at ? fmtDate(j.completed_at) : '—'}</td>
                    <td className="r">{fmt(j.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}

      {modal === 'detail' && active && (
        <Modal title={active.job_number} onClose={() => setModal(null)} size="modal-lg">
          <JobDetail
            job={active}
            can={can}
            t={t}
            onEdit={() => setModal('job')}
            onTransition={transition}
            onInvoice={async () => {
              try {
                const r = await invoiceServiceJob(active.id);
                toast(`${t('service.invoiceRaised')}: ${r.invoice_number}`);
                reload();
                setActive(await getServiceJob(active.id));
              } catch (err) { toast(err.message, 'red'); }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** The job sheet: what was asked for, what was done, what it cost. */
function JobDetail({ job, can, t, onEdit, onTransition, onInvoice }) {
  const open = ['Draft', 'Scheduled', 'In Progress'].includes(job.status);
  const parts = (job.lines || []).filter(l => l.line_type === 'part');
  const charges = (job.lines || []).filter(l => l.line_type === 'charge');

  return (
    <>
      <div className="detail-grid">
        <div><label>{t('common.client')}</label><span>{job.client_name}</span></div>
        <div><label>{t('service.equipment')}</label>
          <span>{job.equipment ? `${job.equipment.name}${job.equipment.serial_number ? ` (${job.equipment.serial_number})` : ''}` : '—'}</span></div>
        <div><label>{t('service.jobType')}</label><span>{job.job_type}</span></div>
        <div><label>{t('common.status')}</label>
          <span className={`badge badge-${STATUS_COLOR[job.status] || 'gray'}`}>
            {t(`service.status${(job.status || '').replace(/\s/g, '')}`)}
          </span></div>
        <div><label>{t('service.scheduledDate')}</label>
          <span>{job.scheduled_date ? fmtDate(job.scheduled_date) : '—'}</span></div>
        <div><label>{t('service.completedAt')}</label>
          <span>{job.completed_at ? fmtDate(job.completed_at) : '—'}</span></div>
      </div>

      {job.reported_fault && (
        <p><strong>{t('service.reportedFault')}:</strong> {job.reported_fault}</p>
      )}
      {job.work_done && (
        <p><strong>{t('service.workDone')}:</strong> {job.work_done}</p>
      )}

      <h3>{t('service.partsAndCharges')}</h3>
      <table>
        <thead><tr>
          <th>{t('common.description')}</th><th className="r">{t('common.quantity')}</th>
          <th className="r">{t('common.unitPrice')}</th><th className="r">{t('common.total')}</th>
        </tr></thead>
        <tbody>
          {[...parts, ...charges].map(l => (
            <tr key={l.id}>
              <td>
                <span className={`badge badge-${l.line_type === 'part' ? 'blue' : 'gray'}`}>
                  {t(`service.${l.line_type}`)}
                </span>{' '}{l.name}
              </td>
              <td className="r">{l.quantity}</td>
              <td className="r">{fmt(l.unit_price)}</td>
              <td className="r">{fmt(l.quantity * l.unit_price)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan="3" className="r">{t('common.subtotal')}</td>
              <td className="r">{fmt(job.subtotal)}</td></tr>
          {job.tax_total > 0 && (
            <tr><td colSpan="3" className="r">{t('common.taxCol')}</td>
                <td className="r">{fmt(job.tax_total)}</td></tr>
          )}
          <tr><td colSpan="3" className="r"><strong>{t('common.total')}</strong></td>
              <td className="r"><strong>{fmt(job.total)}</strong></td></tr>
          {job.status === 'Completed' && (
            <>
              <tr><td colSpan="3" className="r">{t('service.partsCost')}</td>
                  <td className="r">{fmt(job.parts_cost)}</td></tr>
              <tr><td colSpan="3" className="r">{t('service.margin')}</td>
                  <td className="r">{fmt((job.total || 0) - (job.parts_cost || 0))}</td></tr>
            </>
          )}
        </tfoot>
      </table>

      {job.invoice && (
        <p style={{ marginTop: 12 }}>
          <strong>{t('service.billed')}:</strong> {job.invoice.invoice_number}
        </p>
      )}

      <div className="modal-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-secondary"
                onClick={() => printWorkOrder(job)}>{t('service.workOrder')}</button>
        {open && can('service', 'edit') && (
          <button className="btn btn-secondary" onClick={onEdit}>{t('common.edit')}</button>
        )}
        {['Draft', 'Scheduled'].includes(job.status) && can('service', 'edit') && (
          <button className="btn btn-secondary"
                  onClick={() => onTransition(startServiceJob, job.id, t('service.start'))}>
            {t('service.start')}
          </button>
        )}
        {open && can('service', 'edit') && (
          <ConfirmButton
            className="btn btn-primary"
            label={t('service.complete')}
            message={t('service.completeConfirm')}
            onConfirm={() => onTransition(completeServiceJob, job.id, t('service.jobCompleted'))}
          />
        )}
        {job.status === 'Completed' && !job.invoice && can('service', 'create') && (
          <button className="btn btn-primary" onClick={onInvoice}>
            {t('service.raiseInvoice')}
          </button>
        )}
        {job.status === 'Completed' && !job.invoice && can('service', 'edit') && (
          <ConfirmButton
            className="btn btn-secondary"
            label={t('service.reopen')}
            message={t('service.reopenConfirm')}
            onConfirm={() => onTransition(reopenServiceJob, job.id, t('service.jobReopened'))}
          />
        )}
      </div>
    </>
  );
}

/** A button that asks first. Completing and reopening both move stock and post
 *  to the ledger, so neither should be one careless click away. */
function ConfirmButton({ className, label, message, onConfirm }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setAsking(true)}>{label}</button>
      {asking && (
        <ConfirmModal
          message={message}
          confirmLabel={label}
          onConfirm={() => { setAsking(false); onConfirm(); }}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}
