"""Read-only: print what Atlas holds that decides which deal a practice shows (its own columns, its deal link, the network deals that cover it, its networks). Run from the Diagnose a practice workflow."""
import json
import os
import sys

from .common import Rest


def run(rest, ods):
    pr = rest.select_all("gp_practices", "ods_code,practice_name,status,country,hubspot_company_id,cqc_provider_id,cqc_provider_name,group_name,gp_federation,pcn_code,icb_name,hubspot_customer,hubspot_engaged,hubspot_commercial_model,total_patients",
                         order="ods_code", params={"ods_code": f"eq.{ods}"})
    out = {"practice": pr[0] if pr else None}
    out["hubspot_links"] = rest.select_all("hubspot_links", "ods_code,company_id,company_name,deal_id,deal_name,linked_by,linked_at", order="ods_code", params={"ods_code": f"eq.{ods}"})
    deals = rest.select_all("hubspot_network_deals", "deal_id,deal_name,org_id,company_id,covers,created_by", order="deal_id")
    out["network_deals_covering_or_named"] = [d for d in deals if ods in (d.get("covers") or []) or "henmore" in str(d.get("deal_name") or "").lower()]
    out["network_deals_total"] = len(deals)
    orgs = rest.select_all("organisations", "id,kind,name,source_key,ods_code", order="id")
    mine = [o for o in orgs if o.get("ods_code") == ods]
    name_hits = [o for o in orgs if "henmore" in str(o.get("name") or "").lower() or str(o["id"]) in {str(d.get("org_id")) for d in out["network_deals_covering_or_named"]}]
    out["organisations"] = {"practice": mine, "named": name_hits}
    ids = {str(o["id"]) for o in mine}
    rels = rest.select_all("org_relationships", "from_org,to_org,rel_type,source,confirmed", order="from_org")
    out["relationships"] = [r for r in rels if str(r["from_org"]) in ids or str(r["to_org"]) in {str(o["id"]) for o in name_hits}][:40]
    out["hubspot_network_members"] = rest.select_all("hubspot_network_members", "kind,org_key,ods_code", order="ods_code", params={"ods_code": f"eq.{ods}"})
    out["hubspot_org_companies"] = [c for c in rest.select_all("hubspot_org_companies", "org_id,company_id,hs_org_type", order="org_id") if str(c["org_id"]) in {str(o["id"]) for o in name_hits}]
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print(json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["ODS"].strip().upper()), indent=1, default=str))


if __name__ == "__main__":
    main()
