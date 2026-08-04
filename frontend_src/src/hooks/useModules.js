import { useSettings } from './useSettings.jsx';

/**
 * Which ERP modules this tenant is licensed for.
 *
 * `settings.enabled_modules` is the server's already dependency-closed answer
 * (see backend/capabilities.py) — the same set the API paywall enforces — so
 * the UI and the server can never disagree about what exists.
 *
 * An empty value means "unrestricted": single-tenant and desktop installs
 * carry no licence, and must keep showing everything.
 *
 * Use this for anything a customer could have *not bought*. It is a separate
 * question from RBAC, which asks whether THIS USER may see a module they are
 * licensed for. Both gates matter, and a surface needs to pass both:
 *
 *     has('pos') && can('pos', 'view')
 *
 * Checking only RBAC is how the dashboard ended up rendering cards for
 * modules the customer never licensed — an admin passes every permission
 * check, so nothing filtered them out.
 */
export function useModules() {
  const { settings } = useSettings();

  const raw = (settings?.enabled_modules || '').trim();
  const licensed = raw
    ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
    : null;                       // null = no licence recorded = unrestricted

  // `dashboard` is always on — it is the landing page, so gating it would
  // leave a licensed user with nowhere to go.
  const has = (module) => !licensed || module === 'dashboard' || licensed.has(module);

  return { has, licensed, unrestricted: licensed === null };
}
