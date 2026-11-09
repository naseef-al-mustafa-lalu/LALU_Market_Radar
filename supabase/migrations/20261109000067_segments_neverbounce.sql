-- HubSpot segments (lists) Atlas tracks, their members, and the NeverBounce approval queue and run log.
create table if not exists public.hubspot_segments (
  list_id text primary key, name text not null, processing_type text, size integer, filter_text text, filters jsonb,
  tracked boolean not null default false, criteria jsonb, updated_in_hubspot timestamptz, synced_at timestamptz not null default now());
create table if not exists public.hubspot_segment_members (list_id text not null, contact_id text not null, primary key (list_id, contact_id));
create index if not exists hubspot_segment_members_contact_idx on public.hubspot_segment_members (contact_id);
create table if not exists public.neverbounce_runs (
  id bigserial primary key, run_at timestamptz not null default now(), kind text not null default 'weekly', checked integer not null default 0, passed integer not null default 0,
  failed integer not null default 0, created_in_hubspot integer not null default 0, enrolled integer not null default 0, credits_remaining integer, summary jsonb, error text);
alter table public.contacts add column if not exists nb_state text check (nb_state in ('pending', 'approved', 'checked', 'skipped')), add column if not exists nb_result text,
  add column if not exists nb_checked_at timestamptz, add column if not exists nb_approved_by text, add column if not exists nb_approved_at timestamptz;
create index if not exists contacts_nb_state_idx on public.contacts (nb_state) where nb_state in ('pending', 'approved');
alter table public.hubspot_segments enable row level security; alter table public.hubspot_segment_members enable row level security; alter table public.neverbounce_runs enable row level security;
create policy read_hubspot_segments on public.hubspot_segments for select to authenticated using (private.is_allowed());
create policy read_hubspot_segment_members on public.hubspot_segment_members for select to authenticated using (private.is_allowed());
create policy read_neverbounce_runs on public.neverbounce_runs for select to authenticated using (private.is_allowed());
-- anyone on the allowlist can approve or take back contacts waiting for a NeverBounce check
create or replace function public.set_neverbounce_approval(p_urns bigint[], p_approve boolean) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.contacts set nb_state = case when p_approve then 'approved' else 'pending' end, nb_approved_by = case when p_approve then who else null end, nb_approved_at = case when p_approve then now() else null end
    where contact_urn = any(p_urns) and nb_state in ('pending', 'approved'); get diagnostics n = row_count; return n;
end $$;
revoke all on function public.set_neverbounce_approval(bigint[], boolean) from public, anon; grant execute on function public.set_neverbounce_approval(bigint[], boolean) to authenticated;
