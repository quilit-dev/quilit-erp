/**
 * What the browser tab says this page is.
 *
 * The icon is the TENANT's logo, not the vendor's: staff work in their own
 * system, and anyone keeping several customers' workspaces open needs to tell
 * the tabs apart. The Quilit mark ships in the HTML as the starting value, so
 * there is always an icon — before this runs, on a workspace that has uploaded
 * nothing, and if the probe below fails.
 *
 * The logo endpoint is deliberately unauthenticated and resolves the tenant from
 * the request host, so this works on the login screen and on the page a customer
 * opens from a share link — neither of which has a session.
 */

const FALLBACK_ICON = '/icon-192.png';

/** The <link rel="icon"> the page is using, created if the HTML lacks one. */
function iconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

/**
 * Swap the tab icon to the tenant's logo, if they have one.
 *
 * Probed rather than pointed at directly: a `<link rel="icon">` whose URL 404s
 * leaves the tab on the browser's default globe in some browsers and on the
 * previous icon in others, and nothing reports the failure. Checking the
 * response first makes the outcome the same everywhere.
 */
export async function applyTenantFavicon() {
  try {
    const resp = await fetch('/api/settings/logo', { cache: 'no-store' });
    if (!resp.ok) return;                       // no logo uploaded — keep Quilit's
    const type = resp.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return;     // an HTML error page is not an icon

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const link = iconLink();
    // Revoke the PREVIOUS object URL, never the one just assigned: revoking the
    // live one leaves the tab iconless the moment the browser re-reads it.
    const previous = link.dataset.objectUrl;
    link.type = type;
    link.href = url;
    link.dataset.objectUrl = url;
    if (previous) URL.revokeObjectURL(previous);
  } catch {
    /* offline, blocked, or no such endpoint — the shipped icon stands */
  }
}

/** Reset to the vendor mark — used when a logo is removed. */
export function resetFavicon() {
  const link = iconLink();
  const previous = link.dataset.objectUrl;
  link.removeAttribute('type');
  link.href = FALLBACK_ICON;
  delete link.dataset.objectUrl;
  if (previous) URL.revokeObjectURL(previous);
}

/**
 * The tab's text. Falls back to the product name, which is all the login screen
 * can honestly say — the company name needs a session to read.
 */
export function applyTenantTitle(companyName) {
  document.title = String(companyName || '').trim() || 'ERP System';
}
