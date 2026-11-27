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
    """{email: (status, legal basis)} for the Marketing Information subscription: SUBSCRIBED, NOT_SUBSCRIBED, MISSING (HubSpot holds the contact but no status for it), NO_RECORD (404) or ERROR.
    Also returns the first distinct error messages, so a missing API scope is visible."""
    from concurrent.futures import ThreadPoolExecutor
    from urllib.parse import quote

    def one(email):
        try:
            d = hub.call("GET", "/communication-preferences/v3/status/email/" + quote(email, safe=""))
        except RuntimeError as e:
            msg = str(e)
            return email, ("NO_RECORD" if " 404" in msg else "ERROR", ""), msg[:160]
        hit = next((x for x in d.get("subscriptionStatuses", []) if str(x.get("id")) == MARKETING_INFORMATION), None)
        return email, ((hit or {}).get("status") or "MISSING", (hit or {}).get("legalBasis") or ""), None
    out, errs = {}, []
    with ThreadPoolExecutor(8) as ex:
        for email, st, err in ex.map(one, sorted(emails)):
            out[email] = st
            if err and err not in errs and len(errs) < 3:
                errs.append(err)
    return out, errs


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
    return {"atlas_eligible_people": len(eligible), "emails_checked": len(got), "first_errors": errors, "by_status_and_segment": {f"{k[0]} | {k[1]}": v for k, v in sorted(table.items())}, "subscribed_legal_basis": dict(basis)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Hub(env["HUBSPOT_TOKEN"]), Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["LIST_ID"].strip()), default=str))


if __name__ == "__main__":
    main()
