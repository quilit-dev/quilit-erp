// The account popover in the sidebar.
//
// "Change password" lives here rather than under Settings because Settings is a
// company-configuration screen most roles cannot open, while changing your own
// password is the one account action that belongs to everybody. The sidebar is
// also on screen for every authenticated user, on every page — so a crash here
// takes down the whole app, and it is not covered by the pages smoke suite.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocaleProvider } from '../hooks/useLocale.jsx';

// A plain staff user: NOT an admin, which is the case that matters.
let perms = {
  user: { username: 'u_sales', full_name: 'Sam Sales', role_name: 'Sales' },
  isSuperadmin: false, isAdmin: false, can: () => false,
};

vi.mock('../hooks/usePermissions.js', () => ({ usePermissions: () => perms }));
vi.mock('../hooks/useModules', () => ({ useModules: () => ({ has: () => true }) }));
vi.mock('../api/client', () => ({
  logout: vi.fn(async () => ({})),
  getAnnouncementsUnread: vi.fn(async () => ({ unread: 0, pending_ack: 0 })),
  getBranchContext: vi.fn(async () => ({ is_global: false, branches: [] })),
  getBranchFilter: vi.fn(() => null),
  setBranchFilter: vi.fn(),
  changePassword: vi.fn(async () => ({ message: 'ok' })),
}));

import Sidebar from '../components/Sidebar';

const mount = async () => {
  render(
    <LocaleProvider><MemoryRouter><Sidebar /></MemoryRouter></LocaleProvider>);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

// The popover entries carry role="menuitem", which REPLACES their implicit
// button role — so a getAllByRole('button') search silently misses them.
const findButton = (re) =>
  Array.from(document.querySelectorAll('button')).find(b => re.test(b.textContent));

beforeEach(() => { vi.clearAllMocks(); });

describe('the sidebar account menu', () => {
  test('mounts for a non-admin user', async () => {
    await mount();
    expect(screen.getByText('Sam Sales')).toBeTruthy();
  });

  test('offers Change password to a non-admin, alongside Sign out', async () => {
    await mount();

    // The account card is the popover trigger.
    const card = findButton(/Sam Sales/);
    expect(card, 'the account card should be a button').toBeTruthy();
    await act(async () => { fireEvent.click(card); });

    expect(findButton(/change password/i),
      'a plain staff user must be able to change their own password').toBeTruthy();
    expect(findButton(/sign out/i)).toBeTruthy();
  });

  test('opening it shows the dialog, which asks for the current password', async () => {
    await mount();
    await act(async () => { fireEvent.click(findButton(/Sam Sales/)); });
    await act(async () => { fireEvent.click(findButton(/change password/i)); });

    const pw = Array.from(document.querySelectorAll('input[type="password"]'));
    expect(pw.length).toBe(3);
    expect(pw[0].getAttribute('autocomplete')).toBe('current-password');
  });
});
