import { useState, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, Modal, toast, NumberInput } from '../../components/shared';
import { getQCInspection, resolveQC } from '../../api/client';
import { num, Money } from './ui';

function QCResolveModal({ qcId, canEdit, onClose, onDone }) {
  const { t } = useLocale();
  const [qc, setQc] = useState(null);
  const [passed, setPassed] = useState('');
  const [rejected, setRejected] = useState('');
  const [rework, setRework] = useState('');
  const [defects, setDefects] = useState([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(0);

  useEffect(() => {
    getQCInspection(qcId).then(q => {
      setQc(q);
      if (q.status === 'Pending') { setPassed(String(q.quantity)); setRejected('0'); }
    }).catch(e => toast(e.message, 'red'));
  }, [qcId]);

  if (!qc) return <Modal title={t('manufacturing.tabQC')} onClose={onClose}><div className="modal-body"><LoadingSpinner /></div></Modal>;

  const pending = qc.status === 'Pending';
  const total = Number(qc.quantity);
  const p = Number(passed) || 0, r = Number(rejected) || 0, rw = Number(rework) || 0;
  const balanced = Math.abs(p + r - total) < 1e-6 && rw <= r;

  async function submit() {
    setBusy(true);
    try {
      await resolveQC(qcId, {
        passed_qty: p, rejected_qty: r, rework_qty: rw, notes,
        defects: defects.filter(d => (d.reason || '').trim()).map(d => ({ reason: d.reason.trim(), quantity: Number(d.quantity) || 0, notes: d.notes })),
      });
      toast(t('manufacturing.qcResolved')); onDone();
    } catch (e) { toast(e.message, 'red'); } finally { setBusy(false); }
  }

  return (
    <Modal title={`${t('manufacturing.inspect')} · ${qc.order_number}`} onClose={onClose}>
      <div className="modal-body">
        <p style={{ fontSize: 13, marginTop: 0 }}>
          <strong>{qc.output_name}</strong> · {t('manufacturing.qcQuantity')}: {num(qc.quantity)} {qc.output_unit || ''} · <Money value={qc.unit_cost} />/u
        </p>
        {pending && canEdit ? (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcPassed')}</label>
                <NumberInput min="0" step="1" className="form-control" value={passed}
                  onChange={e => { setPassed(e.target.value); const v = total - (Number(e.target.value) || 0); setRejected(String(v >= 0 ? v : 0)); }} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcRejected')}</label>
                <NumberInput min="0" step="1" className="form-control" value={rejected}
                  onChange={e => setRejected(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('manufacturing.qcRework')}</label>
                <NumberInput min="0" step="1" className="form-control" value={rework}
                  onChange={e => setRework(e.target.value)} placeholder="0" />
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: balanced ? 'var(--text-3)' : 'var(--red)', margin: '4px 0 0' }}>
              {balanced ? t('manufacturing.qcReworkHint') : t('manufacturing.qcMustBalance', { total: num(total) })}
            </p>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 4px' }}>
              <h4 style={{ margin: 0, fontSize: 14 }}>{t('manufacturing.defects')}</h4>
              <button className="btn btn-sm btn-secondary" onClick={() => setDefects(d => [...d, { key: ++keyRef.current, reason: '', quantity: '' }])}>{t('manufacturing.addDefect')}</button>
            </div>
            {defects.map((d, i) => (
              <div key={d.key} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="form-control" style={{ flex: 2 }} placeholder={t('manufacturing.defectReason')}
                  value={d.reason} onChange={e => setDefects(ds => ds.map((x, j) => j === i ? { ...x, reason: e.target.value } : x))} />
                <NumberInput className="form-control" style={{ width: 90 }} min="0" placeholder={t('manufacturing.qcQuantity')}
                  value={d.quantity} onChange={e => setDefects(ds => ds.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
                <button className="icon-btn" onClick={() => setDefects(ds => ds.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}

            <div className="form-group" style={{ marginTop: 10 }}>
              <label className="form-label">{t('manufacturing.notes') || 'Notes'}</label>
              <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13 }}>
            <p>{t('common.status')}: <span className={`badge badge-${qc.status === 'Passed' ? 'green' : qc.status === 'Failed' ? 'red' : 'yellow'}`}>{t('manufacturing.qcStatus_' + qc.status)}</span></p>
            <p>{t('manufacturing.qcPassed')}: {num(qc.passed_qty)} · {t('manufacturing.qcRejected')}: {num(qc.rejected_qty)} · {t('manufacturing.qcRework')}: {num(qc.rework_qty)}</p>
            {qc.scrap_cost > 0 && <p>{t('manufacturing.scrapCost')}: <Money value={qc.scrap_cost} /></p>}
            {(qc.defects || []).length > 0 && (
              <ul style={{ margin: '6px 0', paddingInlineStart: 18 }}>
                {qc.defects.map(d => <li key={d.id}>{d.reason} — {num(d.quantity)}{d.notes ? ` (${d.notes})` : ''}</li>)}
              </ul>
            )}
            {qc.notes && <p style={{ color: 'var(--text-3)' }}>{qc.notes}</p>}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {pending && canEdit && (
          <button className="btn btn-primary" disabled={!balanced || busy} onClick={submit}>
            {busy ? t('common.saving') : t('manufacturing.qcResolve')}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ── Resources view ───────────────────────────────────────────────────────────

export { QCResolveModal };
