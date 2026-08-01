// Quilit ERP product brand mark.
//
// This is the PRODUCT's identity, not the tenant's — the customer's own company
// name and uploaded logo still drive invoices, quotations, contracts, POS
// receipts and the login screen. The sidebar shows this and only this.
//
// Drawn inline as SVG rather than loaded as an image file so it stays crisp at
// any size, needs no network request (no flash of missing logo on first paint),
// and can adapt to the theme: the ring and "Quilit" wordmark inherit
// currentColor, so they read correctly on both the light and dark sidebar,
// while the violet mark and "ERP" stay fixed brand colour.
export default function BrandLogo({ height = 28, showWordmark = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--text)' }}>
      <svg
        height={height} width={height} viewBox="2 12 112 112"
        fill="none" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}
      >
        <defs>
          <linearGradient id="quilit-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor="#9A5BAE" />
            <stop offset="100%" stopColor="#5E2472" />
          </linearGradient>
        </defs>
        {/* viewBox is fitted to the artwork (content spans 18-98 x, 16-120 y)
            so the mark is optically centred rather than sitting low-left. */}
        {/* Q ring — currentColor so it survives a dark background */}
        <circle cx="58" cy="56" r="40" stroke="currentColor" strokeWidth="15" />
        {/* Ascending bars: the "growth" motif inside the Q */}
        <path d="M40 70 L54 60 L54 94 L40 94 Z" fill="url(#quilit-mark)" />
        <path d="M60 50 L74 40 L74 94 L60 94 Z" fill="url(#quilit-mark)" />
        {/* Q tail, breaking out of the ring toward the lower right */}
        <path d="M68 82 L94 108 L82 120 L56 94 Z" fill="url(#quilit-mark)" />
      </svg>

      {showWordmark && (
        <span style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 5,
          fontFamily: 'var(--font-display)', letterSpacing: '-0.02em',
          lineHeight: 1, whiteSpace: 'nowrap',
        }}>
          <span style={{ fontSize: height * 0.68, fontWeight: 700, color: 'var(--text)' }}>
            Quilit
          </span>
          <span style={{
            fontSize: height * 0.44, fontWeight: 700, color: '#8B4A9C',
            letterSpacing: '0.02em',
          }}>
            ERP
          </span>
        </span>
      )}
    </div>
  );
}
