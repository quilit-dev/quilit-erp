// SortableTh — the sort control fifteen tables share.
//
// Written before touching it, per the Stage 3 rule. Two things it did not do:
//
//   * it carried no `aria-sort`, so a screen reader announced a plain column
//     heading and never said which column the table was ordered by, or which
//     way;
//   * it was a `<th onClick>` with no tabIndex and no key handler, so sorting
//     was reachable by mouse only. That is WCAG 2.1.1 — not a nicety, a table
//     a keyboard user cannot reorder.
//
// The tests assert behaviour, not appearance: the glyph and the colour are
// free to change with the theme, the semantics are not.
import { describe, test, expect, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { SortableTh } from '../components/shared.jsx';

const mount = (ui) => {
  let container;
  act(() => {
    ({ container } = render(<table><thead><tr>{ui}</tr></thead></table>));
  });
  return container;
};

const th = (props = {}) => (
  <SortableTh
    label="Amount"
    sortKey="amount"
    currentKey={props.currentKey ?? 'amount'}
    currentDir={props.currentDir ?? 'asc'}
    onSort={props.onSort ?? (() => {})}
    {...props}
  />
);

describe('SortableTh', () => {
  test('renders its label', () => {
    expect(mount(th()).textContent).toContain('Amount');
  });

  test('announces the sort direction of the active column', () => {
    const asc = mount(th({ currentDir: 'asc' })).querySelector('th');
    expect(asc.getAttribute('aria-sort')).toBe('ascending');

    const desc = mount(th({ currentDir: 'desc' })).querySelector('th');
    expect(desc.getAttribute('aria-sort')).toBe('descending');
  });

  test('an inactive column announces that it is not the sort column', () => {
    // "none" is meaningful: it tells a screen reader the column IS sortable
    // but is not currently sorted. Omitting the attribute says neither.
    const c = mount(th({ currentKey: 'client' })).querySelector('th');
    expect(c.getAttribute('aria-sort')).toBe('none');
  });

  test('sorts on click', () => {
    const onSort = vi.fn();
    fireEvent.click(mount(th({ onSort })).querySelector('th'));
    expect(onSort).toHaveBeenCalledWith('amount');
  });

  test('is reachable by keyboard', () => {
    const c = mount(th()).querySelector('th');
    // Focusable in the normal tab order, and announced as an activatable
    // control rather than a bare heading cell.
    expect(c.getAttribute('tabindex')).toBe('0');
    expect(c.getAttribute('role')).toBe('button');
  });

  test('sorts on Enter and on Space', () => {
    for (const key of ['Enter', ' ']) {
      const onSort = vi.fn();
      const cell = mount(th({ onSort })).querySelector('th');
      fireEvent.keyDown(cell, { key });
      expect(onSort, `${key} did not sort`).toHaveBeenCalledWith('amount');
    }
  });

  test('ignores other keys', () => {
    // Space and Enter activate; Tab must still move on, and a letter typed
    // while the header has focus must not silently reorder the table.
    const onSort = vi.fn();
    const cell = mount(th({ onSort })).querySelector('th');
    fireEvent.keyDown(cell, { key: 'Tab' });
    fireEvent.keyDown(cell, { key: 'a' });
    expect(onSort).not.toHaveBeenCalled();
  });

  test('does not rely on colour alone to show the sort state', () => {
    // 1.4.1: the active column is tinted, but it also has to carry a glyph.
    const active = mount(th({ currentKey: 'amount' })).querySelector('th');
    expect(active.querySelector('svg')).toBeTruthy();
  });
});
