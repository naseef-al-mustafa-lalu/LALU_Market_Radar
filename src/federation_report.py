"""Read-only: every federation Atlas holds, how many of its member links are unconfirmed (inferred from Oscar), and the members whose ICB differs from the federation's usual one, which is where a wrong link shows up."""
import json
import os
import sys
from collections import Counter

from .common import Rest


def report(rest):
    orgs = {str(o["id"]): o for o in rest.select_all("organisations", "id,kind,name,source_key,ods_code", order="id")}
    prac = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,icb_name,postcode,status,cqc_provider_name", order="ods_code")}
    rels = rest.select_all("org_relationships", "from_org,to_org,rel_type,source,confirmed", order="from_org", params={"rel_type": "eq.MEMBER_OF_FEDERATION"})
    by_fed = {}
    for r in rels:
        o, f = orgs.get(str(r["from_org"])), orgs.get(str(r["to_org"]))
        if o and f and o.get("ods_code") in prac:
            by_fed.setdefault(str(f["id"]), []).append((prac[o["ods_code"]], r))
    out = []
    for fid, members in by_fed.items():
        icbs = Counter(p.get("icb_name") or "(none)" for p, _ in members)
        usual = icbs.most_common(1)[0][0]
        unconfirmed = [p for p, r in members if r.get("confirmed") is False]
        odd = [{"ods": p["ods_code"], "name": p["practice_name"], "icb": p.get("icb_name"), "provider": p.get("cqc_provider_name"), "confirmed": r.get("confirmed"), "source": r.get("source")}
               for p, r in members if (p.get("icb_name") or "(none)") != usual]
        out.append({"federation": orgs[fid]["name"], "members": len(members), "unconfirmed": len(unconfirmed), "usual_icb": usual, "icb_counts": dict(icbs.most_common(4)), "other_icb": len(odd), "examples": odd[:12]})
    return sorted(out, key=lambda x: -x["other_icb"])


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(report(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])), default=str))


if __name__ == "__main__":
    main()
