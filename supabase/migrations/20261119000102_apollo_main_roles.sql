-- Which job titles are Main under the saved Contacts > Settings rules (the same lookup contact_status uses: a per-title override, else the role group's setting, else its default).
-- The Apollo queue only takes Main titles, and its page filters by role group from this.
create or replace function public.apollo_title_sections(p_titles text[]) returns table (title text, role_id text, section text) language sql stable security definer set search_path = '' as $f$
  with cfg as (select coalesce((select value from public.app_flags where key = 'contact_rules'), '{}'::jsonb) as r),
  defs(id, def) as (values ('dropped','off'),('deputy','main'),('pm','main'),('ops','main'),('director','main'),('partner','main'),('pcn','main'),('senior','main'),('finance','other'),('digital','other'),('services','other'),('gp','other'),('clinical','other'),('admin','other'),('other','other'),('none','other')),
  t as (select distinct x as ttl from unnest(p_titles) as x),
  roled as (select t.ttl, private.ct_role(coalesce(t.ttl, ''), (select r -> 'titles' from cfg)) as rid from t)
  select roled.ttl, roled.rid,
    case when roled.rid = 'dropped' then 'off' else coalesce(nullif((select r -> 'titleModes' ->> lower(btrim(coalesce(roled.ttl, ''))) from cfg), ''), nullif((select r -> 'roles' ->> roled.rid from cfg), ''), d.def) end
  from roled join defs d on d.id = roled.rid
$f$;
revoke all on function public.apollo_title_sections(text[]) from public, anon; grant execute on function public.apollo_title_sections(text[]) to authenticated, service_role;
