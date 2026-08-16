// The words under a printed total are the legal control on that document. When
// they disagree with the figure, the words are what a bank honours — so the
// only acceptable behaviour is that they always describe the same number, and
// that an amount this converter cannot state correctly produces NOTHING rather
// than something plausible and wrong.
//
// The invoice this feature was built from carried
// "three hundred million nine hundred ninety thousand Lebanese Pounds only"
// against a total of 301,089,000 — a document stating two different amounts.
// The 301,089,000 case below is that exact number.
import { describe, test, expect } from 'vitest';
import { numberToWords, amountInWords } from '../utils/numberToWords';

describe('numberToWords', () => {
  test.each([
    [0, 'zero'],
    [1, 'one'],
    [9, 'nine'],
    [10, 'ten'],
    [13, 'thirteen'],
    [19, 'nineteen'],
    [20, 'twenty'],
    [21, 'twenty-one'],
    [99, 'ninety-nine'],
    [100, 'one hundred'],
    [101, 'one hundred one'],
    [115, 'one hundred fifteen'],
    [999, 'nine hundred ninety-nine'],
    [1000, 'one thousand'],
    [1001, 'one thousand one'],
    [12345, 'twelve thousand three hundred forty-five'],
    [1000000, 'one million'],
  ])('%i → %s', (n, words) => {
    expect(numberToWords(n)).toBe(words);
  });

  test('the invoice total that started this', () => {
    expect(numberToWords(301089000)).toBe(
      'three hundred one million eighty-nine thousand');
  });

  test('empty groups are skipped, not spoken as zero', () => {
    // "one million one", never "one million zero thousand one".
    expect(numberToWords(1000001)).toBe('one million one');
    expect(numberToWords(1000000001)).toBe('one billion one');
  });

  test('the fractional part is dropped, not rounded up', () => {
    // amountInWords owns rounding; this function states whole numbers only.
    expect(numberToWords(5.99)).toBe('five');
  });

  test.each([
    [-1, 'negative'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['abc', 'a non-numeric string'],
  ])('returns empty for %s (%s)', (input) => {
    expect(numberToWords(input)).toBe('');
  });

  test('refuses beyond the named scales rather than inventing one', () => {
    // 10^15. Saying nothing is correct; "one thousand trillion" is not a form
    // anyone writes on an invoice, and a made-up scale name would be worse.
    expect(numberToWords(1e15)).toBe('');
  });
});

describe('amountInWords', () => {
  test('LBP is stated whole — there is no circulating subdivision', () => {
    expect(amountInWords(301089000, 'LBP')).toBe(
      'Three hundred one million eighty-nine thousand Lebanese Pounds only');
  });

  test('LBP never mentions a minor unit even with a fraction present', () => {
    expect(amountInWords(1500.75, 'LBP')).toBe(
      'One thousand five hundred one Lebanese Pounds only');
  });

  test('USD spells out the cents', () => {
    expect(amountInWords(1250.5, 'USD')).toBe(
      'One thousand two hundred fifty Dollars and Fifty Cents only');
  });

  test('USD omits the cents when there are none', () => {
    expect(amountInWords(1250, 'USD')).toBe(
      'One thousand two hundred fifty Dollars only');
  });

  test('singular units are singular', () => {
    expect(amountInWords(1, 'USD')).toBe('One Dollar only');
    expect(amountInWords(1.01, 'USD')).toBe('One Dollar and One Cent only');
  });

  test('rounds to the printed precision BEFORE splitting', () => {
    // Splitting first would yield "one Dollar and one hundred Cents".
    expect(amountInWords(1.999, 'USD')).toBe('Two Dollars only');
  });

  test('zero is stated, not skipped', () => {
    expect(amountInWords(0, 'USD')).toBe('Zero Dollars only');
  });

  test('an unknown currency uses its code rather than going blank', () => {
    // A company trading in something unlisted still gets a correct sentence.
    expect(amountInWords(42, 'XYZ')).toBe('Forty-two XYZ only');
  });

  test('the code is case-insensitive', () => {
    expect(amountInWords(5, 'usd')).toBe('Five Dollars only');
  });

  test.each([[-5], [NaN], ['abc'], [null]])(
    'says nothing for an unusable amount (%s)', (bad) => {
      expect(amountInWords(bad, 'USD')).toBe('');
    });

  test('says nothing rather than half a sentence when out of range', () => {
    // The failure mode that matters: a truncated or wrong sentence next to a
    // correct figure is worse than no sentence at all.
    expect(amountInWords(1e15, 'USD')).toBe('');
  });
});
