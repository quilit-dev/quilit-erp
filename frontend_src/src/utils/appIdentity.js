/**
 * What the browser tab says this page is.
 *
 * The ICON is not here — it is a plain `<link rel="icon" href="/api/settings/favicon">`
 * in index.html, and the server decides what that URL returns (the tenant's logo,
 * or the product mark when they have uploaded none). That is deliberate: Chrome
 * reads the tab icon while parsing the head and does not reliably repaint when a
 * script rewrites the href afterwards, so a JavaScript swap changes the DOM and
 * leaves the tab alone. A URL that always resolves needs no script and applies
 * before any has run.
 *
 * The TITLE has to be set from here, because the company name needs a session —
 * the settings endpoint is authenticated, unlike the logo.
 */

/**
 * The tab's text. Falls back to the product name, which is all the login screen
 * can honestly say.
 */
export function applyTenantTitle(companyName) {
  document.title = String(companyName || '').trim() || 'ERP System';
}
