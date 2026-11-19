"""Postcode coordinates for the practices map. Looks up every practice postcode that has no stored coordinates (postcodes.io, free, 100 per request) and keeps them in
app_flags.postcode_coords as {"AB12CD": [lat, lng]}. Run after the daily ingest or on its own from the Geocode postcodes workflow."""
import os
import sys

import requests

from .common import Rest

API = "https://api.postcodes.io/postcodes"
KEY = "postcode_coords"


def norm(pc):
    return "".join(str(pc or "").split()).upper()


def missing(practices, have):
    """Distinct normalised postcodes of the practices that are not in `have` yet."""
    return sorted({norm(p.get("postcode")) for p in practices if norm(p.get("postcode"))} - set(have))


def lookup(codes, post=requests.post):
    """{postcode: [lat, lng]} for the codes postcodes.io knows; unknown or terminated ones are left out."""
    out = {}
    for i in range(0, len(codes), 100):
        r = post(API, json={"postcodes": codes[i:i + 100]}, timeout=60)
        r.raise_for_status()
        for item in r.json().get("result") or []:
            res = item.get("result")
            if res and res.get("latitude") is not None and res.get("longitude") is not None:
                out[norm(item["query"])] = [round(res["latitude"], 5), round(res["longitude"], 5)]
    return out


def run(rest, post=requests.post):
    rows = rest.select_all("app_flags", "key,value", order="key", params={"key": f"eq.{KEY}"})
    have = dict(rows[0]["value"]) if rows and isinstance(rows[0].get("value"), dict) else {}
    practices = rest.select_all("gp_practices", "ods_code,postcode", order="ods_code")
    try:   # branch sites too, for the map's "include branches"
        practices = practices + rest.select_all("practice_branches", "branch_code,postcode", order="branch_code")
    except Exception as e:  # noqa: BLE001
        print("Branch postcodes skipped:", str(e)[:150])
    todo = missing(practices, have)
    found = lookup(todo, post) if todo else {}
    if found:
        have.update(found)
        rest.upsert("app_flags", [{"key": KEY, "value": have}], "key")
    return {"postcodes": len(have), "looked_up": len(todo), "found": len(found), "not_found": len(todo) - len(found)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("Geocode:", run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])))


if __name__ == "__main__":
    main()
