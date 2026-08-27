// "Report a problem" — the customer-side half of the support loop.
//
// Two ways in, one dialog:
//   * the topbar action, always available — most problems are not crashes.
//     A wrong total or a confusing workflow never throws, and if the only way
//     to report something is to crash first, those never get reported.
//   * the ErrorBoundary, which pre-fills the technical detail of the crash the
//     user just hit.
//
// The user is only ever asked what they were trying to do. Everything
// technical — page, browser, error, stack — is attached automatically, because
// a frustrated user will not paste a stack trace and should not be asked to.
import { useState } from 'react';
import { reportProblem } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { toast, Icon } from './shared';
import SearchSelect from '../components/SearchSelect.jsx';

export function ReportProblemDialog({ onClose, error = null, componentStack = '' }) {
  const { t } = useLocale();
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState(error ? 'high' : 'medium');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await reportProblem({
        // A crash gets its message as the title; a user-raised issue is
        // titled from what they typed, so the inbox list is scannable.
        title: error
          ? `Page crash: ${String(error?.message || error).slice(0, 160)}`
          : (description.trim().slice(0, 160) || 'Problem report'),
        message: error ? String(error?.message || error) : null,
        stack: error ? [error?.stack, componentStack].filter(Boolean).join('\n\n') : null,
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        severity,
        description: description.trim() || null,
      });
      setDone(true);
    } catch (e) {
      // Reporting must never throw on top of the problem being reported.
      toast(e?.message || t('support.sendFailed'), 'red');
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="modal" style={{ maxWidth: 420 }}>
          <div className="modal-body" style={{ textAlign: 'center', padding: '32px 24px' }}>
            <div style={{ color: 'var(--green)', marginBottom: 10 }}>
              <Icon name="check-circle" size={34} />
            </div>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>{t('support.thanksTitle')}</h3>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)' }}>{t('support.thanksBody')}</p>
          </div>
          <div className="modal-footer">
            <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <span className="modal-title">{t('support.reportTitle')}</span>
        </div>
        <div className="modal-body">
          {error && (
            <div style={{ background: 'var(--red-light)', color: 'var(--red)', fontSize: 12.5,
                          padding: '8px 10px', borderRadius: 'var(--r-sm)', marginBottom: 12 }}>
              {String(error?.message || error).slice(0, 200)}
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('support.whatHappened')}</label>
            <textarea className="form-control" rows={4} autoFocus
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder={t('support.whatHappenedHint')} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('support.howBad')}</label>
            <SearchSelect
              className="form-control"
              value={severity}
              onChange={v => setSeverity(v)}
              options={[{ value: 'low', label: t('support.sevLow') }, { value: 'medium', label: t('support.sevMedium') }, { value: 'high', label: t('support.sevHigh') }, { value: 'critical', label: t('support.sevCritical') }]} />
          </div>
          {/* Say what is being sent. Silently shipping the URL and browser
              string would be a surprise; naming it is the honest default. */}
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0 }}>
            {t('support.autoAttached')}
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}
            disabled={busy || (!error && !description.trim())}>
            {busy ? t('common.sending') : t('support.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Topbar entry point — always reachable, on every page.
//
// LABELLED, not an icon alone. It shipped as a bare 14px alert-circle sitting
// between the notification bell and the theme toggle, with the meaning only in
// a tooltip — and the person who asked for the feature could not find it. A
// reporting channel nobody can see reports nothing, so the word is on screen.
// The label collapses on narrow viewports where the topbar has no room.
export function ReportProblemButton() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="theme-toggle" onClick={() => setOpen(true)}
        title={t('support.reportTitle')} aria-label={t('support.reportTitle')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                 width: 'auto', paddingInline: 10, whiteSpace: 'nowrap' }}>
        <Icon name="alert-circle" size={14} />
        <span className="hide-on-mobile" style={{ fontSize: 12, fontWeight: 600 }}>
          {t('support.reportShort')}
        </span>
      </button>
      {open && <ReportProblemDialog onClose={() => setOpen(false)} />}
    </>
  );
}
