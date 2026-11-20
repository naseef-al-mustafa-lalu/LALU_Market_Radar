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
        if label == "saved_contacts":   # which fields a saved contact carries, and the values of id-like ones (no emails, no credits)
            out["saved_contact_fields"] = [{"keys": sorted(c.keys()), "ids": {k: v for k, v in c.items() if "id" in k.lower() and isinstance(v, (str, int, type(None)))}} for c in (body.get("contacts") or [])[:3]]
        out[label] = {"status": r.status_code, "total": (body.get("pagination") or {}).get("total_entries"), "returned": len(rows), "rows": rows[:25], "error": None if r.ok else r.text[:200]}
    return out


def variants(rest, key, name, ods, post=requests.post):
    """Free search variants for one person at one practice: which way of asking puts the right person first? Prints each variant's status, how many people came back, and who (name, title, organisation)."""
    pr = next(iter(rest.select_all("gp_practices", "ods_code,practice_name,website", order="ods_code", params={"ods_code": f"eq.{ods}"})), {})
    dom, practice = apollo._domain(pr.get("website")), pr.get("practice_name") or ""
    first, last = name.split()[0], name.split()[-1]
    base = {"per_page": 10, "page": 1}
    tries = {
        "A name only": {"q_keywords": name},
        "B name + practice": {"q_keywords": f"{name} {practice}"},
        "C name + title": {"q_keywords": name, "person_titles": ["Practice Manager"]},
        "D name + practice domain": {"q_keywords": name, "q_organization_domains_list": [dom]} if dom else None,
        "E q_person_name": {"q_person_name": name},
        "F q_person_name + q_organization_name": {"q_person_name": name, "q_organization_name": practice},
        "G name + organization_names": {"q_keywords": name, "organization_names": [practice]},
        "H q_keywords name + q_organization_name": {"q_keywords": name, "q_organization_name": practice},
        "I first and last name fields": {"first_name": first, "last_name": last},
    }
    out = {"practice": practice, "domain": dom}
    for label, body in tries.items():
        if not body:
            out[label] = "skipped (no website domain)"
            continue
        r = post(f"{apollo.API}/mixed_people/api_search", headers=apollo.HEADERS(key), json={**base, **body}, timeout=60)
        try:
            j = r.json()
        except Exception:  # noqa: BLE001
            j = {}
        people = j.get("people") or []
        out[label] = {"status": r.status_code, "returned": len(people), "total": (j.get("pagination") or {}).get("total_entries"), "error": None if r.ok else r.text[:140],
                      "top": [f"{x.get('first_name')} {x.get('last_name') or x.get('last_name_obfuscated')} | {x.get('title')} | {(x.get('organization') or {}).get('name')}" for x in people[:4]]}
    return out


def enrich_variants(rest, key, name, ods, post=requests.post):
    """PAID test for ONE named person (credits only if an email comes back; it stops at the first call that reveals one). Takes the person's saved Apollo contact, then asks Apollo to enrich them with
    different identifiers, strongest first, and reports which one revealed the email. The email itself is masked in the log; Atlas picks the revealed email up from the saved contact on its next check."""
    pr = next(iter(rest.select_all("gp_practices", "ods_code,practice_name,website", order="ods_code", params={"ods_code": f"eq.{ods}"})), {})
    person = {"full_name": name, "first_name": name.split()[0], "last_name": name.split()[-1]}
    r = post(f"{apollo.API}/contacts/search", headers=apollo.HEADERS(key), json={"q_keywords": name, "per_page": 25, "page": 1}, timeout=60)
    saved = next((c for c in (r.json() or {}).get("contacts") or [] if apollo._same_person(c, person) and apollo.company_matches({"name": c.get("organization_name")}, pr.get("practice_name"), pr.get("website"))), None)
    if not saved:
        return {"error": "no saved Apollo contact at this practice"}
    org = saved.get("organization_name")
    attempts = [("A id only", {"id": saved.get("id")}),
                ("B linkedin_url", {"linkedin_url": saved.get("linkedin_url")} if saved.get("linkedin_url") else None),
                ("C id + name + organisation", {"id": saved.get("id"), "first_name": saved["first_name"], "last_name": saved["last_name"], "organization_name": org}),
                ("D name + organisation", {"first_name": saved["first_name"], "last_name": saved["last_name"], "organization_name": org}),
                ("E name + organisation + linkedin", {"first_name": saved["first_name"], "last_name": saved["last_name"], "organization_name": org, **({"linkedin_url": saved.get("linkedin_url")} if saved.get("linkedin_url") else {})})]
    out = {"saved_contact": {"id": saved.get("id"), "person_id": saved.get("person_id"), "org": org, "has_linkedin": bool(saved.get("linkedin_url")), "email_status": saved.get("email_status"), "email_present": bool(saved.get("email"))}, "attempts": []}
    for label, body in attempts:
        if not body:
            out["attempts"].append({label: "skipped"})
            continue
        resp = post(f"{apollo.API}/people/match", headers=apollo.HEADERS(key), json={"reveal_personal_emails": False, **body}, timeout=60)
        try:
            j = resp.json()
        except Exception:  # noqa: BLE001
            j = {}
        pers = j.get("person") or {}
        email = str(pers.get("email") or "")
        got = bool(email) and not apollo.LOCKED.search(email)
        out["attempts"].append({label: {"status": resp.status_code, "person_found": bool(pers), "person_keys_with_values": sorted(k for k, v in pers.items() if v)[:25], "email_status": pers.get("email_status"),
                                        "email_revealed": got, "email_masked": (email[:2] + "***@" + email.split("@")[-1]) if got else None, "error": None if resp.ok else resp.text[:140]}})
        if got:
            break
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APOLLO_API_KEY", "NAME", "ODS"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    if env.get("ENRICH") == "1":
        print("ENRICH " + json.dumps(enrich_variants(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["APOLLO_API_KEY"], env["NAME"].strip(), env["ODS"].strip().upper()), default=str))
        return
    if env.get("VARIANTS") == "1":
        print("VARIANTS " + json.dumps(variants(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["APOLLO_API_KEY"], env["NAME"].strip(), env["ODS"].strip().upper()), default=str))
        return
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), env["APOLLO_API_KEY"], env["NAME"].strip(), env["ODS"].strip().upper()), default=str))


if __name__ == "__main__":
    main()
