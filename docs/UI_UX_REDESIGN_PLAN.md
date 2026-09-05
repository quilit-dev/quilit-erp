# Warm Graphite — applying the console look without a rewrite

Revision of the original plan (kept at `UI_UX_REDESIGN_PLAN.codex-original.md`).
The visual target is unchanged: the restrained, dense, warm-graphite operations
console from the reference. What changes is **how it is reached**.

The original proposed 7 phases across 44 routes and 181 files, gated on a test
suite and a visual-regression matrix that do not exist here. This plan reaches
the same look by editing the token layer first, because measurement shows the
token layer already carries most of it.

---

## 1. Why the original plan had to change

Five problems, each with the evidence that settles it.

**1. The safety net it was gated on does not exist.** Its rule was "each
migration batch must pass the existing frontend test suite." But **44 of the 65
frontend test files (68%) assert against raw source text** — `import src from
'../pages/X.jsx?raw'` then `expect(src).toContain(...)`, 616 such assertions
against only 30 `render()` calls. Those break on cosmetic edits and prove
nothing when they pass. Gating a visual rewrite on them produces a suite that
goes red constantly and is then edited to match whatever the code now says.

**2. The visual-regression matrix was unimplementable.** It required every route
at two widths, every dialog, nine states, light/dark × EN/AR. There is **no
Playwright, Percy, Chromatic or Storybook** in `package.json`. Nothing could
capture or diff those screenshots.

**3. It ignored that the tokens already do the work.** Measured in
`frontend_src/src`:

| Measure | Count |
|---|---|
| `var(--token)` uses in pages + components | **2,010** |
| Hardcoded hex colours | 544 |
| Hardcoded `rgb()` / `rgba()` | 48 |
| Radius tokens already defined | `--r-xs` … `--r-xl` |
| Shadow tokens already defined | `--shadow-xs` … `--shadow-xl` |
| `box-shadow` declarations centralised in `index.css` | 48 |

**~78% of colour already resolves through the token layer**, and radius and
shadow are tokenised too. The palette lives in one `:root` block
(`index.css:123–331`) with a matching `[data-theme="dark"]` block at 332, and it
already ships compatibility aliases (`--green: var(--affirm)`). A palette change
is therefore a **single-file edit that reaches all 44 routes at once** — not a
181-file campaign.

**4. Its palette fails the accessibility bar it set for itself.** Section 2 of
the original says not to copy "extremely low-contrast text that would fail WCAG
requirements". Its own token table then specifies exactly that. Computed against
its own backgrounds:

| Token | Value | On `#171310` | On surface `#211B18` | Needs | Verdict |
|---|---|---:|---:|---:|---|
| Tertiary text | `#7F756F` | 4.11 | 3.79 | 4.5 | **fails** |
| Strong border | `#584A44` | 2.18 | 2.01 | 3.0 | **fails as a control boundary** |
| Primary text | `#F2EEE9` | 15.99 | — | 4.5 | passes |
| Secondary text | `#B1A8A1` | 7.90 | — | 4.5 | passes |
| Danger | `#C9605A` | 4.66 | — | 4.5 | passes (narrowly) |

Tertiary is specified for "metadata and helper copy" — real content, so 4.5 is
required. The border figure only matters where a border *is* the control
boundary (inputs, buttons), per WCAG 1.4.11; a row divider may stay faint.
Corrected values are in §3.

**5. It was all-or-nothing on a live system.** Its completion criteria required
every route migrated before it counted as done, with phases 3–6 covering every
module. That guarantees months during which the app looks like two apps. Three
tenants use this daily.

There was also a **direct conflict it did not resolve**: `DESIGN_SYSTEM.md`
documents "Workspace" — plum accent, 8px radii, soft card shadows, light-first —
and the original plan specifies the opposite on every one of those points while
leaving that file untouched. Applying it as written would have silently made the
committed design documentation wrong.

---

## 2. What stays from the original

It was not wrong about everything. Kept verbatim in spirit:

- **The safety boundaries (its §4).** No backend file, no API signature, no
  route, no permission gate, no translation key, no handler semantics. Adopted
  here as standing policy, not just for this work.
- **The visual target.** Warm near-black, borders over shadows, low radii, dense
  aligned tables, tabular numerals, sparing semantic colour, no decorative
  gradients or glass.
- **The primitive vocabulary.** `Panel`, `PageMasthead`, button roles,
  `StatusBadge`, a shared table system. These are real debt: 3,307 inline style
  objects exist because there is no shared vocabulary to reach for.
- **The traceability matrix (its §15).** Useful as a checklist of what exists.

---

## 3. Design decisions

**The identity evolves; it is not replaced.** `DESIGN_SYSTEM.md` is rewritten in
the same commit as the tokens, so the documented system and the shipped system
never disagree. "Workspace" becomes "Workspace — Graphite". No second competing
document.

**Dark is the faithful rendition; light is not abandoned.** The reference is
dark and that is what the graphite dark theme becomes. But this ERP prints
invoices and is used in daylight offices, so **the existing theme preference
stays the default** — nobody is force-switched. The light theme becomes a warm
neutral counterpart sharing the same structure: same radii, same border-led
hierarchy, same density.

**Print is explicitly protected.** `index.css` currently has **zero `@media
print` blocks**; printing is handled inside `pages/Finance.jsx` and
`pages/pos/ReceiptModal.jsx`. Before any palette change, a print guard is added
(§5, Stage 0) forcing white ground and black text for documents, so a dark theme
can never reach paper or a customer's PDF.

**Corrected palette — dark.** Contrast verified against `#171310` (app),
`#211B18` (panel) and `#2B2421` (nested):

| Role | Value | Change from original | Ratio |
|---|---|---|---|
| App background | `#171310` | — | — |
| Primary surface | `#211B18` | — | — |
| Secondary surface | `#2B2421` | — | — |
| Primary text | `#F2EEE9` | — | 15.99 |
| Secondary text | `#B1A8A1` | — | 7.90 |
| **Tertiary text** | **`#988C85`** | **was `#7F756F`** | 5.65 / 5.20 / 4.67 — all pass |
| Row divider | `#403632` | unchanged, decorative only | — |
| **Control boundary** | **`#846F66`** | **was `#584A44`** | 3.91 / 3.60 — passes 1.4.11 |
| Success | `#35A36B` | — | 5.81 |
| Warning | `#D28B45` | — | 6.61 |
| Attention | `#E7C84B` | — | 11.22 |
| Danger | `#C9605A` | — | 4.66 |
| Information | `#6E91B8` | — | 5.63 |

Two border tokens now exist deliberately: a faint one for dividers and a
3:1 one for anything that outlines an interactive control.

**Radius.** `--r` 8px → 5px, `--r-sm` 6px → 4px, `--r-lg`/`--r-xl` → 7px for
dialogs. Token edits; every consumer inherits.

**Shadows.** The 48 centralised `box-shadow` declarations collapse to borders;
`--shadow-lg`/`--shadow-xl` survive for menus, dialogs and the command palette
only.

---

## 4. The sequence

Four stages. **Every stage is independently shippable and independently
revertible.** No stage depends on a later one landing.

### Stage 0 — the rig (no visual change)

Nothing here changes a pixel; it makes the later stages checkable.

1. **Screenshot baseline.** Drive the real app in the browser on a scratch DB
   and capture a fixed route list — dashboard, invoices, POS register, POS
   checkout, purchases, inventory, accounting, reports, settings, a print
   preview, plus one modal and one empty state — at 1440px and 390px, in both
   themes and both languages. Stored as the before/after reference. This needs
   no new dependency.
2. **Print guard.** Add the `@media print` block that forces documents to white
   ground / black ink regardless of theme, and a test asserting it exists.
3. **Contrast test.** A unit test that parses the token block and asserts every
   text-on-surface pair clears 4.5 and every control boundary clears 3.0. This
   makes §3's table permanent instead of a one-off check, and it is the one
   piece of the original's accessibility ambition that can be automated cheaply.
4. **Token inventory test.** Assert no *new* hardcoded hex appears in
   `pages/` or `components/` beyond the current 544, so the mop-up in Stage 2
   only ever moves downward.

**Ships:** a guard rail. **Risk:** none — no runtime code changes.

### Stage 1 — the palette (the stage that delivers the look)

Edit `index.css`'s `:root` and `[data-theme="dark"]` blocks, plus radius and
shadow tokens. Rewrite `DESIGN_SYSTEM.md` in the same commit.

This is where the reference look actually arrives. **It touches no JSX**, which
means:

- **it breaks none of the 44 source-grep test files** — the reason to do it
  first is precisely that the weak suite cannot obstruct it;
- it reaches all 44 routes simultaneously, so the app is never half-migrated;
- reverting is one file.

**Ships:** ~78% of the visual change. **Risk:** low and uniform — if it looks
wrong it looks wrong everywhere at once and is reverted in one commit.

**Verification:** full vitest run (expected to pass untouched), lint,
`npm run build:all` at the repo root — *not* `frontend_src`, because Vite wipes
`static/` and the manual must be rebuilt after it — then the Stage 0 screenshot
set recaptured and compared route by route.

### Stage 2 — the bounded mop-up

After Stage 1 the outliers are visible: the 544 hardcoded hex, 244 inline
literal `borderRadius`, and 21 untokenised `boxShadow` values that did not move
with the tokens. This is a **finite, countable list**, and it is concentrated:

| File | Hardcoded hex |
|---|---:|
| `pages/finance/charts.jsx` | 31 |
| `pages/finance/modals.jsx` | 29 |
| `pages/reports/charts.jsx` | 24 |
| `components/shared.jsx` | 19 |
| `pages/recruitment/OfferForm.jsx` | 17 |
| `pages/HRActivities.jsx` | 16 |
| `pages/pos/ReceiptModal.jsx` | 14 |
| `pages/RoleManagement.jsx` | 13 |

The top 8 files hold 163 of 544 (30%); charts are the worst offenders because
chart colours were written as literals. Work descends this list. Each file is
one commit, verified by its own tests plus a screenshot of its route.

`pages/pos/ReceiptModal.jsx` is handled **first and separately** — it prints, so
its colours must resolve to print-safe values, not theme tokens.

**Ships:** consistency. **Risk:** low, per-file, and each commit is small enough
to eyeball.

### Stage 3 — shell and primitives

Only now the structural work: `Sidebar.jsx` (405 lines), the top utility bar, a
new shared `PageMasthead`, and the button / panel / table / badge primitives in
`components/shared.jsx` (782 lines).

This is the first stage that **changes JSX**, so the test problem becomes real.
The rule for it:

> Before a component's markup is changed, it gets a behavioural `render()` test
> covering what it must still do — renders, is clickable, respects its
> permission gate, fires its handler with the same arguments. Only then is its
> markup touched.

That is a bounded obligation — roughly a dozen components — not the 44-file
conversion the original implied. The source-grep tests for these specific
components are replaced by the new render tests rather than edited to match.

`PageMasthead` is introduced **additively**: it is adopted by pages as they are
touched, and pages that have not adopted it keep their current header. No page
is forced to change to let another page change.

**Ships:** the reference's navigation and page grammar. **Risk:** moderate,
which is why it is last among the required stages and why the render tests come
first.

### Stage 4 — per-page recomposition (opportunistic, never a campaign)

The original's phases 3–6. **Not scheduled.** When a page is being edited for a
real reason, its buttons and panels convert to the primitives at that time. The
inline-style count falls where work is already happening and already being
tested.

Explicitly excluded from "done": the redesign is complete at the end of Stage 3.
Stage 4 has no completion criterion because it is maintenance, not a project.

---

## 5. Safety rules that apply to every stage

1. No file under `backend/` is touched. A frontend commit containing one is
   wrong by construction.
2. No change to `api/client.js` function signatures, request shapes, or response
   handling.
3. No route added, removed, or re-pathed in `App.jsx`; the catch-all and both
   public-document URL shapes are preserved.
4. Every `can(...)` / `has(...)` gate, `RequireAuth`, `RequireAdmin`,
   `RequireUserManager`, and the password/setup gates keep their exact
   behaviour.
5. Every `onClick` / `onSubmit` keeps its handler and its arguments. Presentation
   may move a handler into a shared component; it may not change what it calls.
6. No translation key is removed, and no hardcoded English replaces a `t()` call.
   `t()` returns the raw key when it is missing, so a typo shows as a key on
   screen rather than throwing — meaning a missing key is a *silent* defect and
   must be checked in both languages.
7. Arabic and RTL are checked, never assumed. Footer button order in particular
   is visual, not logical.
8. Print output is verified after any stage that changes colour.
9. Line endings and BOM are preserved per file — this repo mixes CRLF, LF and
   one BOM file, and a naive rewrite turns a two-line change into a whole-file
   diff.
10. Nothing is pushed without explicit permission. `main` auto-deploys to three
    live tenants.

---

## 6. Verification per stage

Run every time, in this order:

```
npm run lint                    # in frontend_src
npx vitest run                  # 1133 tests, currently all passing
npm run build:all               # AT THE REPO ROOT — rebuilds the manual after Vite wipes static/
```

Then the visual pass: recapture the Stage 0 route set and compare. Then, for any
stage touching JSX, drive the real flows in the browser on a scratch DB — ring a
POS sale, open the checkout modal, print a receipt, page a table, open a
right-to-left screen — and restore the demo DB afterwards.

**Rollback:** each stage is one or a few commits on top of a green tree. Stage 1
in particular is a single file. Nothing here requires a migration, so there is no
data state to unwind.

---

## 7. What this plan does not promise

- It does not claim the existing test suite protects a visual refactor. It does
  not; Stage 1 is sequenced first specifically because it sidesteps that, and
  Stage 3 adds real tests before it needs them.
- It does not produce a pixel-identical copy of the reference. That is a
  feature-flag console; this is an ERP with forms, documents and printing.
- It does not touch the 3,307 inline style objects as a project. Most of them
  are layout, not colour, and Stage 1 changes the look without them.
- It sets no deadline for Stage 4, because a maintenance habit with a deadline
  becomes a campaign, which is what this revision exists to avoid.

---

## 8. Recommended first move

Stage 0 then Stage 1, as two commits. That is the whole visual change to
evaluate, on every screen, with the option to revert by reverting one file — and
it is reachable without writing a single new component.
