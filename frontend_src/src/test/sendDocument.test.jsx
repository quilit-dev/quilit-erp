// The Send dialog's channel tabs.
//
// The email tab used to be `disabled` whenever email was not configured. That
// left an unclickable control with no explanation AND made the panel that
// explains why unreachable — so the reason could not be discovered from the UI
// at all. These pin the corrected behaviour: the tab is always browsable, the
// reason is visible, and the Send button is what refuses.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '../hooks/useLocale.jsx';

let emailEnabled = false;
vi.mock('../api/client', () => ({
  commsStatus: vi.fn(async () => ({
    email: { enabled: emailEnabled }, whatsapp: { enabled: true, mode: 'deep_link' },
  })),
  commsLog:    vi.fn(async () => []),
  commsSend:   vi.fn(async () => ({ url: 'https://x/d/inv-1/tok' })),
  commsRevoke: vi.fn(async () => ({})),
}));
vi.mock('../components/shared', () => ({ toast: vi.fn(), Icon: () => null }));

import SendDocument from '../components/SendDocument';

const DOC = { id: 1, invoice_number: 'INV-1', client_email: 'a@b.test',
              client_phone: '+96171234567' };

const mount = async () => {
  const r = render(
    <LocaleProvider><SendDocument entityType="invoice" doc={DOC} onClose={() => {}} /></LocaleProvider>);
  await act(async () => {});
  return r;
};

const emailTab = () => screen.getAllByRole('button')
  .find(b => /email/i.test(b.textContent) && !/send/i.test(b.textContent));

beforeEach(() => { emailEnabled = false; });

describe('SendDocument channel tabs', () => {
  test('the email tab is clickable even when email is not configured', async () => {
    await mount();
    const tab = emailTab();
    expect(tab).toBeTruthy();
    expect(tab.disabled).toBe(false);
  });

  test('clicking it explains why email is unavailable', async () => {
    await mount();
    await act(async () => { fireEvent.click(emailTab()); });
    // The reason, and what to do about it.
    expect(screen.getByText(/not set up/i)).toBeTruthy();
    expect(screen.getByText(/RESEND_API_KEY/)).toBeTruthy();
  });

  test('send refuses on an unconfigured email channel', async () => {
    await mount();
    await act(async () => { fireEvent.click(emailTab()); });
    const send = screen.getAllByRole('button').find(b => /send email/i.test(b.textContent));
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(true);
  });

  test('with email configured the tab is selectable and send is enabled', async () => {
    emailEnabled = true;
    await mount();
    await act(async () => { fireEvent.click(emailTab()); });
    expect(screen.queryByText(/RESEND_API_KEY/)).toBeNull();
    const send = screen.getAllByRole('button').find(b => /send email/i.test(b.textContent));
    expect(send.disabled).toBe(false);
  });

  test('whatsapp stays available regardless', async () => {
    await mount();
    const wa = screen.getAllByRole('button').find(b => /whatsapp/i.test(b.textContent));
    expect(wa.disabled).toBe(false);
  });
});
