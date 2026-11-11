-- NOT YET APPLIED (Supabase confirmation timed out). After applying: select public.refresh_contact_status(); then compare with the browser.
-- Step 3 of docs/contacts-rethink.md: the contact rules ported once into the database. Reads the same settings the Settings screen saves (app_flags.contact_rules) and stores each contact's answer in contact_status. The browser still computes its own answer until the two have been compared.
create or replace function private.ct_role(title text, titles jsonb) returns text language plpgsql stable set search_path = '' as $f$
declare t text := btrim(coalesce(title, '')); m text;
begin
  if t = '' then return 'none'; end if;
  m := titles ->> lower(t);
  if m in ('dropped','deputy','pm','ops','director','partner','pcn','senior','finance','digital','services','gp','clinical','admin','other') then return m; end if;
  return case
    when t ~* 'dropped on' then 'dropped'
    when t ~* '(deputy|assistant).*(manager|director)|(manager|director).*(deputy|assistant)' then 'deputy'
    when t ~* 'practice\s*/?\s*(business\s*)?manager|business\s*/?\s*practice\s*manager|general\s*(practice\s*)?manager|business manager|site manager|surgery manager|office manager|^manager$' then 'pm'
    when t ~* 'operations?\s*manager|operational manager' then 'ops'
    when t ~* 'practice director|managing director|executive (manager|director)|chief (executive|operating)|^director$' then 'director'
    when t ~* '(?<!business\s)(?<!finance\s)partner(?!ship)' then 'partner'
    when t ~* 'pcn\s*(clinical\s*)?(director|manager|lead)|network (director|manager)|clinical director' then 'pcn'
    when t ~* 'senior\s+\w*\s*manager|head of|service (manager|lead)|(group|area|hub|cluster|regional)\s+\w*\s*manager' then 'senior'
    when t ~* 'finance|account|payroll|\yhr\y|human resources|business partner|procurement' then 'finance'
    when t ~* 'digital|\yit\y|information|informatics|systems|data\y|transformation|innovation|project' then 'digital'
    when t ~* 'patient services|administration manager|admin(istrat\w+)? (lead|manager)|reception manager|care navigat|team leader|supervisor' then 'services'
    when t ~* '\ygp\y|general practitioner|doctor|\ydr\.?\y|salaried|locum|registrar|trainee' then 'gp'
    when t ~* 'nurse|anp\y|practitioner|paramedic|pharmac|physio|health ?care assistant|\yhca\y|phlebot|midwi|dietit|therapist' then 'clinical'
    when t ~* 'reception|secretar|clerk|summar|coder|dispens|care coordinator|administrator|admin\y|assistant' then 'admin'
    else 'other' end;
end $f$;

create table if not exists public.contact_status (
  contact_urn bigint primary key references public.contacts(contact_urn) on delete cascade,
  role_id text not null, role_label text not null, section text, excluded text, reasons text[] not null default '{}', status text not null, evaluated_at timestamptz not null default now());
alter table public.contact_status enable row level security;
create policy read_contact_status on public.contact_status for select to authenticated using ((select private.is_allowed()));

create or replace function private.contact_status_rows(rules jsonb) returns table (contact_urn bigint, role_id text, role_label text, section text, excluded text, reasons text[], status text)
language sql stable set search_path = '' as $f$
  with roles(id, label, def, locked) as (values ('dropped','Marked as dropped','off',true),('deputy','Deputy / assistant manager','main',false),('pm','Practice / business / general manager','main',false),('ops','Operations manager','main',false),('director','Practice / managing / executive director','main',false),('partner','GP / senior / managing partner','main',false),('pcn','PCN director or manager','main',false),('senior','Senior manager / head of','main',false),('finance','Finance, HR and business partner','other',false),('digital','Digital, IT and transformation','other',false),('services','Patient services and administration manager','other',false),('gp','GPs (not partners)','other',false),('clinical','Nurses and other clinicians','other',false),('admin','Reception, secretaries and clerks','other',false),('other','Other titles','other',false),('none','No job title','other',false)),
  cfg as (select rules as r),
  locked_ids as (select distinct contact_id from public.audience_members where state in ('approved', 'enrolled') and contact_id is not null),
  base as (
    select c.*, p.hubspot_customer as p_customer, (p.contact_ods is not null) as has_p, p.closed as p_closed,
           private.ct_role(coalesce(nullif(c.job_title, ''), c.title), (select r -> 'titles' from cfg)) as rid,
           coalesce(nullif(c.job_title, ''), c.title) as ttl
    from public.contacts_full c
    left join (select ods_code as contact_ods, hubspot_customer, (merged_into is not null or status = 'Closed' or closure_confirmed_at is not null or status <> 'Active') as closed from public.gp_practices) p on p.contact_ods = c.ods_code),
  m as (
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
      when m.email is null or m.email_quality in ('no_email', 'invalid', 'reject') then 'no usable email'
      when m.email_quality = 'shared' then 'shared mailbox, not a person'
      when not (m.email_quality = 'direct' or (m.email_quality = 'likely_direct' and coalesce((select r ->> 'likely' from cfg), 'false') = 'true'))
        then case when m.email_quality = 'likely_direct' then 'address only partly matches the name' else 'address does not clearly belong to this person' end
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

create or replace function public.refresh_contact_status() returns integer language plpgsql security definer set search_path = '' as $f$
declare n integer; rules jsonb := coalesce((select value from public.app_flags where key = 'contact_rules'), '{}'::jsonb);
begin
  if auth.uid() is not null and not private.is_allowed() then raise exception 'not allowed'; end if;
  delete from public.contact_status where true;
  insert into public.contact_status (contact_urn, role_id, role_label, section, excluded, reasons, status)
    select contact_urn, role_id, role_label, section, excluded, reasons, status from private.contact_status_rows(rules);
  get diagnostics n = row_count; return n;
end $f$;
revoke all on function public.refresh_contact_status() from public, anon;
grant execute on function public.refresh_contact_status() to authenticated, service_role;
