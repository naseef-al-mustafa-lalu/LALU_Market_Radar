-- Apollo is checked first, free of credits: is the person there, at this practice? Only a verified match is then enriched with an email.
alter table public.apollo_queue add column if not exists match text check (match in ('matched', 'no_person', 'company_mismatch'));
alter table public.apollo_queue add column if not exists apollo_person_id text;
alter table public.apollo_queue add column if not exists apollo_org text;
alter table public.apollo_queue add column if not exists matched_at timestamptz;
