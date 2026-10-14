-- Removes links that are no longer true (a practice moved PCN / ICB / operator). Called by refresh_org_graph().
create function public.prune_org_links() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.org_relationships r using public.organisations pr, public.organisations o, public.gp_practices g
   where r.from_org = pr.id and r.to_org = o.id and pr.source_key = 'ods:' || g.ods_code
     and ((r.rel_type = 'MEMBER_OF_PCN' and o.source_key is distinct from 'ods:' || g.pcn_code)
       or (r.rel_type = 'IN_ICB' and o.source_key is distinct from 'icb:' || lower(g.icb_name))
       or (r.rel_type = 'OPERATED_BY' and (g.group_size is null or g.group_size < 2 or o.source_key is distinct from 'cqc:provider:' || g.cqc_provider_id))
       or (r.rel_type = 'MEMBER_OF_FEDERATION' and r.source = 'oscar' and o.source_key is distinct from 'fed:' || lower(g.gp_federation)));

end $$;
revoke all on function public.prune_org_links() from public, anon, authenticated;
grant execute on function public.prune_org_links() to service_role;
