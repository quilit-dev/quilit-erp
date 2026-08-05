// Operator API helper, kept in its own module so the console shell and its
// section screens can share it without importing each other (that cycle
// resolves only by luck of call timing, and breaks the moment something is
// called at module scope).
//
// Deliberately NOT the shared api client: that client redirects every 401 to
// the tenant /login page, but here a 401 just means "operator not signed in"
// and must render the operator login form instead. Operator auth rides its own
// cookie (platform_session), entirely separate from tenant sessions.
export async function pfetch(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* non-JSON error body */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
