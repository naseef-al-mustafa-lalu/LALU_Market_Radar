"""One-off probe: what does ODS say about GP practices that have no NHS list size, and how do closed practices appear?"""
import json
import sys

sys.path.insert(0, ".")
from src import sources  # noqa: E402

CODES = "A81065,A82613,B81006,B81616,B81642,B81653,B82622,B83009,B83020,B83054,B86009,B86623,C81074,C84101,C88622,D83064,E81030,E83049,E83666,E85617,E87756,F81695,F83007,F84750,G81059,G81663,G82027,G82064,G83046,G83047,G85019,H81045,H81046,H82014,H84053,J82022,K83614,K84008,L81670,L84069,L85007,L85010,L85026,L85050,L85066,M83691,M84034,M87621,N81624,N84043,N84630,P81046,P81711,Y00570,Y01253,Y01297,Y01822,Y02128,Y02458,Y02490,Y02495,Y02509,Y02514,Y02620,Y02628,Y02666,Y02766,Y02787,Y02811,Y02854,Y02902,Y02914,Y03005,Y03007,Y03019,Y03020,Y03096,Y03098,Y03099,Y03154,Y03210,Y03218,Y03272,Y03287,Y03303,Y03380,Y03383,Y03387,Y03433,Y03434,Y03454,Y03472,Y03504,Y03546,Y03575,Y05029,Y05030,Y05031,Y05032,Y05088,Y05125,Y05161,Y05162,Y05163,Y05187,Y05190,Y05197,Y05250,Y05257,Y05258,Y05286,Y05346,Y05412,Y05448,Y05472,Y05733,Y05960,Y06125,Y06153,Y06247,Y06354,Y06487,Y07024,Y08082,Y08362,Y08368,Y08516,Y08645,Y08852,Y08886,Y09077".split(",")


def summary(code):
    try:
        o = sources.get_json(f"{sources.ODS_API}/organisations/{code}").get("Organisation", {})
    except Exception as e:  # noqa: BLE001
        return {"code": code, "error": str(e)[:160]}
    roles = [(r.get("id"), "P" if r.get("primaryRole") else "", r.get("Status")) for r in (o.get("Roles", {}).get("Role") or [])]
    rels = [(r.get("id"), r.get("Status"), (r.get("Target", {}).get("OrgId") or {}).get("extension"), (r.get("Target", {}).get("PrimaryRoleId") or {}).get("id"))
            for r in (o.get("Rels", {}).get("Rel") or [])]
    succs = [(s.get("Type"), (s.get("Target", {}).get("OrgId") or {}).get("extension"), [d.get("Start") for d in (s.get("Date") or [])][:1]) for s in (o.get("Succs", {}).get("Succ") or [])]
    dates = [(d.get("Type"), d.get("Start"), d.get("End")) for d in (o.get("Date") or [])]
    return {"code": code, "name": o.get("Name"), "status": o.get("Status"), "dates": dates, "changed": o.get("LastChangeDate"), "roles": roles, "rels": rels, "succs": succs}


print("=== A. full records for 3 examples ===")
for c in ["A81065", "A82613", "B81616"]:
    print(c, json.dumps(sources.get_json(f"{sources.ODS_API}/organisations/{c}").get("Organisation", {}))[:3500])

print("\n=== B. the", len(CODES), "practices with no NHS list size ===")
for c in CODES:
    print(json.dumps(summary(c), default=str))

print("\n=== C. recently INACTIVE GP practices (how closures look) ===")
try:
    orgs = sources.get_json(f"{sources.ODS_API}/organisations", {"PrimaryRoleId": "RO177", "NonPrimaryRoleId": "RO76", "Status": "Inactive", "LastChangeDate": "2026-04-01", "Limit": 100}).get("Organisations", [])
    print("count (limit 100):", len(orgs))
    for o in orgs[:25]:
        print(json.dumps(summary(o.get("OrgId")), default=str))
except Exception as e:  # noqa: BLE001
    print("inactive listing failed:", e)
