-- Non-GP services that ODS lists with the GP Practice role (walk-in centres, community clinics, ICB cost centres, trusts): they never have a list size, so they are
-- not customers. org_kind is 'gp' (default) or 'non_gp'; the daily ingest keeps it current (Y code with no registered patients).
alter table public.gp_practices add column if not exists org_kind text not null default 'gp' check (org_kind in ('gp', 'non_gp'));
update public.gp_practices set org_kind = 'non_gp' where ods_code like 'Y%' and coalesce(total_patients, 0) = 0 and coalesce(hubspot_customer, false) = false and merged_into is null
  and hubspot_company_id is null and practice_name !~* 'surgery|medical|practice|health cent|doctors|family|group';
create index if not exists gp_practices_org_kind_idx on public.gp_practices (org_kind) where org_kind = 'non_gp';

-- Operators and groups (Aspiro, healthcare partnerships, alliances) are not non-GP services.
update public.gp_practices set org_kind = 'gp' where org_kind = 'non_gp' and practice_name ~* 'aspiro|healthcare|health care|partnership|alliance';
