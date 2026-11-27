-- Atlas holds back everything the three HubSpot exclusion lists (3428 Campaign Exclusion, 4570 Data Hygiene, 3796 Owner exclusion) do:
--  * owner: the four owners in list 3796 (contact_rules.owners)
--  * bounces: three or more marketing bounces (hs_bounce_count) hold a contact back, whatever the bounce type
--  * unqualified lead: an associated lead in an Unqualified stage counts as disqualified (hs_lead_unqualified)
--  * Marketing Information opt-out holds a contact back whether or not a marketing email was ever sent (list 4570 has no send-date condition)
alter table public.contact_hubspot add column if not exists hs_bounce_count integer, add column if not exists hs_lead_unqualified boolean;

update public.app_flags set value = jsonb_set(value, '{owners}', '["8768100","29755472","78343211","9112363"]'::jsonb) where key = 'contact_rules';

create or replace view public.contacts_full as
 SELECT c.contact_urn, c.ods_code, c.full_name, c.job_title, c.seniority, c.email, c.phone, c.email_opt_out, c.is_primary, c.updated_at, c.org_urn, c.title, c.first_name, c.last_name, c.quals, c.dept, c.categories, c.data_types, c.main_site, c.source, c.email_quality, c.role_tier, c.held_reason, c.hubspot_status, c.hubspot_imported_at, c.hubspot_contact_id,
    h.hs_lifecycle, h.hs_in_sequence, h.hs_bounced, h.hs_bounce_reason, h.hs_last_sent, h.hs_mkt_optout, h.hs_optout_all, h.hs_owner, h.hs_neverbounce, h.hs_state_at, h.hs_dq_reason, h.hs_dq_note, h.hs_dq_at, h.hs_reengage_date, h.hs_seq_id, h.hs_seq_enrolled_at, h.hs_seq_ended_at, h.hs_seq_exit, h.hs_lost_reason, h.hs_lost_at, h.hs_lost_deal, h.hs_lost_kind,
    n.nb_state, n.nb_result, n.nb_checked_at, n.nb_approved_by, n.nb_approved_at, r.reviewed_by, r.reviewed_at,
    h.hs_bounce_count, h.hs_lead_unqualified
   FROM contacts c
     LEFT JOIN contact_hubspot h USING (contact_urn)
     LEFT JOIN contact_nb n USING (contact_urn)
     LEFT JOIN contact_review r USING (contact_urn);

create or replace function public.apply_contact_state(items jsonb) returns integer
 language sql security definer set search_path to ''
as $function$
  with u as (
    insert into public.contact_hubspot (contact_urn, hs_lifecycle, hs_in_sequence, hs_bounced, hs_bounce_reason, hs_last_sent, hs_mkt_optout, hs_optout_all, hs_owner, hs_neverbounce, hs_state_at, hs_dq_reason, hs_dq_note, hs_dq_at, hs_reengage_date, hs_seq_id, hs_seq_enrolled_at, hs_seq_ended_at, hs_seq_exit, hs_lost_reason, hs_lost_at, hs_lost_deal, hs_lost_kind, hs_bounce_count, hs_lead_unqualified)
    select i.contact_urn, i.hs_lifecycle, i.hs_in_sequence, i.hs_bounced, i.hs_bounce_reason, i.hs_last_sent, i.hs_mkt_optout, i.hs_optout_all, i.hs_owner, i.hs_neverbounce, i.hs_state_at, i.hs_dq_reason, i.hs_dq_note, i.hs_dq_at, i.hs_reengage_date, i.hs_seq_id, i.hs_seq_enrolled_at, i.hs_seq_ended_at, i.hs_seq_exit, i.hs_lost_reason, i.hs_lost_at, i.hs_lost_deal, i.hs_lost_kind, i.hs_bounce_count, i.hs_lead_unqualified
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, hs_lifecycle text, hs_in_sequence boolean, hs_bounced boolean, hs_bounce_reason text, hs_last_sent timestamptz, hs_mkt_optout boolean, hs_optout_all boolean, hs_owner text, hs_neverbounce text, hs_state_at timestamptz, hs_dq_reason text, hs_dq_note text, hs_dq_at timestamptz, hs_reengage_date date, hs_seq_id text, hs_seq_enrolled_at timestamptz, hs_seq_ended_at timestamptz, hs_seq_exit text, hs_lost_reason text, hs_lost_at timestamptz, hs_lost_deal text, hs_lost_kind text, hs_bounce_count integer, hs_lead_unqualified boolean)
    where exists (select 1 from public.contacts c where c.contact_urn = i.contact_urn)
    on conflict (contact_urn) do update set hs_lifecycle = excluded.hs_lifecycle, hs_in_sequence = excluded.hs_in_sequence, hs_bounced = excluded.hs_bounced, hs_bounce_reason = excluded.hs_bounce_reason, hs_last_sent = excluded.hs_last_sent, hs_mkt_optout = excluded.hs_mkt_optout, hs_optout_all = excluded.hs_optout_all, hs_owner = excluded.hs_owner, hs_neverbounce = excluded.hs_neverbounce, hs_state_at = excluded.hs_state_at, hs_dq_reason = excluded.hs_dq_reason, hs_dq_note = excluded.hs_dq_note, hs_dq_at = excluded.hs_dq_at, hs_reengage_date = excluded.hs_reengage_date, hs_seq_id = excluded.hs_seq_id, hs_seq_enrolled_at = excluded.hs_seq_enrolled_at, hs_seq_ended_at = excluded.hs_seq_ended_at, hs_seq_exit = excluded.hs_seq_exit, hs_lost_reason = excluded.hs_lost_reason, hs_lost_at = excluded.hs_lost_at, hs_lost_deal = excluded.hs_lost_deal, hs_lost_kind = excluded.hs_lost_kind, hs_bounce_count = excluded.hs_bounce_count, hs_lead_unqualified = excluded.hs_lead_unqualified
    returning 1)
  select count(*)::integer from u;
$function$;
revoke all on function public.apply_contact_state(jsonb) from public, anon, authenticated;
grant execute on function public.apply_contact_state(jsonb) to service_role;

do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'contact_status_calc';
  if d like '%hs_bounce_count%' then return; end if;
  d := replace(d, 'and (private.bounce_type(', 'and (coalesce(m.hs_bounce_count, 0) >= 3 or private.bounce_type(');
  d := replace(d, 'coalesce(m.hs_mkt_optout, false) and m.hs_last_sent is not null', 'coalesce(m.hs_mkt_optout, false)');
  d := replace(d, 'coalesce(hs_mkt_optout, false) and hs_last_sent is not null', 'coalesce(hs_mkt_optout, false)');
  d := replace(d, 'nullif(m.hs_dq_reason, '''') is not null then ''disqualified''', '(nullif(m.hs_dq_reason, '''') is not null or coalesce(m.hs_lead_unqualified, false)) then ''disqualified''');
  if d not like '%hs_bounce_count%' or d not like '%hs_lead_unqualified%' or d like '%hs_mkt_optout, false) and%' then raise exception 'patch did not apply'; end if;
  execute d;
end $$;
