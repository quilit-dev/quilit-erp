import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, fireEvent, screen } from '@testing-library/react';
import { ExportButton, FileDownloadButton, Icon, IconButton } from '../components/shared.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

// Read from disk, not through Vite: `?raw` on a .css file still goes through
// the CSS pipeline, so the processed output would not contain the rules being
// asserted here.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8');
const inventoryRaw = readFileSync(join(here, '..', 'pages', 'Inventory.jsx'), 'utf8');

describe('IconButton', () => {
  test('keeps the action discoverable and accessible without visible text', () => {
    const onClick = vi.fn();
    render(<IconButton icon="pencil" label="Edit" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button.getAttribute('title')).toBe('Edit');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('btn-icon');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('preserves the variant, disabled state, style and icon size', () => {
    render(
      <IconButton
        icon="trash"
        label="Delete"
        className="btn btn-sm btn-danger"
        disabled
        iconSize={18}
        style={{ opacity: 0.6 }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('btn-danger');
    expect(button.style.opacity).toBe('0.6');
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('18');
  });

  test('uses a fallback glyph instead of shipping a blank control', () => {
    render(<IconButton icon="not-a-real-icon" label="Custom action" />);
    const svg = screen.getByRole('button', { name: 'Custom action' }).querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.innerHTML.length).toBeGreaterThan(10);
  });

});

describe('the standardized action glyphs', () => {
  test.each([
    'sliders',
    'clock',
    'pencil',
    'archive',
    'trash',
    'rotate-ccw',
    'eye',
    'download-excel',
    'download-pdf',
  ])('%s renders an SVG path', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.innerHTML.length).toBeGreaterThan(10);
  });
});

describe('file export actions', () => {
  test('the shared Excel export clearly identifies its file format', () => {
    render(<LocaleProvider><ExportButton data={[{ total: 42 }]} filename="Report" /></LocaleProvider>);
    const button = screen.getByRole('button', { name: 'Download Excel' });
    expect(button.children).toHaveLength(2);
    expect(button.firstElementChild?.tagName).toBe('svg');
    expect(button.lastElementChild?.textContent).toBe('XLS');
    expect(button.className).toContain('is-excel');
  });

  test('PDF downloads use an explicit PDF marker', () => {
    render(<FileDownloadButton format="pdf" label="Download PDF" />);
    const button = screen.getByRole('button', { name: 'Download PDF' });
    expect(button.firstElementChild?.tagName).toBe('svg');
    expect(button.lastElementChild?.textContent).toBe('PDF');
    expect(button.className).toContain('is-pdf');
  });
});

// ── What the component tests above cannot reach ─────────────────────────────
//
// `IconButton` throws without a label, which is a stronger guarantee than the
// source greps this file used to hold — a page cannot ship a nameless icon at
// all now. Three things fall outside it, and each was a real defect once:
//
//   * a label can be present and still be hardcoded English, which is invisible
//     to the component and wrong on an Arabic screen;
//   * `.btn-icon` lives in the stylesheet, not the component. A second base
//     definition appended at the end of the file silently overrode the first
//     for a while, and the size drifted;
//   * the 44px coarse-pointer target is a media query. Nothing that renders a
//     button in jsdom can see it.
//
// And one product guarantee: Inventory's Delete stays a button on the row. The
// report that started this work was that Delete could not be seen, and hiding
// it behind an overflow menu is not an answer to that.
/** Each `<IconButton …/>` tag, tolerating attributes across several lines.
 *
 *  Bounded at its own `/>`. Slicing merely up to the NEXT `<IconButton` looks
 *  equivalent and is not: the last tag in a file then runs to the end of it, so
 *  an assertion about that button happily matches text from a modal several
 *  hundred lines below. That version passed a mutation that renamed Inventory's
 *  Delete action, which is the one guarantee this file exists for.
 */
function iconButtonTags(src) {
  const out = [];
  let i = src.indexOf('<IconButton');
  while (i !== -1) {
    const next = src.indexOf('<IconButton', i + 1);
    const close = src.indexOf('/>', i);
    const end = (close !== -1 && (next === -1 || close < next)) ? close + 2
              : (next === -1 ? src.length : next);
    out.push(src.slice(i, end));
    i = next;
  }
  return out;
}

describe('every icon button in the app is named in the user’s language', () => {
  const files = Object.entries(
    import.meta.glob('../{pages,components}/**/*.jsx', { query: '?raw', import: 'default', eager: true }),
  );

  const tagged = files.flatMap(([file, src]) =>
    iconButtonTags(src).map((tag) => [file, tag]));

  test('there are icon buttons to check', () => {
    // Without this every assertion below passes over an empty list.
    expect(tagged.length).toBeGreaterThan(50);
  });

  test('none of them is labelled with a bare string', () => {
    for (const [file, tag] of tagged) {
      expect(tag, `hardcoded label in ${file}:\n${tag}`)
        .not.toMatch(/label=("|\{\s*['"])/);
    }
  });

  test('every label comes from a translation call', () => {
    // A ternary over two t() calls is fine — three buttons legitimately switch
    // their name on state (Activate/Deactivate).
    for (const [file, tag] of tagged) {
      expect(tag, `label not translated in ${file}:\n${tag}`).toMatch(/label=\{[^}]*t\(/);
    }
  });
});

describe('the inventory row keeps its five actions', () => {
  const tags = iconButtonTags(inventoryRaw);

  test('the five are found as bounded tags', () => {
    // Guards the guard: an extractor that over-reaches makes every assertion
    // below pass on text that belongs to something else.
    expect(tags.length).toBeGreaterThanOrEqual(5);
    for (const tag of tags) expect(tag.length).toBeLessThan(600);
  });

  test.each([
    ['adjust stock', 'sliders', "t('inventory.adjustStock')"],
    ['history', 'clock', "t('common.history')"],
    ['edit', 'pencil', "t('common.edit')"],
    ['archive', 'archive', "t('common.archive')"],
    ['delete', 'trash', "t('common.delete')"],
  ])('%s is a button on the row', (_name, icon, label) => {
    const found = tags.some((t) => t.includes(`icon="${icon}"`) && t.includes(label));
    expect(found, `the ${_name} action is no longer a row button`).toBe(true);
  });
});

describe('the icon button has a usable target', () => {
  const rule = css.slice(css.indexOf('.btn-icon {'),
                         css.indexOf('}', css.indexOf('.btn-icon {')));

  test('is defined once at the top level', () => {
    // Two base definitions is how a size drifts. The responsive override lives
    // inside @media and is indented, so anchoring to the line start counts the
    // real definitions and not that one.
    expect((css.match(/^\.btn-icon \{/gm) || []).length).toBe(1);
  });

  test('is a fixed square', () => {
    expect(rule).toMatch(/width:\s*30px/);
    expect(rule).toMatch(/height:\s*30px/);
  });

  test('grows for a coarse pointer', () => {
    // 30px is comfortable with a mouse and far too small with a thumb.
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).toMatch(/\.btn-icon\s*\{[^}]*44px/);
  });
});
