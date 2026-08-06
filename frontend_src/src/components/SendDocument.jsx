// Send an invoice or quotation to the client, by email or WhatsApp.
//
// One dialog for both channels because the user's intent is the same ("get this
// to the customer") and only the address differs. What they are NOT asked for
// is anything the system already knows: the client's email and phone are
// pre-filled from the client record, and the message body is composed
// server-side so every document goes out looking the same.
//
// The link is always minted by the server. The browser never builds one — a
// client-side token would either be guessable or would have to be handed the
// signing material.
//
// WhatsApp does not send from the server (see backend/communications.py): the
// response carries a wa.me deep link, opened in a new tab, so the message
// leaves the user's own WhatsApp. That is why its log entry reads "opened" and
// not "sent" — nothing here can observe delivery.
import { useEffect, useState } from 'react';
import { commsStatus, commsSend, commsLog, commsRevoke } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { toast, Icon } from './shared';

export default function SendDocument({ entityType, doc, onClose }) {
  const { t } = useLocale();
  const number = doc.invoice_number || doc.quote_number || doc.doc_number || '';

  const [status, setStatus]  = useState(null);
  const [channel, setChannel] = useState('email');
  const [to, setTo]          = useState('');
  const [note, setNote]      = useState('');
  const [busy, setBusy]      = useState(false);
  const [log, setLog]        = useState(null);
  const [sentUrl, setSentUrl] = useState(null);

  const loadLog = () => commsLog(entityType, doc.id).then(setLog).catch(() => setLog([]));

  useEffect(() => {
    commsStatus()
      .then(s => {
        setStatus(s);
        // Default to whichever channel can actually be used, so the dialog does
        // not open on a disabled option.
        if (!s?.email?.enabled) setChannel('whatsapp');
      })
      .catch(() => setStatus({ email: { enabled: false }, whatsapp: { enabled: true } }));
    loadLog();
  }, [entityType, doc.id]);

  useEffect(() => {
    setTo(channel === 'email' ? (doc.client_email || '') : (doc.client_phone || ''));
  }, [channel, doc.client_email, doc.client_phone]);

  const emailReady = status?.email?.enabled;

  async function send() {
    setBusy(true);
    try {
      const r = await commsSend({
        entity_type: entityType, entity_id: doc.id, channel,
        to: to.trim() || null, note: note.trim() || null,
      });
      if (r.whatsapp_url) {
        // Opened rather than navigated so the ERP tab survives; if the popup is
        // blocked the link is still shown below to click manually.
        window.open(r.whatsapp_url, '_blank', 'noopener,noreferrer');
      }
      setSentUrl(r.url);
      toast(channel === 'email' ? t('comms.emailSent') : t('comms.waOpened'));
      loadLog();
    } catch (e) {
      toast(e?.message || t('comms.sendFailed'), 'red');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(shareId) {
    try { await commsRevoke(shareId); toast(t('comms.linkRevoked')); loadLog(); }
    catch (e) { toast(e?.message || t('comms.sendFailed'), 'red'); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <span className="modal-title">{t('comms.sendTitle')} — {number}</span>
        </div>

        <div className="modal-body" style={{ maxHeight: '68vh', overflowY: 'auto' }}>
          <div className="tabs" style={{ marginBottom: 14 }}>
            <button className={`tab-btn${channel === 'email' ? ' active' : ''}`}
              onClick={() => setChannel('email')} disabled={!emailReady}
              title={emailReady ? '' : t('comms.emailNotConfigured')}>
              {t('comms.email')}
            </button>
            <button className={`tab-btn${channel === 'whatsapp' ? ' active' : ''}`}
              onClick={() => setChannel('whatsapp')}>
              {t('comms.whatsapp')}
            </button>
          </div>

          {channel === 'email' && !emailReady && (
            <div style={{ background: 'var(--yellow-light)', color: 'var(--yellow)',
                          border: '1px solid var(--yellow)', borderRadius: 'var(--r-sm)',
                          padding: '9px 11px', fontSize: 12.5, marginBottom: 12 }}>
              {t('comms.emailNotConfigured')}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">
              {channel === 'email' ? t('comms.toEmail') : t('comms.toPhone')}
            </label>
            <input className="form-control" value={to} onChange={e => setTo(e.target.value)}
              placeholder={channel === 'email' ? 'name@example.com' : '+961 71 234567'} />
            {channel === 'whatsapp' && (
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
                {t('comms.waHint')}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('comms.note')}</label>
            <textarea className="form-control" rows={2} value={note}
              onChange={e => setNote(e.target.value)} placeholder={t('comms.notePlaceholder')} />
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 4px' }}>
            {t('comms.linkExplainer')}
          </p>

          {sentUrl && (
            <div style={{ marginTop: 12, padding: '9px 11px', background: 'var(--surface-2)',
                          borderRadius: 'var(--r-sm)', fontSize: 12 }}>
              <div style={{ color: 'var(--text-2)', marginBottom: 4 }}>{t('comms.linkSent')}</div>
              <div className="text-mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>
                {sentUrl}
              </div>
              <button className="btn btn-sm btn-secondary" style={{ marginTop: 6 }}
                onClick={() => { navigator.clipboard?.writeText(sentUrl); toast(t('common.copied')); }}>
                {t('common.copy')}
              </button>
            </div>
          )}

          {log && log.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em',
                            textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }}>
                {t('comms.history')}
              </div>
              <table className="table" style={{ margin: 0, fontSize: 12.5 }}>
                <tbody>
                  {log.map(row => (
                    <tr key={row.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {String(row.sent_at || '').slice(0, 16)}
                      </td>
                      <td>
                        {row.channel === 'email' ? t('comms.email') : t('comms.whatsapp')}
                        <div style={{ color: 'var(--text-3)' }}>{row.recipient}</div>
                      </td>
                      <td>
                        <StatusBadge status={row.status} t={t} />
                        {/* Views are the closest thing to a read receipt: the
                            client opened the link. Email "delivered" is not
                            tracked, so this is the honest signal. */}
                        {row.view_count > 0 && (
                          <div style={{ color: 'var(--text-3)' }}>
                            {t('comms.opened', { n: row.view_count })}
                          </div>
                        )}
                        {row.revoked_at && (
                          <div style={{ color: 'var(--text-3)' }}>{t('comms.revoked')}</div>
                        )}
                        {row.error && (
                          <div style={{ color: 'var(--red)' }}>{row.error}</div>
                        )}
                      </td>
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
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </button>
          <button className="btn btn-primary" onClick={send}
            disabled={busy || !to.trim() || (channel === 'email' && !emailReady)}>
            {busy ? t('common.sending')
              : channel === 'email' ? t('comms.sendEmail') : t('comms.openWhatsApp')}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, t }) {
  const map = {
    sent:   ['badge-green',  t('comms.statusSent')],
    opened: ['badge-blue',   t('comms.statusOpened')],
    failed: ['badge-red',    t('comms.statusFailed')],
  };
  const [cls, label] = map[status] || ['badge-grey', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// Row action — ONE control.
//
// This briefly had three buttons (WhatsApp, Email, Send) plus two PDF links on
// the same row. Seven controls per invoice is not a feature, it is a wall, and
// two of them looked identical because the ⋯ menu already had an "Export PDF"
// that did something different. Quick channels and PDF now live in that menu;
// the row keeps a single Send, which is the action people actually reach for.
export function SendDocumentButton({ entityType, doc }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}
        title={t('comms.sendTitle')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                 padding: '3px 9px', fontSize: 12, lineHeight: 1.4 }}>
        <Icon name="send" size={13} />
        {t('comms.send')}
      </button>
      {open && (
        <SendDocument entityType={entityType} doc={doc} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// One-click send, for the ⋯ menus. Exported separately from the dialog so a row
// stays uncluttered while a single click is still reachable.
//
// WhatsApp is safe to fire on one click: the message opens in the user's own
// WhatsApp and they press send there. Email cannot be unsent, so its toast names
// the address it went to — the only undo available.
export function useQuickSend(entityType, doc) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(null);

  async function quickSend(channel) {
    setBusy(channel);
    try {
      const r = await commsSend({ entity_type: entityType, entity_id: doc.id, channel });
      if (channel === 'whatsapp' && r?.wa_url) {
        window.open(r.wa_url, '_blank', 'noopener,noreferrer');
      } else if (channel === 'email') {
        toast(t('comms.emailedTo', { to: r?.recipient || doc?.client_email || '' }));
      }
    } catch (e) {
      toast(e?.message || t('comms.sendFailed'), 'red');
    } finally {
      setBusy(null);
    }
  }
  return { quickSend, busy };
}

