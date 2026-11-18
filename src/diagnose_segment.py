"""Read-only: for a HubSpot contact segment, count how many members Atlas holds as contacts and say why each missing one is missing (no company, company not a practice, no email, not Atlas's to import).
Prints one RESULT line of counts and HubSpot contact ids (no names or addresses)."""
import json
import os
import sys
from collections import Counter

from .common import Rest
from .hubspot_sync import Hub, associations, chunks, made_by_atlas, read_objects


def members(hub, list_id):
    ids, after = [], None
    while True:
        d = hub.call("GET", f"/crm/v3/lists/{list_id}/memberships?limit=250" + (f"&after={after}" if after else ""))
        ids += [str(r["recordId"]) for r in d.get("results", [])]
        after = (d.get("paging") or {}).get("next", {}).get("after")
        if not after:
            return ids


def contact_companies(hub, ids):
    out = {}
    for ch in chunks(ids, 1000):
        d = hub.call("POST", "/crm/v4/associations/contacts/companies/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            out[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
    return out


def run(hub, rest, list_id):
    ids = members(hub, list_id)
    ours = rest.select_all("contacts", "contact_urn,ods_code,email,hubspot_contact_id,source", order="contact_urn")
    by_id = {str(c["hubspot_contact_id"]): c for c in ours if c.get("hubspot_contact_id")}
    by_email = {(c.get("email") or "").strip().lower(): c for c in ours if c.get("email")}
    props = read_objects(hub, "contacts", ids, ["email", "um_source_detail_1", "um_source_detail_2", "lifecyclestage"])
    comp = contact_companies(hub, ids)
    all_co = sorted({c for v in comp.values() for c in v})
    co = read_objects(hub, "companies", all_co, ["partner_organisation_code", "org_type"])
    atlas_ods = {r["ods_code"] for r in rest.select_all("gp_practices", "ods_code", order="ods_code")}
    reasons, sample, held = Counter(), {}, 0
    for i in ids:
        p = props.get(i, {})
        email = (p.get("email") or "").strip().lower()
        if i in by_id or (email and email in by_email):
            held += 1
            continue
        cs = comp.get(i, [])
        odss = [str(co.get(c, {}).get("partner_organisation_code") or "").upper() for c in cs]
        if not email:
            why = "no email address"
        elif not cs:
            why = "no associated company"
        elif not any(odss):
            why = "company has no ODS code (not a practice company)"
        elif not any(o in atlas_ods for o in odss if o):
            why = "ODS code not a practice Atlas holds"
        elif made_by_atlas(p):
            why = "made by Atlas but not found in Atlas"
        else:
            why = "eligible: not imported yet (next daily sync)"
        reasons[why] += 1
        sample.setdefault(why, []).append(i)
    return {"segment_members": len(ids), "held_in_atlas": held, "missing": len(ids) - held, "reasons": dict(reasons), "sample_ids": {k: v[:5] for k, v in sample.items()}}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["LIST_ID"].strip()), default=str))


if __name__ == "__main__":
    main()
