-- Which performance KPIs an audience shows on its card, and which ones an A/B test tracks (and decides on).
alter table public.audiences add column if not exists kpis text[];
alter table public.audience_tests add column if not exists kpis text[];
alter table public.audience_tests add column if not exists primary_kpi text;
