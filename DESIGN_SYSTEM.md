# Workspace — Design System

The ERP's visual language is **Workspace**: a clean, friendly business-
software aesthetic that draws on Odoo's recognisable shape language —
plum primary accent, soft white cards on a cool light surface, gently
rounded corners — and ships it with more breathing room and less visual
chatter so the operator's eye lands on the work, not the chrome.

This file is the reference for adopting the system across pages not yet
touched and for adding new components.

---

## Principles

1. **Friendly geometry.** 6–10px radii, soft drop shadows on cards, no
   sharp document corners. Reads as a modern product, not a printed page.
2. **Plum primary, used with restraint.** The signature colour shows up on
   the primary CTA, the active sidebar item, focus rings, and small
   accent rules — never as a background fill on entire panels.
3. **White-on-light density.** Surfaces sit on a cool light background;
   the contrast is just enough to read each card as its own object
   without floating away from the page.
4. **Simple before clever.** Where Odoo overloads a screen, we don't.
   Empty whitespace is a feature, not a bug. Two clearly-arranged figures
   beat seven crammed ones.
5. **Numbers are first-class citizens.** JetBrains Mono with tabular
   numerals, right-aligned in cells, slashed zeros.
6. **Dark mode is real dark.** Deep slate-violet background with white
   text; the plum lifts to a brighter lavender for visibility. Not just
   inverted greys — the violet undertone keeps the identity intact.

---

## Tokens (in `index.css`)

### Colours — light (Workspace)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F7F7FA` | Page background — cool light grey |
| `--surface` | `#FFFFFF` | Card surface — pure white |
| `--surface-2` | `#F2F2F6` | Card header band, hover row tint, footer |
| `--surface-3` | `#E9E9EF` | Inset chips, table strong header band |
| `--rule` | `#E5E5EC` | Hairline border |
| `--rule-strong` | `#CFCFD9` | Stronger column rule, table footer top |
| `--ink` / `--text` | `#1F1F2E` | Body text (slight plum undertone) |
| `--text-2` | `#5A5C6F` | Secondary text |
| `--text-3` | `#8A8C9D` | Muted text / labels |
| `--accent` | `#714B67` | **Plum primary — the signature colour** |
| `--accent-2` | `#5C3D54` | Plum hover |
| `--affirm` | `#1FA362` | Positive / paid / balanced |
| `--caution` | `#E29A2C` | Warning / pending |
| `--negate` | `#D14545` | Overdue / error / critical |
| `--info` | `#2C7BC4` | Informational status |

### Colours — dark (Workspace Night)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#15151D` | Deep slate-violet page bg |
| `--surface` | `#1E1E28` | Card surface |
| `--ink` / `--text` | `#F2F0F7` | Soft white body text |
| `--accent` | `#C49AB8` | Lifted lavender — visible against deep slate |

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

Cards 8px, buttons 6px, badges 4px, modals 12px. The friendlier rounding
is the single biggest geometric move from the previous direction.

### Shadows — soft and low

| Token | Use |
|---|---|
| `--shadow-xs` | Subtle drop on cards at rest (1px + light blur) |
| `--shadow` | Card hover (2px + soft blur) |
| `--shadow-md` | Sub-card surfaces, KPI tile hover |
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

- White surface, 8px radius, hairline border, **subtle drop shadow at
  rest**. On hover the shadow steps up to `--shadow`.
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

1. **Soft white surface + drop shadow** — the card floats just enough to
   read as its own object on the cool light background.
2. **Hero value is Inter 700 at 28px**, -0.028em tracking, tabular figures
   with slashed zeros.
3. **Trend pill is monospace** with `▲` / `▼` arrow glyphs and tabular
   percentages — calm, not loud.
4. **Hover gently lifts the shadow + reveals a click chevron** when the
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
| `.btn .btn-primary` | The single most important action on a screen (plum fill) |
| `.btn .btn-secondary` | Default action with chrome (white + hairline) |
| `.btn .btn-ghost` | Tertiary, blends into the surface |
| `.btn .btn-outline` | Plum-bordered, transparent fill |
| `.btn .btn-danger` | Destructive (negate red fill) |
| `.btn .btn-success` | Confirm / complete (affirm green fill) |
| `.btn-sm` / `.btn-xs` | Size modifiers |

6px radius. Weight 600 on the label. Slight tracking tightening for the
engineered feel.

### Badges (`.badge`)

Soft rounded pills, sentence-case Inter — friendlier than the editorial
stamps the previous direction used. 4px radius. Six built-in colour
modifiers: `.badge-gray .badge-blue .badge-green .badge-yellow .badge-red
.badge-purple` (purple is the same plum as the primary accent).

### Tabs (`.tabs` + `.tab-btn.active`)

Underline style. Active tab has a 2px accent rule beneath + plum text +
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
  **plum-filled monogram mark** (white text inside) + Inter 700 company
  name + mono 10px "ERP PLATFORM" eyebrow.
- Items grouped into **workflow directories**: `SALES`, `DELIVERY`,
  `OPERATIONS`, `FINANCE`, `PEOPLE`. Section labels are clean uppercase
  Inter eyebrows — no monospace, no glyph prefix.
- **Active item is a solid plum fill** with white text + 600 weight. No
  rail. (This is the biggest visual change from the previous direction
  and the strongest Odoo nod in the system.)
- Hover: light `surface-2` tint.
- Footer: surface-2 band with a plum-filled avatar circle (white initials)
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
   (plum primary, cool surface, friendlier radii).
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
