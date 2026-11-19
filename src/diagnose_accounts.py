"""Read-only: for a list of practice names, print what Atlas knows (size, clinical system, PCN, ICB, CQC, signals) and the customers most like each, to choose a case study.
Prints one `ACCOUNT {json}` line per name. Uses the stored postcode coordinates (app_flags.postcode_coords) for distances."""
import json
import math
import os
import sys

from .common import Rest

COLS = ("ods_code,practice_name,status,town,postcode,region,country,total_patients,clinical_software,pcn_code,pcn_name,icb_name,group_name,group_size,gp_federation,nhs_num_gp,num_employees,"
        "cqc_rating,cqc_last_inspection,cqc_status,hubspot_customer,hubspot_commercial_model,hubspot_stage,hubspot_engaged,merged_into")


def norm(pc):
    return "".join(str(pc or "").split()).upper()


def miles(a, b):
    r = math.radians
    h = math.sin(r(b[0] - a[0]) / 2) ** 2 + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(r(b[1] - a[1]) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def brief(p):
    return {k: p.get(k) for k in ("ods_code", "practice_name", "town", "total_patients", "clinical_software", "pcn_name", "icb_name", "group_name", "cqc_rating", "hubspot_commercial_model")}


def run(rest, names):
    allp = rest.select_all("gp_practices", COLS, order="ods_code")
    flags = rest.select_all("app_flags", "key,value", order="key", params={"key": "eq.postcode_coords"})
    coords = flags[0]["value"] if flags else {}
    cust = [p for p in allp if p.get("hubspot_customer") and p.get("hubspot_commercial_model") and p.get("hubspot_commercial_model") != "Freemium" and p.get("status") == "Active"]
    out = []
    for name in names:
        words = [w for w in name.lower().replace("&", " ").split() if w not in ("the", "and", "of", "medical", "practice", "surgery", "centre", "group", "health", "care", "primary")] or name.lower().split()
        hits = [p for p in allp if p.get("status") == "Active" and all(w in (p.get("practice_name") or "").lower() for w in words[:2])][:4]
        item = {"query": name, "candidates": [brief(p) for p in hits]}
        if hits:
            p = hits[0]
            at = coords.get(norm(p.get("postcode")))
            sig = rest.select_all("sales_triggers", "trigger_type,headline,detected_at", order="detected_at.desc", params={"ods_code": f"eq.{p['ods_code']}", "limit": "5"}) if True else []
            item["signals"] = [{k: s.get(k) for k in ("trigger_type", "headline", "detected_at")} for s in sig][:5]
            near = []
            for c in cust:
                if c["ods_code"] == p["ods_code"]:
                    continue
                ca = coords.get(norm(c.get("postcode")))
                near.append((miles(at, ca) if at and ca else None, c))
            item["customers_same_pcn"] = [brief(c) for _, c in near if p.get("pcn_code") and c.get("pcn_code") == p["pcn_code"]][:4]
            item["customers_within_25mi"] = [dict(brief(c), miles=round(d, 1)) for d, c in sorted([x for x in near if x[0] is not None and x[0] <= 25], key=lambda x: x[0])[:5]]
            size = p.get("total_patients") or 0
            same_sys = [c for _, c in near if size and c.get("clinical_software") == p.get("clinical_software") and abs((c.get("total_patients") or 0) - size) <= 0.35 * size]
            item["similar_size_same_system"] = [brief(c) for c in same_sys[:4]]
            item["customers_same_icb"] = sum(1 for _, c in near if c.get("icb_name") and c.get("icb_name") == p.get("icb_name"))
        out.append(item)
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rest = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    for item in run(rest, [n.strip() for n in env["NAMES"].split(";") if n.strip()]):
        print("ACCOUNT " + json.dumps(item, default=str))


if __name__ == "__main__":
    main()
