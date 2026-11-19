"""Make GPs who are not partners a Main job role: sets roles.gp = "main" in the saved contact rules (app_flags.contact_rules, the same setting as Contacts > Settings), then recalculates every contact's status."""
import os
import sys
from datetime import datetime, timezone

from .common import Rest, refresh_contact_status


def run(rest):
    rows = rest.select_all("app_flags", "key,value", order="key", params={"key": "eq.contact_rules"})
    rules = dict(rows[0]["value"]) if rows and isinstance(rows[0].get("value"), dict) else {}
    roles = dict(rules.get("roles") or {})
    before = roles.get("gp")
    roles["gp"] = "main"
    rules["roles"] = roles
    rest.upsert("app_flags", [{"key": "contact_rules", "value": rules, "updated_at": datetime.now(timezone.utc).isoformat()}], "key")
    return {"gp_before": before or "default (other)", "gp_now": "main", **refresh_contact_status(rest)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT", run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])))


if __name__ == "__main__":
    main()
