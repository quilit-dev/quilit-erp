# Headline workflows

Three end-to-end workflows that span this chapter's modules.

## Workflow 1 — Monthly payroll

```mermaid
sequenceDiagram
    autonumber
    participant HR as HR Manager
    participant API as POST /api/hr/payroll/runs
    participant ENG as Accounting engine
    participant DB as SQLite

    HR->>API: Create draft run<br/>{ period_start, period_end }
    API->>DB: INSERT hr_payroll_runs (status='Draft')

    loop each active employee
        API->>DB: Look up active contract<br/>(snapshot salary_currency)
        API->>DB: INSERT hr_payroll_lines<br/>(employee_id, base_salary,<br/>tax, NSSF emp + employer,<br/>net, salary_currency)
    end

    Note over HR: HR Manager tweaks bonuses /<br/>deductions / overtime per line

    HR->>API: Approve run<br/>POST /runs/{id}/approve
    API->>DB: UPDATE hr_payroll_runs<br/>status='Approved', approved_at, by

    HR->>API: Mark paid<br/>POST /runs/{id}/mark-paid

    API->>DB: GROUP BY salary_currency
    Note over API: F-6 fix: convert each<br/>currency segment to USD<br/>at the latest spot rate

    alt LBP segment exists but no rate set
        API-->>HR: 400: "Set LBP→USD rate first"
    else proceed
        API->>DB: INSERT expenses (category='Payroll', amount=USD total)
        API->>ENG: post_entry(<br/>DR 6000 Salaries USD total /<br/>CR 1000 Cash (USD segment) /<br/>CR 1010 Cash—LBP (LBP segment))
        ENG->>DB: INSERT journal_entry + lines
        API->>DB: UPDATE hr_payroll_runs<br/>status='Paid', paid_at, by, posted_expense_id
        API->>DB: INSERT audit_log
    end

    API-->>HR: { expense_id, amount }
```

The F-6 fix is what makes this safe for mixed-currency installs. Every line's
`salary_currency` is snapshotted at run-creation time; mark-paid groups by
currency and converts at the *latest* spot rate.

## Workflow 2 — Capex approval chain

A fixed asset over a threshold needs a Finance Manager sign-off before being
recorded. The approval policy engine handles the chain.

```mermaid
sequenceDiagram
    autonumber
    participant USR as Operations Manager
    participant API as POST /api/assets/
    participant POL as Approval engine
    participant FIN as Finance Manager
    participant DB as SQLite

    USR->>API: { asset_code, acquisition_cost: 25000, ... }

    API->>POL: evaluate_and_apply(<br/>module='assets', action='create',<br/>entity_data={amount: 25000})

    Note over POL: Matches policy "Capex > $10K → Finance Manager"

    POL->>DB: INSERT approval_requests (status='pending')
    POL->>DB: INSERT approval_steps (step=1, approver_role='Finance Manager')
    POL-->>API: needs_approval=true

    API->>DB: INSERT fixed_assets (status='Pending Approval')
    API->>DB: INSERT notifications<br/>(user=Finance Mgr, type='approval_request')
    API-->>USR: { id, status: 'Pending Approval' }

    Note over FIN: Sees notification → opens Approvals →

    FIN->>API: POST /api/approval-requests/{id}/approve<br/>{ step: 1, comment: 'OK to capitalise' }
    API->>POL: Approve step
    POL->>DB: UPDATE approval_steps (status='approved', acted_at, by)

    alt all steps approved
        POL->>DB: UPDATE approval_requests (status='approved')
        POL->>API: Apply pending action
        API->>DB: UPDATE fixed_assets (status='Active')
        API->>API: Now safe to depreciate
    end

    API->>DB: INSERT notifications<br/>(user=Ops Mgr, type='approval_status')
    API-->>FIN: { applied: true }
```

The same engine gates expenses, purchases, invoices, projects, and assets.
The policy specifies which modules + actions + conditions + approver roles.

## Workflow 3 — Hire-to-employee conversion

When a recruitment applicant is hired, the system promotes them to a full
HR employee record.

```mermaid
sequenceDiagram
    autonumber
    participant REC as Recruiter
    participant HR as HR Manager
    participant API as Recruitment + HR routers
    participant DB as SQLite

    Note over REC: Process applicant through<br/>Screening → Test → Interview → Accepted

    REC->>API: POST /api/recruitment/offers/<br/>{ applicant_id, salary, terms }
    API->>DB: INSERT recruitment_offers (status='Draft')

    REC->>API: POST /offers/{id}/send
    API->>DB: UPDATE recruitment_offers (status='Sent', sent_at)

    Note over REC: Candidate accepts →

    REC->>API: POST /offers/{id}/accept
    API->>DB: UPDATE recruitment_offers (status='Accepted', accepted_at)
    API->>DB: UPDATE recruitment_applicants (status='Hired')

    HR->>API: POST /api/recruitment/applicants/{id}/convert-to-employee

    API->>DB: BEGIN
    API->>DB: INSERT hr_employees<br/>(full_name, email, salary, job_title,<br/>department_id from offer)
    API->>DB: INSERT hr_contracts<br/>(employee_id, salary_currency,<br/>contract_type, start_date,<br/>benefits, terms from offer)
    API->>DB: UPDATE recruitment_applicants<br/>SET converted_employee_id = <new emp id>
    API->>DB: INSERT hr_employment_changes<br/>(change_type='hire', new_salary, new_title)
    API->>DB: INSERT audit_log<br/>(action='hire_applicant')
    API->>DB: COMMIT

    API-->>HR: { employee_id, message: 'Hired' }
```

After conversion, the applicant record stays (audit trail), but the
operational records are now in HR. From there:

- Payroll runs include the new employee
- HR contract carries forward into the next renewal cycle
- The recruitment position's `headcount` decrements
