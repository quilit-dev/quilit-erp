// Icon-only row actions must still say what they are.
//
// The inventory actions column held five TEXT buttons — 380px of a 1279px
// table, 30% of it — so the table could not fit a laptop and Delete fell off
// the right edge. They are icons now, which is what made the table fit, and an
// icon on its own says nothing: the label has to survive as the accessible
// name or the button becomes a shape only a returning user can identify.
//
// All five stay VISIBLE rather than folding into an overflow menu. The report
// was that Delete could not be seen, and hiding it behind a click is not an
// answer to that.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, act } from '@testing-library/react';
import { Icon } from '../components/shared.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const inventorySrc = readFileSync(join(here, '..', 'pages', 'Inventory.jsx'), 'utf8');
const css = readFileSync(join(here, '..', 'index.css'), 'utf8');

/** Every `<button …>` opening tag in the file. */
function buttonTags(src) {
  return src.match(/<button[^>]*>/g) || [];
}

describe('the inventory row actions are icons with names', () => {
  const iconButtons = buttonTags(inventorySrc).filter((b) => b.includes('btn-icon'));

  test('there are icon buttons to check', () => {
    // Without this the assertions below pass over an empty list.
    expect(iconButtons.length).toBeGreaterThanOrEqual(5);
  });

  test.each([
    ['adjustStock', 'sliders'],
    ['history', 'clock'],
    ['edit', 'pencil'],
    ['archive', 'archive'],
    ['delete', 'trash'],
  ])('%s renders as the %s icon', (action, icon) => {
    expect(inventorySrc).toContain(`<Icon name="${icon}" />`);
  });

  test('every icon-only button carries an accessible name', () => {
    for (const tag of iconButtons) {
      expect(tag, `an icon button with no aria-label:\n${tag}`).toMatch(/aria-label=/);
    }
  });

  test('every icon-only button carries a tooltip', () => {
    // Sighted users get no label either; the title is how they learn it.
    for (const tag of iconButtons) {
      expect(tag, `an icon button with no title:\n${tag}`).toMatch(/title=/);
    }
  });

  test('the names come from translations, not hardcoded English', () => {
    for (const tag of iconButtons) {
      expect(tag, `a hardcoded label on an icon button:\n${tag}`)
        .toMatch(/aria-label=\{t\(/);
    }
  });

  test('delete is still a button on the row, not hidden in a menu', () => {
    const del = iconButtons.find((b) => b.includes("t('common.delete')"));
    expect(del, 'the Delete action is no longer a row button').toBeTruthy();
  });
});

describe('the icons exist', () => {
  // Icon renders nothing for an unknown name — a silently blank button, which
  // is how an empty control shipped next to a PDF link once before.
  test.each(['sliders', 'clock', 'pencil', 'archive', 'trash'])('%s has a path', (name) => {
    let container;
    act(() => { ({ container } = render(<Icon name={name} />)); });
    const svg = container.querySelector('svg');
    expect(svg, `Icon "${name}" rendered nothing`).toBeTruthy();
    expect(svg.innerHTML.length, `Icon "${name}" is an empty svg`).toBeGreaterThan(10);
  });
});

describe('the icon button has a usable target', () => {
  const start = css.indexOf('.btn-icon {');
  const rule = css.slice(start, css.indexOf('}', start));

  test('is defined once at the top level', () => {
    // Two base definitions is how a size drifts: a second one appended at the
    // end of the file silently overrode this rule for a while. The responsive
    // override inside @media is indented, so anchoring to the line start
    // counts real definitions and not that one.
    const baseDefs = (css.match(/^\.btn-icon \{/gm) || []).length;
    expect(baseDefs).toBe(1);
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
