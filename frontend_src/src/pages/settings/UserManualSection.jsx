// "Open the user manual" — the one place in Settings that isn't a setting.
//
// The manual is built into the deployment (Dockerfile stage `manual` → static/
// manual/), so it works with no internet and always matches the running
// version. But it is a separate build step: an image built without it would
// leave this button pointing at nothing, and a dead help link is worse than no
// help link. So the section only renders once the manual has been confirmed
// present.
//
// The probe asks for sitemap.xml rather than the manual's index. Every host in
// front of this app falls back to the SPA shell for unknown paths, and a shell
// is HTML with a 200 — indistinguishable from a real page. sitemap.xml is XML,
// which the fallback can never be, so the content type is the actual evidence.
import { useState, useEffect } from 'react';
import { Icon } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Section } from './ui';

export const MANUAL_URL = '/manual/';
const MANUAL_PROBE = '/manual/sitemap.xml';

export default function UserManualSection() {
  const { t } = useLocale();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(MANUAL_PROBE, { method: 'HEAD' })
      .then(r => {
        const type = r.headers.get('content-type') || '';
        if (alive) setAvailable(r.ok && type.includes('xml'));
      })
      .catch(() => {});          // offline or blocked: just don't offer it
    return () => { alive = false; };
  }, []);

  if (!available) return null;

  return (
    <Section title={t('settings.userManual')} icon="book-open">
      <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 14px', lineHeight: 1.6 }}>
        {t('settings.userManualBlurb')}
      </p>
      <a
        href={MANUAL_URL}
        target="_blank"
        // noopener: the manual is same-origin today, but a tab opened with
        // target=_blank can reach back through window.opener, and this link is
        // the kind that gets repointed at a hosted docs site later.
        rel="noopener noreferrer"
        className="btn btn-secondary"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      >
        <Icon name="book-open" size={15} strokeWidth={1.9} />
        {t('settings.openUserManual')}
        <Icon name="external-link" size={13} strokeWidth={1.9} style={{ opacity: 0.7 }} />
      </a>
      <span style={{ fontSize: 11, color: 'var(--text-3)', marginInlineStart: 10 }}>
        {t('settings.userManualOpensNewTab')}
      </span>
    </Section>
  );
}
