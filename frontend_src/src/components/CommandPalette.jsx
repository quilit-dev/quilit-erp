import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAll } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';

const TYPE_ICONS = {
  client:      '👤',
  project:     '📁',
  invoice:     '🧾',
  quotation:   '📋',
  inventory:   '📦',
  supplier:    '🏭',
  purchase:    '🛒',
  expense:     '💸',
  lead:        '🎯',
  deal:        '💼',
  contact:     '📇',
  employee:    '👔',
  planning:    '🗓️',
  task:        '✓',
  user:        '🧑‍💼',
  production:  '🏭',
  bom:         '📐',
  asset:       '🏛️',
  pos_sale:    '🧾',
  cash_drawer: '💵',
  recurring:   '🔁',
};

const TYPE_LABELS = {
  client:      'Client',
  project:     'Project',
  invoice:     'Invoice',
  quotation:   'Quotation',
  inventory:   'Inventory',
  supplier:    'Supplier',
  purchase:    'Purchase',
  expense:     'Expense',
  lead:        'Lead',
  deal:        'Deal',
  contact:     'Contact',
  employee:    'Employee',
  planning:    'Planning',
  task:        'Task',
  user:        'User',
  production:  'Production',
  bom:         'BOM',
  asset:       'Fixed Asset',
  pos_sale:    'POS Sale',
  cash_drawer: 'Cash Drawer',
  recurring:   'Recurring',
};

// Every navigable module/page. `module` items are gated by view permission;
// `admin` items are shown only to superadmins; the rest are always available.
const NAV_ITEMS = [
  { title: 'Dashboard',         url: '/',                  icon: '🏠', subtitle: 'Overview & KPIs',            module: 'dashboard',  keywords: 'home kpi' },
  { title: 'Clients',           url: '/clients',           icon: '👥', subtitle: 'Manage clients',             module: 'clients',    keywords: 'customers' },
  { title: 'Projects',          url: '/projects',          icon: '📁', subtitle: 'Active projects',            module: 'projects',   keywords: 'jobs' },
  { title: 'Quotations',        url: '/quotations',        icon: '📋', subtitle: 'Proposals & quotes',         module: 'quotations', keywords: 'quote proposal estimate' },
  { title: 'Invoices',          url: '/invoices',          icon: '🧾', subtitle: 'Billing & payments',         module: 'invoices',   keywords: 'billing payment' },
  { title: 'Inventory',         url: '/inventory',         icon: '📦', subtitle: 'Stock management',           module: 'inventory',  keywords: 'stock items products' },
  { title: 'POS',               url: '/pos',               icon: '🛍️', subtitle: 'Point of sale',              module: 'pos',        keywords: 'sale till cashier checkout' },
  { title: 'Manufacturing',     url: '/manufacturing',     icon: '🏭', subtitle: 'BOMs & production orders',   module: 'manufacturing', keywords: 'bom production mo factory build' },
  { title: 'Purchases',         url: '/purchases',         icon: '🛒', subtitle: 'Purchase orders',            module: 'purchases',  keywords: 'po procurement' },
  { title: 'Suppliers',         url: '/suppliers',         icon: '🏭', subtitle: 'Vendor management',          module: 'suppliers',  keywords: 'vendors' },
  { title: 'Expenses',          url: '/expenses',          icon: '💸', subtitle: 'Track spending',             module: 'expenses',   keywords: 'spending costs recurring' },
  { title: 'Fixed Assets',      url: '/fixed-assets',      icon: '🏛️', subtitle: 'Asset register & depreciation', module: 'assets',  keywords: 'depreciation capital equipment' },
  { title: 'Cash',              url: '/cash',              icon: '💵', subtitle: 'Daily reconciliation',       module: 'cash',       keywords: 'drawer reconciliation till close' },
  { title: 'Finance',           url: '/finance',           icon: '💰', subtitle: 'Cash flow & accounts',       module: 'finance',    keywords: 'accounting cash' },
  { title: 'Reports',           url: '/reports',           icon: '📊', subtitle: 'Analytics & exports',        module: 'reports',    keywords: 'analytics charts' },
  { title: 'CRM',               url: '/crm',               icon: '🤝', subtitle: 'Leads & pipeline',           module: 'crm',        keywords: 'leads sales pipeline' },
  { title: 'Planning',          url: '/planning',          icon: '🗓️', subtitle: 'Schedules & tasks',          module: 'planning',   keywords: 'calendar schedule tasks' },
  { title: 'HR',                url: '/hr',                icon: '👔', subtitle: 'Employees & payroll',        module: 'hr',         keywords: 'human resources staff payroll' },
  { title: 'Approvals',         url: '/approvals',         icon: '✅', subtitle: 'Approval requests',          keywords: 'approve requests' },
  { title: 'Approval Policies', url: '/approval-policies', icon: '🛡️', subtitle: 'Automated approval rules',   keywords: 'policy rules workflow' },
  { title: 'Archives',          url: '/archives',          icon: '🗄️', subtitle: 'Archived records',           keywords: 'archive deleted history' },
  { title: 'Notifications',     url: '/notifications',     icon: '🔔', subtitle: 'Alerts & updates',           keywords: 'alerts' },
  { title: 'Settings',          url: '/settings',          icon: '⚙️', subtitle: 'System configuration',       keywords: 'config preferences company' },
  { title: 'User Management',   url: '/users',             icon: '🧑‍💼', subtitle: 'Manage users',             admin: true, keywords: 'users accounts' },
  { title: 'Role Management',   url: '/roles',             icon: '🔑', subtitle: 'Roles & permissions',        admin: true, keywords: 'roles permissions rbac' },
  { title: 'Admin Panel',       url: '/admin',             icon: '🛠️', subtitle: 'Sessions & audit log',       admin: true, keywords: 'audit sessions' },
];

export default function CommandPalette({ open, onClose }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActive] = useState(0);
  const inputRef  = useRef(null);
  const listRef   = useRef(null);
  const abortRef  = useRef(null);
  const timerRef  = useRef(null);
  const navigate  = useNavigate();
  const { t } = useLocale();
  const { isSuperadmin, can } = usePermissions();

  // Nav items the current user is allowed to see
  const visibleNav = NAV_ITEMS.filter(item => {
    if (item.admin)  return isSuperadmin;
    if (item.module) return can(item.module, 'view');
    return true;
  });

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query.trim()) { setResults([]); setLoading(false); return; }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const data = await searchAll(query.trim(), ctrl.signal);
        setResults(data.results || []);
        setActive(0);
      } catch (e) {
        if (e.name !== 'AbortError') setResults([]);
      } finally {
        setLoading(false);
      }
    }, 280);

    return () => clearTimeout(timerRef.current);
  }, [query]);

  // When searching, match nav items locally and show them above record results
  const q = query.trim().toLowerCase();
  const navMatches = q
    ? visibleNav.filter(i =>
        i.title.toLowerCase().includes(q) ||
        (i.subtitle && i.subtitle.toLowerCase().includes(q)) ||
        (i.keywords && i.keywords.includes(q)))
    : visibleNav;
  const displayed = q ? [...navMatches, ...results] : visibleNav;

  const go = useCallback((url) => {
    navigate(url);
    onClose();
  }, [navigate, onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, displayed.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = displayed[activeIdx];
      if (item) go(item.url);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div
      className="command-palette-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cp-search-row">
          <span className="cp-icon">⌘</span>
          <input
            ref={inputRef}
            className="cp-input"
            placeholder={t('commandPalette.placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <span className="cp-spinner" />}
          <kbd className="cp-esc" onClick={onClose}>ESC</kbd>
        </div>

        {displayed.length > 0 && (
          <>
            <div className="cp-section-label">
              {q ? `${displayed.length} result${displayed.length !== 1 ? 's' : ''}` : 'Quick navigation'}
            </div>
            <ul className="cp-list" ref={listRef} role="listbox">
              {displayed.map((item, idx) => (
                <li
                  key={`${item.type || 'link'}-${item.id || item.url}-${idx}`}
                  role="option"
                  aria-selected={idx === activeIdx}
                  className={`cp-item${idx === activeIdx ? ' cp-item--active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => go(item.url)}
                >
                  <span className="cp-item-icon">
                    {item.type ? TYPE_ICONS[item.type] || '🔍' : item.icon || '🔗'}
                  </span>
                  <span className="cp-item-body">
                    <span className="cp-item-title">{item.title}</span>
                    {item.subtitle && <span className="cp-item-sub">{item.subtitle}</span>}
                  </span>
                  {item.type && (
                    <span className="cp-item-badge">{TYPE_LABELS[item.type]}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {q && !loading && displayed.length === 0 && (
          <div className="cp-empty">{t('commandPalette.noResults')}</div>
        )}

        <div className="cp-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
