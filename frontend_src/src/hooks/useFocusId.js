import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Reads a `?focus=<id>` query param (set by global-search deep links) and
// returns [focusId, clear]. It reacts to param changes so searching for a
// record while already on its page works too, and strips the param from the
// URL immediately so a refresh / re-render never re-opens the record.
//
// Usage in a list page:
//   const [focusId, clearFocus] = useFocusId();
//   useEffect(() => {
//     if (focusId != null && rows?.length) {
//       const rec = rows.find(r => r.id === focusId);
//       if (rec) { openRecord(rec); clearFocus(); }
//     }
//   }, [focusId, rows]);
export function useFocusId() {
  const loc = useLocation();
  const nav = useNavigate();
  const [focusId, setFocusId] = useState(null);

  useEffect(() => {
    const raw = new URLSearchParams(loc.search).get('focus');
    if (raw == null || raw === '') return;
    const n = Number(raw);
    if (!Number.isNaN(n)) setFocusId(n);
    // Strip ?focus so back/refresh doesn't re-trigger the open.
    const params = new URLSearchParams(loc.search);
    params.delete('focus');
    nav({ search: params.toString() }, { replace: true });
  }, [loc.search, nav]);

  return [focusId, () => setFocusId(null)];
}
