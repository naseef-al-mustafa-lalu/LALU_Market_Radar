-- Federations and operating groups that are defined in HubSpot (company Org Type Federation or Group, practices linked with the Federation / Member Practice or
-- Operating Provider / Operated Practice association labels) become networks in Atlas. The daily sync sends them to apply_hubspot_orgs(); the links it writes carry
-- source 'hubspot', so the NHS / CQC / Oscar graph refresh never touches them.
create table if not exists public.hubspot_org_companies (
  org_id uuid primary key references public.organisations(id) on delete cascade,
  company_id text not null unique,
  hs_org_type text,
  operating_status text,
  patient_list_size numeric,
  patient_list_rollup numeric,
  synced_at timestamptz not null default now());
alter table public.hubspot_org_companies enable row level security;
create policy read_hubspot_org_companies on public.hubspot_org_companies for select to authenticated using ((select private.is_allowed()));

-- who belongs to a HubSpot-defined network, in the shape the dashboard needs (network kind and key, practice ODS code)
create or replace view public.hubspot_network_members with (security_invoker = on) as
select o.kind, o.source_key as org_key, pr.ods_code
  from public.org_relationships r
  join public.organisations o on o.id = r.to_org
  join public.organisations pr on pr.id = r.from_org and pr.kind = 'practice'
 where r.source = 'hubspot';
grant select on public.hubspot_network_members to authenticated;

create or replace function public.apply_hubspot_orgs(items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare it jsonb; k text; oid uuid; skey text; code text; keep uuid[] := '{}'; n_new int := 0; rel text;
begin
  for it in select * from jsonb_array_elements(coalesce(items, '[]'::jsonb)) loop
    k := it->>'kind';
    rel := case when k = 'federation' then 'MEMBER_OF_FEDERATION' else 'OPERATED_BY' end;
    select org_id into oid from public.hubspot_org_companies where company_id = it->>'company_id';
    if oid is null then   -- a network Atlas already holds under the same name (a CQC provider group, say) is reused rather than duplicated
      select id into oid from public.organisations where kind = k and lower(btrim(name)) = lower(btrim(it->>'name')) order by (source_key like 'cqc:%') desc limit 1;
    end if;
    if oid is null then
      skey := case when k = 'federation' then 'fed:' || lower(btrim(it->>'name')) else 'hs:' || (it->>'company_id') end;
      insert into public.organisations (kind, source_key, name, attrs)
      values (k, skey, btrim(it->>'name'), jsonb_build_object('hubspot_company_id', it->>'company_id', 'defined_by', 'HubSpot association labels'))
      on conflict (source_key) do update set name = excluded.name, attrs = public.organisations.attrs || excluded.attrs, updated_at = now()
      returning id into oid;
      n_new := n_new + 1;
    end if;
    keep := keep || oid;
    insert into public.hubspot_org_companies (org_id, company_id, hs_org_type, operating_status, patient_list_size, patient_list_rollup, synced_at)
    values (oid, it->>'company_id', it->>'org_type', it->>'operating_status', nullif(it->>'size', '')::numeric, nullif(it->>'rollup', '')::numeric, now())
    on conflict (org_id) do update set company_id = excluded.company_id, hs_org_type = excluded.hs_org_type, operating_status = excluded.operating_status,
      patient_list_size = excluded.patient_list_size, patient_list_rollup = excluded.patient_list_rollup, synced_at = now();

    delete from public.org_relationships r using public.organisations pr
     where r.to_org = oid and r.rel_type = rel and r.source = 'hubspot' and pr.id = r.from_org
       and pr.ods_code <> all (coalesce(array(select jsonb_array_elements_text(it->'practices')), '{}'));
    for code in select jsonb_array_elements_text(coalesce(it->'practices', '[]'::jsonb)) loop
      insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
      select pr.id, oid, rel, 'hubspot', 1, true from public.organisations pr where pr.kind = 'practice' and pr.ods_code = code
      on conflict (from_org, to_org, rel_type) do nothing;
    end loop;
  end loop;
  delete from public.org_relationships where source = 'hubspot' and to_org <> all (keep);
  delete from public.hubspot_org_companies where org_id <> all (keep);
  return jsonb_build_object('orgs', jsonb_array_length(coalesce(items, '[]'::jsonb)), 'created', n_new);
end $$;
revoke all on function public.apply_hubspot_orgs(jsonb) from public, anon, authenticated;
grant execute on function public.apply_hubspot_orgs(jsonb) to service_role;
