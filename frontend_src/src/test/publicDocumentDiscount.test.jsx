// A discount on the whole document must reach the customer's copy. Rendered
// with the REAL template: the figure printed is the thing being pinned.
import { describe, test, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PublicDocument from '../pages/PublicDocument';

const DOC = {
  label: 'Document', number: 'D-1', created_at: '2026-11-01', currency: 'USD',
  discount_type: 'percent', discount_value: 10, discount_total: 100,
  subtotal: 900, tax_total: 99, client: { name: 'Acme' }, payments: [],
  company: { company_name: 'Demo', tax_enabled: '1', default_tax_rate: '11' },
  items: [{ name: 'Work', quantity: 1, unit_price: 1000, tax_rate: 11, tax_amount: 99 }],
};

const html = async (doc) => {
  globalThis.fetch = vi.fn(async (u) => (String(u).includes('/public/')
    ? { ok: true, json: async () => doc } : { ok: false }));
  const { container } = render(<MemoryRouter><PublicDocument /></MemoryRouter>);
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  return container.querySelector('iframe').getAttribute('srcdoc');
};
const grand = (h) => h.match(/Grand Total<\/span><span class="v">([^<]+)</)[1];

describe('a discounted document opened from its link', () => {
  test('an invoice asks for the discounted total', async () => {
    const h = await html({ ...DOC, type: 'invoice', amount: 999 });
    expect(h).toContain('Discount (10%)');
    expect(grand(h)).toContain('999.00');
  });
  test('a quotation adds its VAT to the discounted net', async () => {
    const h = await html({ ...DOC, type: 'quotation', amount: 900 });
    expect(grand(h)).toContain('999.00');
  });
});
