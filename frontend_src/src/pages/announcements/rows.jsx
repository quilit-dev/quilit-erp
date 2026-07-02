// Row cards: inbox rows (recipient view) + sent rows (author view).
import { fmtDate } from '../../components/shared';
import { PRIORITY_STYLE, PriorityChip } from './ui';

// ── Row card — single announcement summary in the list ─────────────────────

function AnnouncementRow({ a, onOpen, t }) {
  const unread = !a.read_at;
  const pendingAck = a.requires_ack && !a.acknowledged_at;
  const ps = PRIORITY_STYLE[a.priority] || PRIORITY_STYLE.medium;
  const snippet = (a.body || '').replace(/\s+/g, ' ').slice(0, 160);

  return (
    <div
      onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="card"
      style={{
        position: 'relative', cursor: 'pointer',
        padding: '14px 16px 14px 20px',
        border: `1px solid ${unread ? 'var(--border-strong, var(--border))' : 'var(--border)'}`,
        borderInlineStart: `4px solid ${ps.color}`,
        background: unread
          ? 'color-mix(in srgb, ' + ps.color + ' 4%, var(--card))'
          : 'var(--card)',
        boxShadow: 'var(--shadow-xs)',
        transition: 'transform 160ms var(--ease, ease), box-shadow 160ms var(--ease, ease), background 160ms var(--ease, ease)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 8px 22px rgba(15,23,42,.06)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'var(--shadow-xs)';
      }}
    >
      {a.pinned && (
        <span style={{
          position: 'absolute', top: 10, right: 14,
          fontSize: 10, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase',
          color: 'var(--text-3)',
        }}>📌 {t('announcements.pinned')}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <PriorityChip priority={a.priority} t={t} />
        <div style={{
          fontWeight: unread ? 700 : 600, fontSize: 14.5,
          color: unread ? 'var(--text)' : 'var(--text-2)',
          letterSpacing: '-0.1px',
          flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{a.title}</div>
        {unread && (
          <span style={{
            width: 8, height: 8, borderRadius: 50,
            background: ps.color, flexShrink: 0,
            boxShadow: `0 0 0 3px ${ps.color}22`,
          }} aria-label="unread" />
        )}
      </div>

      <div style={{
        fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{snippet}</div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        fontSize: 11, color: 'var(--text-3)', marginTop: 2,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{a.author_name}</span>
        <span>·</span>
        <span>{fmtDate(a.published_at)}</span>
        {a.comment_count > 0 && (
          <>
            <span>·</span>
            <span>💬 {a.comment_count}</span>
          </>
        )}
        {pendingAck && (
          <span style={{
            marginInlineStart: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'rgba(234,88,12,.10)', color: '#ea580c',
            fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px', textTransform: 'uppercase',
          }}>{t('announcements.pendingAck')}</span>
        )}
        {a.acknowledged_at && (
          <span style={{
            marginInlineStart: pendingAck ? 0 : 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'rgba(16,185,129,.10)', color: '#059669',
            fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px', textTransform: 'uppercase',
          }}>✓ {t('announcements.acknowledged')}</span>
        )}
      </div>
    </div>
  );
}


// ── Sent row card (author's view) ──────────────────────────────────────────

function SentRow({ a, onOpen, t }) {
  const ackPct = a.requires_ack && a.total_recipients > 0
    ? Math.round((a.total_acked / a.total_recipients) * 100) : null;
  const readPct = a.total_recipients > 0
    ? Math.round((a.total_read / a.total_recipients) * 100) : 0;
  const ps = PRIORITY_STYLE[a.priority] || PRIORITY_STYLE.medium;

  return (
    <div
      onClick={onOpen}
      className="card"
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        padding: '14px 16px 14px 20px',
        border: '1px solid var(--border)',
        borderInlineStart: `4px solid ${ps.color}`,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
        opacity: a.archived_at ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PriorityChip priority={a.priority} t={t} />
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtDate(a.published_at)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
                    fontSize: 12, color: 'var(--text-2)' }}>
        <span><strong style={{ color: 'var(--text)' }}>{a.total_recipients}</strong> {t('announcements.recipients')}</span>
        <span>·</span>
        <span><strong style={{ color: 'var(--text)' }}>{readPct}%</strong> {t('announcements.read')}</span>
        {ackPct !== null && (
          <>
            <span>·</span>
            <span><strong style={{ color: ackPct === 100 ? '#059669' : '#ea580c' }}>{ackPct}%</strong>{' '}
              {t('announcements.acknowledged')}</span>
          </>
        )}
        {a.archived_at && (
          <span style={{ marginInlineStart: 'auto', fontSize: 10.5, fontWeight: 700,
                          letterSpacing: '.4px', textTransform: 'uppercase',
                          color: 'var(--text-3)' }}>
            {t('announcements.archived')}
          </span>
        )}
      </div>
    </div>
  );
}

export { AnnouncementRow, SentRow };
