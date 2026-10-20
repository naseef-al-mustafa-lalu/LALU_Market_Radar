-- The audit now also lists PCN and ICB records: say which HubSpot object each row is about (company, pcn or icb).
alter table public.hubspot_audit add column if not exists object_type text not null default 'company';
