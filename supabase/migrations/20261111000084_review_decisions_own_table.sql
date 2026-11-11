-- APPLIED 2026-11-11. Step 2b-3 of docs/contacts-rethink.md: review decisions (who accepted or rejected, when) are written only to contact_review by review_contact; the Oscar load reads them from there. The copy trigger is now a no-op and is dropped in the final cleanup.
create or replace function public.review_contact(p_urns bigint[], p_action text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if p_action = 'accept' then
    update public.contacts set email_quality = 'direct', held_reason = null where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    insert into public.contact_nb (contact_urn, nb_state)
      select c.contact_urn, 'pending' from public.contacts c where c.contact_urn = any(p_urns) and c.source = 'oscar' and c.hubspot_contact_id is null and coalesce(c.email_opt_out, false) = false and c.role_tier in ('A', 'B')
      on conflict (contact_urn) do update set nb_state = 'pending' where public.contact_nb.nb_state is null;
  elsif p_action = 'reject' then
    update public.contacts set held_reason = 'rejected in review' where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    update public.contact_nb set nb_state = 'skipped' where contact_urn = any(p_urns) and nb_state in ('pending', 'approved');
  else raise exception 'unknown action'; end if;
  insert into public.contact_review (contact_urn, reviewed_by, reviewed_at)
    select c.contact_urn, who, now() from public.contacts c where c.contact_urn = any(p_urns)
    on conflict (contact_urn) do update set reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;
  return n;
end $$;
create or replace function private.mirror_contact_sides() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  return null;
end $f$;
