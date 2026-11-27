-- Opt-in: the HubSpot segments only take people subscribed to Marketing Information, so Atlas holds back anyone HubSpot reports as NOT_SUBSCRIBED (opted out, or never opted in).
-- The status is read daily from HubSpot's communication preferences (src/subscription_sync.py); blank means not read yet, which holds nobody back.
alter table public.contact_hubspot add column if not exists hs_mkt_subscription text, add column if not exists hs_mkt_subscription_at timestamptz;

create or replace view public.contacts_full as
 SELECT c.contact_urn, c.ods_code, c.full_name, c.job_title, c.seniority, c.email, c.phone, c.email_opt_out, c.is_primary, c.updated_at, c.org_urn, c.title, c.first_name, c.last_name, c.quals, c.dept, c.categories, c.data_types, c.main_site, c.source, c.email_quality, c.role_tier, c.held_reason, c.hubspot_status, c.hubspot_imported_at, c.hubspot_contact_id,
    h.hs_lifecycle, h.hs_in_sequence, h.hs_bounced, h.hs_bounce_reason, h.hs_last_sent, h.hs_mkt_optout, h.hs_optout_all, h.hs_owner, h.hs_neverbounce, h.hs_state_at, h.hs_dq_reason, h.hs_dq_note, h.hs_dq_at, h.hs_reengage_date, h.hs_seq_id, h.hs_seq_enrolled_at, h.hs_seq_ended_at, h.hs_seq_exit, h.hs_lost_reason, h.hs_lost_at, h.hs_lost_deal, h.hs_lost_kind,
    n.nb_state, n.nb_result, n.nb_checked_at, n.nb_approved_by, n.nb_approved_at, r.reviewed_by, r.reviewed_at,
    h.hs_bounce_count, h.hs_lead_unqualified, h.hs_mkt_subscription, h.hs_mkt_subscription_at
   FROM contacts c
     LEFT JOIN contact_hubspot h USING (contact_urn)
     LEFT JOIN contact_nb n USING (contact_urn)
     LEFT JOIN contact_review r USING (contact_urn);

create or replace function public.apply_subscription_status(items jsonb) returns integer
 language sql security definer set search_path to ''
as $function$
  with u as (
    update public.contact_hubspot h set hs_mkt_subscription = i.status, hs_mkt_subscription_at = i.at
    from jsonb_to_recordset(coalesce(items, '[]'::jsonb)) as i(contact_urn bigint, status text, at timestamptz)
    where h.contact_urn = i.contact_urn and (h.hs_mkt_subscription is distinct from i.status or h.hs_mkt_subscription_at is null or h.hs_mkt_subscription_at < i.at - interval '12 hours')
    returning 1)
  select count(*)::integer from u;
$function$;
revoke all on function public.apply_subscription_status(jsonb) from public, anon, authenticated;
grant execute on function public.apply_subscription_status(jsonb) to service_role;

do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'contact_status_calc';
  if d like '%not_subscribed%' then return; end if;
  d := replace(d, 'then ''neverbounce'' end', 'then ''neverbounce'' end,
      case when coalesce((select r -> ''suppression'' ->> ''not_subscribed'' from cfg), ''true'') = ''true'' and m.hs_mkt_subscription = ''NOT_SUBSCRIBED'' then ''not_subscribed'' end');
  if d not like '%not_subscribed%' then raise exception 'patch did not apply'; end if;
  execute d;
end $$;
