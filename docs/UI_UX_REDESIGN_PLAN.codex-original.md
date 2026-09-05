# ERP frontend redesign plan

## 1. Objective

Redesign the ERP frontend into a restrained, dense, dark operations console inspired by the supplied reference dashboard while preserving every existing backend contract and business workflow.

The redesign is frontend-only. It must not change API URLs, request payloads, response interpretation, permissions, module licensing, routing semantics, audit behavior, accounting rules, state transitions, translation keys, or persisted business data.

The finished product should feel like one coherent operational workspace rather than a set of separately styled modules. Every screen must remain usable in English and Arabic, light and dark themes, desktop and mobile layouts, keyboard navigation, and permission-restricted states.

## 2. Reference design analysis

The reference image is defined by these characteristics:

- A warm near-black application shell rather than pure black.
- A narrow, visually quiet sidebar with a logo, environment selector, grouped navigation, help, and account controls.
- One pale inverse active-navigation row; inactive rows remain almost flat.
- A compact top utility area containing breadcrumbs, small icon controls, one outlined action, and one high-emphasis action.
- Tight typography with modest page titles, muted metadata, and tabular numeric values.
- Low-radius panels composed with borders and tonal surface differences instead of large shadows.
- Dense metric bands that use aligned columns and thin separators.
- Segmented status visualizations made from repeated narrow bars.
- Tables and lists embedded directly in bordered panels, with clear row dividers and minimal decoration.
- Semantic color used sparingly: green for success, amber/yellow for warning or attention, red for failure or danger.
- Small controls and dense spacing on desktop, while preserving larger invisible hit areas for accessibility.
- Almost no gradients, floating cards, decorative illustrations, or oversized empty areas.

Elements not to copy literally:

- Product names, wording, logos, labels, and sample data.
- The outer photographed device frame and textured background.
- Extremely low-contrast text that would fail WCAG requirements.
- Tiny pointer targets from the screenshot; visual controls may be compact but their hit areas must remain at least 44 by 44 CSS pixels where practical.
- Fixed desktop-only proportions that would fail in Arabic or on smaller screens.

## 3. Current frontend audit

### 3.1 Scope found in the repository

- React 18 and React Router 6, built with Vite.
- 43 route declarations, including public-document variants, vendor-console aliases, and the fallback route.
- 157 JSX files in the pages tree and 24 shared JSX components.
- 181 page/component JSX files in the presentation inventory.
- 739 explicit button instances.
- 145 table instances.
- 56 forms, 330 inputs, and 6 native selects; most selection is handled by shared searchable controls.
- 187 inline SVG instances.
- 3,307 inline style objects.
- A 4,045-line global stylesheet.
- Existing English/Arabic localization, RTL support, light/dark themes, permissions, module gating, branch context, command palette, notifications, rate book, and frontend tests.

### 3.2 Strengths to preserve

- Route-level lazy loading and error containment.
- Permission-aware and module-aware UI visibility.
- Existing centralized theme variables.
- Shared loading, error, empty, modal, badge, pagination, currency, export, and confirmation components.
- Existing responsive sidebar behavior.
- Existing deep links for clients, projects, notifications, documents, and focused records.
- Existing keyboard command palette.
- Existing locale-sensitive money, dates, translations, and Arabic font.
- Existing frontend regression coverage for financially and operationally sensitive workflows.

### 3.3 Main redesign risks

- The large number of inline styles makes visual rules difficult to update consistently.
- Some high-density pages define their own visual vocabulary rather than relying on shared primitives.
- Repeated inline SVGs make icon size, alignment, stroke width, and accessibility inconsistent.
- Several pages use emoji in empty or permission states; these do not match the reference or a professional ERP icon system.
- Similar controls use different tab, button, card, and page-header implementations.
- Large forms and tables can overflow or become cramped at tablet widths.
- A visual rewrite performed page by page before stabilizing primitives would cause regressions and duplicated CSS.

## 4. Non-negotiable safety boundaries

1. Keep `frontend_src/src/api/client.js` function signatures and endpoint behavior unchanged.
2. Do not change backend files, database models, migrations, routers, permissions, or business logic.
3. Preserve every route in `App.jsx`, including `/platform`, both public document URL shapes, and the catch-all behavior.
4. Preserve all `can(...)`, `has(...)`, `RequireAuth`, `RequireAdmin`, `RequireUserManager`, and password/setup gates.
5. Preserve every existing `onClick`, `onSubmit`, state transition, mutation call, export function, print function, and navigation destination.
6. Presentation refactors may move existing handlers into shared components, but their invocation and arguments must remain equivalent.
7. Keep English and Arabic translation keys; no hardcoded English may replace translated content.
8. Preserve record focus and query-string behavior used by existing deep links.
9. Do not introduce a new component framework. Build on the current React/CSS stack.
10. Each migration batch must pass the existing frontend test suite and production build before the next batch begins.

## 5. Target design system

### 5.1 Visual identity

Working style name: **Warm Graphite Operations Console**.

The interface should look precise, calm, and operational. It should not look futuristic, neon, glass-heavy, playful, or like a generic AI dashboard.

### 5.2 Color tokens

Dark mode is the reference-matching default visual target. Light mode remains supported as a warm neutral counterpart.

| Role | Dark target | Light counterpart | Usage |
|---|---:|---:|---|
| App background | `#171310` | `#F3F0EC` | Main canvas |
| Sidebar background | `#0F0D0B` | `#E9E5E0` | Persistent navigation |
| Primary surface | `#211B18` | `#FCFAF7` | Main panels |
| Secondary surface | `#2B2421` | `#F2EDE8` | Headers, filters, nested areas |
| Raised surface | `#352C28` | `#FFFFFF` | Menus, dialogs, active panels |
| Subtle border | `#403632` | `#D8D0C9` | Panel and row boundaries |
| Strong border | `#584A44` | `#BCAFA5` | Focused or selected boundaries |
| Primary text | `#F2EEE9` | `#211D1A` | Titles and values |
| Secondary text | `#B1A8A1` | `#5E5650` | Body and labels |
| Tertiary text | `#7F756F` | `#81766E` | Metadata and helper copy |
| Inverse control | `#E9E5E0` | `#211D1A` | Primary button and selected nav |
| Inverse text | `#171310` | `#FFFFFF` | Text on inverse control |
| Success | `#35A36B` | `#147A48` | Completed and healthy states |
| Warning | `#D28B45` | `#A35C18` | Delayed and partial states |
| Attention | `#E7C84B` | `#806A00` | Requires review |
| Danger | `#C9605A` | `#A63834` | Failure and destructive actions |
| Information | `#6E91B8` | `#35658E` | Neutral informational state |

All component styles must consume semantic variables. Existing aliases such as `--green`, `--red`, and `--accent` can remain during migration, but must map to the new semantic set. Raw status hex values in page files must be eliminated gradually.

### 5.3 Typography

- Retain local Inter for English and Cairo for Arabic to avoid new font downloads and preserve Arabic coverage.
- Retain JetBrains Mono for amounts, identifiers, dates, codes, transaction numbers, and compact metrics.
- Page title: 20px, 650 weight, 1.2 line height, slight negative tracking.
- Panel title: 13px, 600 weight.
- Body: 13px on desktop, 14px on touch layouts, 1.5 line height.
- Labels and metadata: 11–12px with careful contrast, never below 11px for meaningful content.
- Large KPI value: 22–28px with tabular figures.
- Table values: 12.5–13px, tabular figures for numeric columns.
- Use sentence case throughout. Avoid uppercase except short codes and compact technical labels.

### 5.4 Spacing and dimensions

- Base spacing scale: 4, 8, 12, 16, 20, 24, 32, 40.
- Desktop sidebar: 208px; collapsed sidebar: 64px.
- Top utility bar: 48px.
- Desktop page gutters: 20px at 1024–1439px, 24px at 1440px and above.
- Maximum content width: none for operational tables; 1480px for composed dashboard content.
- Panel radius: 5px; nested controls: 4px; dialogs: 7px.
- Desktop row height: 38–42px; comfortable-density option: 46–50px.
- Form controls: 36px visual height on desktop, minimum 44px interactive height on touch layouts.
- Icon sizes: 14px compact, 16px standard, 18px emphasized, 20px mobile navigation.

### 5.5 Borders, elevation, and texture

- Use one-pixel borders and tonal separation as the default hierarchy.
- Eliminate routine card shadows.
- Reserve a single deep shadow token for menus, dialogs, and command palette overlays.
- Use a subtle, non-distracting noise texture only on the application background at very low opacity.
- Never use blur as decorative glass. Blur is limited to modal scrims or temporary overlays.

### 5.6 Motion

- Hover/focus transitions: 120–160ms.
- Dialog and drawer entry: 180–220ms; exit approximately 140ms.
- Use opacity and transform only.
- Button press: one-pixel translation or 0.98 scale without moving adjacent layout.
- Tab content: short crossfade, no sliding carousels.
- Disable nonessential motion under `prefers-reduced-motion`.
- Do not add chart animation that delays comprehension.

## 6. Global application shell

### 6.1 Sidebar

- Keep the current permission- and module-filtered navigation logic.
- Replace the wide card-like navigation with a narrow flat list.
- Group items under quiet section labels reflecting the ERP information architecture: Overview, Sales, Operations, Finance, People, Administration.
- Active row uses the reference’s pale inverse treatment with dark icon and text.
- Inactive rows use muted text, transparent backgrounds, and a faint hover fill.
- Standardize every navigation icon through the existing shared `Icon` abstraction at 15–16px and 1.75px stroke.
- Keep branch selection near the top as a compact environment-style selector.
- Keep Help/Manual and account controls pinned to the bottom.
- Preserve unread badges, licensing visibility, branch switching, and account-menu actions.
- Add collapsed desktop state with tooltips; persist the preference locally.
- On mobile, retain drawer behavior, add focus containment, and restore focus to the menu button on close.

### 6.2 Top utility bar and page masthead

- Top bar contains mobile menu, breadcrumb path, command search, rate book, notifications, problem report, language, and theme controls.
- Remove duplicated page identity between top bar and page body by introducing one shared `PageMasthead`.
- `PageMasthead` contains breadcrumb, title, compact subtitle/status metadata, and right-aligned actions.
- A page gets at most one primary action in the masthead.
- Secondary actions use outline or text treatment and move into an overflow menu when space is constrained.
- Search remains keyboard-accessible through Ctrl/Cmd+K.
- Icon-only utilities receive labels, 44px hit areas, visible focus rings, and consistent tooltips.

### 6.3 Main content behavior

- Use a stable CSS grid rather than scattered inline width calculations.
- Tables may use full available width; narrative settings and forms use controlled reading widths.
- Preserve scroll position and filter state on back navigation.
- Never create nested vertical scroll areas inside the main page unless the component is a deliberate fixed-height picker.

## 7. Shared component redesign

### 7.1 Buttons

Every one of the 739 button instances maps to one of these roles:

- `ButtonPrimary`: pale inverse fill, dark text; used once per screen for the main safe action.
- `ButtonSecondary`: dark tonal fill and border; used for ordinary actions.
- `ButtonQuiet`: transparent, muted text; used for low-priority utilities.
- `ButtonDanger`: muted danger text/border or danger fill for final destructive confirmation.
- `IconButton`: compact visible glyph with a larger hit target and accessible name.
- `SegmentButton`: used for tabs, view modes, currency, and time range.
- `SplitButton` or overflow menu: used where one record has more than two secondary actions.

Rules for all buttons:

- Preserve the current handler, type, disabled state, loading state, permission gate, and translated label.
- Loading buttons retain their width, disable repeated submission, and show inline progress.
- Destructive controls remain spatially separated from safe actions.
- No action may depend on color alone.
- Buttons in table rows must not cause row height changes on hover.

### 7.2 Panels and cards

- Replace decorative cards with `Panel`, `PanelHeader`, `PanelBody`, `MetricStrip`, and `SplitPanel` primitives.
- Panels use square-to-low-radius corners, borders, and tonal headers.
- Remove nested cards where simple sections and dividers communicate hierarchy.
- Make panel headers align title, metadata, segmented controls, and actions on one baseline.

### 7.3 Tables

All 145 table instances adopt a shared table system:

- Sticky low-contrast header where the table is long.
- 38–42px desktop rows, consistent horizontal padding, tabular numeric alignment.
- First column carries identity; final column carries actions.
- Row hover uses a single subtle surface tint.
- Selected rows use a left marker plus tonal fill, not color alone.
- Sorting uses `aria-sort`, visible direction glyphs, and keyboard controls.
- Filters and export controls sit in a `TableToolbar` above the panel.
- Empty, loading, error, and no-filter-results states occupy the table panel rather than appearing as detached cards.
- On narrow screens, high-value columns remain visible and secondary columns move into a row detail disclosure. Financial tables may use controlled horizontal scrolling with sticky identity and totals columns.

### 7.4 Forms

- Convert repeated inline layouts into `FormSection`, `FieldGrid`, `Field`, and `FormFooter`.
- Keep labels visible; placeholders never act as labels.
- Validate on blur and place errors directly below fields.
- Focus the first invalid field after submission.
- Long forms are grouped into titled sections with concise descriptions.
- Read-only values use a distinct read-only surface rather than disabled-control styling.
- Required state, helper text, currency, date format, and branch scope are visible before entry.
- Sticky form footers are used only for long dialogs and pages; they must not obscure content.

### 7.5 Dialogs, drawers, and popovers

- Small confirmations and destructive prompts remain centered dialogs.
- Record creation/editing forms become right-side drawers on desktop and full-height sheets on mobile when this does not change workflow semantics.
- Complex transactions such as checkout, payment plans, BOM editing, payroll, and purchase/invoice editing remain large dialogs or dedicated workspaces.
- Every overlay gets a labelled title, close button, Escape behavior, focus trap, initial focus, focus restoration, unsaved-change protection, and scroll lock.
- Footer order remains Cancel on the low-emphasis side and the primary action on the high-emphasis side; RTL visual order must be tested rather than assumed.
- Popovers such as notifications, rate book, account menu, action menu, and search select share one elevation, border, radius, spacing, and dismissal model.

### 7.6 Status and badges

- Replace unrelated colored pills with a shared `StatusBadge` and `StatusDot` system.
- Use square or softly rounded badges rather than fully pill-shaped labels for ordinary statuses.
- Success, warning, danger, neutral, info, archived, draft, and pending each have text and icon/dot semantics.
- Numeric notification counts may remain circular where the shape communicates a count.

### 7.7 Charts

- Retain the existing custom SVG approach initially; do not add a chart dependency solely for visual changes.
- Trends use thin line charts; category comparison uses sorted bars; composition uses stacked bars or donuts only when categories are five or fewer; performance against targets uses bullet bars.
- Use the reference’s segmented micro-bar pattern for operational state distributions and compact health indicators.
- Remove heavy fills, gradients, oversized legends, and decorative animations.
- Provide exact values, time range, unit labels, keyboard-reachable tooltips, and a table or text summary.
- Use patterns, line styles, labels, or shapes in addition to color.
- All chart loading, empty, and error states reserve the same dimensions to prevent layout shift.

### 7.8 Cross-cutting states

- Replace emoji empty-state icons with the shared SVG icon set.
- Skeletons match the final panel/table shape.
- Error states name the failed operation and provide Retry where safe.
- No-results states preserve active filters and offer Clear filters.
- Permission-denied and module-unavailable states explain why the screen is unavailable and provide a valid return path.
- Success feedback uses a concise toast and never shifts page layout.

## 8. Page-by-page redesign specification

### 8.1 Setup, authentication, and public surfaces

#### `/setup` — Setup

- Use a centered, bordered setup workspace on the warm graphite background.
- Add a compact brand header, numbered progress rail, current-step title, and persistent completion context.
- Group company, administrator, and configuration fields into clear steps without changing submissions.
- Primary button: Continue/Finish. Secondary button: Back. Destructive/reset actions remain separated.
- Preserve both existing forms, setup-status behavior, validation, and post-setup navigation.
- On mobile, the progress rail becomes a compact step counter above the form.

#### `/login` — Login

- Use a two-region desktop composition: narrow brand/context rail and focused login panel; collapse to one panel on mobile.
- Keep company code, username, password, server/offline states, language, theme, and submit behavior intact.
- Primary button spans the form width; secondary environment/server actions remain quiet.
- Display errors inline above the first affected field and retain keyboard/autofill behavior.

#### `/force-change-password` — Required password change

- Match the login shell to preserve continuity.
- Present password rules as a compact checklist with live satisfied/unsatisfied states.
- Preserve submit and logout/back actions and prevent accidental dismissal.

#### `/d/:token` and `/d/:label/:token` — Public document

- Do not apply the internal sidebar or operations shell.
- Preserve the document’s print identity and company branding.
- Add a quiet top document bar containing document type/number, print/download, and verification status.
- Ensure invoice/quotation body, totals, terms, and mobile reading order remain print-safe.
- The single action remains visually secondary to the document itself.

### 8.2 Global dashboard and communication

#### `/` — Dashboard

- Recompose into the reference’s hierarchy: masthead, attention strip, primary metric band, operational distribution, split information panels, and recent activity.
- Greeting and period selector remain in the masthead.
- “Needs attention” becomes a thin horizontal signal rail with count, severity, and destination.
- Revenue, expenses, and profit become aligned metric cells in one `MetricStrip`; health becomes a segmented status visualization rather than a floating circular card where possible.
- Operations Today, Pipeline & Growth, and secondary operational metrics become compact bordered grids, not independent elevated cards.
- Revenue/expense history uses a thin two-series bar or line chart with a visible legend and accessible summary.
- Insights become a ranked exception list with severity markers and destination arrows.
- Recent projects, invoices, and upcoming agenda become two-column split panels with consistent row heights.
- Every existing navigation click and permission/module gate remains unchanged.

#### `/communications` — Communications

- Use masthead plus status/filter toolbar and one communication-log panel.
- Show channel, recipient, related record, subject, delivery state, timestamp, and failure reason in aligned columns.
- Row detail opens a side drawer containing message content, share status, and related-document link.
- Existing resend/share/history behavior remains intact; dangerous revoke actions require confirmation.

#### `/notifications` — Notifications

- Replace the broad page with a compact notification inbox inspired by an operations event stream.
- Tabs remain All, Unread, Finance, Inventory, CRM, HR, Approvals, and Tasks.
- Each row shows state dot, concise title, supporting text, source module, timestamp, and destination affordance.
- Keep Mark read, Mark all read, Clear, and navigation behavior; bulk actions live in the toolbar.
- Unread status uses weight and a marker, not background color alone.

#### `/announcements` — Announcements

- Keep Inbox and Sent tabs with unread count.
- Compose/search action is the only primary action.
- `ComposeForm` becomes a structured drawer with audience, priority, title, message, schedule/options, and footer actions.
- `DetailModal` becomes a reading-focused panel with metadata, acknowledgement/read state, and appropriate edit/delete actions.
- Announcement rows use the same event-list grammar as notifications while retaining priority and audience information.

### 8.3 Sales, customer, and project workflows

#### `/clients` — Clients

- Masthead actions: Add client as primary; Import and Export as secondary.
- Filter/search controls form one compact toolbar above the table.
- Table emphasizes client identity, contact, balance/owing state, project activity, and status; row actions move into one predictable final column.
- Add/edit form uses a drawer with identity, contact, billing, terms, and branch sections.
- Preserve View, Edit, Archive/Restore, ImportWizard, pagination, sorting, and permission behavior.

#### `/clients/:id` — Client detail

- Use a record masthead with back path, client identity, contact metadata, balance status, and one primary contextual action.
- Preserve tabs: Overview, Projects, Quotations, Invoices, Payments received, and Statement.
- Overview uses a two-column facts/account-plan layout with no card nesting.
- `AccountPlan` becomes a timeline-style payment commitment panel.
- `CustomerPaymentModal` remains a focused transactional dialog with amount, currency/bank, date, reference, and confirmation summary.
- Projects, quotations, invoices, payments, and statement use shared dense tables and consistent record links.

#### `/projects` — Projects

- Masthead actions: New project primary; Export secondary.
- Summary counts use a compact strip; filters remain in a toolbar.
- Table emphasizes status, client, value, progress, dates, and risk.
- Add/edit form becomes a drawer; archive/restore remains confirmed.
- Preserve navigation to project detail and all permissions.

#### `/projects/:id` — Project detail

- Record masthead shows project identity, client, status, dates, value, and progress.
- Preserve tabs: Overview, Materials, Quotations, Invoices, and Expenses.
- Overview uses a balanced facts/financials split plus progress/activity bands.
- Materials becomes a warehouse-aware stock table; deduct material uses a focused dialog with availability context.
- Quotations and invoices share record-table visuals with the main document pages.
- Expenses uses the standard expense table and form treatment.
- Preserve all 18 actions, attachments, document opening, cost handling, and navigation semantics.

#### `/quotations` — Quotations

- Masthead actions: New quotation primary; Import/Export or document utilities secondary.
- Status counts become a segmented summary strip.
- Filters and search sit in one toolbar; quotations use a dense document table.
- Create/edit remains a large document workspace because line items require width.
- Line-item grid gets sticky headings, aligned quantity/rate/discount/tax/total columns, and a persistent totals summary.
- Keep Convert, Accept/Reject, Send, Share, Print, Archive/Restore, project conversion, attachments, and confirmation flows.
- Secondary record actions move into `ActionMenu`; high-value next action remains visible.

#### `/invoices` — Invoices

- Mirror Quotations so users recognize the quote-to-cash relationship.
- Status/aging summary becomes a segmented strip; overdue and remaining amounts receive clear semantic emphasis.
- Preserve creation/editing, line items, payments, void/unvoid, archive/restore, receipt voucher, send/share/print, attachments, and focused-record query behavior.
- `PaymentPlan` becomes a bordered schedule panel with installments, due state, paid state, add/edit/delete controls, and totals reconciliation.
- `ActionMenu` uses the global popover standard and retains every existing action.
- Payment and receipt operations remain explicit confirmation dialogs with immutable summary rows.

#### `/promotions` — Promotions

- Use a compact list/table emphasizing code/name, rule, active period, usage, and status.
- New promotion is primary; edit uses a drawer; archive/restore/delete uses confirmation.
- Replace decorative discount cards with aligned rule rows and concise status indicators.

#### `/crm` — CRM

- Preserve Dashboard, Deals/Pipeline, Leads, Contacts, and Activities tabs.
- CRM Dashboard uses metric strips plus compact conversion and activity charts.
- Pipeline remains kanban on desktop but adopts low-radius columns, compact cards, clear value/stage metadata, and accessible non-drag alternatives.
- Leads table emphasizes source, owner, value, age, and conversion state.
- Contacts table emphasizes account relationship and last activity.
- Activities use a chronological event stream with due/overdue markers.
- Add/edit/convert forms use drawers; destructive actions remain confirmed.

### 8.4 Inventory, purchasing, warehouse, POS, manufacturing, and service

#### `/inventory` — Inventory

- Masthead actions: Add item primary; Import/Export and settings utilities secondary.
- Compact metric strip covers item count, low stock, stock value, expiring lots, and reservations where available.
- Toolbar contains search, category, product type, warehouse, stock state, and archived filters.
- Table emphasizes item identity/SKU, on-hand, available/reserved, reorder state, price/cost, and status.
- `ItemForm` becomes a categorized drawer; `ProductBuilder` uses a stepwise variant builder inside the drawer.
- `StockForm` remains a focused adjustment dialog with current stock, delta, warehouse, reason, and resulting stock preview.
- `Lots` uses a nested table with expiry status and traceability.
- `MovementsModal` becomes a wide movement-history drawer/table.
- Preserve barcode/scanner behavior, custom fields, reservations, archive/restore, sorting, and pagination.

#### `/purchases` — Purchases

- Masthead actions: New purchase primary; Export secondary.
- Summary strip shows draft/ordered/received/paid/overdue or equivalent available states.
- Filters and supplier search sit in one toolbar; the main table prioritizes PO number, supplier, dates, amount, receipt/payment state, and status.
- `PurchaseForm` remains a wide line-item workspace with sticky totals.
- `PayoutModal` shows payable amount, previous payments, remaining balance, bank/cash destination, currency, reference, and final effect.
- Preserve receive, pay, status changes, void/archive/restore, supplier history, attachments, taxes, costing, and inventory effects.

#### `/suppliers` — Suppliers

- Mirror Clients for familiarity while emphasizing purchasing context.
- Table shows identity, contact, purchase volume, payable balance, last purchase, and state.
- Add/edit uses a drawer; ImportWizard and Export remain toolbar actions.
- Supplier history opens a wide detail drawer with purchases and payments.
- Preserve archive/restore, permissions, sorting, and pagination.

#### `/warehouses` — Warehouses

- Preserve Warehouses, Transfers, and Access tabs.
- Warehouses tab uses a dense list with location, default state, stock value/count, and actions.
- `StockAtWarehouseModal` becomes a wide inventory drawer with search, availability, and valuation columns.
- Transfers tab uses a status pipeline for draft/dispatched/received/cancelled plus a transfer table.
- Transfer creation/edit uses a two-location form with item rows and availability warnings.
- Access tab uses a user-by-warehouse matrix with explicit inherited/direct access states.
- Preserve branch scoping and permission rules exactly.

#### `/pos` — Point of sale

- POS is an operational exception to the standard page density: touch targets stay large and the register remains task-focused.
- Preserve Register, Sessions, History, and Waiting tabs.
- `OpenRegisterPanel` becomes a focused opening-balance surface.
- `RegisterView` uses a stable two-column desktop grid: searchable/scannable item area and persistent cart/checkout summary.
- Product buttons and cart controls remain at least 44px high; barcode focus must never be lost after routine actions.
- `CheckoutModal` remains a large transaction dialog with amount due, tenders, change, customer, installments, and final confirmation.
- `ReceiptModal` uses print-preview styling; `SaleDetailModal` uses a transaction audit layout.
- `CloseRegisterModal` shows expected, counted, variance, and confirmation clearly.
- History, Sessions, and Waiting use the shared table/list system.
- Preserve amend, return, hold/wait, receipt, invoice printing, installments, and all current tests.

#### `/manufacturing` — Manufacturing

- Preserve Orders, BOMs, Quality Control, Resources, and Analytics tabs.
- Six KPIs become one metric strip with aligned production states and values.
- Orders use a status-segment summary plus dense table; `OrderModal`, `OrderDetailModal`, and `CompleteModal` retain all state-transition logic.
- BOMs use master/detail composition; `BomModal` remains a wide editor and `BomDetailModal` becomes a read-focused drawer with version history, components, resources, and cost.
- QC uses a review queue with defect severity and resolution state; `QCResolveModal` clearly separates disposition, rework, scrap, and notes.
- Resources use a compact capacity/cost table and drawer form.
- Analytics uses thin trend lines, sorted bars, and segmented state distributions with text summaries.

#### `/service` — Service

- Preserve Jobs and Equipment views.
- Masthead changes primary action based on the active view; Export remains secondary.
- Jobs table emphasizes number, client, equipment, status, technician, promised date, and value.
- Equipment table emphasizes asset identity, customer, serial, service status, and last/next service.
- `JobForm` and `EquipmentForm` become structured drawers.
- `WriteUp` becomes a full-width work-order summary with labor, parts, findings, customer approval, and billing readiness.
- Preserve status changes, parts usage, invoice/document actions, archive/restore, and confirmations.

### 8.5 Finance, accounting, cash, assets, expenses, and reports

#### `/finance` — Finance overview

- Match the reference most closely: date/branch filters, metric band, full-width trend, paired comparison/composition panels, monthly table, category distribution, and insights.
- Revenue, expenses, profit, and margin use aligned metric cells rather than separate floating cards.
- `FinanceLineChart` uses two thin labelled series; `ProfitBarChart` uses positive/negative baseline bars; `DonutChart` is retained only for five or fewer categories, otherwise use sorted horizontal bars.
- Monthly rows remain clickable; `MonthDrillModal` becomes a wide drill-down drawer with clear return path.
- `SmartInsightsPanel` becomes a ranked exception/recommendation panel with evidence values.
- `ReconciliationModal` remains a high-attention financial workspace with issue groups and resolution state.
- Preserve date range, branch, currency, exports, and all financial calculations.

#### `/accounting` — Accounting

- The current 12 tabs exceed a comfortable single row. Replace them with a compact secondary navigation rail or grouped tab menu while preserving URL/query behavior.
- Groups: Overview; Ledger operations; Statements; FX; Setup and close.
- Preserve views: Overview, Accounts, Journal, Ledger, Trial Balance, Income Statement, Balance Sheet, Cash Flow, FX Differences, Chart Cutover, Revaluation, and Closing.
- Accounts uses a hierarchical chart-of-accounts table with type, balance, state, and actions.
- Journal uses a transaction list plus wide create/detail dialog with balanced debit/credit summary.
- Ledger, Trial Balance, and Statements use sticky financial tables, tabular figures, totals bands, export controls, and drill-through links.
- Cash Flow uses grouped operating/investing/financing sections.
- FX Differences and Revaluation use exception-first tables and explicit posting confirmations.
- Chart Picker/Cutover uses a guarded step process with preview and impact summary.
- Closing uses year/month status timelines and high-friction confirmation for irreversible or sensitive actions.

#### `/cash` — Cash management

- Preserve Today, History, and Drawers tabs.
- Today shows open drawer state, opening amount, inflow/outflow, expected cash, counted cash, and variance in one operations panel.
- `OpenDayModal` and close/count dialogs use strong numeric hierarchy and immutable confirmation summaries.
- History uses dense reconciliation rows; `ReconDetailModal` uses a wide audit drawer.
- Drawers uses a simple management table and drawer form.
- Preserve bank/cash routing, permissions, refresh logic, and reconciliation behavior.

#### `/expenses` — Expenses

- Masthead actions: Add expense primary; recurring/import/export actions secondary according to permissions.
- Summary strip presents total, categories, recurring state, and period context.
- Expense table emphasizes date, description, category, project, payment route, amount/currency, and status.
- Add/edit uses a structured drawer; transaction/accounting details are visible but not visually dominant.
- `RecurringExpensesPanel` becomes a split panel with schedule, next run, amount, active state, and actions.
- Preserve attachments, recurring generation, transaction linkage, filters, archive/delete behavior, and all financial side effects.

#### `/fixed-assets` — Fixed assets

- Split the page into asset register and depreciation/disposal workflow areas without altering the route.
- Metric strip shows acquisition value, accumulated depreciation, net book value, and due depreciation.
- Register table emphasizes asset, category, acquisition, method/rate, accumulated depreciation, NBV, and state.
- Add/edit asset uses a drawer; depreciation run uses a review dialog; disposal uses a high-attention transactional dialog with proceeds and gain/loss preview.
- Preserve opening balances, depreciation posting, disposal, archive/restore, and linked ledger behavior.

#### `/reports` — Reports

- Replace the long wrapping tab row with a left report selector on desktop and searchable dropdown on mobile.
- Keep the shared date-range bar sticky beneath the masthead when useful.
- Preserve Financial, Projects, Clients, Aging, Expenses, Pipeline, VAT, Warehouse Valuation, and conditional Branch Comparison reports.
- Every report receives a consistent header containing title, period, branch/currency context, export, and print where available.
- Financial report uses trend plus income/expense/profit table.
- Projects report uses status/value/progress comparison.
- Clients report uses revenue/balance/ranking bars and a sortable table.
- Aging report uses stacked aging buckets plus exact-value table.
- Expenses report uses trend and sorted category comparison.
- Pipeline report uses stage distribution and conversion flow.
- VAT report emphasizes collected, paid, net due, and source drill-down.
- Warehouse valuation uses location/item/value tables and compact comparison bars.
- Branch comparison uses grouped bars or bullet charts plus a table.
- Every chart has a text summary and exportable data alternative.

### 8.6 Planning, people, approvals, and administration

#### `/planning` — Planning

- Preserve Projects, Gantt, Board, List, and Calendar views.
- Masthead keeps New Project and New Task with one primary action based on current context.
- `ProjectsPanel` uses compact progress/status rows.
- Gantt keeps drag behavior but adds clear date scale, Today marker, accessible edit alternative, and stable sticky identity column.
- Board uses low-radius columns and compact task cards; moving tasks must remain possible without drag.
- List uses the shared sortable table.
- Calendar uses a restrained grid, clear today state, and event density indicators.
- `ProjectForm`, `TaskForm`, and `EventForm` become consistent drawers/sheets with date, owner, status, priority, and dependencies grouped clearly.

#### `/hr` — Human resources

- Six KPI cards become one metric strip.
- Preserve Employees, Payroll, Departments, Leave, and Attendance tabs.
- Employees uses a dense roster table; add/edit and `EmployeeDetail` become a record drawer with identity, employment, compensation, contract, and history sections.
- `ContractsSection` uses a timeline/table with expiry status and attachment actions.
- `PayrollRunPanel` remains a dedicated financial workflow with period, employee totals, exception review, approval, and payment status.
- Departments uses a small management table and drawer form.
- Leave becomes an approval-style queue with duration, balance, dates, reason, and status.
- `AttendanceTab` uses a date-led roster editor with clear unsaved state and sticky Save action.
- Preserve imports, permissions, employee state, payroll transitions, attendance bulk save, and confirmations.

#### `/recruitment` — Recruitment

- Preserve Pipeline, Applicants, and Positions tabs.
- KPI strip remains compact.
- Pipeline uses low-radius stage columns with candidate age, role, owner, and next action.
- Applicants and Positions use shared dense tables.
- `ApplicantDetail` becomes a wide record drawer with timeline and attachments.
- `ApplicantForm`, `PositionForm`, `InterviewForm`, `OfferForm`, and `ConvertForm` share one form/window grammar.
- Hiring/conversion remains a high-attention confirmed workflow; candidate rejection or deletion remains separated.

#### `/hr-activities` — HR activities

- Use masthead, status metric strip, filters, and a timeline/list hybrid.
- `ActivityForm` becomes a drawer grouped by type, employee/audience, owner, due date, recurrence, and notes.
- `CompleteModal` captures outcome and completion date clearly.
- Preserve create/edit/complete/reopen/archive/delete actions and permission checks.

#### `/approvals` — Approval requests

- Preserve All, Pending, Mine, Approved, and Rejected views.
- The default view becomes an exception queue: entity, requester, amount/context, current step, age, and risk cues.
- `ActionPanel` becomes a right-side review drawer showing full request context, policy path, prior decisions, comments, and related-record link.
- Approve and Reject are clearly separated; rejection requires reason where currently required.
- Preserve concurrency handling, admin override, comments, module filtering, and every workflow transition.

#### `/approval-policies` — Approval policies

- Use master/detail composition: policy table on the left or top, selected policy editor on the right or drawer.
- `PolicyForm` exposes entity/module, conditions, approval mode, roles, steps, and active state in progressive sections.
- Add policy is primary; duplicate/edit/archive/delete are secondary or danger actions.
- Preserve condition semantics, role options, step ordering, permissions, and confirmations.

#### `/users` — User management

- Use metric strip for total, active, admins, and branch-scoped users where data exists.
- Main table emphasizes identity, role, branch/access scope, status, last activity, and session/security state.
- Add/edit user uses a drawer; password/reset and deactivate/delete actions use focused confirmations.
- Preserve branch-manager restrictions, admin gates, role assignment, password behavior, sessions, archive/delete, and pagination.

#### `/roles` — Role management

- Use role list plus permission matrix rather than one visually flat page.
- Role identity and description sit in a narrow master pane; selected permissions fill the main pane.
- Permission matrix uses sticky module column, grouped capabilities, explicit inherited/selected states, and keyboard-operable checkboxes.
- Save is the single primary action; delete is isolated and confirmed.
- Preserve role constraints, admin gate, permission keys, and current mutation calls.

#### `/admin` — Administration

- Preserve Active Sessions and Activity Log tabs.
- Top metric strip shows online users, active sessions, audit volume, and relevant security status.
- Sessions table emphasizes user, device/IP, created/last seen, and revoke action.
- Audit log uses a dense event stream/table with actor, action, entity, branch, timestamp, and expandable details.
- Filters live in one toolbar; refresh remains secondary.
- Purge controls move into a separate danger panel with retention explanation and confirmation.

#### `/settings` — Settings

- Replace the very long continuous page with a two-column settings layout: sticky category navigation and one content column.
- Categories: Company & identity; Localization & currency; Inventory; Tax & banking; Documents; Backup & integrity; User manual.
- Keep all existing `Section`, `Field`, `Input`, `Textarea`, and `Toggle` data bindings.
- Company logo and identity settings show preview and recommended dimensions.
- Currency/costing controls include permanent explanatory text and current effective state.
- `InventoryFieldsManager` and `CategoriesManager` use compact editable tables.
- `TaxRatesSection` and `BankAccountsSection` use consistent management tables and drawers.
- `RateBookPanel` uses a compact rate history panel consistent with the top-bar popover.
- Backup controls remain edition-aware and are visually separated as operational maintenance actions.
- Save bar becomes sticky only when the form is dirty and always shows success/error status.

### 8.7 Vendor operations console

#### `/vendor-admin` and `/platform` — Platform console

- Preserve probe, disabled, login, and console phases.
- Use the reference layout most directly: vendor sidebar/header, Businesses, Fleet Health, and Support Inbox sections.
- Businesses uses tenant metric cells plus a dense tenant table.
- `ProvisionWizard` remains a guarded step process; `ModulePicker`, `ModuleEditor`, `LicenceEditor`, and `UserAdmin` share a consistent right-side management drawer.
- Fleet Health uses segmented environment/health bars, compact operational metrics, and tenant exception rows.
- `BusinessAnalytics` uses trend, usage, module, and support panels with drill-back continuity.
- Support Inbox uses a two-pane inbox with status, tenant, severity, last update, and conversation detail.
- Custom domains use a compact management table; Verify, Show TXT, and Remove retain their handlers and states.
- Operator password change remains a focused security dialog.

## 9. Responsive behavior

### Desktop, 1440px and above

- 208px sidebar, 48px utility bar, 24px page gutter.
- Use two-column split panels and full dense tables.
- Dialogs and drawers use their intended desktop widths.

### Compact desktop/tablet, 900–1439px

- Sidebar collapses to 64px or drawer according to available width.
- Metric strips wrap to two rows without inconsistent cell widths.
- Secondary actions move into overflow menus.
- Wide forms reduce from three to two columns.

### Mobile, below 900px

- Sidebar becomes a focus-trapped drawer.
- Masthead stacks title and actions; only the primary action remains visible, with the rest in overflow.
- Form controls are at least 44px high and body text is at least 14–16px where input zoom is a concern.
- Tables use prioritized columns plus row disclosure; financial grids use labelled controlled horizontal scrolling.
- Creation drawers become full-height sheets.
- Charts reduce tick density and place visible summary values above the visualization.

### Required viewport verification

- 375 × 667
- 390 × 844
- 768 × 1024
- 1024 × 768
- 1280 × 720
- 1440 × 900
- 1920 × 1080
- English LTR and Arabic RTL at every representative breakpoint.

## 10. Accessibility specification

- Normal text contrast at least 4.5:1; large text and meaningful graphical elements at least 3:1.
- Sequential headings and a skip-to-content link.
- Visible 2px focus ring with offset on every interactive control.
- Keyboard access to navigation, tabs, table sorting, row actions, charts, drawers, dialogs, and kanban alternatives.
- Modal focus trap and focus restoration.
- Icon-only buttons have accessible names; decorative SVGs are hidden from assistive technology.
- Status never depends on color alone.
- Toasts use polite live regions and never steal focus.
- Form errors use an error summary plus linked inline errors for complex forms.
- Reduced-motion mode disables pulse, entrance, chart, and decorative transitions.
- Charts include text summaries and data-table alternatives.
- Arabic reading order, icon directionality, number formatting, mixed-direction identifiers, and modal footer order are tested explicitly.

## 11. Implementation sequence

### Phase 0 — Baseline and visual contract

1. Capture screenshots of every route and every major nested state at the required desktop and mobile widths.
2. Record current test/build results and known failures.
3. Create a route-state matrix covering default, loading, empty, error, populated, permission-limited, archived, and modal-open states.
4. Freeze API/client and backend files from redesign edits.

Exit gate: complete baseline inventory with no unexplained route or workflow.

### Phase 1 — Tokens and shell

1. Introduce the warm graphite token layer while maintaining compatibility aliases.
2. Redesign sidebar, top utility bar, page masthead, page gutters, focus system, and responsive shell.
3. Keep routing, permissions, branch switching, notifications, search, rate book, language, theme, and account behavior unchanged.

Exit gate: every route loads with the new shell; navigation and keyboard controls pass tests in both directions.

### Phase 2 — Shared primitives

1. Standardize buttons, icon buttons, panels, tabs, badges, tables, forms, pagination, toasts, loading, empty, error, modal, drawer, and popover primitives.
2. Replace emoji states with shared icons.
3. Establish chart tokens and accessible chart scaffolding.
4. Add development-only visual examples for every primitive and state.

Exit gate: primitives pass keyboard, contrast, RTL, reduced-motion, and responsive checks.

### Phase 3 — Read-only and low-risk pages

Migrate Dashboard, Notifications, Communications, Announcements, Reports, Public Document, Admin audit/session views, and vendor Fleet Health/Analytics.

Exit gate: visual comparisons pass and no data-fetching or navigation behavior changes.

### Phase 4 — Master-data CRUD pages

Migrate Clients, Projects, Suppliers, Inventory, Promotions, Warehouses, Users, Roles, Approval Policies, and Settings.

Exit gate: create/edit/archive/restore/import/export and permission states pass existing tests plus targeted interaction tests.

### Phase 5 — Transactional finance and operations

Migrate Quotations, Invoices, Purchases, Expenses, Finance, Accounting, Cash, Fixed Assets, POS, Manufacturing, and Service.

Exit gate: all totals, line items, payment flows, posting-related UI, state transitions, print/share/export behavior, and scanner behavior pass regression tests.

### Phase 6 — Complex people and planning workflows

Migrate CRM, Planning, HR, Recruitment, HR Activities, Approval Requests, Client Detail, and Project Detail.

Exit gate: drag alternatives, timelines, approval concurrency, payroll, attendance, hiring, project costing, and cross-route links pass.

### Phase 7 — Consolidation and removal of legacy presentation code

1. Replace migrated inline style objects with semantic classes or component props.
2. Remove only presentation CSS proven unused after route-by-route verification.
3. Normalize repeated SVGs through the shared icon system.
4. Check bundle size and route splitting.

Exit gate: no obsolete visual rule remains in use, no dead class removal affects runtime rendering, and production build remains clean.

## 12. Verification strategy

### Automated gates after every migration batch

- `npm run lint`
- `npm test`
- `npm run build`
- Existing frontend tests for routes, permissions, accounting, invoices, purchases, POS, service, settings, sharing, documents, warehouses, recruitment, and HR.
- New primitive tests for variants, disabled/loading states, keyboard operation, focus restoration, and RTL rendering.

### Visual regression matrix

Capture and compare:

- Every routed screen at 1440px and 390px.
- Every major tab/view named in this plan.
- Every dialog, drawer, popover, and wizard.
- Loading, empty, error, populated, validation-error, success, permission-restricted, archived, and destructive-confirmation states.
- Dark/light and English/Arabic combinations for representative high-risk pages.

### Backend-protection gate

- Redesign pull requests must contain no files under `backend/`.
- API request snapshots must remain unchanged unless a separately approved functional task exists.
- Route path snapshots and permission/module-visibility snapshots must remain unchanged.
- Financial values in DOM-based tests must match baseline fixtures exactly.

## 13. Completion criteria

The redesign is complete only when:

1. All routes and nested views in this document use the target system.
2. Every visible control belongs to a documented shared component role.
3. Every existing action remains available to the same permitted users.
4. Every table, form, chart, dialog, drawer, popover, loading state, empty state, error state, and confirmation state is visually verified.
5. English, Arabic, light, dark, desktop, tablet, and mobile layouts remain functional.
6. No backend file or API contract changed.
7. Lint, tests, and production build pass.
8. High-risk financial and operational workflows pass targeted regression checks.
9. Accessibility checks pass for contrast, focus, keyboard use, labels, reduced motion, and chart alternatives.
10. Visual regression results show no overlap, clipping, unintended horizontal overflow, unstable reflow, or obscured controls.

## 14. Recommended first implementation slice

The safest first slice is the shell plus Dashboard and Finance:

1. Add the target tokens with compatibility aliases.
2. Redesign Sidebar, top utility bar, `PageMasthead`, buttons, panels, tabs, status badges, and table foundations.
3. Recompose Dashboard into the reference-inspired metric and split-panel structure.
4. Recompose Finance using the same chart, metric, table, and insight system.
5. Verify `/`, `/finance`, mobile navigation, English/Arabic, light/dark, permissions, currency display, and all existing tests.

This slice proves the visual language on the two screens closest to the reference while establishing primitives needed by every remaining page.

## 15. Source-to-redesign traceability matrix

This appendix binds the visual plan to the actual frontend source. A migration batch is incomplete until every named component in its row has been visually verified in all applicable states.

| Route or area | Routed component | Nested components and surfaces covered |
|---|---|---|
| `/setup` | `Setup` | Both setup forms, step/progress state, validation, completion, and server error states |
| `/login` | `Login` | Authentication form, server state, error state, theme/language utilities |
| `/force-change-password` | `ForceChangePassword` | Password form, rule feedback, submission and logout states |
| `/d/:token`, `/d/:label/:token` | `PublicDocument` | Public document loader, verification/error state, print/download action |
| `/` | `Dashboard` | `BarChart`, `HealthRing`, `KpiCard`, `ActionChip`, `Insight`, `SectionTitle`, all dashboard loading/error/limited-permission states |
| `/clients` | `Clients` | Client table/form, `ImportWizard`, `ConfirmModal`, filters, sort, pagination, export |
| `/clients/:id` | `ClientDetail` | `AccountPlan`, `CustomerPaymentModal`, `PaymentsTab`, `StatementTab`, projects, quotations, invoices, document viewer actions |
| `/communications` | `Communications` | Delivery log, history/filter controls, related document and share actions |
| `/projects` | `Projects` | Project table/form, `ConfirmModal`, filters, sort, pagination, export |
| `/projects/:id` | `ProjectDetail` | Overview, material deduction, quotations, invoices, expenses, attachments, document actions, edit/delete confirmations |
| `/quotations` | `Quotations` | Quotation table, document form, line grid, totals, send/share/print, conversion, attachments, confirmations |
| `/invoices` | `Invoices` | Invoice table/form, line grid, `ActionMenu`, `PaymentPlan`, payments, receipt voucher, send/share/print, void/archive confirmations |
| `/inventory` | `Inventory` | `ItemForm`, `ProductBuilder`, `StockForm`, `Lots`, `MovementsModal`, `ImportWizard`, custom fields, reservations, confirmations |
| `/promotions` | `Promotions` | Promotion table/form, status period, archive/restore/delete `ConfirmModal` |
| `/warehouses` | `Warehouses` | `WarehousesTab`, `StockAtWarehouseModal`, `TransfersTab`, `AccessTab`, transfer forms/status/actions |
| `/pos` | `POS` | `OpenRegisterPanel`, `RegisterView`, `CustomLineNameCombobox`, `CheckoutModal`, `ReceiptModal`, `SaleDetailModal`, `CloseRegisterModal`, `SessionsView`, `HistoryView`, `WaitingView` |
| `/manufacturing` | `Manufacturing` | `OrdersView`, `OrderModal`, `OrderDetailModal`, `CompleteModal`, `BomsView`, `BomModal`, `BomDetailModal`, `QCView`, `QCResolveModal`, `ResourcesView`, `AnalyticsView` |
| `/service` | `Service` | Jobs/equipment tables, `JobForm`, `EquipmentForm`, `WriteUp`, confirmations and document actions |
| `/purchases` | `Purchases` | Purchase tables, `PurchaseForm`, `PayoutModal`, receipt/payment/status actions, attachments and confirmations |
| `/suppliers` | `Suppliers` | Supplier tables/form, history, `ImportWizard`, `ConfirmModal`, filters, sort, pagination, export |
| `/finance` | `Finance` | `FinanceLineChart`, `ProfitBarChart`, `DonutChart`, `SmartInsightsPanel`, `MonthDrillModal`, `ReconciliationModal`, monthly table and category distribution |
| `/accounting` | `Accounting` | `Overview`, `Accounts`, `Journal`, `Ledger`, `TrialBalance`, `Statements`, `CashFlow`, `FxDifferences`, `ChartPicker`, `ChartCutover`, `Revaluation`, `Closing`, `StatementExport` |
| `/cash` | `Cash` | `TodayView`, `HistoryView`, `DrawersView`, cash `modals`, `ReconDetailModal`, open/close/reconcile actions |
| `/reports` | `Reports` | `DateRangeBar`, `FinancialReport`, `ProjectsReport`, `ClientsReport`, `AgingReport`, `ExpensesReport`, `PipelineReport`, `VatReport`, `WarehouseValuationReport`, `BranchComparisonReport`, report chart primitives |
| `/crm` | `CRM` | `DashboardTab`, `PipelineTab`, `LeadsTab`, `ContactsTab`, `ActivitiesTab`, forms and conversion/detail actions |
| `/planning` | `Planning` | `ProjectsPanel`, `GanttView`, `BoardView`, `ListView`, `CalendarView`, `ProjectForm`, `TaskForm`, `EventForm`, `ConfirmModal` |
| `/hr` | `HR` | Employee/payroll/department/leave tables and forms, `EmployeeDetail`, `ContractsSection`, `PayrollRunPanel`, `AttendanceTab`, `ImportWizard`, confirmations |
| `/recruitment` | `Recruitment` | Pipeline/applicant/position tables, `ApplicantDetail`, `ApplicantForm`, `PositionForm`, `InterviewForm`, `OfferForm`, `ConvertForm` |
| `/hr-activities` | `HRActivities` | Timeline/list, `ActivityForm`, `CompleteModal`, `ConfirmModal`, filters and status actions |
| `/expenses` | `Expenses` | Expense table/form, `RecurringExpensesPanel`, `TransactionsPanel`, attachments, filters and confirmations |
| `/fixed-assets` | `FixedAssets` | Asset register/forms, depreciation, opening balance, disposal, archive/restore, `ConfirmModal` |
| `/notifications` | `Notifications` | All/Unread/Finance/Inventory/CRM/HR/Approvals/Tasks tabs, rows, bulk actions and empty/error states |
| `/approvals` | `ApprovalRequests` | All/Pending/Mine/Approved/Rejected tabs, `ActionPanel`, comments, approve/reject/override actions |
| `/approval-policies` | `ApprovalPolicies` | Policy table, `PolicyForm`, conditions, step/role controls, `ConfirmModal` |
| `/announcements` | `Announcements` | Inbox/Sent rows, `ComposeForm`, `DetailModal`, filters, read/create/edit/delete states |
| `/settings` | `Settings` | Settings sections and shared settings UI, `InventoryFieldsManager`, `CategoriesManager`, `TaxRatesSection`, `BankAccountsSection`, `RateBookPanel`, `UserManualSection`, backup/integrity controls |
| `/users` | `UserManagement` | User table, create/edit, role/branch scope, passwords/sessions, status actions, `ConfirmModal` |
| `/roles` | `RoleManagement` | Role list, permission matrix, create/edit/save/delete, `ConfirmModal` |
| `/admin` | `AdminDashboard` | Active Sessions, Activity Log, metrics, filters, refresh, revoke, retention/purge actions |
| `/vendor-admin`, `/platform` | `PlatformConsole` | Probe/disabled/login/console phases, tenant manager, `ProvisionWizard`, `ModulePicker`, `ModuleEditor`, `LicenceEditor`, `UserAdmin`, `FleetHealth`, `BusinessAnalytics`, `SupportInbox`, domains and password dialog |

Shared components covered across all routes:

- Application chrome: `Sidebar`, `BrandLogo`, `LicenceBanner`, `NotificationBell`, `CommandPalette`, `RateBook`, `ReportProblemButton`, `ToastContainer`, `ServerGate`, and `ErrorBoundary`.
- Data entry and lookup: `SearchSelect`, `InventoryCombobox`, `BankField`, `BranchField`, `SupplierCombobox`, `SelectOther`, `NumberInput`, and scanner-safe input behavior.
- Records and documents: `Attachments`, `DocumentPostings`, `SendDocument`, `StockReservations`, `PayoutModal`, `RecurringExpensesPanel`, `ImportWizard`, `CategoriesManager`, and `InventoryFieldsManager`.
- Shared presentation: `Icon`, `LoadingSpinner`, `ErrorAlert`, `EmptyState`, `Modal`, `ConfirmModal`, `Badge`, `CategoryBadge`, `DisplayCurrencyToggle`, `ExchangeRateBadge`, `ExportButton`, `WhatsAppShareButton`, `SortableTh`, and `Pagination`.
- Feature helper modules named `ui`, `primitives`, `rows`, `charts`, `insights`, and `modals` are migrated with their owning route and may not retain page-specific visual constants after shared primitives replace them.
