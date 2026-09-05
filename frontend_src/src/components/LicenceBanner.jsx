// Tells the business its licence is running out, before it stops working.
//
// The dates live in the shared platform catalog, which a tenant's own schema
// cannot read, so a customer had no way to know. The first sign of an expiry
// was being locked out one morning with a "workspace suspended" screen — for
// something as ordinary as a renewal invoice sitting unpaid in someone's inbox.
//
// Quiet until it matters: nothing renders on a perpetual licence, or while more
// than 30 days remain. It sharpens as the date nears and again once the grace
// period starts, because at that point access really is about to stop.
import { useEffect, useState } from 'react';
import { getLicenceStatus } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

const WARN_WITHIN_DAYS = 30;

export default function LicenceBanner() {
  const { t } = useLocale();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    getLicenceStatus()
      .then(d => { if (alive) setInfo(d); })
      .catch(() => { /* a banner must never surface an error of its own */ });
    return () => { alive = false; };
  }, []);

  if (!info?.applicable) return null;

  const days = info.days_left;
  const inGrace = info.in_grace;
  if (!inGrace && days > WARN_WITHIN_DAYS) return null;

  // Three tones: a heads-up, a warning, and "this stops now".
  const tone = inGrace ? 'red' : days <= 7 ? 'orange' : 'yellow';
  const palette = {
    yellow: { bg: 'var(--yellow-light, var(--caution-tint))', bd: 'var(--yellow, #ca8a04)', fg: '#854d0e' },
    orange: { bg: '#ffedd5',                      bd: '#ea580c',                fg: '#9a3412' },
    red:    { bg: 'var(--red-light, var(--negate-tint))',    bd: 'var(--red, var(--negate))',    fg: 'var(--negate-ink)' },
  }[tone];

  const kind = info.kind === 'trial' ? t('licence.trial') : t('licence.licence');
  const message = inGrace
    // -days is how long ago it lapsed; grace_days - (-days) is what is left.
    ? t('licence.expiredGrace', { kind, days: Math.max(0, info.grace_days + days) })
    : days === 0
      ? t('licence.expiresToday', { kind })
      : t('licence.expiresIn', { kind, days });

  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      margin: '0 0 14px', padding: '10px 14px', borderRadius: 8,
      background: palette.bg, border: `1px solid ${palette.bd}`,
      color: palette.fg, fontSize: 13,
    }}>
      <strong>{message}</strong>
      <span style={{ opacity: 0.85 }}>{t('licence.contactHint')}</span>
    </div>
  );
}
