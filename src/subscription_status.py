"""Read-only: the Marketing Information subscription status HubSpot holds for the people Atlas calls eligible, and how it lines up with segment membership.
Prints one RESULT line of counts (no names or addresses)."""
import json
import os
import sys
from collections import Counter

from .common import Rest
from .diagnose_segment import members
from .hubspot_sync import Hub, chunks

MARKETING_INFORMATION = "621322507"


def statuses(hub, emails):
    """{email: (status, legal basis)} for the Marketing Information subscription; status is SUBSCRIBED, NOT_SUBSCRIBED or MISSING (HubSpot holds no status for it)."""
    out, errors = {}, 0
    for ch in chunks(sorted(emails), 100):
        d = hub.call("POST", "/communication-preferences/v3/status/email/batch/read", json={"inputs": ch})
        errors += len(d.get("errors") or [])
        for r in d.get("results", []):
            hit = next((s for s in r.get("subscriptionStatuses", []) if str(s.get("id")) == MARKETING_INFORMATION), None)
            out[str(r.get("recipient") or "").lower()] = ((hit or {}).get("status") or "MISSING", (hit or {}).get("legalBasis") or "")
    return out, errors


def run(hub, rest, list_id):
    rows = rest.select_all("contacts_full", "contact_urn,email,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})
    status = {r["contact_urn"]: r["status"] for r in rest.select_all("contact_status", "contact_urn,status", order="contact_urn")}
    eligible = {}
    for r in rows:
        if status.get(r["contact_urn"]) == "eligible" and r.get("email"):
            eligible[str(r["hubspot_contact_id"])] = r["email"].strip().lower()
    got, errors = statuses(hub, set(eligible.values()))
    in_seg = set(members(hub, list_id))
    table = Counter()
    for hid, email in eligible.items():
        s, basis = got.get(email, ("NOT_RETURNED", ""))
        table[(s, "in_segment" if hid in in_seg else "not_in_segment")] += 1
    basis = Counter(b or "(none)" for s, b in got.values() if s == "SUBSCRIBED")
    return {"atlas_eligible_people": len(eligible), "emails_checked": len(got), "errors": errors, "by_status_and_segment": {f"{k[0]} | {k[1]}": v for k, v in sorted(table.items())}, "subscribed_legal_basis": dict(basis)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["LIST_ID"].strip()), default=str))


if __name__ == "__main__":
    main()
