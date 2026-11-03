-- What HubSpot knows about each contact, kept beside it in Atlas so campaign eligibility (suppression rules) can be worked out without calling HubSpot: lifecycle stage,
-- whether the contact is in a sequence, bounces, unsubscribes, owner and NeverBounce status. Filled by the daily HubSpot sync for contacts that have a HubSpot id.
-- Nothing is written back to HubSpot: suppression is decided in Atlas.
alter table public.contacts
  add column if not exists hs_lifecycle text,
  add column if not exists hs_in_sequence boolean,
  add column if not exists hs_bounced boolean,
  add column if not exists hs_bounce_reason text,
  add column if not exists hs_last_sent timestamptz,
  add column if not exists hs_mkt_optout boolean,
  add column if not exists hs_optout_all boolean,
  add column if not exists hs_owner text,
  add column if not exists hs_neverbounce text,
  add column if not exists hs_state_at timestamptz;

create or replace function public.apply_contact_state(items jsonb) returns integer
language sql security definer set search_path = '' as $$
  with u as (
    update public.contacts c set hs_lifecycle = i.hs_lifecycle, hs_in_sequence = i.hs_in_sequence, hs_bounced = i.hs_bounced, hs_bounce_reason = i.hs_bounce_reason,
      hs_last_sent = i.hs_last_sent, hs_mkt_optout = i.hs_mkt_optout, hs_optout_all = i.hs_optout_all, hs_owner = i.hs_owner, hs_neverbounce = i.hs_neverbounce, hs_state_at = i.hs_state_at
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, hs_lifecycle text, hs_in_sequence boolean, hs_bounced boolean, hs_bounce_reason text, hs_last_sent timestamptz,
      hs_mkt_optout boolean, hs_optout_all boolean, hs_owner text, hs_neverbounce text, hs_state_at timestamptz)
    where c.contact_urn = i.contact_urn returning 1)
  select count(*)::integer from u;
$$;
revoke all on function public.apply_contact_state(jsonb) from public, anon, authenticated;
grant execute on function public.apply_contact_state(jsonb) to service_role;
