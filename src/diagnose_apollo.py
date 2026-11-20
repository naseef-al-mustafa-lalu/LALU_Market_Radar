"""Read-only, no credits: what Apollo's people search and your saved Apollo contacts return for a name, and how each result compares with a practice. Run from the Diagnose Apollo workflow.
Prints names, titles and organisations only (the search returns no emails)."""
import json
import os
import sys

import requests

from . import apollo
from .common import Rest


def run(rest, key, name, ods, post=requests.post):
    pr = next(iter(rest.select_all("gp_practices", "ods_code,practice_name,website,postcode", order="ods_code", params={"ods_code": f"eq.{ods}"})), {})
    person = {"full_name": name, "first_name": name.split()[0], "last_name": name.split()[-1]}
    out = {"practice": pr, "tokens_practice": sorted(apollo._tokens(pr.get("practice_name")))}
    for label, path, k in (("people_search", "mixed_people/api_search", "people"), ("saved_contacts", "contacts/search", "contacts")):
        r = post(f"{apollo.API}/{path}", headers=apollo.HEADERS(key), json={"q_keywords": name, "per_page": 25, "page": 1}, timeout=60)
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = {}
        rows = []
        for p in body.get(k) or []:
            org = p.get("organization") or {}
            orgname = org.get("name") or p.get("organization_name")
            rows.append({"name": f"{p.get('first_name')} {p.get('last_name') or p.get('last_name_obfuscated')}", "title": p.get("title"), "org": orgname, "domain": org.get("primary_domain"),
                         "same_person": apollo._same_person(p, person), "company_ok": apollo.company_matches({"name": orgname, "primary_domain": org.get("primary_domain")}, pr.get("practice_name"), pr.get("website")),
                         "org_tokens": sorted(apollo._tokens(orgname))})
        out[label] = {"status": r.status_code, "total": (body.get("pagination") or {}).get("total_entries"), "returned": len(rows), "rows": rows[:25], "error": None if r.ok else r.text[:200]}
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APOLLO_API_KEY", "NAME", "ODS"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["APOLLO_API_KEY"], env["NAME"].strip(), env["ODS"].strip().upper()), default=str))


if __name__ == "__main__":
    main()
