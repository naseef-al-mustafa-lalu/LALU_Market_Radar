-- "Not found" on the Review tab also closes people who hold an address Apollo's API gave but that the person did not confirm (a note of needs reveal, or matched with no person id).
create or replace function public.apollo_close_not_found(p_urn bigint) returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.apollo_queue set state = 'not_found', note = 'closed by hand: revealed in Apollo, no email came back', checked_at = now()
    where contact_urn = p_urn and state = 'approved' and (note ilike 'needs reveal in Apollo%' or note ilike 'matched at the practice, but Apollo gave no person id%');
  get diagnostics n = row_count; return n;
end $function$;
