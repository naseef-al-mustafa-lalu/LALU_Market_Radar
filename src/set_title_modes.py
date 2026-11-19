"""Set job titles to Main in the saved contact rules (app_flags.contact_rules.titleModes, the same setting as Contacts > Settings > Job titles), then recalculate every contact's status.
TITLES is a semicolon-separated list; matching is on the whole title, ignoring case."""
import os
import sys
from datetime import datetime, timezone

from .common import Rest, refresh_contact_status


def run(rest, titles, mode="main"):
    rows = rest.select_all("app_flags", "key,value", order="key", params={"key": "eq.contact_rules"})
    rules = dict(rows[0]["value"]) if rows and isinstance(rows[0].get("value"), dict) else {}
    modes = dict(rules.get("titleModes") or {})
    changed = {}
    for t in titles:
        k = t.strip().lower()
        if k and modes.get(k) != mode:
            changed[k] = modes.get(k) or "(group default)"
            modes[k] = mode
    rules["titleModes"] = modes
    rest.upsert("app_flags", [{"key": "contact_rules", "value": rules, "updated_at": datetime.now(timezone.utc).isoformat()}], "key")
    return {"set_to": mode, "titles_changed": changed, **refresh_contact_status(rest)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TITLES"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT", run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["TITLES"].split(";")))


if __name__ == "__main__":
    main()
