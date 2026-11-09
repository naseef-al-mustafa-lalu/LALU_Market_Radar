-- Contact review decisions (accept an address as the person's, or reject the contact) and which HubSpot segments Atlas tracks.
alter table public.contacts add column if not exists reviewed_by text, add column if not exists reviewed_at timestamptz;
create or replace function public.review_contact(p_urns bigint[], p_action text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if p_action = 'accept' then
    update public.contacts set email_quality = 'direct', held_reason = null, reviewed_by = who, reviewed_at = now(),
      nb_state = case when nb_state is null and source = 'oscar' and hubspot_contact_id is null and coalesce(email_opt_out, false) = false and role_tier in ('A', 'B') then 'pending' else nb_state end
      where contact_urn = any(p_urns);
  elsif p_action = 'reject' then
    update public.contacts set held_reason = 'rejected in review', nb_state = case when nb_state in ('pending', 'approved') then 'skipped' else nb_state end, reviewed_by = who, reviewed_at = now() where contact_urn = any(p_urns);
  else raise exception 'unknown action'; end if;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.review_contact(bigint[], text) from public, anon; grant execute on function public.review_contact(bigint[], text) to authenticated;
create or replace function public.set_segment_tracked(p_list text, p_tracked boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.hubspot_segments set tracked = p_tracked where list_id = p_list;
end $$;
revoke all on function public.set_segment_tracked(text, boolean) from public, anon; grant execute on function public.set_segment_tracked(text, boolean) to authenticated;
