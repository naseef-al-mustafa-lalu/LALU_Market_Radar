-- A practice with no list size that sits at the same postcode as an active branch site of another practice is probably the old code of that site (ODS gives a branch a new code when its
-- operator changes, for example Cauldwell Medical Centre E81030 -> branch U4F5V of The De Parys Group): suggest it merged into the practice that operates the branch, not only into a practice at its own postcode.
create or replace view public.practice_merge_suggestions as
with same_pc as (
  select z.ods_code, c.ods_code as into_code, c.practice_name as into_name, c.total_patients as into_patients, c.n_candidates,
         case when z.ods_code like 'Y%' then 'low' when c.n_candidates = 1 then 'high' else 'medium' end as confidence
  from public.gp_practices z
  cross join lateral (
    select a.ods_code, a.practice_name, a.total_patients, count(*) over () as n_candidates
    from public.gp_practices a
    where a.country = z.country and a.status = 'Active' and a.total_patients > 0 and a.merged_into is null and a.closure_confirmed_at is null
      and upper(replace(a.postcode, ' ', '')) = upper(replace(z.postcode, ' ', ''))
    order by a.total_patients desc, a.ods_code limit 1) c
  where z.status = 'Active' and z.total_patients = 0 and z.merged_into is null and z.closure_confirmed_at is null and not z.merge_dismissed and z.country = 'England' and z.postcode is not null
), via_branch as (
  select distinct on (z.ods_code) z.ods_code, a.ods_code as into_code, a.practice_name as into_name, a.total_patients as into_patients, 1::bigint as n_candidates, 'high'::text as confidence
  from public.gp_practices z
  join public.practice_branches b on upper(replace(b.postcode, ' ', '')) = upper(replace(z.postcode, ' ', '')) and b.status = 'Active' and b.practice_code is not null and b.practice_code <> z.ods_code and b.branch_code <> z.ods_code
  join public.gp_practices a on a.ods_code = b.practice_code and a.status = 'Active' and a.total_patients > 0 and a.merged_into is null and a.closure_confirmed_at is null
  where z.status = 'Active' and z.total_patients = 0 and z.merged_into is null and z.closure_confirmed_at is null and not z.merge_dismissed and z.country = 'England' and z.postcode is not null
  order by z.ods_code, a.total_patients desc
)
select ods_code, into_code, into_name, into_patients, n_candidates, confidence from via_branch
union all
select s.ods_code, s.into_code, s.into_name, s.into_patients, s.n_candidates, s.confidence from same_pc s where not exists (select 1 from via_branch v where v.ods_code = s.ods_code);
