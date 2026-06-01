# ERP System — User Manual (source)

This folder holds the **source** of the multi-audience operator / administrator /
auditor manual. The published HTML site is generated from these Markdown
files. Documentation lives in the repository so it stays in lock-step with
the code that ships.

## What's where

```
docs/manual/
├── mkdocs.yml      ← site configuration + navigation tree
├── README.md       ← this file (build instructions)
└── docs/           ← every Markdown page
    ├── index.md
    ├── architecture/
    ├── foundation/
    ├── sales/      (Phase 2)
    ├── operations/ (Phase 3)
    ├── finance/    (Phase 4)
    ├── people/     (Phase 5)
    └── reference/  (Phase 6)
```

The built site is written to `static-manual/` at the repo root (gitignored).

## Prerequisites

Python 3.11+ (you already have it for the backend) plus three pip packages.
Install once:

```powershell
pip install mkdocs-material pymdown-extensions mkdocs-material[imaging]
```

## Authoring loop — live preview

From this folder:

```powershell
mkdocs serve
```

Opens `http://127.0.0.1:8000/` with **hot reload** on every save. Edit a
`.md` file, the browser refreshes automatically.

## Build static HTML for sharing

```powershell
mkdocs build
```

Produces a self-contained static site at `static-manual/` (configurable in
`mkdocs.yml`). Zip the folder and you can hand it to a customer or host it
behind any web server.

## Export to PDF

For an offline / printable copy:

```powershell
pip install mkdocs-with-pdf
# enable in mkdocs.yml -> plugins -> with-pdf
mkdocs build
# output: static-manual/pdf/document.pdf
```

## Conventions used by every module page

Every module page in the manual follows the same layout so readers always
know where to find what they need:

1. **Purpose** — one-paragraph summary
2. **Personas** — who uses this module
3. **Quick reference** — common operations at a glance
4. **Three-audience tabs** — Operator / Administrator / Auditor
5. **Data model** — Mermaid ER diagram
6. **Workflow** — Mermaid sequence or flowchart
7. **Permissions** — module-level + row-level table
8. **Integrations** — cross-module dependencies
9. **API surface** — endpoints touched by the module
10. **Audit evidence** — what gets recorded and where

The shared template is in `docs/_template/module.md` and `_template/styling.md`.
