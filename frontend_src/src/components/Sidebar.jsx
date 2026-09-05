import { NavLink, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useLocale } from '../hooks/useLocale.jsx';
import { logout as apiLogout, getAnnouncementsUnread, getBranchContext, getBranchFilter, setBranchFilter } from '../api/client';
import BrandLogo from './BrandLogo';
import ChangePasswordModal from './ChangePasswordModal';
import { useModules } from '../hooks/useModules';
import SearchSelect from '../components/SearchSelect.jsx';

const Icons = {
  communications: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>,
  dashboard: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  clients:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  projects:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h20M4 20V10l8-7 8 7v10"/><path d="M10 20v-6h4v6"/></svg>,
  quotations:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  invoices:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  pos:       <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M6 7V4a2 2 0 012-2h8a2 2 0 012 2v3"/><line x1="6" y1="12" x2="10" y2="12"/><circle cx="17" cy="15" r="1.5"/></svg>,
  inventory: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  promotions: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  warehouses: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21V9l9-6 9 6v12"/><path d="M9 21V12h6v9"/><path d="M3 21h18"/></svg>,
  manufacturing: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h20"/><path d="M4 20V9l5 3V9l5 3V9l5 3v8"/><path d="M9 20v-4h2v4"/></svg>,
  service: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
  purchases: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>,
  suppliers: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  expenses:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  finance:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  accounting: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="12" y1="13" x2="17" y2="13"/><line x1="12" y1="17" x2="17" y2="17"/></svg>,
  assets:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><line x1="9" y1="9" x2="9" y2="9"/><line x1="9" y1="13" x2="9" y2="13"/><line x1="9" y1="17" x2="9" y2="17"/></svg>,
  cash:      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/></svg>,
  reports:   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><polyline points="9 21 9 9"/><polyline points="8 14 11 17 16 12"/></svg>,
  crm:       <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M16 3.13a4 4 0 010 7.75"/><path d="M21 21v-2a4 4 0 00-3-3.87"/></svg>,
  planning:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="13" y2="18"/></svg>,
  hr:        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  recruitment: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><path d="M12 11a4 4 0 100-8 4 4 0 000 8z"/><path d="M19 8v6M16 11h6"/></svg>,
  hrActivities: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  approvals: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
  policies:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
  settings:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  users:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  roles:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  admin:     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  discover:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 5L2 7"/></svg>,
  announce:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-8v18l-18-8z"/><path d="M11.6 16.8a3 3 0 11-5.2 0"/></svg>,
  logout:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// Nav groups — the workflow lifecycle, broken into labelled directory
// sections rather than one undifferentiated list. Reads like the index of a
// printed manual: a quick scan from top to bottom traces the operator's
// natural path through the business (lead → invoice → fulfilment → close
// the books → manage the people who did the work).
//
// `group` is the locale key under `nav.section_<group>`. `null` means the
// item floats above all sections (the dashboard / home).
const mainLinkDefs = [
  { to: '/',           navKey: 'dashboard',  icon: Icons.dashboard,  end: true, module: 'dashboard', group: null         },

  { to: '/crm',           navKey: 'crm',          icon: Icons.crm,          module: 'crm',          group: 'sales'      },
  { to: '/clients',       navKey: 'clients',      icon: Icons.clients,      module: 'clients',      group: 'sales'      },
  { to: '/quotations',    navKey: 'quotations',   icon: Icons.quotations,   module: 'quotations',   group: 'sales'      },
  { to: '/invoices',      navKey: 'invoices',     icon: Icons.invoices,     module: 'invoices',     group: 'sales'      },
  { to: '/pos',           navKey: 'pos',          icon: Icons.pos,          module: 'pos',          group: 'sales'      },
  { to: '/communications', navKey: 'communications', icon: Icons.communications, module: 'communications', group: 'sales'      },

  { to: '/projects',      navKey: 'projects',     icon: Icons.projects,     module: 'projects',     group: 'delivery'   },
  { to: '/planning',      navKey: 'planning',     icon: Icons.planning,     module: 'planning',     group: 'delivery'   },

  { to: '/suppliers',     navKey: 'suppliers',    icon: Icons.suppliers,    module: 'suppliers',    group: 'operations' },
  { to: '/purchases',     navKey: 'purchases',    icon: Icons.purchases,    module: 'purchases',    group: 'operations' },
  { to: '/inventory',     navKey: 'inventory',    icon: Icons.inventory,    module: 'inventory',    group: 'operations' },
  { to: '/promotions',    navKey: 'promotions',   icon: Icons.promotions,   module: 'inventory',    group: 'operations' },
  { to: '/warehouses',    navKey: 'warehouses',   icon: Icons.warehouses,   module: 'warehouses',   group: 'operations' },
  { to: '/manufacturing', navKey: 'manufacturing',icon: Icons.manufacturing,module: 'manufacturing',group: 'operations' },
  { to: '/service',       navKey: 'service',      icon: Icons.service,      module: 'service',      group: 'operations' },

  { to: '/expenses',      navKey: 'expenses',     icon: Icons.expenses,     module: 'expenses',     group: 'finance'    },
  { to: '/fixed-assets',  navKey: 'fixedAssets',  icon: Icons.assets,       module: 'assets',       group: 'finance'    },
  { to: '/finance',       navKey: 'finance',      icon: Icons.finance,      module: 'finance',      group: 'finance'    },
  { to: '/accounting',    navKey: 'accounting',   icon: Icons.accounting,   module: 'accounting',   group: 'finance'    },
  { to: '/cash',          navKey: 'cash',         icon: Icons.cash,         module: 'cash',         group: 'finance'    },
  { to: '/reports',       navKey: 'reports',      icon: Icons.reports,      module: 'reports',      group: 'finance'    },

  { to: '/hr',            navKey: 'hr',           icon: Icons.hr,           module: 'hr',           group: 'people'     },
  { to: '/recruitment',   navKey: 'recruitment',  icon: Icons.recruitment,  module: 'recruitment',  group: 'people'     },
  { to: '/hr-activities', navKey: 'hrActivities', icon: Icons.hrActivities, module: 'hr_activities',group: 'people'     },
];

// Render order for the labelled directory sections.
const SECTION_ORDER = ['sales', 'delivery', 'operations', 'finance', 'people'];

const systemLinkDefs = [
  { to: '/announcements',      navKey: 'announcements',      icon: Icons.announce,  badge: 'announcements' },
  { to: '/approvals',          navKey: 'approvals',          icon: Icons.approvals },
  { to: '/approval-policies',  navKey: 'approvalPolicies',   icon: Icons.policies  },
  { to: '/settings',           navKey: 'settings',           icon: Icons.settings  },
];

const adminLinkDefs = [
  { to: '/users',                  navKey: 'users',          icon: Icons.users },
  { to: '/roles',                  navKey: 'roles',          icon: Icons.roles },
  { to: '/admin',                  navKey: 'adminPanel',     icon: Icons.admin },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const { has: hasModule } = useModules();
  const { user, isSuperadmin, isAdmin, can } = usePermissions();
  const { t } = useLocale();

  // Lightweight poll for the announcements badge. 60s feels right — fresh
  // enough that users see new broadcasts during a working session, slow
  // enough that we never spam the API.
  const [unread, setUnread] = useState({ unread: 0, pending_ack: 0 });
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const data = await getAnnouncementsUnread();
        if (alive) setUnread(data || { unread: 0, pending_ack: 0 });
      } catch { /* silent — auth or network blips are not worth surfacing here */ }
    }
    tick();
    const id = setInterval(tick, 60000);
    function refreshOnFocus() { if (document.visibilityState === 'visible') tick(); }
    document.addEventListener('visibilitychange', refreshOnFocus);
    return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', refreshOnFocus); };
  }, []);

  // Branch context — "branch" == a warehouse/location. The switcher appears
  // ONLY for global users (superadmin / Business Owner), who can see all
  // branches and focus one; branch-scoped staff have a single home branch and
  // see no switcher. Choosing a branch focuses every read on it (?branch_id=
  // via the API client); "All branches" clears the focus. A reload re-fetches
  // all pages under the new scope.
  const [branches, setBranches] = useState([]);
  const [isGlobalBranch, setIsGlobalBranch] = useState(false);
  const [branchSel, setBranchSel] = useState(getBranchFilter() || 'all');
  useEffect(() => {
    let alive = true;
    getBranchContext()
      .then(data => {
        if (!alive) return;
        setIsGlobalBranch(!!(data && data.is_global));
        setBranches((data && data.branches) || []);
      })
      .catch(() => { /* silent — non-critical chrome */ });
    return () => { alive = false; };
  }, []);
  function onBranchChange(val) {
    setBranchSel(val);
    setBranchFilter(val === 'all' ? null : val);
    window.location.reload();
  }

  const userInitials = (() => {
    const name = user.full_name || '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (user.username || 'U').charAt(0).toUpperCase();
  })();

  // Account menu — Sign Out now lives in a popover anchored to the user card,
  // the conventional "proper place" for it, instead of a permanent nav row.
  const [accountOpen, setAccountOpen] = useState(false);
  // Changing your own password is the one account action every role has, so it
  // belongs here rather than under Settings, which most roles cannot open.
  const [pwOpen, setPwOpen] = useState(false);
  const accountRef = useRef(null);
  useEffect(() => {
    if (!accountOpen) return undefined;
    function onDown(e) {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setAccountOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [accountOpen]);

  async function handleLogout() {
    setAccountOpen(false);
    try { await apiLogout(); } catch {}
    localStorage.removeItem('user');
    navigate('/login');
  }

  // Two-stage visibility filter:
  //   1. the tenant's LICENCE (useModules) — what the customer bought.
  //      Shared with the dashboard so the menu and the cards can never
  //      disagree about which modules exist.
  //   2. RBAC view permission — the per-user check the rest of the app
  //      already runs.
  const visibleMain = mainLinkDefs.filter(l => hasModule(l.module) && can(l.module, 'view'));

  return (
    <div className="sidebar">
      {/* Logo */}
      {/* Product brand only. The tenant's own name/logo still drive invoices,
          quotations, contracts, POS receipts and the login screen — they are
          deliberately absent from the app chrome. */}
      <div className="sidebar-logo">
        <BrandLogo height={28} />
      </div>

      {/* Main nav — split into workflow directories. The dashboard sits
          alone above the first labelled section; everything else falls
          under its workflow group. */}
      <nav className="sidebar-nav">
        {/* Unsectioned items (dashboard) — rendered first, no label. */}
        {visibleMain.filter(l => l.group === null).map(l => (
          <NavLink
            key={l.to} to={l.to} end={l.end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <span className="nav-link-icon">{l.icon}</span>
            {t(`nav.${l.navKey}`)}
          </NavLink>
        ))}

        {/* Labelled workflow sections — only rendered if they have at
            least one visible item. Keeps a slim sidebar slim. */}
        {SECTION_ORDER.map(section => {
          const sectionItems = visibleMain.filter(l => l.group === section);
          if (sectionItems.length === 0) return null;
          return (
            <div key={section}>
              <div className="nav-section-label">{t(`nav.section_${section}`)}</div>
              {sectionItems.map(l => (
                <NavLink
                  key={l.to} to={l.to} end={l.end}
                  className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                >
                  <span className="nav-link-icon">{l.icon}</span>
                  {t(`nav.${l.navKey}`)}
                </NavLink>
              ))}
            </div>
          );
        })}

        <div className="nav-section-label" style={{ marginTop: 8 }}>{t('nav.system')}</div>
        {systemLinkDefs.map(l => {
          const count =
            l.badge === 'announcements'
              ? (unread.unread || 0) + (unread.pending_ack || 0)
              : 0;
          return (
            <NavLink
              key={l.to} to={l.to} end={l.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              style={{ position: 'relative' }}
            >
              <span className="nav-link-icon">{l.icon}</span>
              <span style={{ flex: 1 }}>{t(`nav.${l.navKey}`)}</span>
              {count > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 18, height: 18, padding: '0 6px',
                  borderRadius: 999,
                  background: 'var(--red, var(--negate))', color: '#fff',
                  fontSize: 10, fontWeight: 700, letterSpacing: '.2px',
                  marginInlineStart: 'auto',
                }}>
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </NavLink>
          );
        })}

        {isAdmin && (
          <>
            <div className="nav-section-label" style={{ marginTop: 8 }}>{t('nav.admin')}</div>
            {adminLinkDefs.map(l => (
              <NavLink
                key={l.to} to={l.to} end={l.end}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span className="nav-link-icon">{l.icon}</span>
                {t(`nav.${l.navKey}`)}
              </NavLink>
            ))}
          </>
        )}

        {/* A branch manager (not admin-tier) who can manage their branch's
            staff gets just the Users link — not the full admin section. */}
        {!isAdmin && can('users', 'view') && (
          <>
            <div className="nav-section-label" style={{ marginTop: 8 }}>{t('nav.admin')}</div>
            <NavLink to="/users"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span className="nav-link-icon">{Icons.users}</span>
              {t('nav.users')}
            </NavLink>
          </>
        )}
      </nav>

      {/* Branch switcher — only for global users (superadmin / Business Owner)
          with more than one branch. Scoped staff see no switcher. */}
      {isGlobalBranch && branches.length > 1 && (
        <div style={{ padding: '0 10px 8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px',
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)' }}>
            <span className="nav-link-icon" style={{ color: 'var(--text-3)', display: 'inline-flex', flexShrink: 0 }}>{Icons.warehouses}</span>
            <SearchSelect value={branchSel} onChange={onBranchChange} aria-label={t('nav.branch')}
              className=""
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', font: 'inherit',
                fontSize: 12.5, fontWeight: 600, color: 'var(--text)', cursor: 'pointer', outline: 'none',
                padding: 0 }}
              allowBlank={false}
              options={[{ value: 'all', label: t('nav.allBranches') },
                        ...branches.map(b => ({ value: b.id, label: b.name }))]} />
          </label>
        </div>
      )}

      {/* Footer — the account card is the trigger for a sign-out popover. */}
      <div className="sidebar-footer" ref={accountRef} style={{ position: 'relative' }}>
        {accountOpen && (
          <div role="menu" style={{
            position: 'absolute', bottom: '100%', insetInlineStart: 0, insetInlineEnd: 0,
            marginBottom: 8, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 14, boxShadow: '0 6px 24px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08)',
            overflow: 'hidden', zIndex: 1000,
            animation: 'fadeSlideUp .16s ease', transformOrigin: 'bottom center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px 12px' }}>
              <div className="sidebar-avatar" style={{ flexShrink: 0 }}>{userInitials}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 1 }}>
                  {t('nav.signedInAs')}
                </div>
                <div className="sidebar-username">{user.full_name || user.username || 'Admin'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email || user.role_name || (isSuperadmin ? t('nav.administrator') : t('nav.staff'))}
                </div>
              </div>
            </div>
            <div style={{ height: 1, background: 'var(--rule)' }} />
            <button type="button" role="menuitem"
              onClick={() => { setAccountOpen(false); setPwOpen(true); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
                font: 'inherit', fontSize: 13, fontWeight: 500, color: 'var(--text)',
                textAlign: 'start', transition: 'background .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2, rgba(0,0,0,0.04))'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span className="nav-link-icon" style={{ color: 'inherit', display: 'inline-flex' }}>{Icons.roles}</span>
              {t('forceChange.title')}
            </button>
            <div style={{ height: 1, background: 'var(--rule)' }} />
            <button type="button" role="menuitem" onClick={handleLogout}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
                font: 'inherit', fontSize: 13, fontWeight: 500, color: 'var(--red)',
                textAlign: 'start', transition: 'background .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--red-light, rgba(220,38,38,0.10))'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span className="nav-link-icon" style={{ color: 'inherit', display: 'inline-flex' }}>{Icons.logout}</span>
              {t('nav.signOut')}
            </button>
          </div>
        )}

        <button type="button" aria-haspopup="menu" aria-expanded={accountOpen}
          onClick={() => setAccountOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '8px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit', textAlign: 'start',
            background: accountOpen ? 'var(--surface)' : 'transparent',
            border: '1px solid', borderColor: accountOpen ? 'var(--border)' : 'transparent',
            transition: 'background .12s, border-color .12s',
          }}
          onMouseEnter={e => { if (!accountOpen) e.currentTarget.style.background = 'var(--surface)'; }}
          onMouseLeave={e => { if (!accountOpen) e.currentTarget.style.background = 'transparent'; }}
        >
          <div className="sidebar-avatar" style={{ flexShrink: 0 }}>{userInitials}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="sidebar-username">{user.full_name || user.username || 'Admin'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.role_name || (isSuperadmin ? t('nav.administrator') : t('nav.staff'))}
            </div>
          </div>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ color: 'var(--text-3)', flexShrink: 0, transition: 'transform .18s ease', transform: accountOpen ? 'rotate(180deg)' : 'none' }}>
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}
