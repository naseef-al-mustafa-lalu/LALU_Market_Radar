-- No calculation reads these; they only cluttered the Data tab and contradicted the current plans.
delete from public.pricing_settings where key in ('min_commitment_months', 'monthly_plan_rate_per_patient_year', 'prepayment_discount_min', 'prepayment_discount_max', 'indexation_min', 'indexation_max', 'gross_margin_floor');
