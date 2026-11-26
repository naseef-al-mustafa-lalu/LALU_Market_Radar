"""Make the source attribution of Apollo-found HubSpot contacts agree (first and latest touch), and fill a blank legal basis, using the same rule as every new Apollo address (neverbounce.apollo_existing_props).
IDS is a comma-separated list of HubSpot contact ids; APPLY=1 writes, anything else only prints what would change."""
import os
import re
import sys

from .neverbounce import APOLLO_READ, apollo_existing_props


def run(hub, ids, apply=False):
    out = []
    for cid in ids:
        cur = (hub.call("GET", f"/crm/v3/objects/contacts/{cid}", params={"properties": APOLLO_READ}) or {}).get("properties") or {}
        extra = apollo_existing_props(cur)
        if extra and apply:
            hub.call("PATCH", f"/crm/v3/objects/contacts/{cid}", json={"properties": extra})
        out.append({"id": cid, "before": {k: cur.get(k) for k in extra}, "after": extra, "applied": bool(extra and apply)})
    return out


def main():
    from .hubspot_sync import Hub
    token = os.environ.get("HUBSPOT_TOKEN")
    ids = [x for x in re.split(r"[\s,;]+", os.environ.get("IDS", "")) if x.isdigit()]
    if not token or not ids:
        print("HUBSPOT_TOKEN and IDS are required", file=sys.stderr)
        sys.exit(2)
    for r in run(Hub(token), ids, os.environ.get("APPLY") == "1"):
        print("RESULT", r)


if __name__ == "__main__":
    main()
