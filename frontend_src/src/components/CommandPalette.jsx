// Global command palette — Ctrl/Cmd+K.
//
// What the user sees:
//   • Type a query → the server searches every accessible module + every
//     navigable page is matched locally. Results are grouped by category
//     (Sales / Operations / Finance / People / Administration / System),
//     each group has its own subheader and result count.
//   • Empty input → "Recent" (last 8 records the user opened from this
//     palette, persisted in localStorage) above the full nav list.
//   • Match highlight on title + subtitle.
//   • Up/Down navigates across all groups; Enter opens; Esc closes.
//
// Everything is locale-aware (RTL-safe) and respects the caller's
// permissions — the server filters its half, and `usePermissions().can()`
// filters the navigation entries.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAll } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useScrollLock } from '../hooks/useScrollLock';
import { safePath } from '../utils/safeNav';

// Emoji-only — same set across themes so the palette renders identically in
// light/dark and in both Latin and Arabic numerals.
const TYPE_ICONS = {
  client:             '👤',
  project:            '📁',
  invoice:            '🧾',
  quotation:          '📋',
  inventory:          '📦',
  supplier:           '🏭',
  purchase:           '🛒',
  expense:            '💸',
  recurring:          '🔁',
  lead:               '🎯',
  deal:               '💼',
  contact:            '📇',
  crm_activity:       '📞',
  employee:           '👔',
  department:         '🏢',
  contract:           '📃',
  leave:              '🌴',
  payroll_run:        '🧮',
  attendance:         '🕒',
  hr_activity:        '📅',
  position:           '📢',
  applicant:          '🧑‍💻',
  interview:          '🎤',
  offer:              '✉️',
  planning:           '🗓️',
  task:               '✓',
  milestone:          '🚩',
  event:              '📆',
  production:         '🏭',
  bom:                '📐',
  work_center:        '⚙️',
  resource:           '🔧',
  asset:              '🏛️',
  account:            '📒',
  journal:            '📓',
  tax_rate:           '％',
  pos_sale:           '🧾',
  cash_drawer:        '💵',
  announcement:       '📣',
  approval_policy:    '🛡️',
  approval_request:   '✅',
  user:               '🧑‍💼',
  role:               '🔑',
  warehouse:          '🏬',
  stock_transfer:     '🚚',
  notification:       '🔔',
  accounting_period:  '📅',
  fiscal_year:        '📊',
  exchange_rate:      '💱',
  document:           '📄',
};

// Map each entity type to its display category. Drives the grouped sections
// the operator sees — keep in sync with the backend's per-entity coverage.
const TYPE_CATEGORY = {
  // Sales lifecycle
  client: 'sales', contact: 'sales', lead: 'sales', deal: 'sales',
  crm_activity: 'sales', quotation: 'sales', invoice: 'sales',
  project: 'sales', planning: 'sales', task: 'sales', milestone: 'sales',
  event: 'sales',
  // Operations
  inventory: 'operations', supplier: 'operations', purchase: 'operations',
  warehouse: 'operations', stock_transfer: 'operations', pos_sale: 'operations',
  production: 'operations', bom: 'operations', work_center: 'operations',
  resource: 'operations',
  // Finance
  expense: 'finance', recurring: 'finance', cash_drawer: 'finance',
  asset: 'finance', account: 'finance', journal: 'finance',
  accounting_period: 'finance', fiscal_year: 'finance', exchange_rate: 'finance',
  tax_rate: 'finance',
  // People
  employee: 'people', department: 'people', contract: 'people', leave: 'people',
  payroll_run: 'people', attendance: 'people',
  hr_activity: 'people', position: 'people', applicant: 'people',
  interview: 'people', offer: 'people', announcement: 'people',
  // Administration
  user: 'admin', role: 'admin', approval_policy: 'admin',
  approval_request: 'admin',
  // System cross-cutting
  notification: 'system', document: 'system',
};

const CATEGORY_ORDER = ['sales', 'operations', 'finance', 'people', 'admin', 'system', 'other'];

const NAV_KEY = (slug) => `commandPalette.nav_${slug}`;
const NAV_SUB_KEY = (slug) => `commandPalette.nav_${slug}_sub`;

// Every navigable page in the app. The order is intentional — it's the same
// shape the operator sees in the sidebar. `module` items are gated by view
// permission; `admin` items require admin tier; the rest are always visible.
const NAV_ITEMS = [
  { slug: 'dashboard',         url: '/',                  icon: '🏠', module: 'dashboard',     keywords: 'home kpi لوحة' },
  { slug: 'clients',           url: '/clients',           icon: '👥', module: 'clients',       keywords: 'customers عملاء' },
  { slug: 'projects',          url: '/projects',          icon: '📁', module: 'projects',      keywords: 'jobs مشاريع' },
  { slug: 'quotations',        url: '/quotations',        icon: '📋', module: 'quotations',    keywords: 'quote proposal estimate عرض' },
  { slug: 'invoices',          url: '/invoices',          icon: '🧾', module: 'invoices',      keywords: 'billing payment فاتورة' },
  { slug: 'inventory',         url: '/inventory',         icon: '📦', module: 'inventory',     keywords: 'stock items products مخزون' },
  { slug: 'warehouses',        url: '/warehouses',        icon: '🏬', module: 'warehouses',    keywords: 'location transfer مستودع' },
  { slug: 'pos',               url: '/pos',               icon: '🛍️', module: 'pos',           keywords: 'sale till cashier checkout بيع' },
  { slug: 'manufacturing',     url: '/manufacturing',     icon: '🏭', module: 'manufacturing', keywords: 'bom production mo factory build تصنيع' },
  { slug: 'service',           url: '/service',           icon: '🔧', module: 'service',       keywords: 'repair maintenance install job work order equipment صيانة تصليح' },
  { slug: 'purchases',         url: '/purchases',         icon: '🛒', module: 'purchases',     keywords: 'po procurement شراء' },
  { slug: 'suppliers',         url: '/suppliers',         icon: '🏭', module: 'suppliers',     keywords: 'vendors موردين' },
  { slug: 'expenses',          url: '/expenses',          icon: '💸', module: 'expenses',      keywords: 'spending costs recurring مصروف' },
  { slug: 'assets',            url: '/fixed-assets',      icon: '🏛️', module: 'assets',        keywords: 'depreciation capital equipment أصل' },
  { slug: 'cash',              url: '/cash',              icon: '💵', module: 'cash',          keywords: 'drawer reconciliation till close صندوق' },
  { slug: 'finance',           url: '/finance',           icon: '💰', module: 'finance',       keywords: 'accounting cash مالية' },
  { slug: 'accounting',        url: '/accounting',        icon: '📒', module: 'accounting',    keywords: 'gl coa journal entry محاسبة' },
  { slug: 'reports',           url: '/reports',           icon: '📊', module: 'reports',       keywords: 'analytics charts تقارير' },
  { slug: 'crm',               url: '/crm',               icon: '🤝', module: 'crm',           keywords: 'leads sales pipeline علاقات' },
  { slug: 'planning',          url: '/planning',          icon: '🗓️', module: 'planning',      keywords: 'calendar schedule tasks تخطيط' },
  { slug: 'hr',                url: '/hr',                icon: '👔', module: 'hr',            keywords: 'human resources staff payroll موارد بشرية' },
  { slug: 'recruitment',       url: '/recruitment',       icon: '📢', module: 'recruitment',   keywords: 'hiring applicants positions توظيف' },
  { slug: 'hr_activities',     url: '/hr-activities',     icon: '📅', module: 'hr_activities', keywords: 'activities calendar أنشطة' },
  { slug: 'announcements',     url: '/announcements',     icon: '📣', module: 'announcements', keywords: 'broadcast إعلان' },
  { slug: 'approvals',         url: '/approvals',         icon: '✅', keywords: 'approve requests موافقة' },
  { slug: 'approval_policies', url: '/approval-policies', icon: '🛡️', keywords: 'policy rules workflow سياسة' },
  { slug: 'notifications',     url: '/notifications',     icon: '🔔', keywords: 'alerts إشعار' },
  { slug: 'settings',          url: '/settings',          icon: '⚙️', keywords: 'config preferences company إعدادات' },
  { slug: 'users',             url: '/users',             icon: '🧑‍💼', admin: true, keywords: 'users accounts مستخدمين' },
  { slug: 'roles',             url: '/roles',             icon: '🔑', admin: true, keywords: 'roles permissions rbac أدوار' },
  { slug: 'admin',             url: '/admin',             icon: '🛠️', admin: true, keywords: 'audit sessions تدقيق' },
];

const RECENTS_KEY = 'cp_recents_v1';
const RECENTS_MAX = 8;

// Read/write the recents stack. Stored as a JSON array of palette items the
// user actually opened — capped so it never grows unbounded.
function loadRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
}
function pushRecent(item) {
  if (!item || !item.url) return;
  const slim = {
    type: item.type, id: item.id, title: item.title,
    subtitle: item.subtitle, url: item.url, icon: item.icon || null,
    slug: item.slug || null,
  };
  const list = loadRecents().filter(
    r => !(r.url === slim.url && (r.id || null) === (slim.id || null)
                              && (r.type || null) === (slim.type || null)),
  );
  list.unshift(slim);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))); }
  catch { /* quota full or storage disabled — recents is non-essential */ }
}

// Highlight all occurrences of `query` inside `text` with a <mark>. Used in
// both titles and subtitles so the operator sees why a record matched.
function Highlight({ text, query }) {
  if (!text) return null;
  const q = (query || '').trim();
  if (!q) return text;
  // Escape regex special chars so a search for "a+b" doesn't blow up.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(text).split(new RegExp(`(${safe})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase()
      ? <mark key={i} className="cp-mark">{p}</mark>
      : <span key={i}>{p}</span>,
  );
}

export default function CommandPalette({ open, onClose }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActive] = useState(0);
  const [recents, setRecents]  = useState(loadRecents);
  const inputRef  = useRef(null);
  const listRef   = useRef(null);
  const abortRef  = useRef(null);
  const timerRef  = useRef(null);
  const navigate  = useNavigate();
  const { t, isRTL } = useLocale();
  const { isSuperadmin, can } = usePermissions();

  // Freeze the page scroll while the palette is open. Otherwise scrolling
  // past the end of the results list bleeds through to the underlying
  // page, which is disorienting.
  useScrollLock(open);

  // Hydrate the navigation menu with localized labels. Permissions filter
  // out items the user can't open — a search hit on a locked module is a
  // permissions bug, not a feature.
  const visibleNav = useMemo(() => NAV_ITEMS
    .filter(item => {
      if (item.admin)  return isSuperadmin;
      if (item.module) return can(item.module, 'view');
      return true;
    })
    .map(item => ({
      ...item,
      kind: 'nav',
      title: t(NAV_KEY(item.slug)),
      subtitle: t(NAV_SUB_KEY(item.slug)),
    })),
    // t depends on lang; recompute on lang change
    [isSuperadmin, can, t],
  );

  // Reset whenever the palette opens — stale results from a prior session
  // would otherwise flash before the new query lands.
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      setRecents(loadRecents());
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Debounced search against the server. AbortController prevents an older
  // in-flight request from clobbering newer results when the user types fast.
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
    }, 240);

    return () => clearTimeout(timerRef.current);
  }, [query]);

  const q = query.trim();
  const qLower = q.toLowerCase();

  // Local nav matching against title/subtitle/keywords — so "ledger" or
  // "السنة المالية" both surface the Accounting page.
  const navMatches = useMemo(() => {
    if (!qLower) return [];
    return visibleNav.filter(i =>
      (i.title    && i.title.toLowerCase().includes(qLower)) ||
      (i.subtitle && i.subtitle.toLowerCase().includes(qLower)) ||
      (i.keywords && i.keywords.toLowerCase().includes(qLower)),
    );
  }, [visibleNav, qLower]);

  // Bucket server results into the same category groups operators see in the
  // sidebar. Unknown types fall into "Other" so future entities still render.
  const groupedRecords = useMemo(() => {
    const out = {};
    for (const r of results) {
      const cat = TYPE_CATEGORY[r.type] || 'other';
      (out[cat] ||= []).push(r);
    }
    return out;
  }, [results]);

  // Compose a flat list of selectable rows for keyboard navigation. The
  // section headers themselves are non-selectable — only items get keyboard
  // focus.
  const sections = useMemo(() => {
    const list = [];
    if (q) {
      if (navMatches.length) {
        list.push({ header: t('commandPalette.navigation'), key: 'nav-matches', items: navMatches });
      }
      for (const cat of CATEGORY_ORDER) {
        const items = groupedRecords[cat];
        if (items && items.length) {
          list.push({ header: t(`commandPalette.cat${cat[0].toUpperCase()}${cat.slice(1)}`), key: `cat-${cat}`, items });
        }
      }
    } else {
      if (recents.length) {
        list.push({ header: t('commandPalette.recent'), key: 'recents', items: recents });
      }
      list.push({ header: t('commandPalette.quickNav'), key: 'quicknav', items: visibleNav });
    }
    return list;
  }, [q, navMatches, groupedRecords, recents, visibleNav, t]);

  const flatItems = useMemo(() => sections.flatMap(s => s.items), [sections]);

  const totalCount = q ? flatItems.length : 0;

  // Navigate + remember. Recents only persists when the user actually opens
  // something — bare keystrokes don't count.
  const go = useCallback((item) => {
    if (!item || !item.url) return;
    pushRecent(item);
    setRecents(loadRecents());
    // Result urls come from stored/search data — validate before navigating.
    navigate(safePath(item.url));
    onClose();
  }, [navigate, onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = flatItems[activeIdx];
      if (item) go(item);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Backspace') {
      // Power-user shortcut: clear the recents stack
      try { localStorage.removeItem(RECENTS_KEY); } catch {}
      setRecents([]);
    }
  };

  // Keep the active row visible. `scrollIntoView({ block: 'nearest' })` is a
  // no-op when the item is already on screen, so it never causes jitter.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-cp-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  // Stable flat-index lookup so a [data-cp-idx] attribute on each row maps
  // unambiguously to the keyboard cursor across multi-section layouts.
  let runningIdx = -1;

  return (
    <div
      className="command-palette-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" dir={isRTL ? 'rtl' : 'ltr'}>
        <div className="cp-search-row">
          <span className="cp-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
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
          {loading && <span className="cp-spinner" aria-label="loading" />}
          <kbd className="cp-esc" onClick={onClose}>ESC</kbd>
        </div>

        {q && !loading && (
          <div className="cp-count-line">
            {totalCount === 1
              ? t('commandPalette.resultCount',  { n: totalCount })
              : t('commandPalette.resultsCount', { n: totalCount })}
          </div>
        )}

        {sections.length > 0 ? (
          <div className="cp-list" ref={listRef} role="listbox">
            {sections.map((sec) => (
              <div key={sec.key} className="cp-section">
                <div className="cp-section-label">
                  <span>{sec.header}</span>
                  <span className="cp-section-count">{sec.items.length}</span>
                </div>
                <ul className="cp-section-list">
                  {sec.items.map((item) => {
                    runningIdx += 1;
                    const idx = runningIdx;
                    const isActive = idx === activeIdx;
                    const badgeKey = item.type ? `commandPalette.type_${item.type}` : null;
                    return (
                      <li
                        key={`${item.type || item.kind || 'nav'}-${item.id ?? item.slug ?? item.url}-${idx}`}
                        role="option"
                        aria-selected={isActive}
                        data-cp-idx={idx}
                        className={`cp-item${isActive ? ' cp-item--active' : ''}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => go(item)}
                      >
                        <span className="cp-item-icon" aria-hidden>
                          {item.type
                            ? TYPE_ICONS[item.type] || '🔍'
                            : item.icon || '🔗'}
                        </span>
                        <span className="cp-item-body">
                          <span className="cp-item-title">
                            <Highlight text={item.title} query={qLower} />
                          </span>
                          {item.subtitle && (
                            <span className="cp-item-sub">
                              <Highlight text={item.subtitle} query={qLower} />
                            </span>
                          )}
                        </span>
                        {badgeKey && (
                          <span className="cp-item-badge">{t(badgeKey)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

        {q && !loading && flatItems.length === 0 && (
          <div className="cp-empty">{t('commandPalette.noResults')}</div>
        )}

        <div className="cp-footer">
          <span><kbd>↑↓</kbd> {t('commandPalette.keyboardNav')}</span>
          <span><kbd>Enter</kbd> {t('commandPalette.keyboardOpen')}</span>
          <span><kbd>Esc</kbd> {t('commandPalette.keyboardClose')}</span>
        </div>
      </div>
    </div>
  );
}
