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
  // Admin tier: vendor superadmin OR an admin-tier role (e.g. "Business Owner").
  // Governs the admin area (users/roles/settings/audit). The module marketplace
  // stays superadmin-only — gate that on isSuperadmin, never isAdmin.
  const isAdmin      = Boolean(user.admin_access) || isSuperadmin;
  const permissions  = user.permissions || {};

  function can(module, action = 'view') {
    if (isSuperadmin) return true;
    return Boolean(permissions[module]?.[action]);
  }

  return { user, isSuperadmin, isAdmin, permissions, can };
}
