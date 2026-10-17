-- Evaluate the allowlist check once per query instead of once per row (dashboard load went from ~3 s to ~0.4 s for network_summary).
-- Already applied to production as rls_check_once_per_query; this file records it.
alter policy read_contacts on public.contacts using (select private.is_allowed());
alter policy read_practices on public.gp_practices using (select private.is_allowed());
alter policy update_lead_status on public.gp_practices using (select private.is_allowed()) with check (select private.is_allowed());
alter policy read_runs on public.ingest_runs using (select private.is_allowed());
alter policy read_job_adverts on public.job_adverts using (select private.is_allowed());
alter policy read_job_employers on public.job_employers using (select private.is_allowed());
alter policy read_rels on public.org_relationships using (select private.is_allowed());
alter policy read_orgs on public.organisations using (select private.is_allowed());
alter policy read_patient_counts on public.patient_counts using (select private.is_allowed());
alter policy read_pricing_settings on public.pricing_settings using (select private.is_allowed());
alter policy read_pricing_tiers on public.pricing_tiers using (select private.is_allowed());
alter policy read_triggers on public.sales_triggers using (select private.is_allowed());
alter policy update_signal_status on public.sales_triggers using (select private.is_allowed()) with check (select private.is_allowed());
alter policy read_signal_settings on public.signal_settings using (select private.is_allowed());
alter policy update_signal_settings on public.signal_settings using (select private.is_allowed()) with check (select private.is_allowed());
