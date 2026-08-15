// A barcode field has to survive being scanned into.
//
// A USB scanner is a keyboard: it types the code, then sends Enter. Enter in a
// single-line input inside a <form> with a submit button submits that form — so
// scanning a barcode halfway through "Add item" saved the item there and then,
// before cost, price, category or unit were filled. Nothing errored and nothing
// looked wrong; the item was simply created half-empty, and the damage surfaced
// later as odd stock or margins.
//
// The misfire needed the operator to work in the natural order, too: name first
// (satisfying `required`), then scan. Scanning into an empty form was blocked by
// validation, so the bug hid from anyone who tested it backwards.
import { describe, test, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { swallowScannerEnter } from '../components/shared';
import itemFormSrc       from '../pages/inventory/ItemForm.jsx?raw';
import productBuilderSrc from '../pages/inventory/ProductBuilder.jsx?raw';

/** A form shaped like the real ones: submit button, single-line inputs. */
function Harness({ onSubmit, guard }) {
  return (
    <form onSubmit={onSubmit}>
      <input aria-label="name" defaultValue="Widget" required />
      <input
        aria-label="barcode"
        onKeyDown={guard ? swallowScannerEnter : undefined}
      />
      <button type="submit">Save</button>
    </form>
  );
}

/** What a scanner does: types the digits, then presses Enter. */
function scan(input, code = '6291041500213') {
  fireEvent.change(input, { target: { value: code } });
  // jsdom does not implicitly submit on Enter, so submit is requested the way a
  // browser would and the guard's preventDefault is what has to stop it.
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
  });
  input.dispatchEvent(enter);
  return enter;
}

describe('swallowScannerEnter', () => {
  test('cancels the Enter a scanner sends', () => {
    const { getByLabelText } = render(<Harness onSubmit={e => e.preventDefault()} guard />);
    const enter = scan(getByLabelText('barcode'));

    expect(enter.defaultPrevented,
      'Enter must be cancelled, or the form submits mid-entry').toBe(true);
  });

  test('without the guard the Enter is NOT cancelled', () => {
    // The bug, pinned: same keystroke, no guard, nothing stops the submit.
    const { getByLabelText } = render(<Harness onSubmit={e => e.preventDefault()} />);
    const enter = scan(getByLabelText('barcode'));

    expect(enter.defaultPrevented).toBe(false);
  });

  test('the scanned code still lands in the field', () => {
    // Swallowing the key must not swallow the value — the whole point is to
    // capture the barcode.
    const { getByLabelText } = render(<Harness onSubmit={e => e.preventDefault()} guard />);
    const field = getByLabelText('barcode');
    scan(field, '5000112637922');

    expect(field.value).toBe('5000112637922');
  });

  test('ordinary typing is untouched', () => {
    const guard = vi.fn(swallowScannerEnter);
    const { getByLabelText } = render(
      <form><input aria-label="b" onKeyDown={guard} /></form>);
    const field = getByLabelText('b');

    const key = new KeyboardEvent('keydown', {
      key: '7', bubbles: true, cancelable: true,
    });
    field.dispatchEvent(key);

    expect(key.defaultPrevented, 'only Enter should be cancelled').toBe(false);
  });
});

describe('the barcode fields use it', () => {
  test.each([
    ['ItemForm',       itemFormSrc],
    ['ProductBuilder', productBuilderSrc],
  ])('%s guards its barcode input', (_name, src) => {
    expect(src).toContain('swallowScannerEnter');
    expect(src).toContain('onKeyDown={swallowScannerEnter}');
  });
});
