-- Remember which practice a contact was held at before it was moved in review, so the HubSpot note can say so.
alter table public.apollo_queue add column if not exists original_ods text;
create or replace function public.apollo_move_to_practice(p_urn bigint, p_ods text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.gp_practices where ods_code = p_ods) then raise exception 'unknown practice %', p_ods; end if;
  update public.apollo_queue set original_ods = coalesce(original_ods, ods_code), ods_code = p_ods, state = 'approved', match = 'matched', approved_by = who, approved_at = now(),
         note = 'moved to ' || p_ods || ' from review and re-queued', suggested_ods = null
    where contact_urn = p_urn and state = 'review'; get diagnostics n = row_count; return n;
end $$;
