"""Run a list of HubSpot contacts through NeverBounce and write the result to each contact's NeverBounce Status property in HubSpot (and nothing else).
RECORDS is one contact per line as `HubSpot record id,email`. Uses NeverBounce credits: one per address. Atlas picks the new status up from HubSpot on its next sync."""
import os
import re
import sys
from collections import Counter

import requests

from .hubspot_sync import Hub
from .neverbounce import credits_left, verify

MAX_PER_RUN = 1000
MAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def parse(text):
    """[(record id, email)] from `id,email` lines; blank, duplicate and malformed lines are dropped."""
    seen, out = set(), []
    for line in (text or "").splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        rid, email = parts[0], parts[1].lower()
        if rid in seen or not MAIL.match(email):
            continue
        seen.add(rid)
        out.append((rid, email))
    return out


def run(hub, key, rows, get=requests.get, apply=True):
    credits = credits_left(key, get)
    if credits is not None and credits < len(rows):
        return {"stopped": f"only {credits} NeverBounce credits left for {len(rows)} addresses"}
    results, errors = Counter(), 0
    for rid, email in rows[:MAX_PER_RUN]:
        try:
            status = verify(email, key, get)
            if apply:
                hub.call("PATCH", f"/crm/v3/objects/contacts/{rid}", json={"properties": {"neverbounce_status": status}})
            results[status] += 1
        except Exception as e:  # noqa: BLE001
            errors += 1
            if errors >= 5:
                return {"stopped": "five errors in a row: " + str(e)[:150], "done": dict(results)}
    return {"checked": sum(results.values()), "results": dict(results), "errors": errors, "credits_before": credits, "written_to_hubspot": apply}


def main():
    env = os.environ
    for k in ("HUBSPOT_TOKEN", "NEVERBOUNCE_API_KEY", "RECORDS"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rows = parse(env["RECORDS"])
    print(f"Contacts to check: {len(rows)}")
    print("NeverBounce list:", run(Hub(env["HUBSPOT_TOKEN"]), env["NEVERBOUNCE_API_KEY"], rows, apply=env.get("APPLY", "1") != "0"))


if __name__ == "__main__":
    main()
