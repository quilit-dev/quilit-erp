// Revoking the LAST warehouse grant does the opposite of what the button reads.
//
// Warehouse access is an opt-in allow-list: a user with zero grants falls back
// to the default, which is EVERY warehouse. So an admin who fences someone into
// Warehouse A and later revokes that single grant — intending to remove their
// access — actually hands them access to all warehouses.
//
// The fail-open default cannot be changed without locking out every existing
// user who has no grants, so the trap is made visible instead: revoking a
// user's last grant asks first. Revoking any other grant just narrows the list
// and is not interrupted.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const WAREHOUSES = [
  { id: 1, code: 'MAIN', name: 'Main', archived_at: null },
  { id: 2, code: 'WH2',  name: 'Second', archived_at: null },
];
const USERS = [{ id: 7, username: 'stan', full_name: 'Stan Stock' }];

// grants[warehouseId] -> rows
let grants;
const revokeWarehouseAccess = vi.fn(async () => ({}));

vi.mock('../api/client', () => ({
  getWarehouses:         vi.fn(async () => WAREHOUSES),
  getUsers:              vi.fn(async () => USERS),
  getWarehouseAccess:    vi.fn(async (wid) => grants[wid] || []),
  grantWarehouseAccess:  vi.fn(async () => ({})),
  revokeWarehouseAccess: (...a) => revokeWarehouseAccess(...a),
}));
vi.mock('../components/shared', async () => {
  const { createElement: h } = await import('react');
  return {
    toast: vi.fn(),
    LoadingSpinner: () => h('div', null, 'loading'),
    EmptyState: ({ title }) => h('div', null, title),
    Modal: ({ title, children }) => h('div', null, h('h2', null, title), children),
    ConfirmModal: ({ title, message, confirmLabel, onConfirm, onCancel }) =>
      h('div', { 'data-testid': 'confirm' },
        h('h2', null, title),
        h('p', null, message),
        h('button', { onClick: onConfirm }, confirmLabel),
        h('button', { onClick: onCancel }, 'Cancel')),
  };
});

import { AccessTab } from '../pages/warehouses/AccessTab';

const GRANT = { user_id: 7, username: 'stan', full_name: 'Stan Stock',
                granted_at: '2026-08-14T10:00:00Z' };

const mount = async () => {
  render(<LocaleProvider><AccessTab t={(k, v) => (v ? `${k} ${JSON.stringify(v)}` : k)} /></LocaleProvider>);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const clickRevoke = async () => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => /revokeBtn/.test(b.textContent));
  expect(btn, 'a Revoke button should exist').toBeTruthy();
  await act(async () => { fireEvent.click(btn); });
};

beforeEach(() => { vi.clearAllMocks(); });

describe('revoking warehouse access', () => {
  test('asks first when it is the user\'s only grant', async () => {
    grants = { 1: [GRANT], 2: [] };          // Stan is fenced into MAIN alone
    await mount();
    await clickRevoke();

    expect(screen.getByTestId('confirm'),
      'removing the last grant re-opens every warehouse — it must not be silent')
      .toBeTruthy();
    expect(revokeWarehouseAccess).not.toHaveBeenCalled();
  });

  test('goes through once confirmed', async () => {
    grants = { 1: [GRANT], 2: [] };
    await mount();
    await clickRevoke();

    const go = Array.from(document.querySelectorAll('button'))
      .find(b => /revokeAnyway/.test(b.textContent));
    await act(async () => { fireEvent.click(go); });

    expect(revokeWarehouseAccess).toHaveBeenCalledWith(1, 7);
  });

  test('does NOT interrupt when the user still has another grant', async () => {
    grants = { 1: [GRANT], 2: [GRANT] };     // Stan holds MAIN and WH2
    await mount();
    await clickRevoke();

    // Narrowing the list is the ordinary case and should not nag.
    expect(screen.queryByTestId('confirm')).toBeNull();
    expect(revokeWarehouseAccess).toHaveBeenCalledWith(1, 7);
  });
});
