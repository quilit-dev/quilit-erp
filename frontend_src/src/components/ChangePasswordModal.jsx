// Every user changing their OWN password.
//
// The endpoint has always existed and has always accepted any authenticated
// user, but nothing in the UI called it: the only password screen was the
// FORCED one-time change at first login. So a member of staff who thought their
// password had been seen had to ask an admin to reset it — which meant the admin
// choosing, and knowing, their password.
//
// It lives in the sidebar account popover rather than under Settings, because
// Settings is a company-configuration screen most roles cannot reach, and this
// is the one account action that belongs to everybody. Requiring the current
// password is what makes it safe to expose to every role: it grants nothing an
// account holder does not already have.
import { useState } from 'react';
import { Modal, toast } from './shared';
import { changePassword } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

export default function ChangePasswordModal({ onClose }) {
  const { t } = useLocale();
  const [current, setCurrent] = useState('');
  const [next,    setNext]    = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw,  setShowPw]  = useState(false);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);

  const rules = [
    { label: t('forceChange.strength8'),     ok: next.length >= 8 },
    { label: t('forceChange.strengthUpper'), ok: /[A-Z]/.test(next) },
    { label: t('forceChange.strengthNum'),   ok: /[0-9]/.test(next) },
  ];

  async function submit(e) {
    e.preventDefault();
    setError('');
    // Mirrors the server's own minimum so the common mistake is caught before a
    // round trip; the server remains the authority.
    if (next.length < 8)   return setError(t('forceChange.passwordMinLength'));
    if (next !== confirm)  return setError(t('forceChange.passwordsNoMatch'));
    setSaving(true);
    try {
      await changePassword(current, next);
      toast(t('forceChange.changedOk'));
      onClose();
    } catch (err) {
      // Surface the server's wording — "Incorrect current password" is the
      // message the user needs, and it is the one case that is not their typo
      // in the new field.
      setError(err?.message || t('forceChange.change'));
    } finally {
      setSaving(false);
    }
  }

  const pwType = showPw ? 'text' : 'password';

  return (
    <Modal title={t('forceChange.title')} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div style={{ padding: '10px 14px', background: 'var(--red-light)',
                        border: '1px solid var(--red)', borderRadius: 8,
                        fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div className="form-group">
          <label className="form-label">{t('forceChange.currentPassword')}</label>
          <input type={pwType} className="form-control" value={current}
                 onChange={e => setCurrent(e.target.value)}
                 autoComplete="current-password" autoFocus required />
        </div>

        <div className="form-group">
          <label className="form-label">{t('forceChange.newPassword')}</label>
          <div style={{ position: 'relative' }}>
            <input type={pwType} className="form-control" value={next}
                   onChange={e => setNext(e.target.value)}
                   placeholder={t('forceChange.minLabel')}
                   autoComplete="new-password" required />
            <button type="button" onClick={() => setShowPw(v => !v)}
              aria-label={t('forceChange.newPassword')}
              style={{ position: 'absolute', insetInlineEnd: 10, top: '50%',
                       transform: 'translateY(-50%)', background: 'none',
                       border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
              {showPw ? '🙈' : '👁'}
            </button>
          </div>
          {next && (
            <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
              {rules.map(({ label, ok }) => (
                <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ height: 3, borderRadius: 2, marginBottom: 3,
                                background: ok ? 'var(--green)' : 'var(--border)' }} />
                  <span style={{ fontSize: 10, color: ok ? 'var(--green)' : 'var(--text-3)' }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">{t('forceChange.confirmPassword')}</label>
          <input type={pwType} className="form-control" value={confirm}
                 onChange={e => setConfirm(e.target.value)}
                 placeholder={t('forceChange.repeatPassword')}
                 autoComplete="new-password" required />
          {confirm && next !== confirm && (
            <p style={{ fontSize: 12, color: 'var(--red)', margin: '4px 0 0' }}>
              {t('forceChange.passwordsNoMatch')}
            </p>
          )}
        </div>

        <div className="modal-footer" style={{ paddingInline: 0, paddingBottom: 0 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('forceChange.changing') : t('forceChange.change')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
