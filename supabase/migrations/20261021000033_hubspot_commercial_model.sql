-- HubSpot company "Commercial Model" (current_subscription): copied by the HubSpot sync. A Freemium customer brings no revenue, so the customer ARR figures on network_summary leave Freemium practices out.
alter table public.gp_practices add column if not exists hubspot_commercial_model text;   -- eMR Plus | PAYG | Freemium | GP eMR | eMR+ SAR Only, null when the company has none
do $$
declare def text;
begin
  def := pg_get_viewdef('public.network_summary'::regclass, true);
  def := replace(def, 'FILTER (WHERE p.hubspot_customer), 0::numeric) AS arr_customers,', 'FILTER (WHERE p.hubspot_customer AND p.hubspot_commercial_model IS DISTINCT FROM ''Freemium''::text), 0::numeric) AS arr_customers,');
  def := replace(def, 'FILTER (WHERE p.hubspot_customer), 0::numeric) AS arr_customers_sar,', 'FILTER (WHERE p.hubspot_customer AND p.hubspot_commercial_model IS DISTINCT FROM ''Freemium''::text), 0::numeric) AS arr_customers_sar,');
  if position('Freemium' in def) = 0 then raise exception 'network_summary definition changed; edit this migration'; end if;
  execute 'create or replace view public.network_summary with (security_invoker=true) as ' || rtrim(def, E';\n ');
end $$;
