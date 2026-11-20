"""Apollo: look up the email address of people Oscar names (with a decision-maker role) but gives no address for. Only contacts a person approved in Atlas > Contacts > Apollo are looked up, at most
MAX_PER_RUN a run (each lookup that returns an address costs Apollo credits). A found address becomes a contact with source 'apollo' and waits in the NeverBounce approval queue; nothing reaches HubSpot
until it has been checked and approved there. Also records, for the Apollo page, how many practices lack a Practice Manager or a second Main-role contact."""
import os
import re
import sys
from datetime import datetime, timezone

import requests

from . import contact_quality
from .common import Rest

API = "https://api.apollo.io/api/v1"
MAX_PER_RUN = 200
LOCKED = re.compile(r"not_unlocked|@domain\.com$", re.I)   # Apollo's placeholder when the address is not revealed


def main_titles(rest, titles):
    """The job titles (of those given) that are Main under the saved Contacts > Settings rules, as decided by the database (apollo_title_sections). Raises if the database function is not there yet."""
    uniq = sorted({t for t in titles if t is not None})
    if not uniq:
        return set()
    out = set()
    for i in range(0, len(uniq), 500):
        out |= {r["title"] for r in (rest.rpc("apollo_title_sections", {"p_titles": uniq[i:i + 500]}) or []) if r.get("section") == "main"}
    return out


def lookup(person, practice, key, post=requests.post):
    """(email, email_status, note). One people/match call; it spends a credit only when an address comes back."""
    r = post(f"{API}/people/match", headers={"X-Api-Key": key, "Content-Type": "application/json", "Cache-Control": "no-cache"},
             json={"first_name": person.get("first_name"), "last_name": person.get("last_name"), "name": person.get("full_name"), "organization_name": practice, "reveal_personal_emails": False}, timeout=60)
    if r.status_code in (401, 403, 422, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    r.raise_for_status()
    p = (r.json() or {}).get("person") or {}
    email = (p.get("email") or "").strip().lower()
    if not email or LOCKED.search(email):
        return None, None, "no address found" if not p else "person found, address not available"
    return email, p.get("email_status"), None


def coverage(rest):
    """Practices with a Practice Manager and at least one other Main-role contact (counted from the stored contacts that have an address)."""
    practices = {r["ods_code"] for r in rest.select_all("gp_practices", "ods_code", order="ods_code")}
    pm, other = {}, {}
    for r in rest.select_all("contacts_full", "ods_code,job_title,email,role_tier", order="contact_urn", params={"email": "not.is.null", "role_tier": "in.(A,B)"}):
        o = r["ods_code"]
        if re.search(r"practice\s*(/\s*business\s*)?manager", r.get("job_title") or "", re.I):
            pm[o] = pm.get(o, 0) + 1
        else:
            other[o] = other.get(o, 0) + 1
    no_pm = [o for o in practices if not pm.get(o)]
    no_other = [o for o in practices if pm.get(o, 0) + other.get(o, 0) < 2]
    return {"practices": len(practices), "no_practice_manager": len(no_pm), "fewer_than_two": len(no_other), "covered": len(practices) - len(set(no_pm) | set(no_other))}


def run(rest, key, cap=MAX_PER_RUN, post=requests.post, now=None):
    now = (now or datetime.now(timezone.utc)).isoformat()
    approved = rest.select_all("apollo_queue", "*", order="contact_urn", params={"state": "eq.approved"})
    main = main_titles(rest, [c.get("job_title") or "" for c in approved])
    for c in [c for c in approved if (c.get("job_title") or "") not in main]:   # the Settings rules changed since it was approved: only Main roles are looked up
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "pending", "approved_by": None, "approved_at": None, "note": "no longer a Main role, taken back to waiting"})
    approved = [c for c in approved if (c.get("job_title") or "") in main][:max(0, min(cap, MAX_PER_RUN))]
    names = {r["ods_code"]: r["practice_name"] for r in rest.select_all("gp_practices", "ods_code,practice_name", order="ods_code")}
    out = {"looked_up": 0, "found": 0, "not_found": 0, "errors": 0, "waiting": 0}
    for c in approved:
        try:
            email, status, note = lookup(c, names.get(c["ods_code"]), key, post)
        except Exception as e:  # noqa: BLE001  the contact stays approved and is tried again next run; stop on repeated failures (a bad key, no credits)
            out["errors"] += 1
            out["last_error"] = str(e)[:200]
            if out["errors"] >= 3:
                break
            continue
        out["looked_up"] += 1
        if not email:
            out["not_found"] += 1
            rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "not_found", "note": note, "checked_at": now})
            continue
        dup = rest.select_all("contacts", "contact_urn", order="contact_urn", params={"ods_code": f"eq.{c['ods_code']}", "email": f"eq.{email}"})
        if not dup:
            quality, _ = contact_quality.email_quality(email, c.get("first_name"), c.get("last_name"))
            rest.insert("contacts", [{"ods_code": c["ods_code"], "full_name": c.get("full_name"), "first_name": c.get("first_name"), "last_name": c.get("last_name"), "job_title": c.get("job_title"), "email": email,
                                      "email_quality": quality if quality in ("direct", "likely_direct", "check", "shared") else None, "role_tier": c.get("role_tier"), "source": "apollo", "nb_state": "pending"}])
        out["found"] += 1
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "found", "apollo_email": email, "apollo_email_status": status, "checked_at": now, "note": "already a contact" if dup else None})
    out["credits_used"] = out["found"]   # one credit per address found
    out["waiting"] = len(rest.select_all("apollo_queue", "contact_urn", order="contact_urn", params={"state": "eq.approved"}))
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rest = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    cov = coverage(rest)
    print("Coverage:", cov)
    summary = {"at": datetime.now(timezone.utc).isoformat(), "coverage": cov}
    if env.get("APOLLO_API_KEY") and env.get("APOLLO_LOOKUP", "1") != "0":
        out = run(rest, env["APOLLO_API_KEY"], int(env.get("APOLLO_CAP") or MAX_PER_RUN))
        print("Apollo:", out)
        summary["run"] = out
    else:
        print("Apollo key not set or lookups off: coverage only")
    rest.upsert("app_flags", [{"key": "apollo_status", "value": summary, "updated_at": summary["at"]}], "key")


if __name__ == "__main__":
    main()
