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
  // `searchable` forced on: the fixture is four rows, and the box appears on
  // its own only once a list is long enough to need one.
  const searchable = { searchable: true };

  test('case does not matter', async () => {
    // The whole point: "ink" has to find "Ink Tube". Case-sensitive matching is
    // the bug that was just fixed on the server; it is not being reintroduced
    // in the browser.
    await mount(searchable);
    await openIt();
    await type('ink');

    expect(rowLabels()).toEqual(['Ink Tube']);
  });

  test('the hint is searched as well as the label', async () => {
    // So an accountant can type a code and a storekeeper can type a name.
    await mount(searchable);
    await openIt();
    await type('tnr');

    expect(rowLabels()).toEqual(['Toner Cartridge']);
  });

  test('words may be typed in any order', async () => {
    await mount(searchable);
    await openIt();
    await type('spool ribbon');

    expect(rowLabels()).toEqual(['Ribbon Spool']);
  });

  test('a query that matches nothing says so', async () => {
    await mount(searchable);
    await openIt();
    await type('zzzz');

    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    expect(document.querySelector('[role="listbox"]').textContent).toMatch(/\S/);
  });
});

describe('the filter box appears only when there is something to filter', () => {
  // A search box over three payment methods is a box nobody types in, and it
  // pushes the one row you wanted further down the panel.
  const many = Array.from({ length: 12 },
    (_, i) => ({ value: i + 1, label: `Item ${i + 1}` }));

  const box = () => document.querySelector('[role="listbox"]')
    .parentElement.querySelector('input');

  test('a short list is just a styled list', async () => {
    await mount();               // four rows
    await openIt();

    expect(box()).toBeNull();
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  });

  test('a long one gets the filter', async () => {
    await mount({ options: many });
    await openIt();

    expect(box()).not.toBeNull();
  });

  test('and a caller can insist either way', async () => {
    await mount({ searchable: true });
    await openIt();
    expect(box()).not.toBeNull();
  });

  test('the keyboard still works without a filter box', async () => {
    // The arrow keys and Enter are handled on the trigger, not the input, so
    // hiding the box must not take the keyboard with it.
    const onChange = vi.fn();
    await mount({ onChange });
    await openIt();

    await act(async () => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); });
    await act(async () => { fireEvent.keyDown(trigger(), { key: 'Enter' }); });

    expect(onChange).toHaveBeenCalledWith('2');
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

  test('a picker with no placeholder has no blank row either', async () => {
    // A <select> has a blank row only when one was written into it. Defaulting
    // it on gave the page-size picker a "—" that meant nothing, and choosing
    // it meant nothing twice.
    await mount({ placeholder: undefined });
    await openIt();

    expect(rowLabels()).toEqual(
      ['Ink Tube', 'Toner Cartridge', 'Ribbon Spool', 'Drum Unit']);
  });

  test('and one with a placeholder keeps it', async () => {
    await mount();               // the fixture passes placeholder="Pick one"
    await openIt();

    expect(rowLabels()[0]).toBe('Pick one');
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
    await mount({ onChange, searchable: true });
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

// It began as four lists — the ones that grow without bound. It ended as every
// dropdown in the app, because the closed controls always matched to the pixel
// and only what OPENED gave it away: a native select hands its list to the
// operating system, which paints it in the system font with square corners and
// no hover styling, beside a designed panel on the field next to it.
//
// This is the part that rots. The next person adds a picker, reaches for
// <select> because that is what they have always typed, and the app grows a
// second answer to the same question. So the rule is stated here.
describe('every dropdown opens the same panel', () => {
  const SOURCES = import.meta.glob('../{pages,components}/**/*.jsx', {
    eager: true, query: '?raw', import: 'default',
  });

  const live = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('no page or component renders a bare <select>', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => /<select[\s>]/.test(live(src)))
      .map(([file]) => file.replace('../', ''));

    expect(offenders).toEqual([]);
  });

  test('nor an <optgroup>, which the panel has no notion of', () => {
    // Purchases grouped variants under their product. A list you type into
    // does not need the grouping, and a filtered list cannot keep the headings
    // anywhere sensible — the product name moved to the hint column instead.
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => /<optgroup/.test(live(src)))
      .map(([file]) => file.replace('../', ''));

    expect(offenders).toEqual([]);
  });

  test('and they were converted, not deleted', () => {
    const used = Object.values(SOURCES)
      .filter(src => /<SearchSelect/.test(src)).length;

    expect(used).toBeGreaterThanOrEqual(60);
  });
});
