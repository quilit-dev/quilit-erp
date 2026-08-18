/**
 * Service — repairs, maintenance and installations that have been carried out.
 *
 * Two tabs because the module has two nouns: the SERVICES done, and the customer
 * EQUIPMENT they were done on. Equipment is a record rather than a text field,
 * so a machine accumulates a history you can read back.
 *
 * A service is a record of completed work, not a plan. Recording one consumes
 * its parts, posts their cost and raises the invoice in a single step — so the
 * only other action here is Cancel, which reverses all three. There is no draft,
 * no schedule and no start/finish ladder, because this module does not track
 * work in flight.
 */
import { useState } from 'react';
import { useData } from '../hooks/useData';
import {
  getServiceJobs, getServiceJob, cancelServiceJob, invoiceServiceJob,
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

export default function Service() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('jobs');
  const [modal, setModal] = useState(null);
  const [active, setActive] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const jobs = useData(getServiceJobs, []);
  const equipment = useData(getServiceEquipment, []);
  const clients = useData(getClients, []);

  const reload = () => { jobs.reload(); equipment.reload(); };

  async function open(id) {
    try {
      setActive(await getServiceJob(id));
      setModal('detail');
    } catch (err) { toast(err.message, 'red'); }
  }

  async function doCancel(id) {
    try {
      const r = await cancelServiceJob(id, { reason: t('service.cancelledByUser') });
      toast(r.voided_invoice
        ? `${t('service.cancelled')} — ${t('service.invoiceVoided')}: ${r.voided_invoice}`
        : t('service.cancelled'));
      setCancelling(null);
      setModal(null);
      reload();
    } catch (err) {
      toast(err.message, 'red');
      setCancelling(null);
    }
  }

  const busy = jobs.loading || equipment.loading;
  const error = jobs.error || equipment.error;

  return (
    <div>
      <div className="page-header">
        <h1>{t('service.title')}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className={`btn btn-sm ${view === 'jobs' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setView('jobs')}>{t('service.jobs')}</button>
          <button className={`btn btn-sm ${view === 'equipment' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setView('equipment')}>{t('service.equipment')}</button>
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
        !jobs.data?.length ? <EmptyState message={t('service.noJobs')} /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('service.jobNumber')}</th>
                  <th>{t('common.client')}</th>
                  <th>{t('service.equipment')}</th>
                  <th>{t('service.jobType')}</th>
                  <th>{t('service.serviceDate')}</th>
                  <th>{t('service.assignedTo')}</th>
                  <th className="text-right">{t('common.total')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map(j => (
                  <tr key={j.id}>
                    <td>
                      <button style={{ fontWeight: 600, color: 'var(--accent)',
                                       background: 'none', border: 'none',
                                       cursor: 'pointer', padding: 0 }}
                              onClick={() => open(j.id)}>{j.job_number}</button>
                    </td>
                    <td>{j.client_name}</td>
                    <td>{j.equipment_name || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td>{j.job_type}</td>
                    <td>{j.completed_at ? fmtDate(j.completed_at)
                                        : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td>{j.assigned_name || <span style={{ color: 'var(--text-3)' }}>{t('service.unassigned')}</span>}</td>
                    <td className="text-right">{fmt(j.total)}</td>
                    <td>
                      {/* Billed state is derived from the invoice, so it stays
                          correct when one is voided. */}
                      {j.status === 'Cancelled'
                        ? <span className="badge badge-red">{t('service.statusCancelled')}</span>
                        : (
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
        )
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
                  <th className="text-right">{t('service.jobs')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {equipment.data.map(e => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>{e.client_name}</td>
                    <td>{e.manufacturer || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td>{e.model || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td>{e.serial_number || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td>{e.location || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                    <td className="text-right">{e.job_count}</td>
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
        <Modal title={t('service.newJob')} onClose={() => setModal(null)} size="modal-lg">
          <JobForm
            clients={clients.data || []}
            onDone={(res) => {
              setModal(null);
              reload();
              toast(res?.invoice?.invoice_number
                ? `${t('service.jobCreated')} — ${t('service.invoiceRaised')}: ${res.invoice.invoice_number}`
                : t('service.jobCreated'));
            }}
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
          <div className="modal-body">
            <div className="form-grid">
              <Row label={t('common.client')} value={active.client_name} />
              <Row label={t('service.manufacturer')} value={active.manufacturer} />
              <Row label={t('service.model')} value={active.model} />
              <Row label={t('service.serialNumber')} value={active.serial_number} />
              <Row label={t('service.installDate')}
                   value={active.install_date ? fmtDate(active.install_date) : null} />
              <Row label={t('service.location')} value={active.location} />
            </div>
            <h3>{t('service.serviceHistory')}</h3>
            {!active.jobs?.length ? <EmptyState message={t('service.noJobs')} /> : (
              <table>
                <thead><tr>
                  <th>{t('service.jobNumber')}</th><th>{t('service.jobType')}</th>
                  <th>{t('service.serviceDate')}</th>
                  <th className="text-right">{t('common.total')}</th>
                </tr></thead>
                <tbody>
                  {active.jobs.map(j => (
                    <tr key={j.id}>
                      <td>{j.job_number}</td>
                      <td>{j.job_type}</td>
                      <td>{j.completed_at ? fmtDate(j.completed_at) : '—'}</td>
                      <td className="text-right">{fmt(j.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}

      {modal === 'detail' && active && (
        <Modal title={active.job_number} onClose={() => setModal(null)} size="modal-lg">
          <JobDetail job={active} t={t} />
          <div className="modal-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
            {active.status !== 'Cancelled' && !active.invoice && can('service', 'create') && (
              <button className="btn btn-secondary" onClick={async () => {
                try {
                  const r = await invoiceServiceJob(active.id);
                  toast(`${t('service.invoiceRaised')}: ${r.invoice_number}`);
                  reload();
                  setActive(await getServiceJob(active.id));
                } catch (err) { toast(err.message, 'red'); }
              }}>{t('service.raiseInvoice')}</button>
            )}
            {active.status !== 'Cancelled' && can('service', 'delete') && (
              <button className="btn btn-danger"
                      onClick={() => setCancelling(active.id)}>
                {t('service.cancel')}
              </button>
            )}
          </div>
        </Modal>
      )}

      {cancelling && (
        <ConfirmModal
          message={t('service.cancelConfirm')}
          confirmLabel={t('service.cancel')}
          confirmClass="btn-danger"
          onConfirm={() => doCancel(cancelling)}
          onCancel={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

/** One label/value pair in a detail grid. `.form-group` is what stacks the
 *  label above its value — without it the two run together on screen. */
function Row({ label, value }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <span>{value || '—'}</span>
    </div>
  );
}

/** The service record: what was wrong, what was done, what it cost. */
function JobDetail({ job, t }) {
  const parts = (job.lines || []).filter(l => l.line_type === 'part');
  const charges = (job.lines || []).filter(l => l.line_type === 'charge');

  return (
    <div className="modal-body">
      <div className="form-grid">
        <Row label={t('common.client')} value={job.client_name} />
        <Row label={t('service.equipment')}
             value={job.equipment
               ? `${job.equipment.name}${job.equipment.serial_number ? ` (${job.equipment.serial_number})` : ''}`
               : null} />
        <Row label={t('service.jobType')} value={job.job_type} />
        <Row label={t('service.serviceDate')}
             value={job.completed_at ? fmtDate(job.completed_at) : null} />
      </div>

      {job.reported_fault && (
        <p><strong>{t('service.reportedFault')}:</strong> {job.reported_fault}</p>
      )}
      {job.work_done && (
        <p><strong>{t('service.workDone')}:</strong> {job.work_done}</p>
      )}
      {job.status === 'Cancelled' && (
        <p><span className="badge badge-red">{t('service.statusCancelled')}</span>{' '}
          {job.cancel_reason}</p>
      )}

      <h3>{t('service.partsAndCharges')}</h3>
      <table>
        <thead><tr>
          <th>{t('common.description')}</th>
          <th className="text-right">{t('common.quantity')}</th>
          <th className="text-right">{t('common.unitPrice')}</th>
          <th className="text-right">{t('common.total')}</th>
        </tr></thead>
        <tbody>
          {[...parts, ...charges].map(l => (
            <tr key={l.id}>
              <td>
                <span className={`badge badge-${l.line_type === 'part' ? 'blue' : 'gray'}`}>
                  {t(`service.${l.line_type}`)}
                </span>{' '}{l.name}
              </td>
              <td className="text-right">{l.quantity}</td>
              <td className="text-right">{fmt(l.unit_price)}</td>
              <td className="text-right">{fmt(l.quantity * l.unit_price)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan="3" className="text-right">{t('common.subtotal')}</td>
              <td className="text-right">{fmt(job.subtotal)}</td></tr>
          {job.tax_total > 0 && (
            <tr><td colSpan="3" className="text-right">{t('common.taxCol')}</td>
                <td className="text-right">{fmt(job.tax_total)}</td></tr>
          )}
          <tr><td colSpan="3" className="text-right"><strong>{t('common.total')}</strong></td>
              <td className="text-right"><strong>{fmt(job.total)}</strong></td></tr>
          {job.status !== 'Cancelled' && (
            <>
              <tr><td colSpan="3" className="text-right">{t('service.partsCost')}</td>
                  <td className="text-right">{fmt(job.parts_cost)}</td></tr>
              <tr><td colSpan="3" className="text-right">{t('service.margin')}</td>
                  <td className="text-right">{fmt((job.total || 0) - (job.parts_cost || 0))}</td></tr>
            </>
          )}
        </tfoot>
      </table>

      {job.invoice && (
        <p style={{ marginTop: 12 }}>
          <strong>{t('service.billed')}:</strong> {job.invoice.invoice_number}
        </p>
      )}
    </div>
  );
}
