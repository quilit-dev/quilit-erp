// A dropdown you can type into.
//
// Four lists in this app grow without bound — inventory, clients, projects and
// the chart of accounts. A business with nine hundred products had a
// nine-hundred-row <select>, and picking from it meant scrolling.
//
// The API is the shape of the <select> it replaces, so these tests hold it to
// that: `value` in, the same string a <select> would give out.
import { describe, test, expect, vi } from 'vitest';
import { render, act, fireEvent, screen, within } from '@testing-library/react';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const OPTIONS = [
  { value: 1, label: 'Ink Tube', hint: 'INK-1' },
  { value: 2, label: 'Toner Cartridge', hint: 'TNR-9' },
  { value: 3, label: 'Ribbon Spool', hint: 'RBN-4' },
  { value: 4, label: 'Drum Unit', hint: 'DRM-2' },
];

async function mount(props = {}) {
  let out;
  await act(async () => {
    out = render(
      <ThemeProvider><LocaleProvider>
        <SearchSelect options={OPTIONS} value="" onChange={() => {}}
                      placeholder="Pick one" {...props} />
      </LocaleProvider></ThemeProvider>);
  });
  return out;
}

const trigger = () => screen.getByRole('combobox');
const openIt = async () => { await act(async () => { fireEvent.click(trigger()); }); };
const type = async (text) => {
  const box = document.querySelector('[role="listbox"]')
    .parentElement.querySelector('input');
  await act(async () => { fireEvent.change(box, { target: { value: text } }); });
};
const rowLabels = () => [...document.querySelectorAll('[role="option"]')]
  .map(r => r.textContent.replace(/(INK|TNR|RBN|DRM)-\d/, '').trim());

describe('closed, it reads like the select it replaces', () => {
  test('it shows the placeholder when nothing is chosen', async () => {
    await mount();

    expect(trigger().textContent).toContain('Pick one');
  });

  test('and the chosen row once something is', async () => {
    await mount({ value: 2 });

    expect(trigger().textContent).toContain('Toner Cartridge');
  });

  test('a value given as a number matches an option keyed by number', async () => {
    // Ids arrive from the API as numbers and from a <select> as strings. The
    // component compares them as strings so a caller never has to care.
    await mount({ value: '2' });

    expect(trigger().textContent).toContain('Toner Cartridge');
  });

  test('the list is not in the document until it is opened', async () => {
    await mount();

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe('typing narrows it', () => {
  test('case does not matter', async () => {
    // The whole point: "ink" has to find "Ink Tube". Case-sensitive matching is
    // the bug that was just fixed on the server; it is not being reintroduced
    // in the browser.
    await mount();
    await openIt();
    await type('ink');

    expect(rowLabels()).toEqual(['Ink Tube']);
  });

  test('the hint is searched as well as the label', async () => {
    // So an accountant can type a code and a storekeeper can type a name.
    await mount();
    await openIt();
    await type('tnr');

    expect(rowLabels()).toEqual(['Toner Cartridge']);
  });

  test('words may be typed in any order', async () => {
    await mount();
    await openIt();
    await type('spool ribbon');

    expect(rowLabels()).toEqual(['Ribbon Spool']);
  });

  test('a query that matches nothing says so', async () => {
    await mount();
    await openIt();
    await type('zzzz');

    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    expect(document.querySelector('[role="listbox"]').textContent).toMatch(/\S/);
  });
});

describe('choosing', () => {
  test('a click hands back the value as a string', async () => {
    // Exactly what `e.target.value` would have given, so a call site keeps the
    // state it already had.
    const onChange = vi.fn();
    await mount({ onChange });
    await openIt();

    const row = [...document.querySelectorAll('[role="option"]')]
      .find(r => r.textContent.includes('Ribbon Spool'));
    await act(async () => { fireEvent.mouseDown(row); });

    expect(onChange).toHaveBeenCalledWith('3');
  });

  test('the blank row clears it', async () => {
    // `<option value="">` had to survive: most of these fields are optional.
    const onChange = vi.fn();
    await mount({ onChange, value: 2 });
    await openIt();

    const blank = [...document.querySelectorAll('[role="option"]')]
      .find(r => r.textContent.includes('Pick one'));
    await act(async () => { fireEvent.mouseDown(blank); });

    expect(onChange).toHaveBeenCalledWith('');
  });

  test('allowBlank=false leaves no way to empty a required field', async () => {
    const onChange = vi.fn();
    await mount({ onChange, allowBlank: false });
    await openIt();

    expect(rowLabels()).toEqual(
      ['Ink Tube', 'Toner Cartridge', 'Ribbon Spool', 'Drum Unit']);
  });

  test('the panel closes afterwards', async () => {
    await mount({ onChange: () => {} });
    await openIt();
    const row = document.querySelector('[role="option"]');
    await act(async () => { fireEvent.mouseDown(row); });

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe('the keyboard alone is enough', () => {
  test('it opens on arrow-down and picks on enter', async () => {
    const onChange = vi.fn();
    await mount({ onChange });

    await act(async () => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); });
    await act(async () => { fireEvent.keyDown(trigger(), { key: 'Enter' }); });

    expect(onChange).toHaveBeenCalledWith('2');
  });

  test('escape closes without choosing', async () => {
    const onChange = vi.fn();
    await mount({ onChange });
    await openIt();

    await act(async () => { fireEvent.keyDown(trigger(), { key: 'Escape' }); });

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('enter picks the top match after typing, not the first option', async () => {
    // Type three letters, press Enter: the thing you were looking at.
    const onChange = vi.fn();
    await mount({ onChange });
    await openIt();
    await type('drum');
    await act(async () => { fireEvent.keyDown(trigger(), { key: 'Enter' }); });

    expect(onChange).toHaveBeenCalledWith('4');
  });
});

describe('it behaves as a form control', () => {
  test('it is a button, so it never submits the form around it', async () => {
    // A bare <button> inside a <form> defaults to type=submit, which would save
    // the dialog every time somebody opened a dropdown.
    await mount();

    expect(trigger().getAttribute('type')).toBe('button');
  });

  test('disabled does not open', async () => {
    await mount({ disabled: true });
    await openIt();

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  test('it wears form-control so it lines up with the fields beside it', async () => {
    await mount();

    expect(trigger().className).toContain('form-control');
  });

  test('a caller can still size it', async () => {
    await mount({ style: { width: 190 } });

    expect(trigger().style.width).toBe('190px');
  });

  test('it announces itself to a screen reader', async () => {
    await mount();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await openIt();

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(within(document.body).getByRole('listbox')).toBeTruthy();
  });
});

describe('the panel escapes the dialog it lives in', () => {
  test('it is portalled to the body, not nested in the field', async () => {
    // .modal is overflow:hidden and .modal-body scrolls inside it. A panel in
    // the normal flow is clipped at the edge of the dialog — which is exactly
    // where most of these fields are.
    const { container } = await mount();
    await openIt();

    const panel = document.querySelector('[role="listbox"]');
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });

  test('and sits above the modal', async () => {
    await mount();
    await openIt();

    const panel = document.querySelector('[role="listbox"]').parentElement;
    expect(Number(panel.style.zIndex)).toBeGreaterThan(1000);
  });
});

// ── The sweep ───────────────────────────────────────────────────────────────

// Four lists were converted and no others. This is the part that rots: the next
// person adds a client picker, reaches for <select> because that is what the
// file next to theirs uses, and the app grows a second answer to the same
// question. So the rule is stated here rather than remembered.
describe('it opens on the right side of its own field', () => {
  // Half this app's users read right to left. The panel is at least 200px wide
  // so the search box is usable, and when that makes it wider than the field,
  // the extra has to grow away from the field's START edge — the right-hand
  // side in Arabic. Anchoring `left` in both directions leaves an RTL panel
  // hanging off the wrong end of the control it belongs to.
  const rtl = (on) => {
    document.documentElement.dir = on ? 'rtl' : 'ltr';
  };

  async function openAt(left, width, dir) {
    await mount({ style: { width } });
    // AFTER mounting: LocaleProvider sets `dir` from the chosen language when
    // it mounts, so a value set beforehand is overwritten before the panel
    // ever measures anything.
    rtl(dir === 'rtl');
    const btn = trigger();
    btn.getBoundingClientRect = () => ({
      left, right: left + width, top: 100, bottom: 130, width, height: 30,
    });
    await act(async () => { fireEvent.click(btn); });
    return document.querySelector('[role="listbox"]').parentElement;
  }

  test('left to right, it starts where the field starts', async () => {
    const panel = await openAt(300, 190, 'ltr');

    expect(panel.style.left).toBe('300px');
    rtl(false);
  });

  test('right to left, it ENDS where the field ends', async () => {
    const panel = await openAt(300, 190, 'rtl');

    // 200 wide (the minimum) ending at 490, so it starts at 290 — not 300,
    // which would push the extra ten pixels past the field's start edge.
    expect(panel.style.left).toBe('290px');
    rtl(false);
  });

  test('a field wider than the minimum keeps its own width', async () => {
    const panel = await openAt(100, 320, 'ltr');

    expect(panel.style.width).toBe('320px');
    rtl(false);
  });
});

describe('the four unbounded lists no longer use a plain select', () => {
  const SOURCES = import.meta.glob('../{pages,components}/**/*.jsx', {
    eager: true, query: '?raw', import: 'default',
  });

  // The collection an option list is mapped FROM is what says which list it is.
  const KIND = /^(clients?|inventory|items|products|stockItems|projects?|accounts)$/i;
  const OPEN_TAG = /<select/;

  function plainSelectsOver(src) {
    const found = [];
    let i = 0;
    for (;;) {
      i = src.indexOf('<select', i);
      if (i === -1) break;
      const close = src.indexOf('</select>', i);
      if (close === -1) break;
      const body = src.slice(i, close);
      const m = body.match(/\(?([A-Za-z_][\w.?]*)\s*(?:\|\|\s*\[\])?\)?\.map\(/);
      const coll = m && m[1].split('.').pop();
      if (coll && KIND.test(coll)) found.push(coll);
      i = close + 1;
    }
    return found;
  }

  test('not one is left anywhere in pages or components', () => {
    const offenders = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const coll of plainSelectsOver(src)) offenders.push(`${file} (${coll})`);
    }

    expect(offenders).toEqual([]);
  });

  test('and the app really did convert them, rather than deleting them', () => {
    const used = Object.values(SOURCES)
      .filter(src => /<SearchSelect/.test(src)).length;

    expect(used).toBeGreaterThanOrEqual(25);
  });

  test('the short fixed lists were left alone', () => {
    // A filter box over five payment methods is more machinery than the
    // problem needs, and a native <select> is the better control on a phone —
    // the OS picker beats anything built out of divs. So the sweep was four
    // lists, not every list.
    const all = Object.values(SOURCES).join('|');

    expect(all).toMatch(/<select[\s\S]{0,400}METHODS\.map/);
    expect(all).toMatch(/<select[\s\S]{0,400}CURRENCIES\.map/);
  });
});
