-- Organisations + relationships graph. Every link records its source and confidence so inferred links can be reviewed.
create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('practice','pcn','icb','group','federation','company')),
  source_key text not null unique,            -- e.g. ods:A81001, ods:U00000, icb:<name>, cqc:provider:<id>, fed:<name>, ch:<number>
  name text not null,
  ods_code text,
  attrs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index on public.organisations (kind);

create table public.org_relationships (
  id uuid primary key default gen_random_uuid(),
  from_org uuid not null references public.organisations(id) on delete cascade,
  to_org   uuid not null references public.organisations(id) on delete cascade,
  rel_type text not null check (rel_type in ('MEMBER_OF_PCN','IN_ICB','OPERATED_BY','MEMBER_OF_FEDERATION','OWNED_BY')),
  source text not null,                        -- ods | cqc | oscar | companies_house | inferred
  confidence numeric not null default 1 check (confidence between 0 and 1),
  confirmed boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (from_org, to_org, rel_type)
);
create index on public.org_relationships (to_org);
create index on public.org_relationships (from_org);

-- Rebuilds the derived links from gp_practices. Idempotent; called by the daily job (service role).
create function public.refresh_org_graph() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_org int; n_rel int;
begin
  insert into public.organisations (kind, source_key, name, ods_code)
  select 'practice', 'ods:' || ods_code, practice_name, ods_code from public.gp_practices
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name, ods_code)
  select 'pcn', 'ods:' || pcn_code, max(pcn_name), pcn_code from public.gp_practices
   where pcn_code is not null group by pcn_code
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'icb', 'icb:' || lower(icb_name), max(icb_name) from public.gp_practices
   where icb_name <> 'Unallocated ICB' group by lower(icb_name)
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'group', 'cqc:provider:' || cqc_provider_id, coalesce(max(group_name), 'Unnamed group') from public.gp_practices
   where group_size > 1 and cqc_provider_id is not null group by cqc_provider_id
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'federation', 'fed:' || lower(gp_federation), max(gp_federation) from public.gp_practices
   where gp_federation is not null group by lower(gp_federation)
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  -- links (only the types we can currently derive; others are added by future sources)
  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'MEMBER_OF_PCN', 'ods', 1, true
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'ods:' || g.pcn_code
   where g.pcn_code is not null
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'IN_ICB', case when g.pcn_code is not null then 'ods' else 'oscar' end,
         case when g.pcn_code is not null then 1 else 0.7 end, g.pcn_code is not null
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'icb:' || lower(g.icb_name)
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'OPERATED_BY', 'cqc', 1, true
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'cqc:provider:' || g.cqc_provider_id
   where g.group_size > 1
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'MEMBER_OF_FEDERATION', 'oscar', 0.7, false
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'fed:' || lower(g.gp_federation)
   where g.gp_federation is not null
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  perform public.prune_org_links();

  select count(*) into n_org from public.organisations;
  select count(*) into n_rel from public.org_relationships;
  return jsonb_build_object('organisations', n_org, 'relationships', n_rel);
end $$;
revoke all on function public.refresh_org_graph() from public, anon, authenticated;
grant execute on function public.refresh_org_graph() to service_role;

-- One row per network (PCN / group / federation / ICB) with what matters for selling to many practices at once.
create view public.org_summary with (security_invoker = true) as
select o.id, o.kind, o.name, o.source_key,
       count(*) as practices,
       coalesce(sum(p.total_patients), 0)::bigint as patients,
       count(*) filter (where p.sales_segment like 'Tier 1%') as tier1,
       count(*) filter (where p.sales_segment like 'Tier 2%') as tier2,
       count(*) filter (where p.sales_segment like 'Tier 3%') as tier3,
       count(*) filter (where p.clinical_software = 'EMIS Web') as emis,
       count(*) filter (where p.clinical_software = 'SystmOne') as systmone,
       count(*) filter (where p.cqc_rating in ('Requires improvement','Inadequate')) as cqc_concern,
       count(*) filter (where p.lead_status in ('In-Progress','Contacted')) as engaged,
       count(*) filter (where p.lead_status = 'Do-Not-Contact') as do_not_contact,
       bool_and(r.confirmed) as confirmed
  from public.organisations o
  join public.org_relationships r on r.to_org = o.id
  join public.organisations pr on pr.id = r.from_org and pr.kind = 'practice'
  join public.gp_practices p on p.ods_code = pr.ods_code and p.status = 'Active'
 where o.kind in ('pcn','icb','group','federation')
 group by o.id, o.kind, o.name, o.source_key;

alter table public.organisations enable row level security;
alter table public.org_relationships enable row level security;
create policy read_orgs on public.organisations for select to authenticated using (private.is_allowed());
create policy read_rels on public.org_relationships for select to authenticated using (private.is_allowed());
grant select on public.organisations, public.org_relationships, public.org_summary to authenticated;
grant all on public.organisations, public.org_relationships to service_role;
