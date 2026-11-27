-- Review tab, "Reveal in Apollo": close a person who was revealed by hand in Apollo but came back with no email.
create or replace function public.apollo_close_not_found(p_urn bigint) returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.apollo_queue set state = 'not_found', note = 'closed by hand: revealed in Apollo, no email came back', checked_at = now()
    where contact_urn = p_urn and state = 'approved' and note ilike 'needs reveal in Apollo%' and apollo_email is null;
  get diagnostics n = row_count; return n;
end $function$;
revoke all on function public.apollo_close_not_found(bigint) from public, anon;
grant execute on function public.apollo_close_not_found(bigint) to authenticated;
