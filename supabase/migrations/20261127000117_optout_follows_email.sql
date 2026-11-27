-- An opt-out belongs to the email address, not to one Atlas row: if any contact with this email has opted out
-- (email opt-out, HubSpot unsubscribed from all, or marketing opt-out after a send), every row with that email is suppressed.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'contact_status_calc';
  if d like '%oe_o%' then return; end if;
  d := replace(d, 'locked_ids as materialized (',
    'oe as materialized (select lower(email) as em, bool_or(coalesce(email_opt_out, false) or coalesce(hs_optout_all, false)) as o, bool_or(coalesce(hs_mkt_optout, false) and hs_last_sent is not null) as mo from public.contacts_full where email is not null group by 1),
  locked_ids as materialized (');
  d := replace(d, 'as p_closed,
           coalesce(nullif(c.job_title', 'as p_closed, coalesce(oe.o, false) as oe_o, coalesce(oe.mo, false) as oe_mo,
           coalesce(nullif(c.job_title');
  d := replace(d, 'from public.contacts_full c
    left join (select ods_code', 'from public.contacts_full c
    left join oe on oe.em = lower(c.email)
    left join (select ods_code');
  d := replace(d, '(coalesce(m.email_opt_out, false) or coalesce(m.hs_optout_all, false))', '(coalesce(m.email_opt_out, false) or coalesce(m.hs_optout_all, false) or m.oe_o)');
  d := replace(d, 'coalesce(m.hs_mkt_optout, false) and m.hs_last_sent is not null then', '((coalesce(m.hs_mkt_optout, false) and m.hs_last_sent is not null) or m.oe_mo) then');
  if d not like '%m.oe_o)%' or d not like '%m.oe_mo)%' or d not like '%left join oe on%' or d not like '%as oe_o%' then raise exception 'patch did not apply'; end if;
  execute d;
end $$;
