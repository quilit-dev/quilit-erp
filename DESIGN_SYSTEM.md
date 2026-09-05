# Workspace Graphite — Design System

The ERP's visual language is **Workspace Graphite**: a restrained, dense
operations console. Warm neutral grounds rather than cool grey, hierarchy
carried by hairline borders and tonal surface steps rather than floating
cards, low near-square corners, and semantic colour spent sparingly so the
operator's eye lands on the numbers, not the chrome.

It replaces the earlier plum-accented "Workspace" palette. The shape
language, spacing scale, typography and component patterns carried over
unchanged; the colour, radius and elevation did not.

This file is the reference for adopting the system across pages not yet
touched and for adding new components. It is kept in step with
`frontend_src/src/index.css` — the tokens below are the ones that ship, and
`src/test/tokenContrast.test.js` fails the build if they drift below WCAG
AA.

---

## Principles

1. **Quiet geometry.** 3–7px radii and no routine drop shadow. Depth is a
   1px border and a tonal step between surfaces. Only things that genuinely
   float — menus, dialogs, the command palette — carry a shadow.
2. **Brand plum for the primary control, semantic colour for status.** The
   plum is the identity; green/amber/red mean something. Never mix them.
   A pale inverse fill was tried here, copied from the reference, and
   reverted: the reference has ONE primary action on screen, this ERP has
   one per table row, and a near-white fill at 14.73:1 against the ground
   turned every list into a wall of bright blocks. A filled control should
   sit around 3-6:1 against the page — clearly a control, never a lamp.
3. **Warm neutral density.** Surfaces sit a single tonal step off the
   ground. Rows are dense and aligned; the eye should travel down a column
   of figures without furniture in the way.
4. **Simple before clever.** Where Odoo overloads a screen, we don't.
   Empty whitespace is a feature, not a bug. Two clearly-arranged figures
   beat seven crammed ones.
5. **Numbers are first-class citizens.** JetBrains Mono with tabular
   numerals, right-aligned in cells, slashed zeros.
6. **Dark mode is the reference rendition.** A warm near-black ground,
   not a pure black and not an inverted grey. The warmth is what keeps it
   from reading as a terminal.
7. **Contrast is not negotiable.** Every text token clears 4.5:1 on every
   surface it can land on, and anything that outlines a control clears
   3:1. Both are asserted by a test, because contrast is invisible to a
   suite that greps source text — which is how the previous palette
   shipped muted text at 3.11:1 without anyone noticing.
8. **Paper is white.** A print block re-declares the tokens so a document
   never inherits the screen theme. A dark invoice reaching a customer is
   a defect, not a preference.

---

## Tokens (in `index.css`)

### Colours — light (Workspace)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F3F0EC` | Page background — warm neutral |
| `--surface` | `#FCFAF7` | Panel surface |
| `--surface-2` | `#F2EDE8` | Panel header band, hover row tint, footer |
| `--surface-3` | `#E9E2DA` | Inset chips, table strong header band |
| `--rule` | `#D8D0C9` | Hairline divider — decorative, may stay faint |
| `--rule-strong` | `#8D7C6E` | **Control boundary — 3.85:1, WCAG 1.4.11** |
| `--ink` / `--text` | `#211D1A` | Body text — 16.06:1 on a panel |
| `--text-2` | `#5E5650` | Secondary text — 6.90:1 |
| `--text-3` | `#655C55` | Muted text / labels — 6.27:1 |
| `--accent` | `#714B67` | **Brand plum** — white label at 7.23:1 |
| `--accent-2` | `#5C3D54` | Plum hover |
| `--affirm` | `#147A48` | Positive / paid / balanced |
| `--caution` | `#A35C18` | Warning / pending |
| `--negate` | `#A63834` | Overdue / error / critical |
| `--info` | `#35658E` | Informational status |

### Colours — dark (Workspace Night)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#171310` | Warm near-black page ground |
| `--surface` | `#211B18` | Panel surface |
| `--surface-2` | `#2B2421` | Panel header band, hover row tint |
| `--rule` | `#403632` | Hairline divider — decorative |
| `--rule-strong` | `#846F66` | **Control boundary — 3.60:1 on a panel** |
| `--ink` / `--text` | `#F2EEE9` | Body text — 14.73:1 on a panel |
| `--text-2` | `#B1A8A1` | Secondary text — 7.28:1 |
| `--text-3` | `#988C85` | Muted text — 5.20:1 |
| `--accent` | `#8B5E7E` | **Brand plum, lifted** — white label at 5.25:1, and 3.52:1 against the ground |
| `--affirm` | `#35A36B` | Positive / paid / balanced |
| `--caution` | `#D28B45` | Warning / pending |
| `--negate` | `#C9605A` | Overdue / error / critical |
| `--info` | `#6E91B8` | Informational status |

A control filled with `--accent` takes its label from `--accent-ink`; one
filled with `--affirm` / `--caution` / `--negate` takes `--text-inv`. Two
tokens, because the accent and the semantic fills sit at different lightnesses
and one value cannot serve both. Never a literal white: the accent moves
between themes and the label has to move with it. When a pale accent was
briefly in place, five inline-styled controls kept a hardcoded `#fff` and
rendered white on white at 1.25:1 — the convert-to-invoice button on every
quotation row was invisible.

### Typography

| Token | Family | Use |
|---|---|---|
| `--font-display` | **Inter** (700 / 800 weights for headlines) | Page titles, card titles, KPI hero values, modal titles |
| `--font-sans` | Inter | Body UI, buttons, labels, captions |
| `--font-mono` | JetBrains Mono | Numbers, codes, IDs, timestamps, keyboard hints |
| `--font-ar` | Cairo | Arabic — used automatically on `[lang="ar"]` |

Built-in helpers:

- `.t-display` — Inter 700, tight tracking (-0.022em)
- `.t-eyebrow` — all-caps 10.5px 0.10em letter-spacing, slate
- `.t-caption` — Inter 400 slate (no italic, no serif)
- `.t-mono`, `.text-mono`, `.td-mono` — JetBrains Mono with tabular nums

### Spacing — 4-pt grid

`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 14 · `--space-5` 20 · `--space-6` 28 · `--space-7` 40 · `--space-8` 56.

### Radii — friendly rounded

`--r-xs` 4 · `--r-sm` 6 · `--r` 8 · `--r-lg` 12 · `--r-xl` 14 · `--r-pill` 999 (avatars, the rare full-pill badge).

Panels 5px, buttons 4px, badges 3px, dialogs 7px. The near-square rounding
is the single biggest geometric move from the previous direction.

### Shadows — soft and low

| Token | Use |
|---|---|
| `--shadow-xs` | **`none`** — panels sit flat; a border does the work |
| `--shadow` | **`none`** — hover is a surface tint, not a lift |
| `--shadow-md` | **`none`** |
| `--shadow-lg` | Dropdowns + notification panel |
| `--shadow-xl` | Modals + command palette |
| `--shadow-focus` | Input focus ring (accent at 22 % alpha) |

---

## Component patterns

### Card (`.card`)

```jsx
<div className="card">
  <div className="card-header">
    <span className="card-title">Title</span>
    <span className="card-subtitle">Plain Inter slate aside</span>
  </div>
  <div className="card-body">…content…</div>
</div>
```

- Panel surface, 5px radius, hairline border, **no shadow at rest**.
  On hover the row or panel takes a `--surface-2` tint instead of lifting.
- Header has a hairline rule beneath, surface-2 band optional.
- Title is Inter 700 with tight tracking; subtitle is Inter 400 slate.

### KPI tile (`.stat-card`)

The dashboard's signature element:

```
[ icon mark · top-left ]                  [ ▲ 12 % · top-right ]
LABEL IN ALL CAPS, LETTERSPACED, SLATE
34,200.00                              ← Inter 700, tabular, hero
plain Inter slate caption              ← optional
[ sparkline below if data present ]
```

Signature touches:

1. **Panel surface + hairline border** — the card sits flat rather than
   read as its own object on the cool light background.
2. **Hero value is Inter 700 at 28px**, -0.028em tracking, tabular figures
   with slashed zeros.
3. **Trend pill is monospace** with `▲` / `▼` arrow glyphs and tabular
   percentages — calm, not loud.
4. **Hover tints the surface + reveals a click chevron** when the
   tile is interactive.

### Tables (`.table-wrap` + plain `<table>`)

- Hairline horizontal rules, no vertical lines, no row banding.
- `<thead th>` is uppercased eyebrow style on `surface-2`.
- Row hover: **soft `surface-2` tint**, no rail.
- Numeric cells should add `className="td-mono"` so figures use
  JetBrains Mono.
- Tfoot: 2px top border, surface-2 band.

### Forms

- `.form-label`: 11px, all-caps, 0.06em letter-spacing, slate.
- `.form-control`: hairline border, 6px radius, **3px accent ring on
  focus** (no border colour change — softer).
- `input[type="number"]` is automatically monospace + right-aligned.
- `.form-hint`: Inter 400 slate, no italic.

### Buttons

| Variant | When |
|---|---|
| `.btn .btn-primary` | The single most important action on a screen (plum fill, label from `--accent-ink`) |
| `.btn .btn-secondary` | Default action with chrome (white + hairline) |
| `.btn .btn-ghost` | Tertiary, blends into the surface |
| `.btn .btn-outline` | Accent-bordered, transparent fill |
| `.btn .btn-danger` | Destructive (negate red fill) |
| `.btn .btn-success` | Confirm / complete (affirm green fill) |
| `.btn-sm` / `.btn-xs` | Size modifiers |

6px radius. Weight 600 on the label. Slight tracking tightening for the
engineered feel.

### Badges (`.badge`)

Soft rounded pills, sentence-case Inter — friendlier than the editorial
stamps the previous direction used. 4px radius. Six built-in colour
modifiers: `.badge-gray .badge-blue .badge-green .badge-yellow .badge-red
.badge-purple` (a legacy alias; it resolves to the plum accent).

### Tabs (`.tabs` + `.tab-btn.active`)

Underline style. Active tab has a 2px accent rule beneath + accent text +
slight tracking tightening.

### Modal (`.modal-overlay` + `.modal`)

Slide-up entrance with spring ease. Inter 700 title. Hairline rule under
header, hairline rule above footer, surface-2 footer band. **12px modal
radius** (slightly more generous than before). Use `.modal-lg` (820px)
or `.modal-xl` (1100px) as needed.

### Empty state (`.empty-state` via `<EmptyState>`)

A 44px hairline-dashed square outline anchors the composition — reads as
an empty document slot. Default glyph is `+`; pass a specific icon via
the `icon` prop only when category-specific empties call for it.

---

## Sidebar grammar

- 236px wide, white fill, hairline right border.
- Logo block: 60px tall, `--surface-2` background, hairline bottom rule,
  **accent-filled monogram mark** (label from `--text-inv`) + Inter 700 company
  name + mono 10px "ERP PLATFORM" eyebrow.
- Items grouped into **workflow directories**: `SALES`, `DELIVERY`,
  `OPERATIONS`, `FINANCE`, `PEOPLE`. Section labels are clean uppercase
  Inter eyebrows — no monospace, no glyph prefix.
- **Active item is a solid plum fill** with `--accent-ink` text + 600 weight. No
  rail. (This is the biggest visual change from the previous direction
  and the strongest Odoo nod in the system.)
- Hover: light `surface-2` tint.
- Footer: surface-2 band with an accent-filled avatar circle (`--text-inv` initials)
  and the user's role in mono 11px.

---

## Numbers culture

Every page that renders figures should:

1. Use `className="text-mono"` or `font-family: var(--font-mono)` on the
   number (not the entire row — the label stays in Inter).
2. Right-align numeric columns in tables.
3. Trust that the body has `font-variant-numeric` set — don't override.
4. Use `▲` / `▼` (not `↑` / `↓`) for trend arrows.
5. Format with `Intl.NumberFormat` for the active locale; tabular figures
   ensure column alignment regardless.

---

## What to NOT do

- ❌ Don't add gradient backgrounds (purple → pink, blue → cyan, etc.).
- ❌ Don't introduce a new accent colour. The plum is the single
   chromatic move; semantics appear only when meaning requires them.
- ❌ Don't put emoji inside coloured-circle backgrounds on KPI tiles.
- ❌ Don't add heavy `box-shadow` to interactive elements at rest. Hover
   lifts step from `--shadow-xs` → `--shadow`, no more.
- ❌ Don't switch back to sharp 2px badge corners. Badges are friendly 4px
   rounded pills.
- ❌ Don't introduce additional fonts. The pair (**Inter** + JetBrains
   Mono, Cairo for Arabic) is the entire system. No serifs.
- ❌ Don't switch to very large radii on cards (16 / 20px). 8px is the
   ceiling for cards, 12px for modals.
- ❌ Don't add row-banding (`tr:nth-child(odd)`) to tables. Soft hover
   tint is the pattern.
- ❌ Don't translate the page title into all-caps. The bold Inter title
   IS the headline; uppercase eyebrows belong only on labels.
- ❌ Don't restore the 2px hover rail on table rows or the active sidebar
   item. Solid fills are the Workspace pattern.

---

## Adopting Workspace on a page you haven't yet refreshed

99 % of the work happens automatically:

1. **CSS variables cascade** — every `var(--accent)`, `var(--surface)`,
   `var(--border)` reference in inline styles updates with the new tokens
   (plum primary, warm neutral surface, near-square radii).
2. **Base class definitions changed** — `.btn`, `.card`, `.table-wrap`,
   `.modal`, `.form-control`, `.tabs`, `.badge`, `.stat-card`, `.sidebar`,
   `.nav-link` all carry the new geometry without JSX changes.

When you do touch a page, the polish list:

- [ ] Replace any rounded-pill badge shape (`border-radius: 999px` on a
      status indicator) with the `.badge` class.
- [ ] Confirm form labels use `.form-label`, not inline styled `<div>`s.
- [ ] Wrap numbers in `<span className="text-mono">`.
- [ ] Remove any inline `box-shadow` lift effects — the system handles
      hover elevation on cards already.
- [ ] Replace emoji-on-coloured-bubble icons with thin marks or none.
- [ ] If an old "active item indicator" used a left-rail style, swap to
      the solid plum fill pattern.

That's the system. Read it once, internalise the principles, and the rest
of the surface area takes care of itself.
