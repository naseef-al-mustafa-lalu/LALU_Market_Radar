-- APPLIED 2026-11-26. Contacts tab KPI card: also count the eligible contacts Atlas holds that are not in HubSpot yet (they can never be in a HubSpot list until they are pushed).
create or replace function public.contacts_counts() returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object('total', count(*), 'eligible', count(*) filter (where s.status = 'eligible'), 'main', count(*) filter (where s.status = 'eligible' and s.section = 'main'),
    'other', count(*) filter (where s.status = 'eligible' and s.section = 'other'), 'suppressed', count(*) filter (where s.status = 'suppressed'), 'excluded', count(*) filter (where s.status = 'excluded'),
    'eligible_not_in_hubspot', count(*) filter (where s.status = 'eligible' and c.hubspot_contact_id is null))
  from public.contact_status s left join public.contacts c using (contact_urn);
$f$;
