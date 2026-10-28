-- Federations by PCN membership. A federation that Oscar does not name (One Care, from its Partnership Map of April 2026) is defined by the PCNs it covers;
-- the daily job (and this migration) then sets gp_practices.gp_federation for every active practice in those PCNs and links them to the federation node,
-- so the Networks tab, the Federation filter, pricing route and exports all treat it like any other federation. Oscar's own NHSGPFed value stays authoritative
-- for practices outside these PCNs; a practice that leaves a listed PCN is released.
create table if not exists public.federation_pcns (
  federation text not null,
  pcn_code text not null,
  source text not null default 'manual',
  note text,
  primary key (federation, pcn_code)
);
alter table public.federation_pcns enable row level security;
create policy read_federation_pcns on public.federation_pcns for select to authenticated using (private.is_allowed());

create or replace function public.apply_federation_pcns() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_set int; n_released int; n_links int;
begin
  update public.gp_practices g set gp_federation = f.federation
    from public.federation_pcns f
   where g.pcn_code = f.pcn_code and g.status = 'Active' and g.gp_federation is distinct from f.federation;
  get diagnostics n_set = row_count;

  update public.gp_practices g set gp_federation = null
   where g.gp_federation in (select federation from public.federation_pcns)
     and not exists (select 1 from public.federation_pcns f where f.federation = g.gp_federation and f.pcn_code = g.pcn_code and g.status = 'Active');
  get diagnostics n_released = row_count;

  insert into public.organisations (kind, source_key, name, attrs)
  select 'federation', 'fed:' || lower(federation), federation, jsonb_build_object('defined_by', 'PCN membership', 'pcns', count(*))
    from public.federation_pcns group by federation
  on conflict (source_key) do update set name = excluded.name, attrs = public.organisations.attrs || excluded.attrs, updated_at = now();

  -- links we own: confirmed, source 'pcn_rule' (refresh_org_graph leaves existing links alone and only prunes Oscar-sourced ones)
  delete from public.org_relationships r using public.organisations pr, public.organisations o, public.gp_practices g
   where r.from_org = pr.id and r.to_org = o.id and r.rel_type = 'MEMBER_OF_FEDERATION' and r.source = 'pcn_rule'
     and pr.source_key = 'ods:' || g.ods_code and (g.gp_federation is null or o.source_key is distinct from 'fed:' || lower(g.gp_federation));
  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'MEMBER_OF_FEDERATION', 'pcn_rule', 1, true
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'fed:' || lower(g.gp_federation)
   where g.status = 'Active' and g.gp_federation in (select federation from public.federation_pcns)
  on conflict (from_org, to_org, rel_type) do update set source = 'pcn_rule', confidence = 1, confirmed = true, updated_at = now();
  get diagnostics n_links = row_count;
  return jsonb_build_object('practices_set', n_set, 'practices_released', n_released, 'links', n_links);
end $$;
revoke all on function public.apply_federation_pcns() from public, anon, authenticated;
grant execute on function public.apply_federation_pcns() to service_role;

insert into public.federation_pcns (federation, pcn_code, source, note)
select 'One Care', c, 'One Care Partnership Map (April 2026)', 'BNSSG GP federation: 21 PCNs'
  from unnest(array['U48538','U66596','U70886','U65207','U78490','U90977','U21617','U63843','U84178','U33963','U88179','U98167','U84294','U86579','U00402','U92125','U32001','U16600','U37297','U13456','U06486']) as c
on conflict do nothing;

select public.apply_federation_pcns();
