-- Sokra v1 production schema (idempotent; safe to re-run)

create schema if not exists sokra;

-- Private key/value config. Holds the playbook (system prompt) so it can be
-- edited without redeploying, plus hashed admin/cron tokens.
create table if not exists sokra.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table sokra.config enable row level security;

create table if not exists sokra.cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text,
  bill_type text,
  provider text,
  total_cents bigint,
  est_reduction_low_cents bigint,
  est_reduction_high_cents bigint,
  context jsonb,
  analysis jsonb,
  files jsonb,
  model text,
  tokens_in int,
  tokens_out int,
  latency_ms int,
  outcome_reported_cents bigint,
  outcome_note text,
  outcome_at timestamptz,
  followup_sent_at timestamptz,
  plan_emailed_at timestamptz,
  consent_store boolean not null default false,
  deleted_at timestamptz,
  ip_hash text,
  source text,
  ua text
);
alter table sokra.cases add column if not exists outcome_at timestamptz;
alter table sokra.cases add column if not exists followup_sent_at timestamptz;
alter table sokra.cases add column if not exists plan_emailed_at timestamptz;
alter table sokra.cases add column if not exists consent_store boolean not null default false;
alter table sokra.cases add column if not exists deleted_at timestamptz;
alter table sokra.cases add column if not exists ua text;

create index if not exists cases_created_idx on sokra.cases (created_at desc);
create index if not exists cases_email_idx on sokra.cases (email);
create index if not exists cases_followup_idx on sokra.cases (created_at) where followup_sent_at is null and outcome_reported_cents is null and email is not null;

alter table sokra.cases enable row level security;

-- Event log (lightweight analytics: page views, analyses, outcome reports)
create table if not exists sokra.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  case_id uuid,
  meta jsonb
);
alter table sokra.events enable row level security;
create index if not exists events_at_idx on sokra.events (at desc);

insert into storage.buckets (id, name, public) values ('sokra-bills','sokra-bills', false) on conflict (id) do nothing;

grant usage on schema sokra to service_role;
grant all on all tables in schema sokra to service_role;
grant all on all sequences in schema sokra to service_role;
alter default privileges in schema sokra grant all on tables to service_role;

-- 14-day follow-up: every day at 14:00 UTC (10am ET) ask people who left an email whether it worked.
select cron.unschedule('sokra-followup') where exists (select 1 from cron.job where jobname = 'sokra-followup');
select cron.schedule(
  'sokra-followup',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://igussyvvpcrgriugnvlx.supabase.co/functions/v1/sokra-analyze/followup',
    headers := jsonb_build_object('content-type','application/json','x-cron-token', (select value from sokra.config where key = 'cron_token_plain')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
