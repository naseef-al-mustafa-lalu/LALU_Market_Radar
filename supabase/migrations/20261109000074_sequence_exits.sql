-- When a contact leaves a HubSpot sequence (a reply, a booked call, an unsubscribe, a bounce, or the sequence simply finishing) Atlas records when and why. HubSpot does the unenrolling itself; Atlas only keeps the record.
alter table public.contacts add column if not exists hs_seq_id text, add column if not exists hs_seq_enrolled_at timestamptz, add column if not exists hs_seq_ended_at timestamptz, add column if not exists hs_seq_exit text;
alter table public.audience_members add column if not exists exit_reason text, add column if not exists exited_at timestamptz;
create or replace function public.apply_contact_state(items jsonb) returns integer
language sql security definer set search_path = '' as $$
  with u as (
    update public.contacts c set hs_lifecycle = i.hs_lifecycle, hs_in_sequence = i.hs_in_sequence, hs_bounced = i.hs_bounced, hs_bounce_reason = i.hs_bounce_reason,
      hs_last_sent = i.hs_last_sent, hs_mkt_optout = i.hs_mkt_optout, hs_optout_all = i.hs_optout_all, hs_owner = i.hs_owner, hs_neverbounce = i.hs_neverbounce, hs_state_at = i.hs_state_at,
      hs_dq_reason = i.hs_dq_reason, hs_dq_note = i.hs_dq_note, hs_dq_at = i.hs_dq_at, hs_reengage_date = i.hs_reengage_date,
      hs_seq_id = i.hs_seq_id, hs_seq_enrolled_at = i.hs_seq_enrolled_at, hs_seq_ended_at = i.hs_seq_ended_at, hs_seq_exit = i.hs_seq_exit
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, hs_lifecycle text, hs_in_sequence boolean, hs_bounced boolean, hs_bounce_reason text, hs_last_sent timestamptz,
      hs_mkt_optout boolean, hs_optout_all boolean, hs_owner text, hs_neverbounce text, hs_state_at timestamptz, hs_dq_reason text, hs_dq_note text, hs_dq_at timestamptz, hs_reengage_date date,
      hs_seq_id text, hs_seq_enrolled_at timestamptz, hs_seq_ended_at timestamptz, hs_seq_exit text)
    where c.contact_urn = i.contact_urn returning 1)
  select count(*)::integer from u;
$$;
revoke all on function public.apply_contact_state(jsonb) from public, anon, authenticated;
grant execute on function public.apply_contact_state(jsonb) to service_role;
