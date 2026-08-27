/**
 * The write-up: what the sheet says when it comes back from site.
 *
 * This is the second half of the service workflow, and it lives on the job's
 * own pane rather than behind an Edit button. Opening the job IS the act of
 * entering what happened — the technician is standing there with the paper, and
 * a click that only reveals the boxes is a click that exists to be complained
 * about.
 *
 * The job's header — client, machine, reported problem, technician, date — is
 * still edited through the form, because changing those is correcting the
 * record of the call, which is a different and rarer thing than writing up a
 * visit. So the two do not overlap and there is exactly one place that owns
 * each: no second copy of the lines editor to keep in step.
 *
 * A PART draws from stock and needs a stock item; a CHARGE is labour, a callout
 * or a flat fee. Two buttons rather than a type dropdown on a generic row,
 * because they are different things to the person filling this in — "what did I
 * fit" and "what am I charging for" — and because the backend rejects the
 * mixed-up combinations anyway.
 */
import { useEffect, useState } from 'react';
import { getInventory, updateServiceJob } from '../../api/client';
import { NumberInput, toast, fmt } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';

const emptyPart = () => ({ line_type: 'part', inventory_id: '', name: '', quantity: 1, unit_price: 0 });
const emptyCharge = () => ({ line_type: 'charge', inventory_id: null, name: '', quantity: 1, unit_price: 0 });

const asRows = (job) => (job.lines || []).map(l => ({
  line_type: l.line_type, inventory_id: l.inventory_id || '',
  name: l.name, quantity: l.quantity, unit_price: l.unit_price,
}));

export default function WriteUp({ job, canEdit, onSaved, onDirtyChange }) {
  const { t } = useLocale();
  const [workDone, setWorkDone] = useState(job.work_done || '');
  const [lines, setLines] = useState(() => asRows(job));
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  // Re-seed when the parent hands over a different job, or the same one after a
  // save: the pane is reused rather than remounted, so state that is only
  // initialised once would show the previous job's parts against this one.
  useEffect(() => {
    setWorkDone(job.work_done || '');
    setLines(asRows(job));
  }, [job]);

  useEffect(() => {
    getInventory().then(r => setItems(r.items || r || [])).catch(() => {});
  }, []);

  const dirty = workDone !== (job.work_done || '')
    || JSON.stringify(lines) !== JSON.stringify(asRows(job));

  // Reported upward so the pane can refuse to close a job over unsaved work.
  // Closing consumes stock from the lines the SERVER holds, so anything only
  // typed here would be silently dropped at the moment it matters most.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const setLine = (i, patch) =>
    setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  /** Choosing a stock item fills the name and price, which is what the person
   *  typing expects and stops the two drifting apart. */
  function pickItem(i, inventoryId) {
    const it = items.find(x => String(x.id) === String(inventoryId));
    setLine(i, {
      inventory_id: inventoryId,
      name: it?.name || '',
      unit_price: it?.sale_price ?? 0,
    });
  }

  const subtotal = lines.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);

  async function save() {
    setSaving(true);
    try {
      await updateServiceJob(job.id, {
        // The header is sent back as it stands: this pane does not edit it, and
        // the endpoint takes a whole job.
        client_id: job.client_id,
        equipment_id: job.equipment_id || null,
        job_type: job.job_type,
        priority: job.priority,
        scheduled_date: job.scheduled_date || null,
        assigned_to: job.assigned_to || null,
        reported_fault: job.reported_fault || '',
        work_done: workDone,
        items: lines
          .filter(l => (l.name || '').trim())
          .map(l => ({
            line_type: l.line_type,
            inventory_id: l.line_type === 'part' ? Number(l.inventory_id) || null : null,
            name: l.name,
            quantity: Number(l.quantity) || 0,
            unit_price: Number(l.unit_price) || 0,
          })),
      });
      toast(t('service.writeUpSaved'));
      onSaved?.();
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14,
                  borderTop: '1px solid var(--border)' }}>
      <div className="form-group">
        <label className="form-label">{t('service.workDone')}</label>
        <textarea className="form-control" rows="2" value={workDone}
                  disabled={!canEdit}
                  onChange={e => setWorkDone(e.target.value)} />
      </div>

      <h3>{t('service.partsAndCharges')}</h3>
      <table>
        <thead>
          <tr>
            <th style={{ width: '45%' }}>{t('common.description')}</th>
            <th className="text-right">{t('common.quantity')}</th>
            <th className="text-right">{t('common.unitPrice')}</th>
            <th className="text-right">{t('common.total')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <span className={`badge badge-${l.line_type === 'part' ? 'blue' : 'gray'}`}>
                  {t(`service.${l.line_type}`)}
                </span>{' '}
                {l.line_type === 'part' ? (
                  <SearchSelect
                    className="form-control"
                    disabled={!canEdit}
                    value={l.inventory_id}
                    onChange={v => pickItem(i, v)}
                    placeholder="—"
                    options={(items || []).map(it => ({ value: it.id, label: `${it.name} (${it.quantity} ${it.unit || ''})` }))} />
                ) : (
                  <input className="form-control" value={l.name}
                         placeholder={t('service.charge')} disabled={!canEdit}
                         onChange={e => setLine(i, { name: e.target.value })} />
                )}
              </td>
              {/* NumberInput adds no class of its own — it spreads props onto a
                  bare input — so without form-control these two render unstyled
                  next to the styled name field beside them. */}
              <td className="text-right">
                <NumberInput className="form-control" min="0" step="any"
                             style={{ textAlign: 'right' }} disabled={!canEdit}
                             value={l.quantity}
                             onChange={e => setLine(i, { quantity: e.target.value })} />
              </td>
              <td className="text-right">
                <NumberInput className="form-control" min="0" step="any"
                             style={{ textAlign: 'right' }} disabled={!canEdit}
                             value={l.unit_price}
                             onChange={e => setLine(i, { unit_price: e.target.value })} />
              </td>
              <td className="text-right">
                {fmt((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
              </td>
              <td>
                {canEdit && (
                  <button type="button" className="btn btn-sm btn-danger"
                          onClick={() => setLines(ls => ls.filter((_, n) => n !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {canEdit && (
          <>
            <button type="button" className="btn btn-sm btn-secondary"
                    onClick={() => setLines(ls => [...ls, emptyPart()])}>
              {t('service.addPart')}
            </button>
            <button type="button" className="btn btn-sm btn-secondary"
                    onClick={() => setLines(ls => [...ls, emptyCharge()])}>
              {t('service.addCharge')}
            </button>
            <button type="button" className="btn btn-sm btn-primary"
                    disabled={!dirty || saving} onClick={save}>
              {saving ? t('common.saving') : t('service.saveWriteUp')}
            </button>
          </>
        )}
        <div style={{ marginInlineStart: 'auto', alignSelf: 'center' }}>
          <strong>{t('common.subtotal')}: {fmt(subtotal)}</strong>
        </div>
      </div>
    </div>
  );
}
