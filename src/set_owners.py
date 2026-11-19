"""Set the HubSpot owners whose contacts are kept out of campaigns (app_flags.contact_rules.owners, the same setting as Contacts > Settings > Contact owners), then recalculate every contact's status.
OWNERS is a comma-separated list of HubSpot owner ids; it replaces the whole list."""
import os
import re
import sys
from datetime import datetime, timezone

from .common import Rest, refresh_contact_status


def run(rest, owners):
    rows = rest.select_all("app_flags", "key,value", order="key", params={"key": "eq.contact_rules"})
    rules = dict(rows[0]["value"]) if rows and isinstance(rows[0].get("value"), dict) else {}
    before = [str(x) for x in rules.get("owners") or []]
    rules["owners"] = owners
    rest.upsert("app_flags", [{"key": "contact_rules", "value": rules, "updated_at": datetime.now(timezone.utc).isoformat()}], "key")
    return {"owners_before": before, "owners_now": owners, **refresh_contact_status(rest)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OWNERS"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT", run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), [x for x in re.split(r"[\s,;]+", env["OWNERS"]) if x.isdigit()]))


if __name__ == "__main__":
    main()
