// The self-service change-password dialog.
//
// The endpoint always accepted any authenticated user, but nothing in the UI
// called it, so staff had to ask an admin to reset their password — meaning the
// admin picked it and knew it. These cover the dialog's side: the current
// password is required, a mismatch never reaches the server, and the server's
// own wording is what the user reads when it refuses.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const changePassword = vi.fn(async () => ({ message: 'ok' }));
const toast = vi.fn();

vi.mock('../api/client', () => ({ changePassword: (...a) => changePassword(...a) }));
vi.mock('../components/shared', async () => {
  const { createElement: h } = await import('react');
  return {
    toast: (...a) => toast(...a),
    // A minimal stand-in: the real Modal pulls in scroll-lock and portal
    // behaviour that has nothing to do with what these assert.
    Modal: ({ title, children }) => h('div', null, h('h2', null, title), children),
  };
});

import ChangePasswordModal from '../components/ChangePasswordModal';

const onClose = vi.fn();

const mount = async () => {
  const r = render(
    <LocaleProvider><ChangePasswordModal onClose={onClose} /></LocaleProvider>);
  await act(async () => {});
  return r;
};

// The three password inputs, in DOM order: current, new, confirm.
const fields = () => Array.from(document.querySelectorAll('input'));

const fill = (current, next, confirm) => {
  const [c, n, k] = fields();
  fireEvent.change(c, { target: { value: current } });
  fireEvent.change(n, { target: { value: next } });
  fireEvent.change(k, { target: { value: confirm } });
};

const submit = async () => {
  const btn = screen.getAllByRole('button')
    .find(b => /change password/i.test(b.textContent));
  expect(btn, 'submit button should exist').toBeTruthy();
  await act(async () => { fireEvent.click(btn); });
};

beforeEach(() => { vi.clearAllMocks(); });

describe('changing your own password', () => {
  test('sends the current and the new password', async () => {
    await mount();
    fill('OldPass123!', 'NewPass456!', 'NewPass456!');
    await submit();

    expect(changePassword).toHaveBeenCalledWith('OldPass123!', 'NewPass456!');
    expect(onClose).toHaveBeenCalled();
  });

  test('asks for the CURRENT password, not just a new one', async () => {
    // This is the whole reason the dialog is safe for every role. If the field
    // ever disappears, anyone with a borrowed session could lock the owner out.
    await mount();
    expect(fields().length).toBe(3);
    expect(fields()[0].getAttribute('autocomplete')).toBe('current-password');
  });

  test('a mismatched confirmation never reaches the server', async () => {
    await mount();
    fill('OldPass123!', 'NewPass456!', 'NewPass457!');
    await submit();

    expect(changePassword).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a too-short password never reaches the server', async () => {
    await mount();
    fill('OldPass123!', 'short7!', 'short7!');
    await submit();

    expect(changePassword).not.toHaveBeenCalled();
  });

  test("shows the server's reason and stays open when it refuses", async () => {
    changePassword.mockRejectedValueOnce(new Error('Incorrect current password.'));
    await mount();
    fill('wrong', 'NewPass456!', 'NewPass456!');
    await submit();

    expect(screen.getByText(/incorrect current password/i)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('confirms success', async () => {
    await mount();
    fill('OldPass123!', 'NewPass456!', 'NewPass456!');
    await submit();

    expect(toast).toHaveBeenCalled();
  });
});
