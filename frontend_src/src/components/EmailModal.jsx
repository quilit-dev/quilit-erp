import { useState } from 'react';
import { Modal, toast } from './shared';
import { useLocale } from '../hooks/useLocale.jsx';

// Shared "Send by email" dialog used by Invoices and Quotations.
//
// The recipient is pre-filled with the contact's email on file (when known);
// leaving it blank lets the backend fall back to that same address, mirroring
// the server-side `to || client_email || lead_email` resolution. `onSend`
// receives `{ to, message }` and should perform the API call — on success the
// modal closes; on failure it stays open and surfaces the error as a toast.
export default function EmailModal({ title, to: defaultTo = '', docLabel, onClose, onSend }) {
  const { t } = useLocale();
  const [to, setTo]           = useState(defaultTo || '');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    try {
      const recipient = to.trim();
      await onSend({ to: recipient || undefined, message: message.trim() || undefined });
      onClose();
    } catch (err) {
      toast(err.message || t('email.failed'), 'red');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          {docLabel && (
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 0, marginBottom: 16 }}>
              {docLabel}
            </p>
          )}
          <div className="form-group">
            <label className="form-label">{t('email.recipient')}</label>
            <input
              type="email"
              className="form-control"
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder="client@example.com"
              autoFocus
            />
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6, marginBottom: 0 }}>
              {t('email.leaveBlankHint')}
            </p>
          </div>
          <div className="form-group">
            <label className="form-label">{t('email.message')} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({t('common.optional')})</span></label>
            <textarea
              className="form-control"
              rows={3}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={t('email.messagePlaceholder')}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? t('email.sending') : t('email.send')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
