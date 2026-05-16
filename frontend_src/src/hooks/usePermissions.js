import { useState, useEffect } from 'react';

function readUser() {
  try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
}

export function usePermissions() {
  const [user, setUser] = useState(readUser);

  useEffect(() => {
    function refresh() { setUser(readUser()); }
    window.addEventListener('user-updated', refresh);
    return () => window.removeEventListener('user-updated', refresh);
  }, []);

  const isSuperadmin = Boolean(user.is_superadmin);
  const permissions  = user.permissions || {};

  function can(module, action = 'view') {
    if (isSuperadmin) return true;
    return Boolean(permissions[module]?.[action]);
  }

  return { user, isSuperadmin, permissions, can };
}
