-- Where a practice's primary contact (manager_name, manager_title, ...) came from, so the Oscar load never wipes one chosen from the HubSpot-sourced contacts.
alter table public.gp_practices add column if not exists manager_source text check (manager_source in ('oscar', 'hubspot'));
update public.gp_practices set manager_source = 'oscar' where manager_name is not null and manager_source is null;

-- First fill from the HubSpot-sourced contacts (the daily sync keeps this up to date afterwards): the most senior decision-maker per practice who is not opted out.
with ranked as (
  select distinct on (c.ods_code) c.contact_urn, c.ods_code, c.full_name, c.job_title, c.email, c.phone,
         case when c.job_title ~* 'deputy|assistant' then 5 when c.job_title ~* 'practice\s*manager' then 1 when c.job_title ~* 'business manager|operations? manager|general manager' then 2 when c.job_title ~* 'partner' then 3 else 4 end as rk
    from public.contacts c where c.source = 'hubspot' and not c.email_opt_out and c.email is not null
   order by c.ods_code, rk, c.contact_urn)
update public.gp_practices g set manager_name = r.full_name, manager_title = r.job_title, manager_email = r.email, manager_phone = r.phone, manager_email_opt_out = false, manager_source = 'hubspot'
  from ranked r where g.ods_code = r.ods_code and g.manager_name is null;
update public.contacts k set is_primary = true from public.gp_practices g where g.manager_source = 'hubspot' and k.ods_code = g.ods_code and k.source = 'hubspot' and lower(k.email) = lower(g.manager_email);
