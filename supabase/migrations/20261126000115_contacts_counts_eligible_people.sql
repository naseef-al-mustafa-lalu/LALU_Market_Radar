-- APPLIED 2026-11-26. Contacts summary card: the usable contacts are practice listings (one row per person per practice); also count the different people behind them (by email address).
create or replace function public.contacts_counts() returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object('total', count(*), 'eligible', count(*) filter (where s.status = 'eligible'), 'main', count(*) filter (where s.status = 'eligible' and s.section = 'main'),
    'other', count(*) filter (where s.status = 'eligible' and s.section = 'other'), 'suppressed', count(*) filter (where s.status = 'suppressed'), 'excluded', count(*) filter (where s.status = 'excluded'),
    'eligible_not_in_hubspot', count(*) filter (where s.status = 'eligible' and c.hubspot_contact_id is null),
    'eligible_people', count(distinct lower(c.email)) filter (where s.status = 'eligible' and c.email is not null))
  from public.contact_status s left join public.contacts c using (contact_urn);
$f$;
