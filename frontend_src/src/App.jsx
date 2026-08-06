import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import ServerGate from './components/ServerGate';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/ToastContainer';
import CommandPalette from './components/CommandPalette';
import NotificationBell from './components/NotificationBell';
import { ReportProblemButton } from './components/ReportProblem';
import { LoadingSpinner } from './components/shared';
import { useTheme } from './hooks/useTheme.jsx';
import { useLocale } from './hooks/useLocale.jsx';
import { logout, getSetupStatus } from './api/client';

const Login               = lazy(() => import('./pages/Login'));
const PlatformConsole     = lazy(() => import('./pages/PlatformConsole'));
const Setup               = lazy(() => import('./pages/Setup'));
// Client-facing document view. Public by design: the recipient is not a user.
const PublicDocument      = lazy(() => import('./pages/PublicDocument'));
const Communications      = lazy(() => import('./pages/Communications'));
const ForceChangePassword = lazy(() => import('./pages/ForceChangePassword'));
const Dashboard      = lazy(() => import('./pages/Dashboard'));
const Clients        = lazy(() => import('./pages/Clients'));
const ClientDetail   = lazy(() => import('./pages/ClientDetail'));
const Projects       = lazy(() => import('./pages/Projects'));
const ProjectDetail  = lazy(() => import('./pages/ProjectDetail'));
const Quotations     = lazy(() => import('./pages/Quotations'));
const Invoices       = lazy(() => import('./pages/Invoices'));
const Inventory      = lazy(() => import('./pages/Inventory'));
const Promotions     = lazy(() => import('./pages/Promotions'));
const POS            = lazy(() => import('./pages/POS'));
const Manufacturing  = lazy(() => import('./pages/Manufacturing'));
const Purchases      = lazy(() => import('./pages/Purchases'));
const Finance        = lazy(() => import('./pages/Finance'));
const Accounting     = lazy(() => import('./pages/Accounting'));
const Expenses       = lazy(() => import('./pages/Expenses'));
const FixedAssets    = lazy(() => import('./pages/FixedAssets'));
const Cash           = lazy(() => import('./pages/Cash'));
const Settings       = lazy(() => import('./pages/Settings'));
const Notifications   = lazy(() => import('./pages/Notifications'));
const Suppliers      = lazy(() => import('./pages/Suppliers'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const RoleManagement = lazy(() => import('./pages/RoleManagement'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const Reports           = lazy(() => import('./pages/Reports'));
const CRM               = lazy(() => import('./pages/CRM'));
const Planning          = lazy(() => import('./pages/Planning'));
const HR                = lazy(() => import('./pages/HR'));
const Recruitment       = lazy(() => import('./pages/Recruitment'));
const HRActivities      = lazy(() => import('./pages/HRActivities'));
const ApprovalPolicies  = lazy(() => import('./pages/ApprovalPolicies'));
const ApprovalRequests  = lazy(() => import('./pages/ApprovalRequests'));
const Announcements     = lazy(() => import('./pages/Announcements'));
const Warehouses        = lazy(() => import('./pages/Warehouses'));

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

function InactivityGuard({ children }) {
  const navigate = useNavigate();

  useEffect(() => {
    let timer;
    function reset() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await logout(); } catch {}
        localStorage.removeItem('user');
        navigate('/login');
      }, INACTIVITY_MS);
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart'];
    events.forEach(e => document.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach(e => document.removeEventListener(e, reset));
    };
  }, [navigate]);

  return children;
}

function RequireAuth({ children }) {
  const location = useLocation();
  let user = null;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch {}
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <InactivityGuard>{children}</InactivityGuard>;
}

// Admin tier: vendor superadmin OR an admin-tier role (e.g. "Business Owner").
// Governs the admin area — users, roles, the admin dashboard.
function RequireAdmin({ children }) {
  let user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
  if (!(user.is_superadmin || user.admin_access)) return <Navigate to="/" replace />;
  return children;
}

// User management is reachable by admins OR a branch manager with the `users`
// permission (who can manage only their own branch's staff). Roles/settings/
// audit stay admin-only via RequireAdmin.
function RequireUserManager({ children }) {
  let user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
  const allowed = user.is_superadmin || user.admin_access
    || Boolean(user.permissions?.users?.view);
  if (!allowed) return <Navigate to="/" replace />;
  return children;
}

function RequirePasswordChange({ children }) {
  let user = null;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch {}
  if (user?.must_change_password) return <Navigate to="/force-change-password" replace />;
  return children;
}

function SetupGate({ children }) {
  const [checked, setChecked] = useState(false);
  const [setupComplete, setSetupComplete] = useState(true);
  const location = useLocation();

  useEffect(() => {
    getSetupStatus()
      .then(data => { setSetupComplete(data.setup_complete); setChecked(true); })
      .catch(() => { setSetupComplete(true); setChecked(true); });
  }, []);

  if (!checked) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}><LoadingSpinner /></div>;
  // The operator console (/vendor-admin, legacy alias /platform) is the vendor's
  // surface, not a tenant page — a tenant's incomplete setup must never hijack it.
  const VENDOR_ADMIN_PATHS = ['/vendor-admin', '/platform'];
  if (!setupComplete && location.pathname !== '/setup' && !VENDOR_ADMIN_PATHS.includes(location.pathname)) return <Navigate to="/setup" replace />;
  if (setupComplete && location.pathname === '/setup') return <Navigate to="/login" replace />;
  return children;
}

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useLocale();
  return (
    <button className="theme-toggle" onClick={toggleTheme} title={theme === 'light' ? t('common.switchToDark') : t('common.switchToLight')}>
      {theme === 'light'
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      }
    </button>
  );
}

function LangToggleButton() {
  const { lang, setLang } = useLocale();
  return (
    <button
      className="theme-toggle"
      onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
      title={lang === 'en' ? 'Switch to Arabic' : 'التبديل إلى الإنجليزية'}
      style={{ fontWeight: 700, fontSize: 11, letterSpacing: 0, minWidth: 28 }}
    >
      {lang === 'en' ? 'ع' : 'EN'}
    </button>
  );
}

function Layout({ children }) {
  const { t } = useLocale();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    function handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(prev => !prev);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  // Close the mobile sidebar drawer whenever the route changes (e.g. a nav tap).
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const pageKeys = [
    '/', '/clients', '/projects', '/quotations', '/invoices', '/inventory', '/pos',
    '/purchases', '/suppliers', '/manufacturing', '/expenses', '/fixed-assets', '/finance', '/cash', '/reports', '/crm', '/planning', '/hr', '/recruitment', '/hr-activities',
    '/notifications', '/approvals', '/approval-policies', '/settings', '/users', '/roles', '/admin',
  ];
  const path = location.pathname;
  const matchedKey = pageKeys.find(k => k === path) || pageKeys.find(k => k !== '/' && path.startsWith(k));
  const label = matchedKey ? t(`pages.${matchedKey}`) : 'ERP';

  return (
    <div className={`layout${sidebarOpen ? ' sidebar-open' : ''}`}>
      <Sidebar />
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}
      <div className="main-content">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className="sidebar-toggle icon-btn"
              onClick={() => setSidebarOpen(true)}
              aria-label="Menu"
              title="Menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.1px' }}>{label}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setPaletteOpen(true)}
              className="btn btn-outline search-btn"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px' }}
              title={t('common.searchCtrlK') + ' (Ctrl+K)'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              {t('common.searchCtrlK')}
              <kbd style={{ fontSize: 10, opacity: 0.6, fontFamily: 'monospace', border: '1px solid var(--border)', borderRadius: 3, padding: '0 3px' }}>Ctrl K</kbd>
            </button>
            <div className="live-badge" style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--green-light)', color: 'var(--green)',
              padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 2s infinite' }} />
              {t('common.live')}
            </div>
            <NotificationBell />
            <ReportProblemButton />
            <LangToggleButton />
            <ThemeToggleButton />
          </div>
        </div>
        <div className="page-content">{children}</div>
      </div>
      <ToastContainer />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

function Page({ children }) {
  const { t } = useLocale();
  const location = useLocation();
  return (
    <Suspense fallback={<div className="page-content"><LoadingSpinner /></div>}>
      {/* Keyed by path: a crash is contained to the page area, and simply
          navigating to another page resets the boundary. */}
      <ErrorBoundary key={location.pathname} t={t}>
        {children}
      </ErrorBoundary>
    </Suspense>
  );
}

function Auth(element) {
  return <RequireAuth><RequirePasswordChange><Layout><Page>{element}</Page></Layout></RequirePasswordChange></RequireAuth>;
}

function Admin(element) {
  return <RequireAuth><RequirePasswordChange><RequireAdmin><Layout><Page>{element}</Page></Layout></RequireAdmin></RequirePasswordChange></RequireAuth>;
}

function UsersAdmin(element) {
  return <RequireAuth><RequirePasswordChange><RequireUserManager><Layout><Page>{element}</Page></Layout></RequireUserManager></RequirePasswordChange></RequireAuth>;
}

export default function App() {
  return (
    <ServerGate>
      <BrowserRouter>
        <SetupGate>
          <Routes>
            <Route path="/setup"                  element={<Page><Setup /></Page>} />
            <Route path="/login"                  element={<Page><Login /></Page>} />
            {/* Two shapes on purpose. New links carry the document number for
                readability (/d/inv-2026-0042/<token>); links already sent to
                clients are /d/<token> and must keep working forever, because a
                dead invoice link is a support call. PublicDocument reads the
                LAST segment either way. */}
            <Route path="/d/:token"               element={<Page><PublicDocument /></Page>} />
            <Route path="/d/:label/:token"        element={<Page><PublicDocument /></Page>} />
            <Route path="/vendor-admin"           element={<Page><PlatformConsole /></Page>} />
            <Route path="/platform"               element={<Page><PlatformConsole /></Page>} />{/* legacy alias */}
            <Route path="/force-change-password"  element={<RequireAuth><Page><ForceChangePassword /></Page></RequireAuth>} />
            <Route path="/"             element={Auth(<Dashboard />)} />
            <Route path="/clients"      element={Auth(<Clients />)} />
            <Route path="/communications" element={Auth(<Communications />)} />
            <Route path="/clients/:id"  element={Auth(<ClientDetail />)} />
            <Route path="/projects"     element={Auth(<Projects />)} />
            <Route path="/projects/:id" element={Auth(<ProjectDetail />)} />
            <Route path="/quotations"   element={Auth(<Quotations />)} />
            <Route path="/invoices"     element={Auth(<Invoices />)} />
            <Route path="/inventory"    element={Auth(<Inventory />)} />
            <Route path="/promotions"   element={Auth(<Promotions />)} />
            <Route path="/warehouses"   element={Auth(<Warehouses />)} />
            <Route path="/pos"          element={Auth(<POS />)} />
            <Route path="/manufacturing" element={Auth(<Manufacturing />)} />
            <Route path="/purchases"    element={Auth(<Purchases />)} />
            <Route path="/suppliers"    element={Auth(<Suppliers />)} />
            <Route path="/finance"      element={Auth(<Finance />)} />
            <Route path="/accounting"   element={Auth(<Accounting />)} />
            <Route path="/cash"         element={Auth(<Cash />)} />
            <Route path="/reports"      element={Auth(<Reports />)} />
            <Route path="/crm"          element={Auth(<CRM />)} />
            <Route path="/planning"     element={Auth(<Planning />)} />
            <Route path="/hr"           element={Auth(<HR />)} />
            <Route path="/recruitment"  element={Auth(<Recruitment />)} />
            <Route path="/hr-activities" element={Auth(<HRActivities />)} />
            <Route path="/expenses"     element={Auth(<Expenses />)} />
            <Route path="/fixed-assets" element={Auth(<FixedAssets />)} />
            <Route path="/notifications"  element={Auth(<Notifications />)} />
            <Route path="/approvals"          element={Auth(<ApprovalRequests />)} />
            <Route path="/approval-policies" element={Auth(<ApprovalPolicies />)} />
            <Route path="/announcements"     element={Auth(<Announcements />)} />
            <Route path="/settings"          element={Auth(<Settings />)} />
            <Route path="/users"        element={UsersAdmin(<UserManagement />)} />
            <Route path="/roles"        element={Admin(<RoleManagement />)} />
            <Route path="/admin"                  element={Admin(<AdminDashboard />)} />
            <Route path="*"             element={<Navigate to="/" replace />} />
          </Routes>
        </SetupGate>
      </BrowserRouter>
    </ServerGate>
  );
}
