-- Dashboard button support: allowlist check callable by the edge function, patient-count visibility, apply step for the runner job.
create function public.am_i_allowed() returns boolean
language sql stable security definer set search_path = '' as $$ select private.is_allowed(); $$;
revoke all on function public.am_i_allowed() from public, anon;
grant execute on function public.am_i_allowed() to authenticated;

create policy read_patient_counts on public.patient_counts for select to authenticated using (private.is_allowed());
grant select on public.patient_counts to authenticated;

-- Copies stored counts onto active practices (called by the monthly job after it stores the file; service role only).
create function public.apply_patient_counts() returns integer
language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.gp_practices g
     set total_patients = c.patients, data_month = c.data_month
    from public.patient_counts c
   where c.ods_code = g.ods_code and g.status = 'Active'
     and (g.total_patients is distinct from c.patients or g.data_month is distinct from c.data_month);
  get diagnostics changed = row_count;
  return changed;
end $$;
revoke all on function public.apply_patient_counts() from public, anon, authenticated;
grant execute on function public.apply_patient_counts() to service_role;
