# Typefaces

Served from this app rather than fetched from Google. The production
Content-Security-Policy permits `style-src 'self'` and nothing else, so the
`@import url(fonts.googleapis.com/...)` these used to arrive through was blocked
on every page load and every print — the whole app fell back to system fonts,
and Arabic rendered without Cairo, the face its screens were designed in.

Serving them here needs no CSP change (`font-src 'self'` was already allowed),
removes a third-party request from every page load, keeps the app looking right
on a network that cannot reach Google, and stops every user's address being
handed to a third party on the way to a font.

| File | Family | Subset |
|---|---|---|
| `inter-latin.woff2` | Inter | latin |
| `inter-latin-ext.woff2` | Inter | latin-ext |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | latin |
| `jetbrains-mono-latin-ext.woff2` | JetBrains Mono | latin-ext |
| `cairo-arabic.woff2` | Cairo | arabic |
| `cairo-latin.woff2` | Cairo | latin |

All three are **variable** fonts: one file covers the family's whole weight
range, which is why there are six files and not the thirteen a
weight-per-file approach would need. Declared in `src/index.css` with
`font-weight: 400 800` ranges and `font-display: swap`; the print stylesheet in
`src/utils/exportUtils.js` declares the two it needs.

Only the subsets this app renders are here. Google slices each family by
unicode-range, and taking all of them would ship Cyrillic and Vietnamese for an
app that shows neither.

## Licence

All three are licensed under the **SIL Open Font License 1.1**, which permits
redistribution as part of a larger work:

- **Inter** — Rasmus Andersson · <https://github.com/rsms/inter>
- **JetBrains Mono** — JetBrains · <https://github.com/JetBrains/JetBrainsMono>
- **Cairo** — Mohamed Gaber and contributors · <https://github.com/Gue3bara/Cairo>

The full licence text ships with each project at the links above.

## Regenerating

If a weight or subset is ever added, refetch rather than editing by hand — the
`unicode-range` values in the stylesheet have to match the files. The fetch
script lives with the delivery notes for this change.
