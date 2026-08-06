// The module licence picker, shared by the provisioning wizard (setting a
// licence) and the module editor (changing one).
//
// It was extracted rather than copied because the dependency closure here has
// to mirror capabilities.resolve() on the server exactly. Two copies drift,
// and the failure mode of drift is silent: the console shows the operator one
// licence and the backend stores another, which is precisely the class of bug
// that let a customer see modules they had not bought.
//
// Presentation grouping lives here; licensing truth lives in the backend
// graph, which this only renders.
import { useEffect, useMemo, useState } from 'react';

export const GROUPS = [
  { title: 'Sales & Customers', keys: ['clients', 'quotations', 'invoices', 'crm', 'communications'] },
  { title: 'Operations',        keys: ['inventory', 'warehouses', 'purchases', 'suppliers', 'manufacturing', 'pos'] },
  { title: 'Finance',           keys: ['finance', 'expenses', 'cash', 'assets', 'accounting', 'reports'] },
  { title: 'Delivery',          keys: ['projects', 'planning'] },
  { title: 'People',            keys: ['hr', 'hr_contracts', 'hr_activities', 'recruitment'] },
  { title: 'Workplace',         keys: ['announcements'] },
];

export const LABEL = {
  clients: 'Clients', quotations: 'Quotations', invoices: 'Invoices', crm: 'CRM Pipeline',
  inventory: 'Inventory', warehouses: 'Multi-warehouse', purchases: 'Purchasing',
  suppliers: 'Suppliers', manufacturing: 'Manufacturing', pos: 'Point of Sale',
  finance: 'Finance', expenses: 'Expenses', cash: 'Cash & Till', assets: 'Fixed Assets',
  accounting: 'Accounting', reports: 'Reports', projects: 'Projects', planning: 'Planning',
  hr: 'HR & Payroll', hr_contracts: 'Contracts', hr_activities: 'HR Activities',
  recruitment: 'Recruitment', announcements: 'Announcements',
  communications: 'Client Communications',
};

export const label = (k) => LABEL[k] || k;

// Everything the picker needs: the catalogue, the closure, and the lock
// reasons. Owns the selection so both callers behave identically.
export function useModuleGraph(pfetch, initial = []) {
  const [catalog, setCatalog] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set(initial));

  useEffect(() => {
    pfetch('GET', '/api/platform/modules')
      .then(d => setCatalog(d.modules || []))
      .catch(err => setError(err.message));
  }, [pfetch]);

  const graph = useMemo(() => {
    const requires = {}, alwaysOn = new Set();
    for (const m of catalog) {
      requires[m.key] = m.requires || [];
      if (m.always_on) alwaysOn.add(m.key);
    }
    return { requires, alwaysOn };
  }, [catalog]);

  // Transitive closure, mirroring capabilities.resolve() on the server so the
  // UI never promises a combination the backend would silently expand.
  const resolve = useMemo(() => (chosen) => {
    const out = new Set([...chosen, ...graph.alwaysOn]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const key of [...out]) {
        for (const dep of (graph.requires[key] || [])) {
          if (!out.has(dep)) { out.add(dep); grew = true; }
        }
      }
    }
    return out;
  }, [graph]);

  const effective = useMemo(() => resolve(selected), [resolve, selected]);

  // Which explicit choices force a given module on — powers the lock reason.
  const lockedBy = useMemo(() => {
    const map = {};
    for (const key of effective) {
      if (graph.alwaysOn.has(key)) continue;
      const causes = [...selected].filter(c => c !== key && resolve(new Set([c])).has(key));
      if (causes.length) map[key] = causes;
    }
    return map;
  }, [effective, selected, resolve, graph]);

  function toggle(key) {
    if (graph.alwaysOn.has(key) || lockedBy[key]) return;   // required — not removable
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const ready = catalog.length > 0;
  return { catalog, graph, selected, setSelected, effective, lockedBy, toggle, error, ready };
}

export function ModulePicker({ graph, selected, effective, lockedBy, toggle }) {
  return (
    <>
      {GROUPS.map(group => {
        const keys = group.keys.filter(k => graph.requires[k] !== undefined);
        if (!keys.length) return null;
        return (
          <div key={group.title} style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8,
            }}>{group.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
              {keys.map(key => {
                const always = graph.alwaysOn.has(key);
                const forced = lockedBy[key];
                const on = effective.has(key);
                const locked = always || !!forced;
                return (
                  <label key={key}
                    title={always ? 'Always included'
                      : forced ? `Required by ${forced.map(label).join(', ')}` : ''}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '9px 11px', border: '1px solid var(--rule)',
                      borderRadius: 'var(--r-sm)',
                      background: on ? 'var(--accent-soft)' : 'var(--surface)',
                      cursor: locked ? 'not-allowed' : 'pointer',
                      opacity: locked && !on ? 0.6 : 1,
                    }}>
                    <input type="checkbox" checked={on} disabled={locked}
                      onChange={() => toggle(key)} style={{ marginTop: 2 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                        {label(key)}
                      </span>
                      {always && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Always included</span>
                      )}
                      {forced && (
                        <span style={{ fontSize: 11, color: 'var(--accent)' }}>
                          Required by {forced.map(label).join(', ')}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
