-- Dashboard upload: a signed-in, allowlisted user sends parsed rows (<=2000 per call); we store them and update active practices.
create function public.load_patient_counts(p_month text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  stored int;
  changed int;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'month must look like 2026-10'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'send at most 2000 rows per call'; end if;

  with src as (
    select upper(btrim(r ->> 'code')) as code, sum((r ->> 'n')::int) as n
    from jsonb_array_elements(p_rows) r
    where upper(btrim(r ->> 'code')) ~ '^[A-Z][0-9]{5}$' and (r ->> 'n') ~ '^[0-9]{1,7}$'
    group by 1
  ), up as (
    insert into public.patient_counts (ods_code, patients, data_month, updated_at)
    select code, n, p_month, now() from src
    on conflict (ods_code) do update
      set patients = excluded.patients, data_month = excluded.data_month, updated_at = now()
    returning 1)
  select count(*) into stored from up;

  update public.gp_practices g
     set total_patients = c.patients, data_month = c.data_month
    from public.patient_counts c
   where c.ods_code = g.ods_code and c.data_month = p_month and g.status = 'Active'
     and (g.total_patients is distinct from c.patients or g.data_month is distinct from c.data_month)
     and g.ods_code in (select upper(btrim(r ->> 'code')) from jsonb_array_elements(p_rows) r);
  get diagnostics changed = row_count;

  return jsonb_build_object('stored', stored, 'practices_updated', changed);
end $$;
revoke all on function public.load_patient_counts(text, jsonb) from public, anon;
grant execute on function public.load_patient_counts(text, jsonb) to authenticated;
