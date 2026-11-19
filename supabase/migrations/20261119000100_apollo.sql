-- Apollo: a supplementary source of email addresses for people Oscar names (with a job role) but gives no address for. They wait in apollo_queue for a person to approve the credit spend;
-- an approved one is looked up by the Apollo job, and an address found becomes a contact with source 'apollo' that enters the normal NeverBounce approval queue.
alter table public.contacts drop constraint if exists contacts_source_check;
alter table public.contacts add constraint contacts_source_check check (source in ('oscar', 'hubspot', 'apollo'));
create table if not exists public.apollo_queue (
  contact_urn bigint primary key,                       -- the Oscar URN of the person who has no address
  ods_code text not null,
  full_name text, first_name text, last_name text, job_title text, role_tier text,
  state text not null default 'pending' check (state in ('pending', 'approved', 'found', 'not_found', 'error')),
  approved_by text, approved_at timestamptz,
  apollo_email text, apollo_email_status text, checked_at timestamptz, note text,
  first_seen timestamptz not null default now());
create index if not exists apollo_queue_state_idx on public.apollo_queue (state);
alter table public.apollo_queue enable row level security;
create policy read_apollo_queue on public.apollo_queue for select to authenticated using ((select private.is_allowed()));
create or replace function public.set_apollo_approval(p_urns bigint[], p_approve boolean) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.apollo_queue set state = case when p_approve then 'approved' else 'pending' end, approved_by = case when p_approve then who else null end, approved_at = case when p_approve then now() else null end
    where contact_urn = any(p_urns) and state in ('pending', 'approved'); get diagnostics n = row_count; return n;
end $$;
revoke all on function public.set_apollo_approval(bigint[], boolean) from public, anon; grant execute on function public.set_apollo_approval(bigint[], boolean) to authenticated;
