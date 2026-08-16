// The total, spelled out — "Three hundred one million eighty-nine thousand
// Lebanese Pounds only".
//
// This is not decoration. On a printed invoice the words are the control: a
// figure can be altered with a pen after it leaves your hands, and the words
// are what a bank, a court or an auditor reads when the two disagree. Which is
// exactly why they must be computed from the same number that is printed, and
// never typed. The sample invoice this was built from carried
// "three hundred million nine hundred ninety thousand" against a total of
// 301,089,000 — two different amounts on one document, which is the failure
// this function exists to make impossible.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

// Indexed by group-of-three from the right. Stops at trillion: an invoice
// beyond that is a data-entry error, and `formatted` below refuses rather than
// inventing a scale name.
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

/**
 * Strict numeric parse. `Number()` alone will not do: it turns null, undefined,
 * '' and [] into 0, so a document with no total would confidently print "Zero
 * Dollars only" — a sentence that looks deliberate and is not. A missing amount
 * has to be distinguishable from an amount that is genuinely zero.
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/** 1–999 in words. Below 20 is a lookup; above it, tens-hyphen-ones. */
function underThousand(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = ONES[n % 10];
    return ones ? `${tens}-${ones}` : tens;
  }
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${underThousand(rest)}` : ''}`;
}

/**
 * A whole number in English words. Returns '' for anything that is not a
 * finite non-negative number, or that exceeds the named scales.
 */
export function numberToWords(value) {
  const n = Math.floor(toNumber(value));
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'zero';

  const groups = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  if (groups.length > SCALES.length) return '';

  // Most significant first, skipping empty groups so 1,000,001 reads
  // "one million one" and not "one million zero thousand one".
  return groups
    .map((g, i) => (g ? `${underThousand(g)}${SCALES[i] ? ` ${SCALES[i]}` : ''}` : ''))
    .filter(Boolean)
    .reverse()
    .join(' ');
}

// How each currency is named and whether it has a minor unit worth printing.
// LBP has no circulating subdivision — writing "and zero piastres" on every
// Lebanese invoice would be noise, so the amount is stated whole.
const CURRENCIES = {
  USD: { major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  EUR: { major: ['Euro', 'Euros'], minor: ['Cent', 'Cents'] },
  GBP: { major: ['Pound', 'Pounds'], minor: ['Penny', 'Pence'] },
  LBP: { major: ['Lebanese Pound', 'Lebanese Pounds'], minor: null },
  AED: { major: ['Dirham', 'Dirhams'], minor: ['Fils', 'Fils'] },
  SAR: { major: ['Riyal', 'Riyals'], minor: ['Halala', 'Halalas'] },
};

const capitalise = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * An amount as the sentence that goes under a total.
 *
 *   amountInWords(301089000, 'LBP')
 *     → "Three hundred one million eighty-nine thousand Lebanese Pounds only"
 *   amountInWords(1250.5, 'USD')
 *     → "One thousand two hundred fifty Dollars and Fifty Cents only"
 *
 * An unknown currency code is used verbatim as the unit name, so a company
 * trading in something not listed above still gets a correct sentence rather
 * than a blank line. Returns '' when there is nothing sensible to say.
 */
export function amountInWords(value, currency = 'USD') {
  const amount = toNumber(value);
  if (!Number.isFinite(amount) || amount < 0) return '';

  const code = String(currency || 'USD').toUpperCase();
  const spec = CURRENCIES[code];
  const hasMinor = spec ? Boolean(spec.minor) : true;

  // Round to the printed precision FIRST. Rounding after splitting lets
  // 1.999 print as "one Dollar and one hundred Cents".
  const rounded = hasMinor ? Math.round(amount * 100) / 100 : Math.round(amount);
  const major = Math.floor(rounded);
  const minor = hasMinor ? Math.round((rounded - major) * 100) : 0;

  const majorWords = numberToWords(major);
  if (!majorWords) return '';                    // out of range — say nothing

  const majorName = spec
    ? spec.major[major === 1 ? 0 : 1]
    : code;                                      // unknown code: "1250 XYZ"
  let out = `${capitalise(majorWords)} ${majorName}`;

  if (minor > 0) {
    const minorName = spec.minor[minor === 1 ? 0 : 1];
    out += ` and ${capitalise(numberToWords(minor))} ${minorName}`;
  }

  // "only" is the convention that closes the sentence, and it is functional:
  // it marks the end so nothing can be appended to the line afterwards.
  return `${out} only`;
}
