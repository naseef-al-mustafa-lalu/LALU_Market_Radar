"""One-off: create a federation or provider group in HubSpot from a list of member practices and link them, the same way Atlas's "New group or federation" does (Org Type from the kind; the account's
Federation / Operating Provider labels on each practice). Members are found by ODS code in Atlas and must agree by name or postcode, be in HubSpot and not be merged. Run without apply for a plan that writes nothing.
The daily HubSpot sync then brings the new network into Atlas."""
import json
import os
import re
import sys

from .common import Rest
from .hubspot_sync import Hub, add_notes, chunks, note_text

NOISE = {"surgery", "medical", "centre", "center", "practice", "health", "group", "partners", "partnership", "clinic", "care", "primary", "the", "and"}


def keys(text):
    return {w for w in re.sub(r"[^a-z0-9 ]", " ", str(text or "").lower().replace("&", " and ").replace("'", "")).split() if len(w) > 2 and w not in NOISE}


def pc(v):
    return re.sub(r"\s", "", str(v or "")).upper()


def plan(spec, practices):
    """(linkable, skipped): each member found by ODS code and checked; skipped carries the reason."""
    ok, skipped = [], []
    for m in spec["members"]:
        p = practices.get(m["ods"])
        if not p:
            skipped.append((m, "not in Atlas"))
        elif not (keys(m["name"]) & keys(p["practice_name"]) or keys(m.get("also_known_as")) & keys(p["practice_name"]) or (m.get("postcode") and pc(m["postcode"]) == pc(p.get("postcode")))):
            skipped.append((m, f"the code belongs to {p['practice_name']} in Atlas"))
        elif p.get("merged_into"):
            skipped.append((m, f"merged into {p['merged_into']}"))
        elif not p.get("hubspot_company_id"):
            skipped.append((m, "not in HubSpot yet"))
        else:
            ok.append((m, p))
    return ok, skipped


def find_or_create(hub, name, kind, apply):
    org_type = "federation" if kind == "federation" else "Group"
    hits = hub.call("POST", "/crm/v3/objects/companies/search", json={"properties": ["name", "org_type"], "limit": 10, "query": name}).get("results", [])
    same = next((c for c in hits if str(c["properties"].get("name") or "").strip().lower() == name.lower()), None)
    if same:
        if apply and not same["properties"].get("org_type"):
            hub.call("PATCH", f"/crm/v3/objects/companies/{same['id']}", json={"properties": {"org_type": org_type}})
        return str(same["id"]), False
    if not apply:
        return None, True
    made = hub.call("POST", "/crm/v3/objects/companies", json={"properties": {"name": name, "company_status": "Prospective Customer", "org_type": org_type}})
    return str(made["id"]), True


def member_label(hub, kind):
    want = "federation" if kind == "federation" else "operating provider"
    for x in hub.call("GET", "/crm/v4/associations/companies/companies/labels").get("results", []):
        if str(x.get("label") or "").strip().lower() == want:
            return {"associationCategory": x.get("category") or "USER_DEFINED", "associationTypeId": int(x["typeId"])}
    return None


def run(hub, rest, spec, apply=False):
    practices = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,postcode,status,merged_into,hubspot_company_id", order="ods_code")}
    ok, skipped = plan(spec, practices)
    out = {"name": spec["name"], "kind": spec["kind"], "members": len(spec["members"]), "to_link": len(ok), "skipped": [f"{m['ods']} {m['name']}: {why}" for m, why in skipped], "applied": False}
    if not apply:
        return out
    company, created = find_or_create(hub, spec["name"], spec["kind"], True)
    label = member_label(hub, spec["kind"])
    types = [label] if label else None
    linked = 0
    for ch in chunks([p["hubspot_company_id"] for _, p in ok], 100):
        if types:
            hub.call("POST", "/crm/v4/associations/companies/companies/batch/create", json={"inputs": [{"from": {"id": str(i)}, "to": {"id": company}, "types": types} for i in ch]})
        else:
            hub.call("POST", "/crm/v4/associations/companies/companies/batch/associate/default", json={"inputs": [{"from": {"id": str(i)}, "to": {"id": company}} for i in ch]})
        linked += len(ch)
    add_notes(hub, "companies", [(company, note_text(f"{spec['kind']} {'created' if created else 'used'} and {linked} practices linked from Atlas", [f"{m['ods']} {m['name']}" for m, _ in ok][:50]))])
    out.update(applied=True, company_id=company, created=created, linked=linked, labelled=bool(label), link=f"https://app.hubspot.com/contacts/145802630/record/0-2/{company}")
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    spec = json.load(open(env.get("NETWORK_FILE") or "data/networks/conexus.json"))
    out = run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), spec, apply=env.get("APPLY") == "1")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
