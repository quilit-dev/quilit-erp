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
import { getChartStatus, installLebaneseChart } from '../../api/client';
import { Modal, toast } from '../../components/shared';

function ChartPicker({ t, canEdit, onInstalled }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);

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
    </>
  );
}

export { ChartPicker };
