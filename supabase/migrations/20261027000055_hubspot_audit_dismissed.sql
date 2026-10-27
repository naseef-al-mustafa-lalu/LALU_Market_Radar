-- Audit items a person has dismissed (fixed in HubSpot, or nothing to do); they stay off the HubSpot audit list even though the sync rebuilds it.
create table if not exists public.hubspot_audit_dismissed (
  id text primary key, issue text, company_name text, ods_code text, note text, dismissed_by text, dismissed_at timestamptz not null default now());
alter table public.hubspot_audit_dismissed enable row level security;
create policy read_audit_dismissed on public.hubspot_audit_dismissed for select to authenticated using ((select private.is_allowed()));
create policy add_audit_dismissed on public.hubspot_audit_dismissed for insert to authenticated with check ((select private.is_allowed()));
create policy restore_audit_dismissed on public.hubspot_audit_dismissed for delete to authenticated using ((select private.is_allowed()));
