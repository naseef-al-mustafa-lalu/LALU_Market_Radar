-- Contacts with no email address cannot be contacted, so they are not stored: this ledger counts and remembers them (by Oscar URN or HubSpot id) so they are never re-imported.
create table if not exists public.contact_noemail (
  source text not null check (source in ('oscar', 'hubspot')),
  ref text not null,
  ods_code text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (source, ref));
alter table public.contact_noemail enable row level security;
create policy read_contact_noemail on public.contact_noemail for select to authenticated using ((select private.is_allowed()));
insert into public.contact_noemail (source, ref, ods_code)
  select source, case when source = 'oscar' then contact_urn::text else coalesce(hubspot_contact_id, contact_urn::text) end, ods_code from public.contacts where email is null
  on conflict do nothing;
