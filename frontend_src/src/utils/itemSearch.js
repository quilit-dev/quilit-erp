// Finding a stock item from whatever the user types.
//
// Every word typed must appear somewhere in the item --- in any order, at any
// position in a word --- so "shirt red", "red shirt" and "irt re" all find
// "Red Cotton Shirt". The item is searched across its name, its product and
// variant, barcode, SKU, category and attribute values (Size=XL, Color=Red),
// so a variant is found by the attribute that tells it apart.
//
// Text is normalised before comparing: case, Arabic letter variants (أ إ آ ٱ
// → ا, ة → ه, ى → ي), diacritics and tatweel, Arabic-Indic digits, and
// punctuation, so the spelling the user happens to type does not decide
// whether the item is found.

const AR_DIACRITICS = /[ً-ٰٟـ]/g;          // harakat + superscript alef + tatweel
const PUNCT = /[\-_/\\.,;:()[\]{}'"`|+*#!?&]+/g;

export function normaliseSearch(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')         // é → e
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))   // Arabic-Indic
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))   // Persian
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchWords(query) {
  const q = normaliseSearch(query);
  return q ? q.split(' ') : [];
}

/** Everything an item can be found by, normalised once. */
function haystack(item) {
  const attrs = item?.attributes && typeof item.attributes === 'object'
    ? Object.values(item.attributes) : [];
  return {
    name: normaliseSearch(item?.name),
    rest: normaliseSearch([item?.product_name, item?.variant_label, item?.barcode,
                           item?.sku, item?.category, ...attrs].filter(Boolean).join(' ')),
  };
}

/**
 * How well `item` matches the typed words, or -1 when it does not match.
 * Lower is better:
 *   0  the name is exactly what was typed
 *   1  the name starts with what was typed
 *   2  every word starts a word in the name
 *   3  every word is somewhere in the name
 *   4  every word is found, some outside the name (barcode, variant, …)
 */
export function matchRank(item, words, phrase) {
  if (!words.length) return 3;
  const h = haystack(item);
  const all = `${h.name} ${h.rest}`;
  if (!words.every(w => all.includes(w))) return -1;
  if (h.name === phrase) return 0;
  if (h.name.startsWith(phrase)) return 1;
  const nameWords = h.name.split(' ');
  if (words.every(w => nameWords.some(nw => nw.startsWith(w)))) return 2;
  if (words.every(w => h.name.includes(w))) return 3;
  return 4;
}

/** The items that match `query`, best first. An empty query returns them all. */
export function searchItems(items, query) {
  const words = searchWords(query);
  if (!words.length) return items || [];
  const phrase = words.join(' ');
  const scored = [];
  (items || []).forEach((it, i) => {
    const r = matchRank(it, words, phrase);
    if (r >= 0) scored.push([r, String(it?.name || '').length, i, it]);
  });
  // Best rank, then the shorter name (closer to what was typed), then the
  // order the list came in.
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return scored.map(s => s[3]);
}
