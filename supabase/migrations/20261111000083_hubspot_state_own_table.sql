-- NOT YET APPLIED: needs a confirmation in Supabase (drops a view and three columns). Apply before the next HubSpot sync.
-- Step 2b-2 of docs/contacts-rethink.md: the HubSpot state (hs_*) is written only to contact_hubspot, by apply_contact_state (sync) and the NeverBounce result. The link to HubSpot (hubspot_contact_id, hubspot_status, hubspot_imported_at) stays on contacts because the Oscar load, the import and the sync all use it.
create or replace function public.apply_contact_state(items jsonb) returns integer
language sql security definer set search_path = '' as $$
  with u as (
    insert into public.contact_hubspot (contact_urn, hs_lifecycle, hs_in_sequence, hs_bounced, hs_bounce_reason, hs_last_sent, hs_mkt_optout, hs_optout_all, hs_owner, hs_neverbounce, hs_state_at, hs_dq_reason, hs_dq_note, hs_dq_at, hs_reengage_date, hs_seq_id, hs_seq_enrolled_at, hs_seq_ended_at, hs_seq_exit, hs_lost_reason, hs_lost_at, hs_lost_deal, hs_lost_kind)
    select i.contact_urn, i.hs_lifecycle, i.hs_in_sequence, i.hs_bounced, i.hs_bounce_reason, i.hs_last_sent, i.hs_mkt_optout, i.hs_optout_all, i.hs_owner, i.hs_neverbounce, i.hs_state_at, i.hs_dq_reason, i.hs_dq_note, i.hs_dq_at, i.hs_reengage_date, i.hs_seq_id, i.hs_seq_enrolled_at, i.hs_seq_ended_at, i.hs_seq_exit, i.hs_lost_reason, i.hs_lost_at, i.hs_lost_deal, i.hs_lost_kind
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, hs_lifecycle text, hs_in_sequence boolean, hs_bounced boolean, hs_bounce_reason text, hs_last_sent timestamptz, hs_mkt_optout boolean, hs_optout_all boolean, hs_owner text, hs_neverbounce text, hs_state_at timestamptz, hs_dq_reason text, hs_dq_note text, hs_dq_at timestamptz, hs_reengage_date date, hs_seq_id text, hs_seq_enrolled_at timestamptz, hs_seq_ended_at timestamptz, hs_seq_exit text, hs_lost_reason text, hs_lost_at timestamptz, hs_lost_deal text, hs_lost_kind text)
    where exists (select 1 from public.contacts c where c.contact_urn = i.contact_urn)
    on conflict (contact_urn) do update set hs_lifecycle = excluded.hs_lifecycle, hs_in_sequence = excluded.hs_in_sequence, hs_bounced = excluded.hs_bounced, hs_bounce_reason = excluded.hs_bounce_reason, hs_last_sent = excluded.hs_last_sent, hs_mkt_optout = excluded.hs_mkt_optout, hs_optout_all = excluded.hs_optout_all, hs_owner = excluded.hs_owner, hs_neverbounce = excluded.hs_neverbounce, hs_state_at = excluded.hs_state_at, hs_dq_reason = excluded.hs_dq_reason, hs_dq_note = excluded.hs_dq_note, hs_dq_at = excluded.hs_dq_at, hs_reengage_date = excluded.hs_reengage_date, hs_seq_id = excluded.hs_seq_id, hs_seq_enrolled_at = excluded.hs_seq_enrolled_at, hs_seq_ended_at = excluded.hs_seq_ended_at, hs_seq_exit = excluded.hs_seq_exit, hs_lost_reason = excluded.hs_lost_reason, hs_lost_at = excluded.hs_lost_at, hs_lost_deal = excluded.hs_lost_deal, hs_lost_kind = excluded.hs_lost_kind
    returning 1)
  select count(*)::integer from u;
$$;
revoke all on function public.apply_contact_state(jsonb) from public, anon, authenticated;
grant execute on function public.apply_contact_state(jsonb) to service_role;

drop trigger if exists contacts_mirror_sides on public.contacts;
create or replace function private.mirror_contact_sides() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.contact_review (contact_urn,reviewed_by,reviewed_at) values (new.contact_urn,new.reviewed_by,new.reviewed_at)
    on conflict (contact_urn) do update set reviewed_by=excluded.reviewed_by, reviewed_at=excluded.reviewed_at;
  return null;
end $f$;
create trigger contacts_mirror_sides after insert or update of reviewed_by,reviewed_at on public.contacts for each row execute function private.mirror_contact_sides();

drop view if exists public.contacts_full;
alter table public.contact_hubspot drop column if exists hubspot_status, drop column if exists hubspot_imported_at, drop column if exists hubspot_contact_id;
create view public.contacts_full with (security_invoker = true) as select c.contact_urn, c.ods_code, c.full_name, c.job_title, c.seniority, c.email, c.phone, c.email_opt_out, c.is_primary, c.updated_at, c.org_urn, c.title, c.first_name, c.last_name, c.quals, c.dept, c.categories, c.data_types, c.main_site, c.source, c.email_quality, c.role_tier, c.held_reason, c.hubspot_status, c.hubspot_imported_at, c.hubspot_contact_id, h.hs_lifecycle, h.hs_in_sequence, h.hs_bounced, h.hs_bounce_reason, h.hs_last_sent, h.hs_mkt_optout, h.hs_optout_all, h.hs_owner, h.hs_neverbounce, h.hs_state_at, h.hs_dq_reason, h.hs_dq_note, h.hs_dq_at, h.hs_reengage_date, h.hs_seq_id, h.hs_seq_enrolled_at, h.hs_seq_ended_at, h.hs_seq_exit, h.hs_lost_reason, h.hs_lost_at, h.hs_lost_deal, h.hs_lost_kind, n.nb_state, n.nb_result, n.nb_checked_at, n.nb_approved_by, n.nb_approved_at, r.reviewed_by, r.reviewed_at
 from public.contacts c left join public.contact_hubspot h using (contact_urn) left join public.contact_nb n using (contact_urn) left join public.contact_review r using (contact_urn);

create or replace function public.contact_sides_check() returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object('contacts',(select count(*) from public.contacts),
    'with_hubspot_state',(select count(*) from public.contact_hubspot),
    'with_nb',(select count(*) from public.contact_nb),
    'missing_review',(select count(*) from public.contacts c where not exists (select 1 from public.contact_review x where x.contact_urn=c.contact_urn)),
    'review_differs',(select count(*) from public.contacts c join public.contact_review r using (contact_urn) where c.reviewed_by is distinct from r.reviewed_by));
$f$;
