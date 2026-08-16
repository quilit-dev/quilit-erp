# Reference

Lists worth keeping open in a second tab.

| Page | What it contains |
|---|---|
| [Permissions matrix](permissions.md) | 18 seeded roles × 27 modules × 5 actions in one printable grid |
| [Chart of Accounts](chart-of-accounts.md) | The 30 seeded accounts + what posts to each |
| [Module index](module-index.md) | Every module with a one-liner + page link |
| [Glossary](glossary.md) | The business terms used throughout the manual |

## When to use each

| Goal | Page |
|---|---|
| "Can the Cashier do X?" | [Permissions matrix](permissions.md) |
| "Which account does this expense go to?" | [Chart of Accounts](chart-of-accounts.md) |
| "Where's the deep-dive on Module Y?" | [Module index](module-index.md) |
| "What does 'EOS' / 'COGS' / 'accrual' mean?" | [Glossary](glossary.md) |

## Print-friendly export

To produce a paper-ready PDF appendix:

```powershell
pip install mkdocs-with-pdf
# add to mkdocs.yml: plugins: [..., with-pdf]
mkdocs build
# Output: static-manual/pdf/document.pdf
```

The reference pages are all heavy on tables — they paginate cleanly.
