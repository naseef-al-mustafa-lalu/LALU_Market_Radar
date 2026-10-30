-- Company-to-company relationships that used HubSpot's single Parent Company slot (a merged practice and its successor, a branch site and its practice) now use association
-- labels, which allow any number of relationships. The daily sync records what it reads: the company a practice's company was merged into, and the company a branch is a branch of.
alter table public.gp_practices add column if not exists hubspot_successor_company_id text;
alter table public.gp_practices add column if not exists hubspot_branch_parent_company_id text;
