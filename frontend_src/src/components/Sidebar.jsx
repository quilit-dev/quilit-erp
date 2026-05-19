import { NavLink, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useSettings } from '../hooks/useSettings.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import { logout as apiLogout } from '../api/client';

const Icons = {
  dashboard: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  clients:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  projects:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h20M4 20V10l8-7 8 7v10"/><path d="M10 20v-6h4v6"/></svg>,
  quotations:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  invoices:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  pos:       <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M6 7V4a2 2 0 012-2h8a2 2 0 012 2v3"/><line x1="6" y1="12" x2="10" y2="12"/><circle cx="17" cy="15" r="1.5"/></svg>,
  inventory: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  manufacturing: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h20"/><path d="M4 20V9l5 3V9l5 3V9l5 3v8"/><path d="M9 20v-4h2v4"/></svg>,
  purchases: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>,
  suppliers: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  expenses:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  finance:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  assets:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><line x1="9" y1="9" x2="9" y2="9"/><line x1="9" y1="13" x2="9" y2="13"/><line x1="9" y1="17" x2="9" y2="17"/></svg>,
  cash:      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/></svg>,
  reports:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><polyline points="9 21 9 9"/><polyline points="8 14 11 17 16 12"/></svg>,
  crm:       <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M16 3.13a4 4 0 010 7.75"/><path d="M21 21v-2a4 4 0 00-3-3.87"/></svg>,
  planning:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="13" y2="18"/></svg>,
  hr:        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  archives:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
  approvals: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
  policies:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
  recycle:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
  settings:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  users:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  roles:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  admin:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  logout:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// Each entry maps to a backend module key and a nav translation key.
// Ordered to follow the business workflow:
//   sales pipeline → delivery → procurement → finance → people.
const mainLinkDefs = [
  { to: '/',           navKey: 'dashboard',  icon: Icons.dashboard,  end: true, module: 'dashboard' },
  // Sales: lead → client → quote → invoice
  { to: '/crm',        navKey: 'crm',        icon: Icons.crm,        module: 'crm' },
  { to: '/clients',    navKey: 'clients',    icon: Icons.clients,    module: 'clients' },
  { to: '/quotations', navKey: 'quotations', icon: Icons.quotations, module: 'quotations' },
  { to: '/invoices',   navKey: 'invoices',   icon: Icons.invoices,   module: 'invoices' },
  { to: '/pos',        navKey: 'pos',        icon: Icons.pos,        module: 'pos' },
  // Delivery
  { to: '/projects',   navKey: 'projects',   icon: Icons.projects,   module: 'projects' },
  { to: '/planning',   navKey: 'planning',   icon: Icons.planning,   module: 'planning' },
  // Procurement: supplier → purchase → stock
  { to: '/suppliers',  navKey: 'suppliers',  icon: Icons.suppliers,  module: 'suppliers' },
  { to: '/purchases',  navKey: 'purchases',  icon: Icons.purchases,  module: 'purchases' },
  { to: '/inventory',  navKey: 'inventory',  icon: Icons.inventory,  module: 'inventory' },
  { to: '/manufacturing', navKey: 'manufacturing', icon: Icons.manufacturing, module: 'manufacturing' },
  // Finance & analysis
  { to: '/expenses',   navKey: 'expenses',   icon: Icons.expenses,   module: 'expenses' },
  { to: '/fixed-assets', navKey: 'fixedAssets', icon: Icons.assets,  module: 'assets' },
  { to: '/finance',    navKey: 'finance',    icon: Icons.finance,    module: 'finance' },
  { to: '/cash',       navKey: 'cash',       icon: Icons.cash,       module: 'cash' },
  { to: '/reports',    navKey: 'reports',    icon: Icons.reports,    module: 'reports' },
  // People
  { to: '/hr',         navKey: 'hr',         icon: Icons.hr,         module: 'hr' },
];

const systemLinkDefs = [
  { to: '/approvals',          navKey: 'approvals',          icon: Icons.approvals },
  { to: '/approval-policies',  navKey: 'approvalPolicies',   icon: Icons.policies  },
  { to: '/archives',           navKey: 'archives',           icon: Icons.archives  },
  { to: '/settings',           navKey: 'settings',           icon: Icons.settings  },
];

const adminLinkDefs = [
  { to: '/users',  navKey: 'users',      icon: Icons.users },
  { to: '/roles',  navKey: 'roles',      icon: Icons.roles },
  { to: '/admin',  navKey: 'adminPanel', icon: Icons.admin },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { user, isSuperadmin, can } = usePermissions();
  const { t } = useLocale();
  const companyName = settings?.company_name || 'ERP System';
  const [logoError, setLogoError] = useState(false);
  const [logoKey, setLogoKey] = useState(Date.now());

  useEffect(() => {
    setLogoError(false);
    setLogoKey(Date.now());
  }, [settings]);

  const initials = companyName.split(' ').map(w => w[0]).filter(c => c && /[a-zA-Z]/.test(c)).slice(0, 2).join('').toUpperCase();
  const userInitials = (() => {
    const name = user.full_name || '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (user.username || 'U').charAt(0).toUpperCase();
  })();

  async function handleLogout() {
    try { await apiLogout(); } catch {}
    localStorage.removeItem('user');
    navigate('/login');
  }

  const visibleMain = mainLinkDefs.filter(l => can(l.module, 'view'));

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        {logoError
          ? <div className="sidebar-logo-mark">{initials}</div>
          : <img key={logoKey} src={`/api/settings/logo?t=${logoKey}`} alt="logo" onError={() => setLogoError(true)} style={{ height: 32, width: 'auto', maxWidth: 40, objectFit: 'contain' }} />
        }
        <div>
          <div className="sidebar-logo-title">{companyName}</div>
          <div className="sidebar-logo-sub">{t('nav.erpPlatform')}</div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="sidebar-nav">
        <div className="nav-section-label">{t('nav.main')}</div>
        {visibleMain.map(l => (
          <NavLink
            key={l.to} to={l.to} end={l.end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <span className="nav-link-icon">{l.icon}</span>
            {t(`nav.${l.navKey}`)}
          </NavLink>
        ))}

        <div className="nav-section-label" style={{ marginTop: 8 }}>{t('nav.system')}</div>
        {systemLinkDefs.map(l => (
          <NavLink
            key={l.to} to={l.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <span className="nav-link-icon">{l.icon}</span>
            {t(`nav.${l.navKey}`)}
          </NavLink>
        ))}

        {isSuperadmin && (
          <>
            <div className="nav-section-label" style={{ marginTop: 8 }}>{t('nav.admin')}</div>
            {adminLinkDefs.map(l => (
              <NavLink
                key={l.to} to={l.to}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span className="nav-link-icon">{l.icon}</span>
                {t(`nav.${l.navKey}`)}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="sidebar-avatar">{userInitials}</div>
          <div style={{ minWidth: 0 }}>
            <div className="sidebar-username">{user.full_name || user.username || 'Admin'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>
              {user.role_name || (isSuperadmin ? t('nav.administrator') : t('nav.staff'))}
            </div>
          </div>
        </div>
        <button
          className="nav-link"
          style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', marginTop: 2 }}
          onClick={handleLogout}
        >
          <span className="nav-link-icon">{Icons.logout}</span>
          {t('nav.signOut')}
        </button>
      </div>
    </div>
  );
}
