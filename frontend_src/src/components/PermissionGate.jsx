import { usePermissions } from '../hooks/usePermissions';

export default function PermissionGate({ module, action = 'view', fallback = null, children }) {
  const { can } = usePermissions();
  if (!can(module, action)) return fallback;
  return children;
}
