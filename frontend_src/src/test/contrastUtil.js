// WCAG 2.1 relative luminance and contrast ratio.
//
// A plain module, not a test file: importing this from another spec must not
// re-run a suite. It was briefly exported from tokenContrast.test.js, which
// meant every file that wanted the helper also re-executed that file's 49
// assertions and reported them as its own.
export function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** An alpha wash of `fg` laid over `bg`, as a hex string. */
export function over(fg, alpha, bg) {
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
  const f = rgb(fg);
  const b = rgb(bg);
  return '#' + [0, 1, 2]
    .map((i) => Math.round(f[i] * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('');
}
