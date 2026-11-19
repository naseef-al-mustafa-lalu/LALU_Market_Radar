"""Read-only: count practices by HubSpot state the way the map, the Revenue page and the practice list each define it, so the numbers can be reconciled."""
import json
import os
import sys
from collections import Counter

from .common import Rest


def run(rest):
    rows = rest.select_all("gp_practices", "ods_code,status,merged_into,total_patients,hubspot_customer,hubspot_engaged,hubspot_commercial_model,hubspot_contracted_arr,hubspot_company_id,postcode,closure_confirmed_at", order="ods_code")
    out = Counter()
    for p in rows:
        cust = bool(p.get("hubspot_customer")); free = p.get("hubspot_commercial_model") == "Freemium"
        active = p.get("status") == "Active" and not p.get("merged_into"); sized = (p.get("total_patients") or 0) > 0
        contracted = float(p.get("hubspot_contracted_arr") or 0) > 0
        if cust and not free:
            out["customer_total"] += 1
            out[f"customer_{'active' if active else 'not_active'}_{'sized' if sized else 'no_list'}_{'contract' if contracted else 'no_contract'}"] += 1
            out["customer_merged" if p.get("merged_into") else "customer_status_" + str(p.get("status"))] += 1
        elif cust and free:
            out["freemium_total"] += 1
            out[f"freemium_{'active' if active else 'not_active'}"] += 1
        elif p.get("hubspot_engaged"):
            out["engaged_total"] += 1
            out[f"engaged_{'active' if active else 'not_active'}"] += 1
    out["practices"] = len(rows)
    return dict(sorted(out.items()))


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]))))


if __name__ == "__main__":
    main()
