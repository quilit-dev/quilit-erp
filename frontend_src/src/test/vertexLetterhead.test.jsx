// VertexMedia's letterhead: a centred logo at the head, a blue baseline and
// three bars at the foot. The same sheet mechanism as hajosign --- the frame
// CSS is one function of the page geometry --- so anything that holds for one
// letterhead's paging holds for the other.
import { describe, test, expect } from 'vitest';
import { THEMES, themeFor } from '../utils/documentThemes';
import { buildInvoiceHTML, exportReportPDF } from '../utils/exportUtils';

const C = { name: 'Vertex Media', tagline: '' };
const SETTINGS = { company_name: 'Vertex Media', document_template: 'vertex' };

describe('the vertex theme', () => {
  test('is the theme for the vertex template id', () => {
    expect(themeFor({ document_template: 'vertex' })).toBe(THEMES.vertex);
    expect(THEMES.vertex.id).toBe('vertex');
  });

  test('draws the foot: two blue bands and three bars, bled off the edge', () => {
    const sheet = THEMES.vertex.sheet(C, null);
    const art = sheet.match(/<svg class="hj-art"[^]*?<\/svg>/)[0];
    const paths = [...art.matchAll(/<path fill="(#[0-9A-F]{6})" d="([^"]+)"/g)];
    expect(paths).toHaveLength(5);
    const fills = paths.map(p => p[1]);
    expect(fills.filter(f => f === '#0189D5')).toHaveLength(2);   // the bands
    expect(fills.filter(f => f === '#282828')).toHaveLength(2);   // black bars
    expect(fills.filter(f => f === '#00456C')).toHaveLength(1);   // the navy bar
    // The bands run to x=210 and the bars to y=297 --- the paper edge.
    for (const [, , d] of paths.slice(0, 2)) expect(d).toMatch(/L210 /);
    for (const [, , d] of paths.slice(2)) expect(d).toMatch(/ 297 /);
  });

  test('the masthead is the uploaded logo, or the traced mark when there is none', () => {
    const own = THEMES.vertex.sheet(C, 'data:image/png;base64,AAAA');
    expect(own).toContain('src="data:image/png;base64,AAAA"');
    const fallback = THEMES.vertex.sheet(C, null);
    // Inline SVG, not a data URI: the wordmark is text and has to reach the
    // fonts the print document loads, which an <img> never can.
    expect(fallback).toMatch(/<svg class="hj-logo hj-logo--mark" viewBox="0 0 270 119"/);
    expect(fallback).toContain('M6 5.5H27L69 77');                 // the chevron
    expect(fallback).toContain('M49 4.5H70L92 42L114.5 4.5H136V82'); // the M
    expect(fallback).toMatch(/textLength="84"[^>]*>MEDIA</);
    expect(fallback).not.toContain('<img');
    // No contact strip and no watermark: the letterhead has neither.
    expect(fallback).not.toContain('hj-foot');
    expect(fallback).not.toContain('hj-watermark');
  });

  test('content clears the logo at the head and the bars at the foot', () => {
    const css = THEMES.vertex.css;
    expect(css).toMatch(/\.hj-sheet > thead > tr > td \{ height: 46mm; \}/);
    expect(css).toMatch(/\.hj-sheet > tfoot > tr > td \{ height: 34mm;/);
    // The same repeating-sheet mechanism as every letterhead.
    expect(css).toContain('height: 297mm;');
    expect(css).not.toContain('position: fixed');
    expect(css).toMatch(/@media print \{\s*@page \{ margin: 0; size: A4; \}/);
  });

  test('an invoice rides in the vertex sheet', () => {
    const { html } = buildInvoiceHTML({
      id: 1, invoice_number: 'INV-1', client_id: 1, amount: 100, created_at: '2026-09-16',
      items: [{ name: 'Design', quantity: 1, unit_price: 100 }], payments: [],
    }, SETTINGS, null, {});
    expect(html).toContain('class="hj-sheet"');
    expect(html).toMatch(/M157\.5 267\.4/);     // the first bar
    expect(html).not.toContain('hj-foot');
  });
});

describe('hajosign is untouched by the refactor', () => {
  test('its sheet still carries watermark, masthead and contact strip', () => {
    const sheet = THEMES.hajosign.sheet({ name: 'Hajo', tagline: 'Signs' }, null);
    for (const cls of ['hj-watermark', 'hj-masthead', 'hj-foot', 'hj-wordmark']) {
      expect(sheet).toContain(cls);
    }
    expect(THEMES.hajosign.css).toContain('.hj-watermark {');
    expect(THEMES.hajosign.css).toContain('.hj-foot {');
    expect(THEMES.hajosign.css).toMatch(/\.hj-sheet > thead > tr > td \{ height: 54mm; \}/);
    expect(THEMES.hajosign.css).toMatch(/\.hj-sheet--preprinted > thead > tr > td \{ height: 62mm; \}/);
  });
});

// exportReportPDF is exercised for the vertex theme too, through the same
// path the statement of account takes; the capture helper mirrors
// statementLetterhead.test.jsx.
describe('a report on the vertex letterhead', () => {
  test('goes through the themed shell', async () => {
    globalThis.fetch = async (url) => (String(url).startsWith('/api/settings/logo')
      ? { ok: false, headers: new Headers() }
      : { ok: true, json: async () => SETTINGS });
    const orig = document.body.appendChild.bind(document.body);
    const captured = new Promise((resolve) => {
      document.body.appendChild = (node) => {
        const out = orig(node);
        if (node.tagName === 'IFRAME') {
          node.contentWindow.print = () => {};
          node.contentWindow.focus = () => {};
          queueMicrotask(() => resolve(node.contentDocument.documentElement.outerHTML));
        }
        return out;
      };
    });
    try {
      await exportReportPDF({
        title: 'Statement of account', filename: 's.pdf', client: { name: 'Acme' },
        columns: [{ label: 'Date', value: r => r.d }], rows: [{ d: 'x' }],
      });
      const html = await captured;
      expect(html).toContain('class="hj-sheet"');
      expect(html).toMatch(/M157\.5 267\.4/);
      expect(html).toMatch(/hj-account">Acme/);
    } finally {
      document.body.appendChild = orig;
    }
  });
});
