// Which chart of accounts this business keeps its books on.
//
// Lebanon publishes a statutory plan — النظام المحاسبي العام — and it is not a
// renaming of the default chart: class 1 is capital there and 4 is third
// parties, where here 1 is assets. A business that files under it needs its
// books in it, and postings have to land on its accounts rather than merely be
// relabelled with its names.
//
// Switching is offered freely to a tenant that has never posted. One that has
// is asked to type the phrase, because until the old balances are brought
// across as an opening entry its figures are spread over two charts and no
// statement reads correctly. That is a decision with an accountant in it, and
// the phrase is what stops it being a stray click.
import { useState, useEffect, useCallback } from 'react';
import { getChartStatus, installLebaneseChart, getChartPurgePreview,
         postChartPurge } from '../../api/client';
import { Modal, toast } from '../../components/shared';

function ChartPicker({ t, canEdit, onInstalled }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  // Installing a statutory chart RETIRES the old one rather than deleting it,
  // because an account is what historical entries point at. Once those entries
  // are gone — or were never made — the rows are only clutter in the account
  // list, and they cannot be removed by hand because every seeded account is a
  // system account.
  const [purge, setPurge] = useState(null);

  const load = useCallback(
    () => getChartStatus().then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return null;
  const lb = (data.charts || []).find(c => c.key === 'lebanon');
  if (!lb) return null;

  const onLebanese = data.current === 'lebanon';
  const needsPhrase = !lb.clean;

  async function install() {
    setBusy(true);
    try {
      const res = await installLebaneseChart(
        needsPhrase ? { confirm: phrase.trim() } : {});
      toast(res.message);
      setOpen(false); setPhrase('');
      await load();
      onInstalled?.();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  async function openPurge() {
    try { setPurge(await getChartPurgePreview()); }
    catch (e) { toast(e.message, 'red'); }
  }

  async function doPurge() {
    setBusy(true);
    try {
      const res = await postChartPurge();
      toast(t('chart.purged', { count: res.removed }), 'green');
      setPurge(null);
      await load();
      onInstalled?.();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                    flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ color: 'var(--text-3)' }}>{t('chart.inUse')}</span>
        <span className={`badge badge-${onLebanese ? 'green' : 'gray'}`}>
          {onLebanese ? t('chart.lebanon') : t('chart.default')}
        </span>
        {!onLebanese && canEdit && (
          <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
            {t('chart.switchTo', { name: t('chart.lebanon') })}
          </button>
        )}
        {onLebanese && canEdit && (
          <button className="btn btn-sm btn-secondary" onClick={openPurge}>
            {t('chart.removeOld')}
          </button>
        )}
      </div>

      {open && (
        <Modal title={t('chart.switchTitle')} onClose={() => setOpen(false)}>
          <div className="modal-body">
            <p style={{ fontSize: 13.5, marginTop: 0 }}>
              {t('chart.whatItDoes', { count: lb.accounts_total })}
            </p>
            <ul style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7,
                         paddingInlineStart: 18 }}>
              <li>{t('chart.pointRoles')}</li>
              <li>{t('chart.retireOld', { count: (lb.foreign_active || []).length })}</li>
              <li>{t('chart.keepsHistory')}</li>
            </ul>

            {needsPhrase ? (
              <>
                {/* The tenant has posted. Say exactly what that means before
                    asking them to type anything. */}
                <div style={{ display: 'flex', gap: 10, padding: '12px 14px',
                              background: '#fef3c7', border: '1px solid #f59e0b',
                              borderRadius: 8, margin: '12px 0' }}>
                  <span style={{ fontSize: 18 }}>⚠️</span>
                  <span style={{ fontSize: 13, color: '#78350f' }}>
                    {t('chart.alreadyPosted', { count: lb.posted_lines })}
                  </span>
                </div>
                <div className="form-group form-full">
                  <label className="form-label">
                    {t('chart.typeToConfirm', { phrase: 'SWITCH CHART' })}
                  </label>
                  <input className="form-control" value={phrase}
                    onChange={e => setPhrase(e.target.value)} />
                </div>
              </>
            ) : (
              <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                {t('chart.nothingPostedYet')}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={install}
              disabled={busy || (needsPhrase && phrase.trim().toUpperCase() !== 'SWITCH CHART')}>
              {busy ? t('common.saving') : t('chart.install')}
            </button>
          </div>
        </Modal>
      )}

      {purge && (
        <Modal title={t('chart.removeOldTitle')} onClose={() => setPurge(null)}>
          <div className="modal-body">
            {!purge.eligible ? (
              <p style={{ fontSize: 13.5 }}>{t('chart.purgeOnlyAfterSwitch')}</p>
            ) : (
              <>
                <p style={{ fontSize: 13.5, marginTop: 0 }}>
                  {t('chart.purgeWhat', { count: purge.removable_count })}
                </p>
                {purge.removable_count > 0 && (
                  <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12,
                                border: '1px solid var(--border)',
                                borderRadius: 8, padding: '8px 10px' }}>
                    {purge.removable.map(a => (
                      <div key={a.code} style={{ display: 'flex', gap: 8 }}>
                        <span className="text-mono"
                              style={{ minWidth: 48 }}>{a.code}</span>
                        <span style={{ color: 'var(--text-2)' }}>{a.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Named individually, because "3 must stay" invites the
                    question "which ones", and the answer decides whether
                    somebody goes and does a cutover first. */}
                {purge.kept_count > 0 && (
                  <div style={{ marginTop: 12, padding: '10px 12px',
                                background: '#fef3c7', border: '1px solid #f59e0b',
                                borderRadius: 8, fontSize: 12.5, color: '#78350f' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {t('chart.purgeKept', { count: purge.kept_count })}
                    </div>
                    {purge.kept.map(a => (
                      <div key={a.code}>
                        {a.code} {a.name} — {t('chart.purgeKeptLines', { n: a.lines })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setPurge(null)}>
              {t('common.cancel')}
            </button>
            {purge.eligible && purge.removable_count > 0 && (
              <button className="btn btn-danger" disabled={busy} onClick={doPurge}>
                {busy ? t('common.saving')
                      : t('chart.removeCount', { count: purge.removable_count })}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

export { ChartPicker };
