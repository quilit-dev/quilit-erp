// Carrying the balances across after a change of chart.
//
// Switching charts leaves every historical entry pointing where it was posted,
// which is right — but the balances stay there too, and until they move the
// trial balance carries two charts at once and no statement reads correctly.
//
// This shows every retired account still holding something, where it would go,
// and whether that destination was derived or guessed. Nothing is written
// until it is posted, and what is posted is one ordinary journal entry that
// reverses like any other.
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getChartCutoverPreview, postChartCutover, getAccounts,
} from '../../api/client';
import { LoadingSpinner, ConfirmModal, toast } from '../../components/shared';
import { todayISO } from './constants';
import SearchSelect from '../../components/SearchSelect.jsx';

function ChartCutover({ t, fmt, fmtDate, tAccount, can }) {
  const canPost = can('accounting', 'create');
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    getChartCutoverPreview({ as_of: asOf })
      .then(d => { setData(d); setOverrides({}); })
      .catch(e => toast(e.message, 'red'));
  }, [asOf]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Anything but a list means the call did not return what it should;
    // an empty picker is recoverable, a crashed screen is not.
    getAccounts({ active: true })
      .then(a => setAccounts(Array.isArray(a) ? a : []))
      .catch(() => setAccounts([]));
  }, []);

  if (!data) return <LoadingSpinner />;

  const lines = data.lines || [];
  const target = l => overrides[l.from_code] ?? l.to_code ?? '';
  const missing = lines.filter(l => !target(l));
  const done = data.already_posted;

  async function post() {
    setConfirm(false);
    setBusy(true);
    try {
      const mappings = {};
      for (const l of lines) mappings[l.from_code] = target(l);
      const res = await postChartCutover({
        as_of: asOf, mappings, note: note.trim() || null,
      });
      toast(res.message);
      load();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <span className="card-title">{t('cutover.title')}</span>
          <div className="card-subtitle">{t('cutover.subtitle')}</div>
        </div>
        <input type="date" className="form-control" style={{ width: 150 }}
          value={asOf} onChange={e => setAsOf(e.target.value)}
          aria-label={t('cutover.asOf')} title={t('cutover.asOf')} />
      </div>

      {done ? (
        // Already carried across. Say so and point at the entry rather than
        // offering a button that would refuse.
        <div className="card-body">
          <p style={{ fontSize: 13.5, marginTop: 0 }}>
            {t('cutover.alreadyDone', { date: fmtDate(done.entry_date) })}
          </p>
          <Link to={`/accounting?tab=journal&focus=${done.id}`}
            style={{ color: 'var(--accent)', fontWeight: 600 }}>
            {done.entry_number}
          </Link>
          <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {t('cutover.redoHint')}
          </p>
        </div>
      ) : lines.length === 0 ? (
        <div className="card-body">
          <p style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 0 }}>
            {t('cutover.nothingToMove')}
          </p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('cutover.from')}</th>
                  <th className="text-right">{t('cutover.balance')}</th>
                  <th>{t('cutover.to')}</th>
                  <th>{t('cutover.basis')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.from_code}>
                    <td>
                      <div className="td-primary">
                        <span className="text-mono">{l.from_code}</span>{' '}
                        {tAccount({ code: l.from_code, name: l.from_name,
                                    name_ar: l.from_name_ar })}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{l.type}</div>
                    </td>
                    <td className="text-right" style={{ fontWeight: 600 }}>
                      {fmt(Math.abs(l.balance))}
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {t(l.side === 'debit' ? 'accounting.debit' : 'accounting.credit')}
                      </div>
                    </td>
                    <td>
                      {/* Only accounts of the same type are offered: moving a
                          balance across types restates the books rather than
                          relocating them, and the server refuses it. */}
                      <SearchSelect
                        className="form-control"
                        style={{ minWidth: 210 }}
                        value={target(l)}
                        onChange={v => setOverrides(o => ({
                          ...o, [l.from_code]: v }))}
                        placeholder={t('cutover.choose')}
                        options={((accounts || []).filter(a => a.type === l.type)).map(a => ({ value: a.code, label: `${a.code} — ${tAccount(a)}` }))} />
                    </td>
                    <td>
                      <span className={`badge badge-${l.suggested_by === 'role' ? 'green' : 'yellow'}`}>
                        {t(l.suggested_by === 'role' ? 'cutover.byRole' : 'cutover.bySimilarity')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-body">
            <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 0 }}>
              {t('cutover.whatItDoes', { total: fmt(data.total) })}
            </p>
            {missing.length > 0 && (
              <div style={{ color: 'var(--red)', fontSize: 12.5 }}>
                {t('cutover.stillUnmapped', { count: missing.length })}
              </div>
            )}
            <div className="form-group form-full" style={{ marginTop: 10 }}>
              <label className="form-label">{t('invoices.noteOptional')}</label>
              <input className="form-control" value={note}
                onChange={e => setNote(e.target.value)} />
            </div>
          </div>

          <div className="modal-footer" style={{ borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-primary"
              disabled={busy || !canPost || missing.length > 0}
              onClick={() => setConfirm(true)}>
              {busy ? t('common.saving') : t('cutover.post')}
            </button>
          </div>
        </>
      )}

      {confirm && (
        <ConfirmModal
          title={t('cutover.title')}
          message={t('cutover.confirm', { total: fmt(data.total), count: lines.length })}
          confirmLabel={t('cutover.post')}
          onConfirm={post} onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
}

export { ChartCutover };
