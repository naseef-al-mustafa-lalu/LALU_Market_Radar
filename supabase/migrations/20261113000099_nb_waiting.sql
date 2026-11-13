-- APPLIED 2026-11-13. How many contacts passed NeverBounce but are not in HubSpot yet (they wait for a push: automatic, or the button in Contacts > Settings).
create or replace function public.contacts_nb_waiting() returns integer language plpgsql stable security definer set search_path = '' as $f$
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  return (select count(*) from public.contacts c join public.contact_nb n using (contact_urn)
           where n.nb_state = 'checked' and n.nb_result in ('Valid', 'Accept All (Unverifiable)') and c.hubspot_contact_id is null and c.email is not null);
end $f$;
revoke all on function public.contacts_nb_waiting() from public, anon;
grant execute on function public.contacts_nb_waiting() to authenticated;
comment on function public.contacts_nb_waiting() is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it.';
