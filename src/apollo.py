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


HEADERS = lambda key: {"X-Api-Key": key, "Content-Type": "application/json", "Cache-Control": "no-cache"}   # noqa: E731
STOP = {"the", "and", "of", "surgery", "medical", "centre", "center", "practice", "group", "health", "healthcare", "gp", "partnership", "clinic", "limited", "ltd", "nhs", "primary", "care", "general"}


def _tokens(name):
    return {t for t in re.findall(r"[a-z0-9]+", str(name or "").lower()) if t not in STOP}


def _domain(url):
    return re.sub(r"^(https?://)?(www\.)?", "", str(url or "").strip().lower()).split("/")[0]


def company_matches(org, practice, website=None):
    """Is Apollo's organisation this practice? Same website domain, or the names share their distinctive words (Staverton Surgery = Staverton Medical Practice)."""
    org = org or {}
    d1, d2 = _domain(org.get("primary_domain") or org.get("website_url")), _domain(website)
    if d1 and d2 and d1 == d2:
        return True
    a, b = _tokens(org.get("name")), _tokens(practice)
    return bool(a and b and (a <= b or b <= a or len(a & b) / len(a | b) >= 0.5))


def _same_person(p, person):
    first = str(person.get("first_name") or "").strip().lower()
    last = str(person.get("last_name") or "").strip().lower()
    last_p = str(p.get("last_name") or p.get("last_name_obfuscated") or "").strip().lower().split("*")[0]   # Apollo's search may hide the end of a surname
    return bool(first and last and str(p.get("first_name") or "").strip().lower() == first and last_p and last.startswith(last_p))


def check(person, practice, website, key, post=requests.post):
    """Free of credits: search Apollo for the person and compare their organisation with the practice. Returns {match, apollo_person_id, apollo_org} where match is matched, no_person or company_mismatch."""
    r = post(f"{API}/mixed_people/api_search", headers=HEADERS(key), json={"q_keywords": person.get("full_name"), "per_page": 25, "page": 1}, timeout=60)
    if r.status_code in (401, 403, 422, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    r.raise_for_status()
    same = [p for p in ((r.json() or {}).get("people") or []) if _same_person(p, person)]
    if not same:
        return {"match": "no_person", "apollo_person_id": None, "apollo_org": None}
    for p in same:
        if company_matches(p.get("organization"), practice, website):
            return {"match": "matched", "apollo_person_id": p.get("id"), "apollo_org": (p.get("organization") or {}).get("name")}
    org = same[0].get("organization") or {}
    return {"match": "company_mismatch", "apollo_person_id": same[0].get("id"), "apollo_org": org.get("name"),
            "apollo_org_info": {k: org.get(k) for k in ("name", "primary_domain", "city", "postal_code") if org.get(k)}}


def suggest_practices(org_info, practices, limit=5):
    """Practices that look like the organisation Apollo has the person at: same website domain first, then the most shared distinctive words in the name (and the same postcode area breaks a tie)."""
    a, dom, post = _tokens((org_info or {}).get("name")), _domain((org_info or {}).get("primary_domain")), str((org_info or {}).get("postal_code") or "").replace(" ", "").upper()
    scored = []
    for p in practices:
        b = _tokens(p.get("practice_name"))
        score = (10 if dom and dom == _domain(p.get("website")) else 0) + (len(a & b) / len(a | b) if a and b else 0) + (0.2 if post and post[:4] == str(p.get("postcode") or "").replace(" ", "").upper()[:4] else 0)
        if score >= 0.5:
            scored.append((score, p))
    return [{"ods_code": p["ods_code"], "practice_name": p["practice_name"]} for _, p in sorted(scored, key=lambda x: -x[0])[:limit]]


def lookup(person, practice, key, post=requests.post):
    """(email, email_status, note). One people/match call for the verified person; it spends credits only when an address comes back."""
    body = {"reveal_personal_emails": False, "organization_name": practice}
    body.update({"id": person["apollo_person_id"]} if person.get("apollo_person_id") else {"first_name": person.get("first_name"), "last_name": person.get("last_name"), "name": person.get("full_name")})
    r = post(f"{API}/people/match", headers=HEADERS(key), json=body, timeout=60)
    if r.status_code in (401, 403, 422, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    r.raise_for_status()
    p = (r.json() or {}).get("person") or {}
    email = (p.get("email") or "").strip().lower()
    if not email or LOCKED.search(email):
        return None, None, "no address found" if not p else "person found, address not available"
    return email, p.get("email_status"), None


def _name_key(ods, name):
    return (ods, " ".join(str(name or "").lower().split()))


def prune_known(rest):
    """Anyone waiting for Apollo (waiting, approved or in review) whom Atlas already holds at that practice with an address is taken out of the queue: there is nothing to look up and credits would be wasted."""
    known = {_name_key(r["ods_code"], r.get("full_name")) for r in rest.select_all("contacts", "contact_urn,ods_code,full_name,email", order="contact_urn", params={"email": "not.is.null"}) if r.get("full_name")}
    n = 0
    for c in rest.select_all("apollo_queue", "contact_urn,ods_code,full_name", order="contact_urn", params={"state": "in.(pending,approved,review)"}):
        if _name_key(c["ods_code"], c.get("full_name")) in known:
            rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "not_found", "note": "Atlas already holds this person at this practice with an address"})
            n += 1
    return n


def hubspot_same_name(hub, c, company_id, email):
    """A contact on the practice's HubSpot company with this name and a different address, as {id, email}; None when there is none (or no company)."""
    if not hub or not company_id:
        return None
    ids = [str(x["toObjectId"]) for x in hub.call("GET", f"/crm/v4/objects/companies/{company_id}/associations/contacts", params={"limit": 100}).get("results", [])]
    if not ids:
        return None
    first, last = str(c.get("first_name") or "").strip().lower(), str(c.get("last_name") or "").strip().lower()
    for r in hub.call("POST", "/crm/v3/objects/contacts/batch/read", json={"properties": ["firstname", "lastname", "email"], "inputs": [{"id": i} for i in ids[:100]]}).get("results", []):
        p = r.get("properties") or {}
        theirs = str(p.get("email") or "").strip().lower()
        if first and last and theirs and theirs != email and str(p.get("firstname") or "").strip().lower() == first and str(p.get("lastname") or "").strip().lower() == last:
            return {"id": str(r["id"]), "email": theirs}
    return None


def same_name_other_address(rest, hub, c, company_id, email):
    """Does Atlas (first) or HubSpot already hold this person at this practice under a different address? Returns {email, where, urn, hubspot_id} or None."""
    key = _name_key(c["ods_code"], c.get("full_name"))
    for r in rest.select_all("contacts", "contact_urn,ods_code,full_name,email,hubspot_contact_id", order="contact_urn", params={"ods_code": f"eq.{c['ods_code']}", "email": "not.is.null"}):
        if _name_key(r["ods_code"], r.get("full_name")) == key and str(r["email"]).strip().lower() != email:
            return {"email": str(r["email"]).strip().lower(), "where": "Atlas", "urn": r["contact_urn"], "hubspot_id": r.get("hubspot_contact_id")}
    h = hubspot_same_name(hub, c, company_id, email)
    return {"email": h["email"], "where": "HubSpot", "urn": None, "hubspot_id": h["id"]} if h else None


def apply_accepted(rest, now):
    """People whose Apollo address was chosen in review: the Atlas contact that already holds them is changed to the Apollo address (and waits for NeverBounce, then HubSpot updates the same record); with no Atlas contact, one is added."""
    n = 0
    for c in rest.select_all("apollo_queue", "*", order="contact_urn", params={"state": "eq.accepted"}):
        email = str(c.get("apollo_email") or "").strip().lower()
        if not email:
            continue
        quality, _ = contact_quality.email_quality(email, c.get("first_name"), c.get("last_name"))
        q = quality if quality in ("direct", "likely_direct", "check", "shared") else None
        if c.get("existing_urn"):
            rest.patch("contacts", {"contact_urn": f"eq.{c['existing_urn']}"}, {"email": email, "email_quality": q, "source": "apollo", "nb_state": "pending"})
        else:
            rest.insert("contacts", [{"ods_code": c["ods_code"], "full_name": c.get("full_name"), "first_name": c.get("first_name"), "last_name": c.get("last_name"), "job_title": c.get("job_title"), "email": email,
                                      "email_quality": q, "role_tier": c.get("role_tier"), "source": "apollo", "nb_state": "pending"}])
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "found", "checked_at": now})
        n += 1
    return n


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


def run(rest, key, cap=MAX_PER_RUN, post=requests.post, now=None, mode="enrich", hub=None):
    """mode 'check': only verify approved contacts at Apollo (no credits). 'enrich': verify, then look up the email of each verified one. Both are capped at `cap` contacts a run."""
    now = (now or datetime.now(timezone.utc)).isoformat()
    applied = apply_accepted(rest, now)
    approved = rest.select_all("apollo_queue", "*", order="contact_urn", params={"state": "eq.approved"})
    main = main_titles(rest, [c.get("job_title") or "" for c in approved])
    for c in [c for c in approved if (c.get("job_title") or "") not in main]:   # the Settings rules changed since it was approved: only Main roles are looked up
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "pending", "approved_by": None, "approved_at": None, "note": "no longer a Main role, taken back to waiting"})
    approved = [c for c in approved if (c.get("job_title") or "") in main]
    approved.sort(key=lambda c: c.get("match") != "matched")   # already-verified ones first: they are the ones that can be enriched
    approved = approved[:max(0, min(cap, MAX_PER_RUN))]
    practices = {r["ods_code"]: r for r in rest.select_all("gp_practices", "ods_code,practice_name,website,postcode,hubspot_company_id", order="ods_code")}
    out = {"checked": 0, "matched": 0, "no_match": 0, "looked_up": 0, "found": 0, "not_found": 0, "errors": 0, "waiting": 0, "applied_from_review": applied}
    for c in approved:
        pr = practices.get(c["ods_code"]) or {}
        pq = {"contact_urn": f"eq.{c['contact_urn']}"}
        try:
            if c.get("match") != "matched":   # step 1, free: is the person at Apollo, at this practice?
                res = check(c, pr.get("practice_name"), pr.get("website"), key, post)
                out["checked"] += 1
                rest.patch("apollo_queue", pq, {**res, "matched_at": now})
                c.update(res)
                if res["match"] == "company_mismatch":   # a review list: move them to the matching practice, then they are re-queued for enrichment
                    out["review"] = out.get("review", 0) + 1
                    rest.patch("apollo_queue", pq, {"state": "review", "review_reason": "different_practice", "checked_at": now, "suggested_ods": suggest_practices(res.get("apollo_org_info"), practices.values()),
                                                    "note": f"Apollo has them at {res.get('apollo_org') or 'another organisation'}, not this practice"})
                    continue
                if res["match"] != "matched":
                    out["no_match"] += 1
                    rest.patch("apollo_queue", pq, {"state": "not_found", "checked_at": now, "note": "Apollo has no one of that name"})
                    continue
            out["matched"] += 1
            if mode == "check":
                continue
            email, status, note = lookup(c, pr.get("practice_name"), key, post)   # step 2, uses credits when an address comes back
        except Exception as e:  # noqa: BLE001  the contact stays approved and is tried again next run; stop on repeated failures (a bad key, no credits)
            out["errors"] += 1
            out["last_error"] = str(e)[:200]
            if out["errors"] >= 3:
                break
            continue
        out["looked_up"] += 1
        if not email:
            out["not_found"] += 1
            rest.patch("apollo_queue", pq, {"state": "not_found", "note": note, "checked_at": now})
            continue
        try:   # the same person already held here under a different address: nothing is created or changed, a person decides in review (the credits for the address are spent either way)
            other = same_name_other_address(rest, hub, c, pr.get("hubspot_company_id"), email)
        except Exception as e:  # noqa: BLE001  a HubSpot hiccup must not turn into a duplicate: the contact stays approved for the next run
            out["errors"] += 1
            out["last_error"] = str(e)[:200]
            continue
        if other:
            out["found"] += 1
            out["review_email"] = out.get("review_email", 0) + 1
            patch = {"state": "review", "review_reason": "different_email", "apollo_email": email, "apollo_email_status": status, "existing_email": other["email"], "existing_where": other["where"], "existing_urn": other["urn"],
                     "checked_at": now, "note": f"Apollo found {email}; {other['where']} already has {other['email']}"}
            try:
                rest.patch("apollo_queue", pq, {**patch, **({"hubspot_contact_id": other["hubspot_id"]} if other.get("hubspot_id") and not c.get("hubspot_contact_id") else {})})
            except Exception:  # noqa: BLE001  the HubSpot id is already on another queue row
                rest.patch("apollo_queue", pq, patch)
            continue
        dup = rest.select_all("contacts", "contact_urn", order="contact_urn", params={"ods_code": f"eq.{c['ods_code']}", "email": f"eq.{email}"})
        if not dup:
            quality, _ = contact_quality.email_quality(email, c.get("first_name"), c.get("last_name"))
            rest.insert("contacts", [{"ods_code": c["ods_code"], "full_name": c.get("full_name"), "first_name": c.get("first_name"), "last_name": c.get("last_name"), "job_title": c.get("job_title"), "email": email,
                                      "email_quality": quality if quality in ("direct", "likely_direct", "check", "shared") else None, "role_tier": c.get("role_tier"), "source": "apollo", "nb_state": "pending"}])
        out["found"] += 1
        rest.patch("apollo_queue", pq, {"state": "found", "apollo_email": email, "apollo_email_status": status, "checked_at": now, "note": "already a contact" if dup else None})
    out["addresses_found"] = out["found"]   # credits are worked out on the Apollo page from the credits-per-address setting
    out["waiting"] = len(rest.select_all("apollo_queue", "contact_urn", order="contact_urn", params={"state": "eq.approved"}))
    return out


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rest = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    try:
        print("Taken out of the queue (already held with an address):", prune_known(rest))
    except Exception as e:  # noqa: BLE001
        print("Queue tidy skipped:", e)
    cov = coverage(rest)
    print("Coverage:", cov)
    summary = {"at": datetime.now(timezone.utc).isoformat(), "coverage": cov}
    if env.get("APOLLO_API_KEY") and env.get("APOLLO_MODE", "enrich") != "none":
        from .hubspot_sync import Hub
        out = run(rest, env["APOLLO_API_KEY"], int(env.get("APOLLO_CAP") or MAX_PER_RUN), mode="check" if env.get("APOLLO_MODE") == "check" else "enrich", hub=Hub(env["HUBSPOT_TOKEN"]) if env.get("HUBSPOT_TOKEN") else None)
        print("Apollo:", out)
        summary["run"] = out
    else:
        print("Apollo key not set or mode none: coverage only")
    rest.upsert("app_flags", [{"key": "apollo_status", "value": summary, "updated_at": summary["at"]}], "key")


if __name__ == "__main__":
    main()
