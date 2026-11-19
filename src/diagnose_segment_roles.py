"""Read-only: for the members of a HubSpot segment, cross the HubSpot standardised job role with the section Atlas puts the contact in (main / other) and the Atlas role group.
Prints one RESULT line of counts only."""
import json
import os
import sys
from collections import Counter

from .common import Rest
from .diagnose_segment import members
from .hubspot_sync import Hub, read_objects


def run(hub, rest, list_id):
    ids = members(hub, list_id)
    props = read_objects(hub, "contacts", ids, ["job_role_standardised", "jobtitle"])
    ours = {str(c["hubspot_contact_id"]): c["contact_urn"] for c in rest.select_all("contacts", "contact_urn,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})}
    status = {s["contact_urn"]: s for s in rest.select_all("contact_status", "contact_urn,role_id,role_label,section", order="contact_urn")}
    cross, by_atlas_role, missing = Counter(), Counter(), Counter()
    for i in ids:
        hs_role = (props.get(i, {}).get("job_role_standardised") or "(blank)")
        urn = ours.get(i)
        st = status.get(urn) if urn else None
        if not st:
            missing[hs_role] += 1
            continue
        cross[f"{hs_role} -> {st['section']}"] += 1
        by_atlas_role[f"{st['role_label']} ({st['section']})"] += 1
    return {"members": len(ids), "not_in_atlas_or_no_status": dict(missing), "hubspot_role_to_atlas_section": dict(sorted(cross.items())), "atlas_role_groups": dict(by_atlas_role.most_common())}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["LIST_ID"].strip())))


if __name__ == "__main__":
    main()
