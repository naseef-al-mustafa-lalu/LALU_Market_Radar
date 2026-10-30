-- When a HubSpot-only network is folded into an existing one of another type (a company typed Group that is really a federation), its HubSpot links take the new network's relationship type.
create or replace function public.apply_hubspot_orgs(items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare it jsonb; k text; oid uuid; target uuid; skey text; code text; keep uuid[] := '{}'; n_new int := 0; rel text;
begin
  for it in select * from jsonb_array_elements(coalesce(items, '[]'::jsonb)) loop
    k := it->>'kind'; target := null;
    rel := case when k = 'federation' then 'MEMBER_OF_FEDERATION' else 'OPERATED_BY' end;
    select org_id into oid from public.hubspot_org_companies where company_id = it->>'company_id';
    if oid is null then   -- a network Atlas already holds under the same name (a CQC provider group, say) is reused rather than duplicated
      select id into oid from public.organisations where kind = k and public.norm_org_name(name) = public.norm_org_name(it->>'name') order by (source_key like 'cqc:%') desc limit 1;
    elsif (select source_key from public.organisations where id = oid) like 'hs:%' then   -- made from HubSpot alone earlier: fold it into the same-named network Atlas holds
      select id into target from public.organisations where kind = k and id <> oid and source_key not like 'hs:%' and public.norm_org_name(name) = public.norm_org_name(it->>'name') order by (source_key like 'cqc:%') desc limit 1;
      if target is not null then
        insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
          select from_org, target, case when source = 'hubspot' then rel else rel_type end, source, confidence, confirmed from public.org_relationships where to_org = oid on conflict (from_org, to_org, rel_type) do nothing;
        update public.hubspot_network_deals set org_id = target where org_id = oid;
        delete from public.hubspot_org_companies where org_id = oid;
        delete from public.organisations where id = oid;
        oid := target;
      end if;
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
