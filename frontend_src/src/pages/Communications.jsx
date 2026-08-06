// Communications — everything sent to clients, across every document.
//
// The per-document log inside the Send dialog answers "did this invoice go
// out?". This page answers the questions you cannot ask from inside one record:
// what failed today, what has been sent but never opened, who has been sending.
//
// "Sent but never opened" is given its own counter because it is the only
// number here that prompts an action. A failure is loud and gets fixed; a
// delivered-but-ignored invoice is silent, and it is the one that ages into a
// collections problem.
import { useCallback, useEffect, useState } from 'react';
import { commsHistory, commsRevoke } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { LoadingSpinner, toast, Icon } from '../components/shared';

const CHANNELS = ['', 'email', 'whatsapp'];
const STATUSES = ['', 'sent', 'opened', 'failed'];

export default function Communications() {
  const { t } = useLocale();
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);
  const [channel, setChannel] = useState('');
  const [status, setStatus]   = useState('');
  const [q, setQ]             = useState('');

  const load = useCallback(() => {
    commsHistory({ channel, status, q })
      .then(setData)
      .catch(e => setError(e?.message || String(e)));
  }, [channel, status, q]);

  useEffect(() => { load(); }, [load]);

  async function revoke(shareId) {
    try { await commsRevoke(shareId); toast(t('comms.linkRevoked')); load(); }
    catch (e) { toast(e?.message || t('comms.sendFailed'), 'red'); }
  }

  if (error) return <div className="card" style={{ padding: 20, color: 'var(--red)' }}>{error}</div>;
  if (!data) return <LoadingSpinner />;

  // Normalise once. The endpoint returns an envelope, but a page must not
  // white-screen on an unexpected shape — an empty array, a truncated proxy
  // response, an older server. Everything below reads these, not `data`.
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Number.isFinite(data.total) ? data.total : items.length;
  const c = data.counts || {};

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t('nav.communications')}</h1>
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('comms.pageHint')}</div>
      </div>

      {/* Email config is surfaced here, not buried in the send dialog: if it is
          off, every email attempt on every document will fail, and this is the
          page someone lands on when wondering why. */}
      {data.email && !data.email.enabled && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--yellow)' }}>
          <div className="card-body" style={{ fontSize: 13, color: 'var(--yellow)' }}>
            {t('comms.emailNotConfigured')}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10, marginBottom: 14,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Stat label={t('comms.statusSent')}   value={c.sent || 0} />
        <Stat label={t('comms.statusOpened')} value={c.opened || 0} />
        <Stat label={t('comms.statusFailed')} value={c.failed || 0}
              tone={(c.failed || 0) > 0 ? 'red' : undefined} />
        <Stat label={t('comms.neverOpened')}  value={data.unopened || 0}
              tone={(data.unopened || 0) > 0 ? 'yellow' : undefined} />
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap',
                                            alignItems: 'center' }}>
          <input className="form-control" style={{ maxWidth: 240 }} value={q}
            onChange={e => setQ(e.target.value)} placeholder={t('comms.searchHint')} />
          <select className="form-control" style={{ maxWidth: 170 }} value={channel}
            onChange={e => setChannel(e.target.value)}>
            {CHANNELS.map(v => (
              <option key={v || 'all'} value={v}>
                {v ? t(`comms.${v}`) : t('comms.allChannels')}
              </option>
            ))}
          </select>
          <select className="form-control" style={{ maxWidth: 170 }} value={status}
            onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(v => (
              <option key={v || 'all'} value={v}>
                {v ? t(`comms.status${v[0].toUpperCase()}${v.slice(1)}`) : t('comms.allStatuses')}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load}>
            <Icon name="refresh-cw" size={13} /> {t('common.refresh')}
          </button>
          <span style={{ marginInlineStart: 'auto', fontSize: 12.5, color: 'var(--text-3)' }}>
            {t('comms.showing', { shown: items.length, total })}
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th>{t('comms.when')}</th>
                <th>{t('comms.document')}</th>
                <th>{t('comms.channel')}</th>
                <th>{t('comms.recipient')}</th>
                <th>{t('common.status')}</th>
                <th>{t('comms.sentBy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)',
                                             padding: 24 }}>
                  {t('comms.nothingSent')}
                </td></tr>
              )}
              {items.map(row => (
                <tr key={row.id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {String(row.sent_at || '').slice(0, 16)}
                  </td>
                  <td className="td-primary">{row.document || `#${row.entity_id}`}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {row.channel === 'email' ? t('comms.email') : t('comms.whatsapp')}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{row.recipient}</td>
                  <td style={{ fontSize: 12.5 }}>
                    <StatusBadge status={row.status} t={t} />
                    {row.view_count > 0
                      ? <div style={{ color: 'var(--text-3)' }}>
                          {t('comms.opened', { n: row.view_count })}
                        </div>
                      : row.status !== 'failed' && (
                          <div style={{ color: 'var(--text-3)' }}>{t('comms.notOpenedYet')}</div>
                        )}
                    {row.revoked_at && (
                      <div style={{ color: 'var(--text-3)' }}>{t('comms.revoked')}</div>
                    )}
                    {row.error && <div style={{ color: 'var(--red)' }}>{row.error}</div>}
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{row.sent_by_name || '—'}</td>
                  <td style={{ textAlign: 'end' }}>
                    {row.share_id && !row.revoked_at && (
                      <button className="btn btn-sm btn-secondary"
                        onClick={() => revoke(row.share_id)}>{t('comms.revokeLink')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'yellow' ? 'var(--yellow)' : undefined;
  return (
    <div className="card">
      <div className="card-body">
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', textTransform: 'uppercase',
                      letterSpacing: '.05em' }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status, t }) {
  const map = {
    sent:   ['badge-green', t('comms.statusSent')],
    opened: ['badge-blue',  t('comms.statusOpened')],
    failed: ['badge-red',   t('comms.statusFailed')],
  };
  const [cls, label] = map[status] || ['badge-grey', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}
