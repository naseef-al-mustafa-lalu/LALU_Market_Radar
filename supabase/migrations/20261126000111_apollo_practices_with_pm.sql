-- APPLIED 2026-11-26. The practices that already have a practice manager with an email address in Atlas (the same test the Apollo coverage count uses), so the Apollo queue can flag people at practices with none.
create or replace function public.apollo_practices_with_pm()
 returns text[]
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(array_agg(distinct ods_code), '{}'::text[])
  from public.contacts_full
  where email is not null and role_tier in ('A', 'B') and ods_code is not null and coalesce(job_title, '') ~* 'practice\s*(/\s*business\s*)?manager';
$function$;
