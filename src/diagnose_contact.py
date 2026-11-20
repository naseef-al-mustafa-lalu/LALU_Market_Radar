"""Read-only: print what Atlas holds for contacts whose name contains NAME (the contact row, its HubSpot link and state, its status, and any Apollo queue entry). Run from the Diagnose a contact workflow."""
import json
import os
import sys

from .common import Rest


def run(rest, name):
    n = name.strip().lower()
    first = n.split()[0] if n.split() else n
    def hit(r):
        text = " ".join(str(r.get(k) or "") for k in ("full_name", "first_name", "last_name", "email")).lower()
        return n in text or (first in text and n.split()[-1] in text)
    rows = [r for r in rest.select_all("contacts_full", "*", order="contact_urn") if hit(r)]
    out = {"contacts": rows}
    out["no_email_ledger_count"] = len(rest.select_all("contact_noemail", "ref", order="ref"))
    urns = {str(r["contact_urn"]) for r in rows}
    out["contact_status"] = [r for r in rest.select_all("contact_status", "*", order="contact_urn") if str(r["contact_urn"]) in urns]
    try:
        out["apollo_queue"] = [r for r in rest.select_all("apollo_queue", "*", order="contact_urn") if hit(r)]
    except Exception as e:  # noqa: BLE001  the table arrives with migration 100
        out["apollo_queue"] = f"not available: {str(e)[:80]}"
    ods = {r["ods_code"] for r in rows}
    out["practices"] = [r for r in rest.select_all("gp_practices", "ods_code,practice_name,hubspot_company_id", order="ods_code") if r["ods_code"] in ods]
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NAME"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["NAME"]), default=str))


if __name__ == "__main__":
    main()
