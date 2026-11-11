-- APPLIED 2026-11-11 (via execute_sql). Full refresh of 55,973 contacts takes about 3 s; the Save button recalculates in 8 buckets.
-- Step 3b of docs/contacts-rethink.md: the database keeps contact_status current. Calculation is memoised per title and written only where it changed; refresh by all, by list, by bucket, or by HubSpot id.
create or replace function private.contact_status_calc(rules jsonb, p_only bigint[] default null, p_bucket integer default null, p_buckets integer default null) returns table (contact_urn bigint, role_id text, role_label text, section text, excluded text, reasons text[], status text)
language sql stable set search_path = '' as $f$
  with roles(id, label, def, locked) as (values ('dropped','Marked as dropped','off',true),('deputy','Deputy / assistant manager','main',false),('pm','Practice / business / general manager','main',false),('ops','Operations manager','main',false),('director','Practice / managing / executive director','main',false),('partner','GP / senior / managing partner','main',false),('pcn','PCN director or manager','main',false),('senior','Senior manager / head of','main',false),('finance','Finance, HR and business partner','other',false),('digital','Digital, IT and transformation','other',false),('services','Patient services and administration manager','other',false),('gp','GPs (not partners)','other',false),('clinical','Nurses and other clinicians','other',false),('admin','Reception, secretaries and clerks','other',false),('other','Other titles','other',false),('none','No job title','other',false)),
  cfg as materialized (select rules as r),
  locked_ids as materialized (select distinct contact_id from public.audience_members where state in ('approved', 'enrolled') and contact_id is not null),
  base0 as materialized (
    select c.*, coalesce(c.email_quality, case when c.held_reason like '%(invalid)%' then 'invalid' when c.held_reason like '%(reject)%' then 'reject' when c.held_reason like '%(no_email)%' then 'no_email' end) as eq, p.hubspot_customer as p_customer, (p.contact_ods is not null) as has_p, p.closed as p_closed,
           coalesce(nullif(c.job_title, ''), c.title, '') as ttl
    from public.contacts_full c
    left join (select ods_code as contact_ods, hubspot_customer, (merged_into is not null or status = 'Closed' or closure_confirmed_at is not null or status <> 'Active') as closed from public.gp_practices) p on p.contact_ods = c.ods_code
    where (p_only is null or c.contact_urn = any(p_only)) and (p_buckets is null or abs(c.contact_urn) % p_buckets = p_bucket)),
  tt as materialized (select d.ttl, private.ct_role(d.ttl, (select r -> 'titles' from cfg)) as rid from (select distinct ttl from base0) d),   -- one role lookup per distinct title, not per contact
  base as materialized (select b.*, tt.rid from base0 b join tt on tt.ttl = b.ttl),
  m as materialized (
    select b.*, ro.label, ro.locked,
      case when ro.locked then coalesce(nullif((select r -> 'roles' ->> b.rid from cfg), ''), ro.def)
           else coalesce(nullif((select r -> 'titleModes' ->> lower(btrim(coalesce(b.ttl, ''))) from cfg), ''), nullif((select r -> 'roles' ->> b.rid from cfg), ''), ro.def) end as mode
    from base b join roles ro on ro.id = b.rid)
  select m.contact_urn, m.rid, m.label,
    case when ex.excluded is null then m.mode end,
    case when ex.excluded is not null and m.held_reason is not null then 'held back at import: ' || m.held_reason else ex.excluded end,
    case when ex.excluded is null then rs.reasons else '{}'::text[] end,
    case when ex.excluded is not null then 'excluded' when cardinality(rs.reasons) > 0 then 'suppressed' else 'eligible' end
  from m
  cross join lateral (select case
      when m.email is null or m.eq in ('no_email', 'invalid', 'reject') then 'no usable email'
      when m.eq = 'shared' then 'shared mailbox, not a person'
      when not (m.eq = 'direct' or (m.eq = 'likely_direct' and coalesce((select r ->> 'likely' from cfg), 'false') = 'true'))
        then case when m.eq = 'likely_direct' then 'address only partly matches the name' else 'address does not clearly belong to this person' end
      when m.mode = 'off' then 'role switched off: ' || m.label
    end as excluded) ex
  cross join lateral (select array_remove(array[
      case when coalesce((select r -> 'suppression' ->> 'optout' from cfg), 'true') = 'true' and (coalesce(m.email_opt_out, false) or coalesce(m.hs_optout_all, false)) then 'optout' end,
      case when coalesce((select r -> 'suppression' ->> 'mkt_optout' from cfg), 'true') = 'true' and coalesce(m.hs_mkt_optout, false) and m.hs_last_sent is not null then 'mkt_optout' end,
      case when coalesce((select r -> 'suppression' ->> 'bounced' from cfg), 'true') = 'true' and ((coalesce(m.hs_bounced, false) and m.hs_last_sent is not null) or lower(m.hs_bounce_reason) in ('unknown_user', 'other', 'policy', 'unknown user')) then 'bounced' end,
      case when coalesce((select r -> 'suppression' ->> 'sequence' from cfg), 'true') = 'true' and coalesce(m.hs_in_sequence, false) then 'sequence' end,
      case when coalesce((select r -> 'suppression' ->> 'in_audience' from cfg), 'true') = 'true' and m.hubspot_contact_id is not null and exists (select 1 from locked_ids l where l.contact_id = m.hubspot_contact_id) then 'in_audience' end,
      case when coalesce((select r -> 'suppression' ->> 'lifecycle' from cfg), 'true') = 'true' and nullif(m.hs_lifecycle, '') is not null and m.hs_lifecycle not in ('lead', '2207373534') then 'lifecycle' end,
      case when coalesce((select r -> 'suppression' ->> 'customer' from cfg), 'true') = 'true' and coalesce(m.p_customer, false) then 'customer' end,
      case when coalesce((select r -> 'suppression' ->> 'closed' from cfg), 'true') = 'true' and coalesce(m.p_closed, false) then 'closed' end,
      case when coalesce((select r -> 'suppression' ->> 'owner' from cfg), 'true') = 'true' and nullif(m.hs_owner, '') is not null and (select r -> 'owners' from cfg) ? m.hs_owner then 'owner' end,
      case when coalesce((select r -> 'suppression' ->> 'neverbounce' from cfg), 'true') = 'true' and nullif(m.hs_neverbounce, '') is not null and (m.hs_neverbounce in ('Invalid', 'Disposable') or (coalesce((select r ->> 'strictValid' from cfg), 'false') = 'true' and m.hs_neverbounce <> 'Valid')) then 'neverbounce' end
    ], null) as reasons) rs;
$f$;


create or replace function private.contact_status_rows(rules jsonb) returns table (contact_urn bigint, role_id text, role_label text, section text, excluded text, reasons text[], status text)
language sql stable set search_path = '' as $f$ select * from private.contact_status_calc(rules); $f$;

-- Recalculate (only what changed is written). All contacts, a list of contacts, or one bucket of contacts (the Save button recalculates in buckets so no request runs long).
create or replace function private.refresh_status(p_urns bigint[] default null, p_bucket integer default null, p_buckets integer default null) returns integer language plpgsql security definer set search_path = '' as $f$
declare n integer; rules jsonb := coalesce((select value from public.app_flags where key = 'contact_rules'), '{}'::jsonb);
begin
  insert into public.contact_status as t (contact_urn, role_id, role_label, section, excluded, reasons, status, evaluated_at)
    select contact_urn, role_id, role_label, section, excluded, reasons, status, now() from private.contact_status_calc(rules, p_urns, p_bucket, p_buckets)
    on conflict (contact_urn) do update set role_id = excluded.role_id, role_label = excluded.role_label, section = excluded.section, excluded = excluded.excluded, reasons = excluded.reasons, status = excluded.status, evaluated_at = excluded.evaluated_at
      where (t.role_id, t.role_label, t.section, t.excluded, t.reasons, t.status) is distinct from (excluded.role_id, excluded.role_label, excluded.section, excluded.excluded, excluded.reasons, excluded.status);
  get diagnostics n = row_count; return n;
end $f$;
revoke all on function private.refresh_status(bigint[], integer, integer) from public, anon, authenticated;

create or replace function public.refresh_contact_status() returns integer language plpgsql security definer set search_path = '' as $f$
begin
  if auth.uid() is not null and not private.is_allowed() then raise exception 'not allowed'; end if;
  return private.refresh_status();
end $f$;
create or replace function public.refresh_contact_status_bucket(p_bucket integer, p_buckets integer) returns integer language plpgsql security definer set search_path = '' as $f$
begin
  if auth.uid() is not null and not private.is_allowed() then raise exception 'not allowed'; end if;
  return private.refresh_status(null, p_bucket, p_buckets);
end $f$;
create or replace function public.refresh_contact_status_hubspot(p_ids text[]) returns integer language plpgsql security definer set search_path = '' as $f$
begin
  if auth.uid() is not null and not private.is_allowed() then raise exception 'not allowed'; end if;
  return private.refresh_status((select array_agg(contact_urn) from public.contacts where hubspot_contact_id = any(p_ids)));
end $f$;
revoke all on function public.refresh_contact_status_bucket(integer, integer) from public, anon;
revoke all on function public.refresh_contact_status_hubspot(text[]) from public, anon;
grant execute on function public.refresh_contact_status_bucket(integer, integer) to authenticated, service_role;
grant execute on function public.refresh_contact_status_hubspot(text[]) to authenticated, service_role;

-- a review decision changes the contact's answer at once
create or replace function public.review_contact(p_urns bigint[], p_action text) returns integer language plpgsql security definer set search_path = public as $$
declare n integer; who text := coalesce((select email from auth.users where id = auth.uid()), 'unknown');
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  if p_action = 'accept' then
    update public.contacts set email_quality = 'direct', held_reason = null where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    insert into public.contact_nb (contact_urn, nb_state)
      select c.contact_urn, 'pending' from public.contacts c where c.contact_urn = any(p_urns) and c.source = 'oscar' and c.hubspot_contact_id is null and coalesce(c.email_opt_out, false) = false and c.role_tier in ('A', 'B')
      on conflict (contact_urn) do update set nb_state = 'pending' where public.contact_nb.nb_state is null;
  elsif p_action = 'reject' then
    update public.contacts set held_reason = 'rejected in review' where contact_urn = any(p_urns);
    get diagnostics n = row_count;
    update public.contact_nb set nb_state = 'skipped' where contact_urn = any(p_urns) and nb_state in ('pending', 'approved');
  else raise exception 'unknown action'; end if;
  insert into public.contact_review (contact_urn, reviewed_by, reviewed_at)
    select c.contact_urn, who, now() from public.contacts c where c.contact_urn = any(p_urns)
    on conflict (contact_urn) do update set reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;
  perform private.refresh_status(p_urns);
  return n;
end $$;
