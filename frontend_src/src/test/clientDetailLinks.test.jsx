// A client's invoice list has to be a way INTO the invoice.
//
// The invoices tab on a client used to render the invoice number as plain text,
// so the one screen that tells you "this customer has six open invoices" was a
// dead end — you read the number, went to Invoices, and searched for it by hand.
//
// The link deliberately points at `/invoices?focus=<id>` rather than a detail
// route of its own: there is no /invoices/:id, and `?focus=` is the same deep
// link global search uses. These pin that, so a future "tidy up" that swaps in
// a route which does not exist fails here instead of in the user's hands.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const CLIENT = {
  id: 7,
  name: 'Acme Contracting',
  stats: {},
  projects: [],
  quotations: [],
  invoices: [
    { id: 41, invoice_number: 'INV-2026-0041', status: 'unpaid',
      amount: 1500, paid_amount: 0, due_date: '2026-09-01' },
    { id: 42, invoice_number: 'INV-2026-0042', status: 'paid',
      amount: 900, paid_amount: 900, due_date: '2026-09-14' },
  ],
  documents: [],
};

vi.mock('../api/client', () => ({
  getClient: vi.fn(async () => CLIENT),
  getDocumentContent: vi.fn(async () => ({ html_content: '<p>x</p>' })),
}));
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));

import ClientDetail from '../pages/ClientDetail';

async function openInvoicesTab() {
  render(
    <LocaleProvider>
      <MemoryRouter initialEntries={['/clients/7']}>
        <ClientDetail />
      </MemoryRouter>
    </LocaleProvider>,
  );
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });

  const tab = screen.getAllByRole('button')
    .find(b => /invoice/i.test(b.textContent));
  expect(tab, 'invoices tab should exist').toBeTruthy();
  await act(async () => { fireEvent.click(tab); });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("a client's invoices open the invoice", () => {
  test('each invoice number is a link to that invoice', async () => {
    await openInvoicesTab();

    const link = screen.getByText('INV-2026-0041').closest('a');
    expect(link, 'the invoice number should be a link, not plain text').toBeTruthy();
    expect(link.getAttribute('href')).toBe('/invoices?focus=41');
  });

  test('the link carries the invoice id, not the row position', async () => {
    // The bug this catches: rendering with the map index, so every row after
    // the first opens the wrong customer's invoice.
    await openInvoicesTab();

    expect(screen.getByText('INV-2026-0042').closest('a').getAttribute('href'))
      .toBe('/invoices?focus=42');
  });
});
