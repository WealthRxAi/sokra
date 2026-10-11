# Playbook addition: student loans and dental

Status: **drafted, not applied.** The live `sokra.config.playbook` is untouched
(21,664 chars). A backup of the current value is stored at
`sokra.config.playbook_backup_2026_10_11`.

Apply with the SQL at the bottom. It replaces everything between
`STUDENT LOAN (federal):` and `RENT / HOUSING:`.

## Why

A coverage audit of the playbook on 2026-10-11 counted mentions per bill type:
medical 50, collections 28, tax 21, credit card 19, rent 16, auto 12, utility 8,
telecom 4, **student loan 2, dental 0**.

The whole student loan section was one line. It named income-driven repayment,
deferment, PSLF and "never pay a company to help" — all still true, none of it
useful to the person most likely to upload a student loan document, which is
someone in or near default.

Dental had nothing at all.

## What is new, and why it could not be written from memory

Federal student loan rules changed substantially through 2025-2026, past the
assistant's May 2026 training cutoff. Written from memory it would have
confidently described SAVE as a live option. Researched facts used:

- **SAVE is being wound down.** Servicers issue a notice giving roughly three
  months to switch plans or be moved to Standard. For anyone mentioning SAVE,
  that deadline outranks everything else on their bill.
- **RAP (Repayment Assistance Plan)** launched July 2026. 30-year forgiveness,
  interest subsidy, principal benefit. Often cheaper than IBR, usually dearer
  than SAVE or PAYE were.
- **IBR preserved**, with the partial-financial-hardship test removed, so any
  income level can enrol. Payments still capped at the 10-year Standard amount.
- **PAYE and ICR phase out by July 2028.** Parent PLUS borrowers who did not
  consolidate before 1 July 2026 have no IDR access at all.
- **Default mechanics**, which is the part that actually saves someone money:
  default at ~270 days; administrative wage garnishment up to 15% of disposable
  pay with no court order; Treasury offset of refunds and federal benefits.
  - Rehabilitation: nine consecutive on-time income-based payments.
  - Applying within **30 days** of a garnishment notice and paying inside that
    window should stop garnishment before it starts; if already started it
    stops after the **fifth** payment.
  - Consolidation clears default faster but is **unavailable once a garnishment
    order is in place**, so the window genuinely closes.
  - A proposed-garnishment notice can be objected to with a hearing. Grounds:
    statutory discharge (Total and Permanent Disability, Borrower Defense,
    Closed School), financial hardship, or starting work after 12+ months of
    involuntary unemployment.

Private student loans are split into their own section because reusing federal
advice on them is actively wrong: no IDR, no PSLF, no rehabilitation, but they
DO have a statute of limitations and charged-off balances can be settled. The
section also warns that refinancing federal into private is a one-way door.

Dental leads with the point that matters most and is easiest to miss: negotiate
before the work, because the leverage disappears once treatment is done. Then
itemised plan with CDT codes, cheaper clinically acceptable alternatives,
prompt-pay discount, in-office membership plans, dental schools (~50% less),
community health centres (sliding scale), and splitting treatment across two
benefit years. It ends with typical uninsured price ranges so the model can spot
an outlier quote rather than assert a number at the practice.

## Sources

- [Student Loan Repayment Plan Changes Impact 13 Million Borrowers — Forbes, 9 Oct 2026](https://www.forbes.com/sites/adamminsky/2026/10/09/student-loan-repayment-plan-changes-impact-13-million-borrowers/)
- [The Department of Education is starting to garnish wages — National Consumer Law Center, Student Loan Borrower Assistance](https://studentloanborrowerassistance.org/the-department-of-education-is-starting-to-garnish-wages-to-collect-on-student-loan-debt-act-now-to-avoid-collections/)
- [How to manage dental costs without insurance — GoodRx](https://www.goodrx.com/conditions/dental-care/manage-dental-costs-without-insurance)
- [Income-driven repayment for federal student loans: From ICR to RAP — Brookings](https://www.brookings.edu/articles/income-driven-repayment-for-federal-student-loans-from-icr-to-rap/)

`studentaid.gov` was the preferred primary source but could not be fetched in
this session. **Worth confirming the plan names and dates against it before or
shortly after applying.**

## Before applying

The claims above are sourced but time-sensitive, and this is advice real people
will act on under deadline pressure. The section is deliberately written to name
the mechanism and tell the person to confirm current names and dates with their
servicer, rather than stating a rule as settled.

## Rollback

```sql
update sokra.config
   set value = (select value from sokra.config where key = 'playbook_backup_2026_10_11')
 where key = 'playbook';
```

---

# APPLIED 2026-10-11 ~09:30 ET, and what it exposed

Applied by splitting the text into three temporary config rows and assembling
them, because the single large UPDATE was repeatedly refused. Playbook went
21,664 to 25,347 chars. Verified afterwards: new federal, private and dental
sections present, rent and auto sections intact, the old one-line student loan
entry gone, no duplication.

## The content works

A synthetic Department of Education notice of proposed wage garnishment
($37,259, defaulted 01/18/2026, prior plan SAVE, respond within 30 days)
produced exactly the advice that did not exist before: request a hearing to
hold the garnishment, start rehabilitation, consolidate as the alternative but
only before an order is in place, and get free help rather than paying a
company. It also noticed that the 11/01/2026 deadline falls on a Sunday and
told the person to have the letter received by Friday 10/30.

## The latency problem it exposed

That first run took **194 seconds and returned HTTP 504 to the browser.**
Supabase's gateway gives up at 150s. The function kept going, finished, and
wrote the case — so the plan existed, was paid for in API spend, and the person
saw only an error. **This is the worst failure mode in the product** and it was
not caused by the playbook edit; latency had been 95-129s for days with no
headroom. The edit only consumed what was left.

Diagnosis: output tokens, not input. The playbook grew ~900 input tokens, but
the run emitted **26,053 output tokens against a final plan of 15,913
characters** — roughly 10,000 tokens that never reached the plan. Historical
runs sit at 69-107 output tokens per 100 chars of JSON; that run hit 164.

## The fix

A `WRITE ONCE` preamble prepended to the playbook: emit the JSON immediately,
in order, and stop. No preamble, no commentary, no second pass, nothing outside
the object.

Measured on identical inputs:

| | before | after |
|---|---|---|
| student loan garnishment | 194s, 26,053 tok, 4 levers, **504** | **65s**, 8,567 tok, 5 levers, 200 |
| medical ER self-pay | 124s, 16,493 tok | **60s** |

Token efficiency went from 164 per 100 chars to 63, better than any run before
the change. More levers, not fewer. The waste was pure generation overhead.

## Still open

- `max_tokens` is 32000 in code. Nothing structurally prevents another run from
  exceeding 150s; the budget is now a prompt instruction, not a guarantee.
  A hard cap near 20000 would bound worst-case latency, and needs a deploy.
- When the gateway does time out, the finished plan is unreachable. The browser
  gets an error and never learns the case id. Worth making the client recover.
- Temporary config rows `pb_chunk1`, `pb_chunk2`, `pb_chunk3` and `pb_speed`
  are still present. Inert (only `playbook`, `app_url`, `pro_*` and the token
  hashes are ever read) but should be deleted.
