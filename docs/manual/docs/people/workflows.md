# Headline workflows

Three jobs that run across several parts of the system. Each one is a
sequence of ordinary screens — this page shows the order.

---

## Monthly payroll

**Who:** HR Manager · **When:** end of each month

| # | Where | What you do |
|---|---|---|
| 1 | **HR → Payroll → New run** | Pick the month. The system creates a draft and adds a line for every active employee, using the salary on their current contract. |
| 2 | The draft run | Adjust bonuses, deductions and overtime per person. Tax and social contributions are worked out for you. |
| 3 | **Approve** | The run locks. Nobody can edit the lines after this. |
| 4 | **Mark paid** | The system records the expense and posts it to the accounts. |

**Before you start:** every employee who should be paid needs an active
contract. Someone without one is skipped, which is the usual reason a person
is missing from a run.

**If someone's pay is wrong:** fix it while the run is still a draft. Once
approved, the run cannot be edited — cancel it and start again, so the
history shows what happened.

Staff paid in different currencies are grouped by currency, so each is
recorded at its own rate.

---

## Capex approval

**Who:** whoever requests the purchase, then the approvers · **When:** buying
something that becomes a company asset

| # | Where | What happens |
|---|---|---|
| 1 | **Fixed Assets → New asset** | Enter what you want to buy and its cost. |
| 2 | Automatic | If the amount crosses an approval rule, the request goes to the first approver instead of being created outright. |
| 3 | **Approvals** | Each approver in turn approves or rejects. Everyone sees where it is. |
| 4 | On final approval | The asset is created and starts depreciating. |
| 5 | On rejection | Nothing is created. The request and its reason stay on record. |

**Why nothing appeared:** if you created an asset and cannot find it, it is
probably waiting for approval. Check **Approvals**.

Approval rules are set up once by an administrator — see
[Approvals](approvals.md).

---

## Hiring someone

**Who:** Recruiter, then HR Manager · **When:** filling a position

| # | Where | What you do |
|---|---|---|
| 1 | **Recruitment → Positions** | Open the role you are hiring for. |
| 2 | **Applicants** | Add candidates as they apply. |
| 3 | **Interviews** | Schedule them; each is recorded against the applicant. |
| 4 | **Offer** | Make the offer. The applicant's status follows it. |
| 5 | **Convert to employee** | Once accepted, this creates the employee record from the applicant — you do not retype their details. |
| 6 | **HR → Contracts** | Add their employment contract. Until this exists they will not appear in a payroll run. |

**The step people forget is 6.** Converting an applicant creates the person;
it does not create their contract, and payroll works from contracts.

---

## Where to read more

- [HR](hr.md) — employees, leave, payroll
- [HR Contracts](hr-contracts.md) — contracts and renewals
- [Recruitment](recruitment.md) — positions, applicants, offers
- [Approvals](approvals.md) — how approval rules are configured
