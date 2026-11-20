-- Emails pulled from people already enriched in your Apollo account cost no credits: mark them so the credit figures on the Apollo page leave them out.
alter table public.apollo_queue add column if not exists free boolean not null default false;
