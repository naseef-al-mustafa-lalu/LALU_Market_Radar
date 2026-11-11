-- APPLIED 2026-11-11 (people 19,211 = distinct emails; 6 same-person-same-practice duplicates left unlinked).
-- Step 1b of docs/contacts-rethink.md: a person is one row keyed by email, linked to one or more practices. Backfilled from contacts; triggers keep it in step with contacts so no writer has to change yet.
create table if not exists public.people (
  person_id bigint generated always as identity primary key,
  email_key text not null unique,
  hubspot_contact_id text,
  created_at timestamptz not null default now());
create table if not exists public.contact_practices (
  person_id bigint not null references public.people(person_id) on delete cascade,
  ods_code text not null,
  contact_urn bigint not null unique references public.contacts(contact_urn) on delete cascade,
  job_title text,
  source text,
  primary key (person_id, ods_code));
create index if not exists contact_practices_ods on public.contact_practices (ods_code);
alter table public.people enable row level security;
alter table public.contact_practices enable row level security;
create policy read_people on public.people for select to authenticated using ((select private.is_allowed()));
create policy read_contact_practices on public.contact_practices for select to authenticated using ((select private.is_allowed()));

insert into public.people (email_key, hubspot_contact_id)
  select lower(btrim(email)), max(hubspot_contact_id) from public.contacts where email is not null and btrim(email) <> '' group by 1
  on conflict (email_key) do nothing;
insert into public.contact_practices (person_id, ods_code, contact_urn, job_title, source)
  select distinct on (p.person_id, c.ods_code) p.person_id, c.ods_code, c.contact_urn, c.job_title, c.source
  from public.contacts c join public.people p on p.email_key = lower(btrim(c.email))
  where c.email is not null and btrim(c.email) <> ''
  order by p.person_id, c.ods_code, (c.full_name is not null) desc, c.contact_urn
  on conflict do nothing;

create or replace function private.sync_person() returns trigger language plpgsql security definer set search_path = '' as $f$
declare k text; pid bigint;
begin
  k := case when new.email is null or btrim(new.email) = '' then null else lower(btrim(new.email)) end;
  delete from public.contact_practices where contact_urn = new.contact_urn;
  if k is not null then
    insert into public.people (email_key, hubspot_contact_id) values (k, new.hubspot_contact_id)
      on conflict (email_key) do update set hubspot_contact_id = coalesce(excluded.hubspot_contact_id, public.people.hubspot_contact_id)
      returning person_id into pid;
    begin
      insert into public.contact_practices (person_id, ods_code, contact_urn, job_title, source) values (pid, new.ods_code, new.contact_urn, new.job_title, new.source);
    exception when unique_violation then null;   -- a second row for the same person at the same practice stays unlinked until it is removed
    end;
  end if;
  return new;
end $f$;
drop trigger if exists contacts_sync_person on public.contacts;
create trigger contacts_sync_person after insert or update of email, ods_code, job_title, hubspot_contact_id, source on public.contacts for each row execute function private.sync_person();

create or replace function private.prune_person() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  delete from public.people p where p.person_id = old.person_id and not exists (select 1 from public.contact_practices c where c.person_id = p.person_id);
  return null;
end $f$;
drop trigger if exists contact_practices_prune on public.contact_practices;
create trigger contact_practices_prune after delete on public.contact_practices for each row execute function private.prune_person();

create or replace function public.contact_integrity() returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object(
    'contacts_with_email_unlinked', (select count(*) from public.contacts c where c.email is not null and btrim(c.email) <> '' and not exists (select 1 from public.contact_practices l where l.contact_urn = c.contact_urn)),
    'people', (select count(*) from public.people),
    'distinct_emails', (select count(distinct lower(btrim(email))) from public.contacts where email is not null and btrim(email) <> ''),
    'people_without_practice', (select count(*) from public.people p where not exists (select 1 from public.contact_practices l where l.person_id = p.person_id)));
$f$;
revoke all on function public.contact_integrity() from public, anon;
grant execute on function public.contact_integrity() to authenticated, service_role;
