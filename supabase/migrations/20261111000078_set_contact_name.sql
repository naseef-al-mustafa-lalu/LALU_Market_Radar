-- Review: give a contact with no name its name before accepting it. Gated like the other review functions.
create or replace function public.set_contact_name(p_urn bigint, p_first text, p_last text) returns integer
language plpgsql security definer set search_path = public as $f$
declare f text := nullif(btrim(coalesce(p_first, '')), ''), l text := nullif(btrim(coalesce(p_last, '')), ''); n integer;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  update public.contacts set first_name = f, last_name = l, full_name = nullif(btrim(coalesce(f, '') || ' ' || coalesce(l, '')), ''), updated_at = now() where contact_urn = p_urn;
  get diagnostics n = row_count; return n;
end $f$;
revoke all on function public.set_contact_name(bigint, text, text) from public, anon;
grant execute on function public.set_contact_name(bigint, text, text) to authenticated;
