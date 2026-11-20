-- A contact Apollo has at a different organisation than the practice we hold them at goes to a review list (state 'review'): someone moves them to the matching practice and re-queues them for enrichment.
alter table public.apollo_queue drop constraint if exists apollo_queue_state_check;
alter table public.apollo_queue add constraint apollo_queue_state_check check (state in ('pending', 'approved', 'found', 'not_found', 'error', 'review'));
alter table public.apollo_queue add column if not exists apollo_org_info jsonb;       -- what Apollo says about the organisation: name, domain, city, postcode
alter table public.apollo_queue add column if not exists suggested_ods jsonb;         -- practices that look like Apollo's organisation: [{ods_code, practice_name}]
create or replace function public.apollo_move_to_practice(p_urn bigint, p_ods text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.gp_practices where ods_code = p_ods) then raise exception 'unknown practice %', p_ods; end if;
  update public.apollo_queue set ods_code = p_ods, state = 'approved', match = 'matched', approved_by = who, approved_at = now(), note = 'moved to ' || p_ods || ' from review and re-queued', suggested_ods = null
    where contact_urn = p_urn and state = 'review'; get diagnostics n = row_count; return n;
end $$;
create or replace function public.apollo_dismiss_review(p_urns bigint[]) returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.apollo_queue set state = 'not_found', note = 'dismissed from review: not the same person or practice', checked_at = now() where contact_urn = any(p_urns) and state = 'review'; get diagnostics n = row_count; return n;
end $$;
revoke all on function public.apollo_move_to_practice(bigint, text) from public, anon;
revoke all on function public.apollo_dismiss_review(bigint[]) from public, anon;
grant execute on function public.apollo_move_to_practice(bigint, text) to authenticated;
grant execute on function public.apollo_dismiss_review(bigint[]) to authenticated;
