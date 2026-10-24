-- One row per referral group priced in the tool: the lead practice/deal, who was counted, and whether the extra discount still stands.
create table if not exists public.referral_groups (
  id uuid primary key default gen_random_uuid(),
  lead_ods text not null,
  lead_deal_id text,
  members jsonb not null default '[]',
  combined_patients integer,
  extra_discount numeric,
  status text not null default 'active' check (status in ('active', 'reverted')),
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  reverted_at timestamptz,
  reverted_by text
);
create unique index if not exists referral_groups_one_active on public.referral_groups (lead_ods) where status = 'active';
alter table public.referral_groups enable row level security;
create policy read_referral_groups on public.referral_groups for select to authenticated using ((select private.is_allowed()));
