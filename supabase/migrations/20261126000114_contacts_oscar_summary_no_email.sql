-- APPLIED 2026-11-26. The Contacts summary card says why Oscar contacts are not in Atlas: most have no email address (Atlas never stores those, only counts them).
create or replace function public.contacts_oscar_summary() returns jsonb language sql stable set search_path = '' as $f$
  with run as (select stats, finished_at from public.ingest_runs where status = 'success' and stats ? 'oscar_contacts' order by id desc limit 1)
  select jsonb_build_object(
    'total', coalesce((select (stats ->> 'oscar_contacts')::int from run), 0),
    'no_email', coalesce((select (stats ->> 'contacts_noemail')::int from run), 0),
    'run_at', (select finished_at from run),
    'stored', count(*), 'eligible', count(*) filter (where s.status = 'eligible'), 'suppressed', count(*) filter (where s.status = 'suppressed'), 'excluded', count(*) filter (where s.status = 'excluded'))
  from public.contacts c join public.contact_status s using (contact_urn) where c.source = 'oscar';
$f$;
