# Suppliers

The vendor master. Every purchase points here. The Supplier detail is the
360° view: every PO ever issued, payment terms, contact info.

## Purpose

Suppliers mirror Clients on the buy side. A single, deduplicated record per
vendor, referenced by every purchase. Lightweight on purpose — just enough
to know who you're buying from and how to pay them.

## Personas

| Persona | What they do here |
|---|---|
| **Procurement Officer** | Adds suppliers, maintains contact info |
| **Accountant** | Reads payment terms, reconciles outstanding payables |
| **Operations Manager** | Reviews supplier performance (delivery times, defect rates) |
| **Auditor** | Verifies no orphan PO records (every `purchases.supplier_id` resolves) |

## Quick reference

- **Required**: `name`. Everything else optional.
- **Payment terms**: payment terms days — informational (default 30)
- **Soft delete + soft archive**: same pattern as Clients
- **Linked entities**: purchases (one-to-many)
- **No per-supplier restrictions**: anyone who can open the module sees every supplier

---

=== "Operator's view"

    ### The supplier list

    Sidebar → **Suppliers**. Columns: Name · Contact · Phone · Email ·
    Payment terms · open PO count.

    Click a row to open the 360° detail.

    ### Supplier detail — tabs

    1. **Overview** — contact details, notes, payment terms
    2. **Purchases** — every PO with this supplier (status + amount)
    3. **Activity** — derived: last PO date, total purchase volume

    ### Adding a supplier

    Suppliers → **+ Add supplier** → name + contact + payment terms.
    Save. New supplier appears in the dropdown on new purchase orders.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Procurement Officer | ✅ | ✅ | ✅ | ✗ |
    | Operations Manager | ✅ | ✅ | ✅ | ✅ |
    | Accountant | ✅ | ✗ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ |

    ### Merging duplicates

    Same procedure as Clients (no native merge).

    1. Pick the canonical supplier
    2. Re-attach the duplicate's `purchases.supplier_id` to the canonical
    3. Archive the duplicate with `archive_reason="Merged into supplier #X"`

    ### Payment terms

    payment terms days is **informational only** — the system doesn't
    automatically compute due dates from it. The accountant sets each
    purchase's payment date manually when payment goes out.

=== "Auditor's view"

    ### Orphan check

    ### Top suppliers by spend

    ### Open payables

---
