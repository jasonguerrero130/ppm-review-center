-- ============================================================
-- Pinoy Project Managers — Review Center
-- Supabase schema. Run this in Supabase's SQL Editor once,
-- against a fresh project (Project > SQL Editor > New query).
-- ============================================================

create extension if not exists pgcrypto;

-- Extra fields per registered user, keyed to Supabase's built-in auth.users.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null,
  email text not null,
  answered_count int not null default 0,
  read_article_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Subscription status, updated only by the PayMongo webhook (never directly by the client).
create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null check (plan in ('monthly','annual')),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  paymongo_customer_id text,
  paymongo_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Every quiz / mock exam attempt.
create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date timestamptz not null default now(),
  is_mock boolean not null,
  domain_key text,
  total int not null,
  correct int not null,
  percent int not null,
  passed boolean not null,
  time_used_sec int,
  per_domain jsonb not null default '{}'::jsonb,
  cert_id text
);

-- ============================================================
-- Row Level Security: every user can only ever read/write their own rows.
-- The PayMongo webhook updates `subscriptions` using the service role key,
-- which bypasses RLS entirely — so clients can never fake their own "active" status.
-- ============================================================

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.attempts enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "subscriptions: read own" on public.subscriptions
  for select using (auth.uid() = user_id);
-- NOTE: intentionally no insert/update policy for regular users —
-- only the webhook (using the service role key, which bypasses RLS) can write here.

create policy "attempts: read own" on public.attempts
  for select using (auth.uid() = user_id);
create policy "attempts: insert own" on public.attempts
  for insert with check (auth.uid() = user_id);

-- Helper view: quick "does this user currently have full access" check the front end can query.
create or replace view public.my_access as
select
  s.user_id,
  s.plan,
  s.status,
  s.current_period_end,
  (s.status = 'active' and (s.current_period_end is null or s.current_period_end > now())) as has_full_access
from public.subscriptions s
where s.user_id = auth.uid();
