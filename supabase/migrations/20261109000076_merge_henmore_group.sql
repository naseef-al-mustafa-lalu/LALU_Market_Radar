-- A network name can be locked, so the daily graph refresh does not put the CQC provider's legal name back (attrs.name_locked).
create or replace function private.keep_locked_org_name() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(old.attrs ->> 'name_locked', '') = 'true' then new.name := old.name; end if;
  return new;
end $$;
drop trigger if exists keep_locked_org_name on public.organisations;
create trigger keep_locked_org_name before update on public.organisations for each row execute function private.keep_locked_org_name();

-- Henmore Health (a HubSpot group) and Dr de Sousa and Partners (the CQC provider of the same two practices) are one organisation, known as Henmore Health. The CQC node stays (practices match it by provider id); it takes the HubSpot company, deals and links and the name.
do $$
declare hs uuid := 'ebbe7683-9344-420c-87bf-2b3d46020ac5', cq uuid := 'c33d0d26-692d-4f7b-8025-76785d9d23fb';
begin
  if exists (select 1 from public.organisations where id = hs) and exists (select 1 from public.organisations where id = cq) then
    update public.hubspot_org_companies set org_id = cq where org_id = hs;
    update public.hubspot_network_deals set org_id = cq where org_id = hs;
    insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
      select from_org, cq, rel_type, source, confidence, confirmed from public.org_relationships where to_org = hs on conflict (from_org, to_org, rel_type) do nothing;
    delete from public.organisations where id = hs;
    update public.organisations set name = 'Henmore Health', attrs = coalesce(attrs, '{}'::jsonb) || '{"name_locked": true, "hubspot_company_id": "462003654884", "defined_by": "HubSpot association labels"}'::jsonb where id = cq;
  end if;
end $$;
