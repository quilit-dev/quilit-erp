# Permissions matrix

The full permission grid as shipped, regenerated from the live
database at manual-build time. **18 roles × 27 modules × 5 actions =
2,430 cells.**

## How to read

- **V** — can view (read)
- **C** — can create (insert)
- **E** — can edit (update)
- **D** — can delete (or soft-delete)
- **A** — can approve (used by approval policies)
- **✓** — granted · **·** — not granted

## Quick lookup

| Question | Answer |
|---|---|
| Who can approve an expense? | Anyone with `expenses : A` (Finance Manager, Business Owner, Admin) |
| Who can post manual journal entries? | Anyone with `accounting : C` (Accountant, Finance Manager) |
| Who can manage user accounts? | Anyone with `users : E` (Admin tier) |
| Who can dispatch a stock transfer? | Anyone with `warehouses : E` AND access to the source warehouse |

!!! tip "Per-warehouse access is independent"
    Your role (this matrix) decides "can the user touch the
    module?". For Inventory / POS / Manufacturing / Warehouses,
    **warehouse access** decides "which warehouses
    specifically?". See [Multi-warehouse access](../foundation/warehouse-access.md).

## Special tiers

| Tier | Effect |
|---|---|
| Support account | Bypasses **every** permission and warehouse check. Reserved for the vendor or company owner. |
| Admin-tier role | Adds the administration pages (Users, Roles, Settings, Audit). Does not bypass the ordinary permission checks. |

The **Business Owner** role is admin-tier; everyone else (except the support account)
is standard.

### Admin


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | ✓ | ✓ | ✓ |
| clients | ✓ | ✓ | ✓ | ✓ | ✓ |
| quotations | ✓ | ✓ | ✓ | ✓ | ✓ |
| invoices | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pos` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | ✓ | ✓ | ✓ | ✓ |
| `planning` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | ✓ | ✓ |
| purchases | ✓ | ✓ | ✓ | ✓ | ✓ |
| inventory | ✓ | ✓ | ✓ | ✓ | ✓ |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assets` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `finance` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cash` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounting` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports` | ✓ | ✓ | ✓ | ✓ | ✓ |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | ✓ | ✓ | ✓ | ✓ |
| contracts | ✓ | ✓ | ✓ | ✓ | ✓ |
| HR activities | ✓ | ✓ | ✓ | ✓ | ✓ |
| `recruitment` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Business Owner


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | ✓ | ✓ | ✓ |
| clients | ✓ | ✓ | ✓ | ✓ | ✓ |
| quotations | ✓ | ✓ | ✓ | ✓ | ✓ |
| invoices | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pos` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | ✓ | ✓ | ✓ | ✓ |
| `planning` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | ✓ | ✓ |
| purchases | ✓ | ✓ | ✓ | ✓ | ✓ |
| inventory | ✓ | ✓ | ✓ | ✓ | ✓ |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assets` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `finance` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cash` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounting` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports` | ✓ | ✓ | ✓ | ✓ | ✓ |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | ✓ | ✓ | ✓ | ✓ |
| contracts | ✓ | ✓ | ✓ | ✓ | ✓ |
| HR activities | ✓ | ✓ | ✓ | ✓ | ✓ |
| `recruitment` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | ✓ | ✓ | ✓ | ✓ | ✓ |
| users | ✓ | ✓ | ✓ | ✓ | ✓ |
| roles | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit` | ✓ | ✓ | ✓ | ✓ | ✓ |

### Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | ✓ | · | ✓ |
| clients | ✓ | ✓ | ✓ | · | ✓ |
| quotations | ✓ | ✓ | ✓ | · | ✓ |
| invoices | ✓ | ✓ | ✓ | · | ✓ |
| `pos` | ✓ | ✓ | ✓ | ✓ | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | ✓ | ✓ | · | ✓ |
| `planning` | ✓ | ✓ | ✓ | · | ✓ |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | · | ✓ |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | · | · | · | · |
| `assets` | ✓ | · | · | · | · |
| `finance` | ✓ | · | · | · | · |
| `cash` | ✓ | ✓ | ✓ | ✓ | · |
| `accounting` | ✓ | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | · | · | · | · |
| contracts | ✓ | · | · | · | · |
| HR activities | ✓ | · | · | · | · |
| `recruitment` | ✓ | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | ✓ | ✓ | ✓ | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Finance Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | ✓ | ✓ | ✓ | · | ✓ |
| `pos` | ✓ | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | · | · | · | · |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assets` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `finance` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cash` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounting` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Accountant


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | ✓ | ✓ | ✓ | · | · |
| `pos` | ✓ | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | · | · | · | · |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | ✓ | ✓ | · | · |
| `assets` | ✓ | ✓ | ✓ | · | · |
| `finance` | ✓ | ✓ | ✓ | · | · |
| `cash` | ✓ | ✓ | ✓ | · | · |
| `accounting` | ✓ | ✓ | ✓ | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Sales Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | ✓ | · | ✓ |
| clients | ✓ | ✓ | ✓ | ✓ | · |
| quotations | ✓ | ✓ | ✓ | · | ✓ |
| invoices | ✓ | ✓ | ✓ | · | · |
| `pos` | ✓ | ✓ | ✓ | ✓ | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | ✓ | ✓ | ✓ | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Sales


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | · | · | · |
| clients | ✓ | ✓ | ✓ | · | · |
| quotations | ✓ | ✓ | ✓ | · | · |
| invoices | ✓ | · | · | · | · |
| `pos` | ✓ | ✓ | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Cashier


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | ✓ | ✓ | · | · | · |
| quotations | · | · | · | · | · |
| invoices | ✓ | · | · | · | · |
| `pos` | ✓ | ✓ | ✓ | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | ✓ | ✓ | ✓ | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Project Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | ✓ | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | ✓ | ✓ | · | ✓ |
| `planning` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | ✓ | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Operations Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | ✓ | ✓ | ✓ | ✓ | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | ✓ | ✓ | · | · |
| `planning` | ✓ | ✓ | ✓ | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | · | · |
| purchases | ✓ | ✓ | ✓ | · | · |
| inventory | ✓ | ✓ | ✓ | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | ✓ | ✓ | ✓ | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | ✓ | ✓ | ✓ | · | · |
| `finance` | · | · | · | · | · |
| `cash` | ✓ | ✓ | ✓ | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### HR Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | · | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | · | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | ✓ | ✓ | ✓ | ✓ |
| contracts | ✓ | ✓ | ✓ | ✓ | ✓ |
| HR activities | ✓ | ✓ | ✓ | ✓ | ✓ |
| `recruitment` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Recruiter


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | · | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | · | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | ✓ | ✓ | ✓ | ✓ | ✓ |
| `recruitment` | ✓ | ✓ | ✓ | ✓ | ✓ |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Procurement Officer


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | · | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | ✓ | · |
| purchases | ✓ | ✓ | ✓ | · | ✓ |
| inventory | ✓ | ✓ | ✓ | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Inventory


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | · | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | ✓ | ✓ | · | · |
| purchases | ✓ | ✓ | ✓ | · | · |
| inventory | ✓ | ✓ | ✓ | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | ✓ | ✓ | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Production Manager


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | · | · | · | · | · |
| clients | · | · | · | · | · |
| quotations | · | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | ✓ | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | ✓ | ✓ | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | ✓ | ✓ | ✓ | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### CRM Specialist


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | ✓ | ✓ | ✓ | · |
| clients | ✓ | ✓ | ✓ | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | · | · | · | · | · |
| `pos` | · | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | · | · | · | · | · |
| `planning` | · | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | · | · | · | · | · |
| purchases | · | · | · | · | · |
| inventory | · | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | · | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | · | · | · | · | · |
| `assets` | · | · | · | · | · |
| `finance` | · | · | · | · | · |
| `cash` | · | · | · | · | · |
| `accounting` | · | · | · | · | · |
| `reports` | · | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |

### Auditor


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | ✓ | · | · | · | · |
| `pos` | ✓ | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | ✓ | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | · | · | · | · |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | · | · | · | · |
| `assets` | ✓ | · | · | · | · |
| `finance` | ✓ | · | · | · | · |
| `cash` | ✓ | · | · | · | · |
| `accounting` | ✓ | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | ✓ | · | · | · | · |
| contracts | ✓ | · | · | · | · |
| HR activities | ✓ | · | · | · | · |
| `recruitment` | ✓ | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | ✓ | · | · | · | · |

### Viewer


**Foundation**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard` | ✓ | · | · | · | · |


**Sales**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `crm` | ✓ | · | · | · | · |
| clients | ✓ | · | · | · | · |
| quotations | ✓ | · | · | · | · |
| invoices | ✓ | · | · | · | · |
| `pos` | ✓ | · | · | · | · |


**Delivery**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| projects | ✓ | · | · | · | · |
| `planning` | ✓ | · | · | · | · |


**Procurement / stock**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| suppliers | ✓ | · | · | · | · |
| purchases | ✓ | · | · | · | · |
| inventory | ✓ | · | · | · | · |
| warehouses | · | · | · | · | · |
| `manufacturing` | ✓ | · | · | · | · |


**Finance**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| expenses | ✓ | · | · | · | · |
| `assets` | ✓ | · | · | · | · |
| `finance` | ✓ | · | · | · | · |
| `cash` | ✓ | · | · | · | · |
| `accounting` | ✓ | · | · | · | · |
| `reports` | ✓ | · | · | · | · |


**People**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `hr` | · | · | · | · | · |
| contracts | · | · | · | · | · |
| HR activities | · | · | · | · | · |
| `recruitment` | · | · | · | · | · |


**Comms**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `announcements` | ✓ | · | · | · | · |


**Administration**

| Module | V | C | E | D | A |
|---|:-:|:-:|:-:|:-:|:-:|
| `settings` | · | · | · | · | · |
| users | · | · | · | · | · |
| roles | · | · | · | · | · |
| `audit` | · | · | · | · | · |
