import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAll } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';

const TYPE_ICONS = {
  client:    '👤',
  project:   '📁',
  invoice:   '🧾',
  quotation: '📋',
  inventory: '📦',
  supplier:  '🏭',
  purchase:  '🛒',
};

const TYPE_LABELS = {
  client:    'Client',
  project:   'Project',
  invoice:   'Invoice',
  quotation: 'Quotation',
  inventory: 'Inventory',
  supplier:  'Supplier',
  purchase:  'Purchase',
};

const QUICK_LINKS = [
  { title: 'Dashboard',   url: '/',            icon: '🏠', subtitle: 'Overview & KPIs' },
  { title: 'Clients',     url: '/clients',     icon: '👥', subtitle: 'Manage clients' },
  { title: 'Projects',    url: '/projects',    icon: '📁', subtitle: 'Active projects' },
  { title: 'Invoices',    url: '/invoices',    icon: '🧾', subtitle: 'Billing & payments' },
  { title: 'Quotations',  url: '/quotations',  icon: '📋', subtitle: 'Proposals & quotes' },
  { title: 'Inventory',   url: '/inventory',   icon: '📦', subtitle: 'Stock management' },
  { title: 'Finance',     url: '/finance',     icon: '💰', subtitle: 'Reports & expenses' },
  { title: 'Suppliers',   url: '/suppliers',   icon: '🏭', subtitle: 'Vendor management' },
  { title: 'Purchases',   url: '/purchases',   icon: '🛒', subtitle: 'Purchase orders' },
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

  const displayed = query.trim() ? results : QUICK_LINKS;

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
              {query.trim() ? `${results.length} result${results.length !== 1 ? 's' : ''}` : 'Quick navigation'}
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

        {query.trim() && !loading && results.length === 0 && (
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
