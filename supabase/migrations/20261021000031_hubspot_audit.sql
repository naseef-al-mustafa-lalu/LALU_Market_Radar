-- Mismatches between HubSpot companies and the NHS practice list, rebuilt by every HubSpot sync (service role); signed-in allowlisted users can read.
-- issue: name_mismatch (same ODS code, different name), unknown_code (code is not a GP practice in Atlas), duplicate_code (code on several companies), closed_practice (practice closed or merged).
create table if not exists public.hubspot_audit (
  id text primary key,                       -- issue-companyid
  issue text not null,
  company_id text not null,
  company_name text,
  ods_code text,
  nhs_name text,
  nhs_status text,
  detail text,
  found_at timestamptz not null default now());
create index if not exists hubspot_audit_issue on public.hubspot_audit (issue);
alter table public.hubspot_audit enable row level security;
create policy read_hubspot_audit on public.hubspot_audit for select to authenticated using ((select private.is_allowed()));
