-- Contacts linked to a closed-lost HubSpot deal are re-engagement candidates too: keep the latest lost deal's UM Closed Lost Reasons, when it was lost and which pipeline it was in (new business = a lead, renewals = a customer, conversion = a freemium user).
alter table public.contacts add column if not exists hs_lost_reason text, add column if not exists hs_lost_at timestamptz, add column if not exists hs_lost_deal text, add column if not exists hs_lost_kind text;
create or replace function public.apply_contact_state(items jsonb) returns integer
language sql security definer set search_path = '' as $$
  with u as (
    update public.contacts c set hs_lifecycle = i.hs_lifecycle, hs_in_sequence = i.hs_in_sequence, hs_bounced = i.hs_bounced, hs_bounce_reason = i.hs_bounce_reason,
      hs_last_sent = i.hs_last_sent, hs_mkt_optout = i.hs_mkt_optout, hs_optout_all = i.hs_optout_all, hs_owner = i.hs_owner, hs_neverbounce = i.hs_neverbounce, hs_state_at = i.hs_state_at,
      hs_dq_reason = i.hs_dq_reason, hs_dq_note = i.hs_dq_note, hs_dq_at = i.hs_dq_at, hs_reengage_date = i.hs_reengage_date,
      hs_seq_id = i.hs_seq_id, hs_seq_enrolled_at = i.hs_seq_enrolled_at, hs_seq_ended_at = i.hs_seq_ended_at, hs_seq_exit = i.hs_seq_exit,
      hs_lost_reason = i.hs_lost_reason, hs_lost_at = i.hs_lost_at, hs_lost_deal = i.hs_lost_deal, hs_lost_kind = i.hs_lost_kind
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, hs_lifecycle text, hs_in_sequence boolean, hs_bounced boolean, hs_bounce_reason text, hs_last_sent timestamptz,
      hs_mkt_optout boolean, hs_optout_all boolean, hs_owner text, hs_neverbounce text, hs_state_at timestamptz, hs_dq_reason text, hs_dq_note text, hs_dq_at timestamptz, hs_reengage_date date,
      hs_seq_id text, hs_seq_enrolled_at timestamptz, hs_seq_ended_at timestamptz, hs_seq_exit text, hs_lost_reason text, hs_lost_at timestamptz, hs_lost_deal text, hs_lost_kind text)
    where c.contact_urn = i.contact_urn returning 1)
  select count(*)::integer from u;
$$;
revoke all on function public.apply_contact_state(jsonb) from public, anon, authenticated;
grant execute on function public.apply_contact_state(jsonb) to service_role;
