// The module editor decides what a customer is billed for and what they can
// reach, so its behaviour is pinned here rather than left to manual clicking.
//
// The page smoke suite globs `pages/*.jsx` only, so components under
// pages/platform/ are not covered by it — and this one never mounts during a
// PlatformConsole smoke render because it only appears once a tenant is opened.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// The editor talks to the operator API through platform/api's pfetch. Mock it
// so the catalogue is deterministic and no save escapes the test.
const saved = [];
vi.mock('../pages/platform/api', () => ({
  pfetch: vi.fn(async (method, url, body) => {
    if (method === 'GET' && url === '/api/platform/modules') {
      return {
        modules: [
          { key: 'dashboard', always_on: true,  requires: [] },
          { key: 'clients',   always_on: false, requires: [] },
          { key: 'invoices',  always_on: false, requires: ['clients'] },
          { key: 'hr',        always_on: false, requires: [] },
          { key: 'accounting', always_on: true, requires: [] },
        ],
        always_on: ['dashboard'],
      };
    }
    if (method === 'PUT') { saved.push({ url, body }); return {}; }
    return {};
  }),
}));

vi.mock('../components/shared', () => ({ toast: vi.fn() }));

import ModuleEditor from '../pages/platform/ModuleEditor';

const mount = async (tenant) => {
  const r = render(<ModuleEditor tenant={tenant} onClose={() => {}} onSaved={() => {}} />);
  await act(async () => {});     // let the catalogue fetch settle
  return r;
};

beforeEach(() => { saved.length = 0; });

describe('ModuleEditor', () => {
  test('an unlicensed business is called out, not shown as empty', async () => {
    await mount({ slug: 'aman', name: 'Aman', modules: '' });
    // This is the AMAN case: no licence recorded means every module is visible,
    // and the operator has to be told that explicitly.
    expect(screen.getByText(/no licence recorded/i)).toBeTruthy();
  });

  test('save is blocked until something actually changes', async () => {
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients' });
    const save = screen.getByRole('button', { name: /save licence/i });
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/no changes/i)).toBeTruthy();
  });

  test('enabling a module is previewed before saving', async () => {
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients' });
    fireEvent.click(screen.getByRole('checkbox', { name: /hr/i }));
    expect(screen.getByText(/enabling/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save licence/i }).disabled).toBe(false);
  });

  test('a downgrade warns and promises the data is kept', async () => {
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients,hr' });
    fireEvent.click(screen.getByRole('checkbox', { name: /hr/i }));
    expect(screen.getByText(/disabling/i)).toBeTruthy();
    // The reassurance is load-bearing: an operator must know a downgrade is
    // reversible, or they will avoid it and misprice instead.
    expect(screen.getByText(/kept, not deleted/i)).toBeTruthy();
  });

  test('a dependency cannot be unticked', async () => {
    // invoices requires clients, so clients must be locked on.
    await mount({ slug: 'acme', name: 'Acme', modules: 'invoices' });
    const clients = screen.getByRole('checkbox', { name: /clients/i });
    expect(clients.checked).toBe(true);
    expect(clients.disabled).toBe(true);
  });

  test('an always-on module is on and cannot be turned off', async () => {
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients' });
    // accounting is always-on AND appears in a presentation group, so it shows
    // as ticked-and-locked with its reason.
    const acct = screen.getByRole('checkbox', { name: /accounting/i });
    expect(acct.checked).toBe(true);
    expect(acct.disabled).toBe(true);
    expect(screen.getAllByText(/always included/i).length).toBeGreaterThan(0);
  });

  test('infrastructure modules are not offered as choices at all', async () => {
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients' });
    // dashboard/users/roles/settings/audit are always-on plumbing, deliberately
    // absent from the presentation groups — they are not sellable, so showing a
    // permanently-locked tickbox for each would be noise.
    expect(screen.queryByRole('checkbox', { name: /dashboard/i })).toBeNull();
  });

  test('saves the SELECTED keys, not the resolved closure', async () => {
    // The backend recomputes the closure; storing it would freeze today's
    // dependency graph into every existing customer's licence.
    await mount({ slug: 'acme', name: 'Acme', modules: 'clients' });
    fireEvent.click(screen.getByRole('checkbox', { name: /invoices/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save licence/i }));
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].url).toBe('/api/platform/tenants/acme');
    expect([...saved[0].body.modules].sort()).toEqual(['clients', 'invoices']);
  });
});
