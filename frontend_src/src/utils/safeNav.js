// Guard for navigation targets that come from DATA rather than from a literal
// in the source.
//
// Most navigate() calls in this app are template literals with an id from our
// own API — nothing to guard. A few navigate to a stored value: a notification's
// `link`, a command-palette result's `url`. Those are written by server-side
// code today, but "today" is the whole problem: the day one of them becomes
// user-settable, a stored `//evil.example` or `\\evil.example` turns into an
// open redirect that carries the user's trust in the app with it.
//
// React Router 6.30 is affected by an open-redirect advisory
// (GHSA-wrjc-x8rr-h8h6) whose fix is only in 7.x, a major upgrade. Validating
// at the call site removes the exposure independently of the router version,
// and stays correct after the upgrade.
//
// Accepted: a single-slash absolute in-app path ("/clients/12?tab=x#top").
// Rejected: anything with a scheme, a protocol-relative "//host", a backslash
// (which some parsers normalise to "/"), or a control character.


const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function isInternalPath(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || CONTROL_CHARS.test(v)) return false;
  // Backslashes are the documented bypass — reject before any normalisation.
  if (v.includes('\\')) return false;
  if (!v.startsWith('/')) return false;
  if (v.startsWith('//')) return false;     // protocol-relative → external host
  return true;
}

// Returns a safe target, or the fallback when the value cannot be trusted.
export function safePath(value, fallback = '/') {
  return isInternalPath(value) ? value.trim() : fallback;
}
