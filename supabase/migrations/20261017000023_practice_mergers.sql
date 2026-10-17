-- Practice mergers. ODS carries no successor links, so a merged practice stays Active on ODS with no NHS list size
-- (its patients are counted under the practice that absorbed it). We record the merge ourselves.
alter table public.gp_practices add column if not exists merged_into varchar references public.gp_practices(ods_code) on delete set null;
alter table public.gp_practices add column if not exists merged_note text;
alter table public.gp_practices add column if not exists merged_at timestamptz;
alter table public.gp_practices add column if not exists merged_by text;
alter table public.gp_practices add column if not exists merge_dismissed boolean not null default false;
alter table public.gp_practices drop constraint if exists gp_practices_not_merged_into_self;
alter table public.gp_practices add constraint gp_practices_not_merged_into_self check (merged_into is null or merged_into <> ods_code);
create index if not exists gp_practices_merged_into_idx on public.gp_practices (merged_into) where merged_into is not null;

-- Suggestions: active English practices with no list size that share a postcode with an active practice that has one.
-- 'high' = exactly one such practice, 'medium' = several (the largest is suggested), 'low' = ODS Y-codes (non-standard sites such as services
-- that often just share a building with a practice). Never applied automatically.
create or replace view public.practice_merge_suggestions with (security_invoker = true) as
select z.ods_code, c.ods_code as into_code, c.practice_name as into_name, c.total_patients as into_patients, c.n_candidates,
       case when z.ods_code like 'Y%' then 'low' when c.n_candidates = 1 then 'high' else 'medium' end as confidence
  from public.gp_practices z
  cross join lateral (
    select a.ods_code, a.practice_name, a.total_patients, count(*) over () as n_candidates
      from public.gp_practices a
     where a.country = z.country and a.status = 'Active' and a.total_patients > 0 and a.merged_into is null
       and upper(replace(a.postcode, ' ', '')) = upper(replace(z.postcode, ' ', ''))
     order by a.total_patients desc, a.ods_code limit 1) c
 where z.status = 'Active' and z.total_patients = 0 and z.merged_into is null and not z.merge_dismissed and z.country = 'England' and z.postcode is not null;
grant select on public.practice_merge_suggestions to authenticated;

-- Confirm (p_into set) or undo (p_into null) a merge. Raises a MERGER_DETECTED signal when a customer or engaged practice is involved.
create or replace function public.set_practice_merge(p_ods text, p_into text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.gp_practices; b public.gp_practices; involved boolean;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  select * into a from public.gp_practices where ods_code = p_ods;
  if not found then raise exception 'unknown practice %', p_ods; end if;
  if p_into is null or btrim(p_into) = '' then
    update public.gp_practices set merged_into = null, merged_note = null, merged_at = null, merged_by = null where ods_code = p_ods;
    return jsonb_build_object('ods', p_ods, 'merged_into', null);
  end if;
  select * into b from public.gp_practices where ods_code = p_into;
  if not found then raise exception 'unknown practice %', p_into; end if;
  if p_ods = p_into then raise exception 'a practice cannot merge into itself'; end if;
  if b.status <> 'Active' or b.merged_into is not null then raise exception '% is not an active practice that can absorb others', p_into; end if;
  if exists (select 1 from public.gp_practices where merged_into = p_ods) then raise exception '% has other practices merged into it: move those first', p_ods; end if;
  update public.gp_practices set merged_into = p_into, merged_note = nullif(btrim(coalesce(p_note, '')), ''), merged_at = now(),
         merged_by = coalesce(auth.jwt() ->> 'email', ''), merge_dismissed = false where ods_code = p_ods;
  involved := coalesce(a.hubspot_customer, false) or coalesce(a.hubspot_engaged, false) or coalesce(b.hubspot_customer, false) or coalesce(b.hubspot_engaged, false);
  if involved then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (p_into, 'MERGER_DETECTED', 'Practice merged: ' || a.practice_name || ' into ' || b.practice_name,
            a.practice_name || ' (' || a.ods_code || ') now operates as part of ' || b.practice_name || ' (' || b.total_patients || ' patients).',
            'Check any contract covers the combined list, re-price on the larger size and contact the practice manager.');
  end if;
  return jsonb_build_object('ods', p_ods, 'merged_into', p_into, 'signal', involved);
end $$;
revoke all on function public.set_practice_merge(text, text, text) from public, anon;
grant execute on function public.set_practice_merge(text, text, text) to authenticated;
comment on function public.set_practice_merge(text, text, text) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';

-- "Not a merger": hide a suggestion (p_dismissed false brings it back).
create or replace function public.dismiss_merge_suggestion(p_ods text, p_dismissed boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  update public.gp_practices set merge_dismissed = p_dismissed where ods_code = p_ods;
end $$;
revoke all on function public.dismiss_merge_suggestion(text, boolean) from public, anon;
grant execute on function public.dismiss_merge_suggestion(text, boolean) to authenticated;
comment on function public.dismiss_merge_suggestion(text, boolean) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';
