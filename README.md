# Sokra — Reduce what you owe

Upload any bill. Sokra reads it, finds the errors and the programs you're owed, ranks every way to reduce it by dollar impact, and hands you the exact words to say — then teaches you why it worked.

**Live:** https://getsokra.com/
**Admin:** https://getsokra.com/admin.html

Free for the person with the bill. Education and advocacy scripting, not legal or licensed financial advice.

## How it works

```
photo/PDF ──▶ docs/ (PWA, no build step)
                 │  client-side: HEIC→JPEG, resize ≤1800px
                 ▼
     supabase/functions/sokra-analyze   (Deno edge function)
                 │  playbook (sokra.config) + bill → Claude (vision) → structured plan JSON
                 ├─▶ sokra.cases         (plan, estimates, outcome)
                 ├─▶ sokra-bills bucket  (original file, only with consent)
                 ├─▶ Resend              (plan email, 14-day follow-up)   [optional]
                 └─▶ sokra.events        (instrumentation)
```

The playbook — the expert reasoning for medical, credit card, collections, utility, telecom, loans, rent, tax — lives in the `sokra.config` table, not in code. Edit the row, no redeploy.

## Repo

| Path | What |
|---|---|
| `docs/` | The app. Static files, deploy anywhere. `index.html` (intake + results), `plan.html` (saved plan), `admin.html`, `privacy.html`, `terms.html`, `sw.js`, `manifest.webmanifest` |
| `supabase/functions/sokra-analyze/` | Backend. Routes: `GET /health`, `POST /` (analyze), `GET /case/:id`, `POST /outcome`, `POST /delete`, `GET /stats` + `GET /cases` (admin token), `POST /followup` (cron token) |
| `supabase/migrations/` | Schema: `sokra.config`, `sokra.cases`, `sokra.events`, bucket, pg_cron job |
| `supabase/playbook.md` | The system prompt as stored in `sokra.config.playbook` |
| `scripts/eval.mjs` | Runs every file in `test-bills/` through the live engine and checks the plan is usable |
| `test-bills/` | Synthetic bills with planted errors + expected outcomes |

## Configuration

Supabase project: `igussyvvpcrgriugnvlx`

**Edge function secrets** (Dashboard → Edge Functions → Secrets):

| Secret | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | **yes** | The engine. Without it `/health` reports `has_key:false` and analysis returns 503. |
| `STRIPE_SECRET_KEY` | for Pro | Live or test secret key. Without it the Pro block is hidden and `/checkout` returns 503. |
| `STRIPE_WEBHOOK_SECRET` | for Pro | Signing secret of a webhook endpoint pointed at `…/sokra-analyze/stripe-webhook` for event `checkout.session.completed`. |
| `RESEND_API_KEY` | no | Plan email + 14-day follow-up. Without it, both silently skip. |
| `SOKRA_FROM` | no | From address, default `Sokra <sokra@llcreativityllc.com>` (domain must be verified in Resend) |
| `SOKRA_MODEL` | no | Default `claude-sonnet-5-5` |

**`sokra.config` rows:** `playbook`, `admin_token_sha256`, `cron_token_sha256`, `cron_token_plain` (used by pg_cron), `app_url`.

## Deploy

Backend (via Supabase MCP or CLI):
```
supabase functions deploy sokra-analyze --no-verify-jwt --project-ref igussyvvpcrgriugnvlx
```

Frontend: `docs/` is static. GitHub Pages serves it from `main` / `docs`. To put it on a custom domain, add a `CNAME` file in `docs/` and a DNS CNAME record → `wealthrxai.github.io`. Change `app_url` in `sokra.config` so emails link to the right place.

## Evaluate

```
node scripts/eval.mjs
```
Prints PASS/FAIL per test bill with latency and the plan summary. Exit code 0 when all pass.

## Tiers

- **Free** — the full plan: errors, ranked levers, scripts, do-first, deadlines, teach. Always.
- **Pro ($29 one-time, per bill)** — letters drafted from the bill (financial-assistance cover letter, dispute, debt validation, hardship — whichever fit), a call sheet, checklist, timeline. Stripe Checkout; the webhook marks the case `tier='pro'` and pre-generates the documents. Price and copy live in `sokra.config` (`pro_price_cents`, `pro_name`, `pro_description`).

## The one metric

**Reported dollars reduced** (`sokra.cases.outcome_reported_cents`). Users report it on the plan page; the follow-up email asks once at 14 days. The admin dashboard shows it in teal.

## Privacy posture

- Files discarded after analysis unless the user ticks "keep a copy"
- No accounts, no trackers, IP stored only as a one-way hash
- "Delete my data" on every plan page removes analysis, context, email and files
- Anthropic API does not train on inputs
