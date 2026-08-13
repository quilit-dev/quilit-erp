// The logo on the document a CUSTOMER opens from a WhatsApp link.
//
// The share page used to hand the template a bare `/logo.png`. That string is
// always truthy, so the <img> was always emitted — and a tenant that has never
// uploaded a logo serves a 404 there, so the customer opened their invoice and
// saw a broken-image icon captioned "logo" where the supplier's branding should
// be. The templates already omit the image when handed null; the share page
// simply was not doing the resolution.
//
// These pin the resolution, not the markup: the page must ask for the logo the
// same way the supplier's own export does, and must not render a document until
// that has settled either way.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const DOC = {
  type: 'invoice', label: 'Invoice', number: 'INV-2026-0042',
  issued_at: '2026-08-13', created_at: '2026-08-13', currency: 'USD',
  amount: 1500, notes: null, client: { name: 'Acme' },
  company: { company_name: 'Quilit Demo', name: 'Quilit Demo' },
  payments: [], items: [{ name: 'Pump', quantity: 2, unit_price: 750 }],
};

let logoResult;
const getLogoDataURL = vi.fn(async () => logoResult);
const buildInvoiceHTML = vi.fn(() => ({ html: '<p>doc</p>', docNo: 'INV-2026-0042' }));

vi.mock('../utils/exportUtils', () => ({
  getLogoDataURL:     (...a) => getLogoDataURL(...a),
  buildInvoiceHTML:   (...a) => buildInvoiceHTML(...a),
  buildQuotationHTML: vi.fn(() => ({ html: '<p>q</p>', docNo: 'Q' })),
}));

import PublicDocument from '../pages/PublicDocument';

const mount = async () => {
  render(
    <MemoryRouter initialEntries={['/d/tok']}><PublicDocument /></MemoryRouter>,
  );
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

beforeEach(() => {
  vi.clearAllMocks();
  logoResult = 'data:image/png;base64,AAAA';
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => DOC }));
});

describe('the logo on a shared document', () => {
  test('is resolved, never passed through as a bare /logo.png URL', async () => {
    await mount();

    expect(getLogoDataURL, 'the page must resolve the logo').toHaveBeenCalled();
    const passedLogo = buildInvoiceHTML.mock.calls[0][2];
    expect(passedLogo).toBe('data:image/png;base64,AAAA');
    expect(passedLogo).not.toBe('/logo.png');
  });

  test('a tenant with no logo gets null, so the template omits the image', async () => {
    logoResult = null;          // what getLogoDataURL answers on a 404
    await mount();

    // null — NOT a URL string that would render as a broken image.
    expect(buildInvoiceHTML.mock.calls[0][2]).toBeNull();
  });

  test('a failure to resolve still renders the document, without the logo', async () => {
    getLogoDataURL.mockRejectedValueOnce(new Error('network'));
    await mount();

    expect(buildInvoiceHTML).toHaveBeenCalled();
    expect(buildInvoiceHTML.mock.calls[0][2]).toBeNull();
  });

  test('does not flash the error panel while the logo is still resolving', async () => {
    // The document cannot be built until the logo settles, so the page has to
    // say "loading" in the meantime rather than "could not be displayed".
    let release;
    getLogoDataURL.mockImplementationOnce(() => new Promise(r => { release = r; }));
    await mount();

    expect(screen.queryByText(/could not be displayed/i)).toBeNull();
    await act(async () => { release('data:image/png;base64,AAAA'); });
  });
});
