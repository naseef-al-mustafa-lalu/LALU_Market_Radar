"""Apollo: look up the email address of people Oscar names (with a decision-maker role) but gives no address for. Only contacts a person approved in Atlas > Contacts > Apollo are looked up, at most
MAX_PER_RUN a run (each lookup that returns an address costs Apollo credits). A found address becomes a contact with source 'apollo' and waits in the NeverBounce approval queue; nothing reaches HubSpot
until it has been checked and approved there. Also records, for the Apollo page, how many practices lack a Practice Manager or a second Main-role contact."""
import os
import re
import sys
import time
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


HEALTH = re.compile(r"health|medical|surgery|practice|centre|center|clinic|pcn|partnership|\bgp\b|\bnhs\b|primary care|doctors", re.I)


def _words(text):
    return set(re.findall(r"[a-z]+", str(text or "").lower())) - {"and", "of", "the", "a"}


def _candidate_score(p, person):
    """How much a same-name Apollo result looks like our person: the job title (+2 when it holds all the words of ours, +1 for some, so a Practice Manager beats a Pharmacist Manager) and a healthcare-looking organisation (+1)."""
    theirs, ours = _words(p.get("title")), _words(person.get("job_title"))
    title = 2 if ours and ours <= theirs else (1 if theirs & ours else 0)
    return title + (1 if HEALTH.search(str((p.get("organization") or {}).get("name") or "")) else 0)


def _people_search(key, post, body):
    """One free People API Search; None when Apollo rejects a filter (the caller falls back to a plainer search)."""
    r = post(f"{API}/mixed_people/api_search", headers=HEADERS(key), json=body, timeout=60)
    if r.status_code in (401, 403, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    if r.status_code == 422:
        return None
    r.raise_for_status()
    return (r.json() or {}).get("people") or []


def check(person, practice, website, key, post=requests.post, alt_names=()):
    """Free of credits: find the person in Apollo and compare their organisation with the practice (its Atlas name, or its HubSpot company name). Tested against the real API: a search for the name AND the job
    title (person_titles) is the one that narrows a common name to the right person; putting the practice in the keywords, or filtering by organisation name or domain, returns nothing. So: search name + title; if
    nobody of that title comes back, search the name alone. Returns {match, apollo_person_id, apollo_org} where match is matched, no_person or company_mismatch."""
    names = [n for n in (practice, *alt_names) if n]
    title = str(person.get("job_title") or "").strip()
    base = {"q_keywords": person.get("full_name"), "per_page": 25, "page": 1}
    same = []
    for body in ([{**base, "person_titles": [title]}] if title else []) + [base]:
        people = _people_search(key, post, body)
        if people is None:
            continue
        found = [p for p in people if _same_person(p, person)]
        for p in found:
            if any(company_matches(p.get("organization"), n, website) for n in names):
                return {"match": "matched", "apollo_person_id": p.get("id"), "apollo_org": (p.get("organization") or {}).get("name")}
        same += [p for p in found if p.get("id") not in {q.get("id") for q in same}]
        if found:   # people of that title exist but none at this practice: do not widen to same-name people with other jobs
            break
    if not same:
        return {"match": "no_person", "apollo_person_id": None, "apollo_org": None}
    best = max(same, key=lambda p: _candidate_score(p, person))   # not whichever came first: the one whose job title and organisation look most like our person
    org = best.get("organization") or {}
    return {"match": "company_mismatch", "apollo_person_id": best.get("id"), "apollo_org": org.get("name"), "apollo_looks_like_practice": _candidate_score(best, person) >= 3,
            "apollo_org_info": {k: org.get(k) for k in ("name", "primary_domain", "city", "postal_code") if org.get(k)}}


def saved_contact(person, practice, website, key, post=requests.post, alt_names=()):
    """Free of credits: is this person already one of YOUR Apollo contacts, at this practice? Returns {email, status, person_id, org} (email is None when the contact has none yet) or None.
    A saved contact at the practice is a verified match, with or without an email; with one, nothing more is needed."""
    r = post(f"{API}/contacts/search", headers=HEADERS(key), json={"q_keywords": person.get("full_name"), "per_page": 25, "page": 1}, timeout=60)
    if r.status_code in (401, 403, 422, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    r.raise_for_status()
    names = [x for x in (practice, *alt_names) if x]
    best = None
    for p in (r.json() or {}).get("contacts") or []:
        org = p.get("organization_name") or (p.get("organization") or {}).get("name")
        if not _same_person(p, person) or not any(company_matches({"name": org, "primary_domain": (p.get("organization") or {}).get("primary_domain")}, n, website) for n in names):
            continue
        email = str(p.get("email") or "").strip().lower()
        hit = {"email": None if (not email or LOCKED.search(email)) else email, "status": p.get("email_status"), "person_id": p.get("person_id") or p.get("id"), "org": org}   # the contact's own id when it is not linked to a person record: the id Apollo itself shows for them
        if hit["email"]:
            return hit
        best = best or hit
    return best


def location_matches(org_info, practice):
    """Evidence that Apollo's organisation is in the same place as the practice: the same postcode area (the part before the space) or the same town. Without it a same-name person elsewhere is a namesake."""
    org_info = org_info or {}
    pc = lambda v: str(v or "").upper().replace(" ", "")   # noqa: E731
    a, b = pc(org_info.get("postal_code")), pc(practice.get("postcode"))
    if len(a) >= 4 and len(b) >= 4 and a[:-3] == b[:-3]:
        return True
    return bool(org_info.get("city") and practice.get("town") and str(org_info["city"]).strip().lower() == str(practice["town"]).strip().lower())


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
    """(email, email_status, note). One people/match call for the verified person (pinned by its Apollo id); it spends credits only when an email comes back. Apollo answers 200 with the submitted details echoed back
    even when it found no one, so the answer is read from match_confidence: only high or medium counts as a match (none means Apollo could not identify the person, and no credits are charged)."""
    body = {"reveal_personal_emails": False, "id": person["apollo_person_id"]}   # always pinned to the person that was verified
    r = post(f"{API}/people/match", headers=HEADERS(key), json=body, timeout=60)
    if r.status_code in (401, 403, 422, 429):
        raise RuntimeError(f"Apollo {r.status_code}: {r.text[:160]}")
    r.raise_for_status()
    p = (r.json() or {}).get("person") or {}
    email = (p.get("email") or "").strip().lower()
    confidence = str(p.get("match_confidence") or "").lower()
    has_email = bool(email) and not LOCKED.search(email)
    if has_email and confidence in ("high", "medium"):
        return email, p.get("email_status"), None
    if has_email:   # a weak match is not trusted with a contact's name
        return None, None, f"no api match: low-confidence match ({confidence or 'none'}), email not used"
    if not p:
        return None, None, "no email found"
    return None, None, "person found, email not available" if confidence in ("high", "medium") else "no api match: Apollo could not match them to a person record"


def _name_key(ods, name):
    return (ods, " ".join(str(name or "").lower().split()))


def prune_known(rest):
    """Anyone waiting for Apollo (waiting, approved or in review) whom Atlas already holds at that practice with an email is taken out of the queue: there is nothing to look up and credits would be wasted."""
    known = {_name_key(r["ods_code"], r.get("full_name")) for r in rest.select_all("contacts", "contact_urn,ods_code,full_name,email", order="contact_urn", params={"email": "not.is.null"}) if r.get("full_name")}
    n = 0
    for c in rest.select_all("apollo_queue", "contact_urn,ods_code,full_name", order="contact_urn", params={"state": "in.(pending,approved,review)"}):
        if _name_key(c["ods_code"], c.get("full_name")) in known:
            rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "not_found", "note": "Atlas already holds this person at this practice with an email"})
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


def ensure_status(rest):
    """Contacts this job adds need a row in contact_status, or the NeverBounce tab (which joins on it) never shows them. Any Apollo contact without one triggers a refresh. Returns how many were missing."""
    mine = [r["contact_urn"] for r in rest.select_all("contacts", "contact_urn", order="contact_urn", params={"source": "eq.apollo"}) if r.get("contact_urn") is not None]
    have = set()
    for i in range(0, len(mine), 200):
        have |= {r["contact_urn"] for r in rest.select_all("contact_status", "contact_urn", order="contact_urn", params={"contact_urn": f"in.({','.join(str(u) for u in mine[i:i + 200])})"})}
    missing = [u for u in mine if u not in have]
    if missing:
        rest.rpc("refresh_contact_status")
    return len(missing)


def add_contact(rest, c, email):
    """A contact with the email Apollo found (source 'apollo'), waiting in the NeverBounce approval queue. NeverBounce state lives in its own table (contact_nb), so it is written there."""
    quality, _ = contact_quality.email_quality(email, c.get("first_name"), c.get("last_name"))
    made = rest.insert("contacts", [{"ods_code": c["ods_code"], "full_name": c.get("full_name"), "first_name": c.get("first_name"), "last_name": c.get("last_name"), "job_title": c.get("job_title"), "email": email,
                                     "email_quality": quality if quality in ("direct", "likely_direct", "check", "shared") else None, "role_tier": c.get("role_tier"), "source": "apollo"}], returning=True)
    rest.upsert("contact_nb", [{"contact_urn": made[0]["contact_urn"], "nb_state": "pending"}], "contact_urn")
    return made[0]["contact_urn"]


def apply_accepted(rest, now):
    """People whose Apollo address was chosen in review: the Atlas contact that already holds them is changed to the Apollo address (and waits for NeverBounce, then HubSpot updates the same record); with no Atlas contact, one is added."""
    n = 0
    for c in rest.select_all("apollo_queue", "*", order="contact_urn", params={"state": "eq.accepted"}):
        email = str(c.get("apollo_email") or "").strip().lower()
        if not email:
            continue
        if c.get("existing_urn"):
            quality, _ = contact_quality.email_quality(email, c.get("first_name"), c.get("last_name"))
            rest.patch("contacts", {"contact_urn": f"eq.{c['existing_urn']}"}, {"email": email, "email_quality": quality if quality in ("direct", "likely_direct", "check", "shared") else None, "source": "apollo"})
            rest.upsert("contact_nb", [{"contact_urn": c["existing_urn"], "nb_state": "pending", "nb_result": None}], "contact_urn")
        else:
            add_contact(rest, c, email)
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


NEEDS_REVEAL = "needs reveal in Apollo: Apollo's API could not give an email for them (it cannot match them to a person record, or holds no email). Reveal it in Apollo and it is pulled in free within the hour."


def reopen_unrevealed(rest):
    """People parked as 'not found' only because the API lookup returned no email (the email can be revealed in Apollo itself) go back to waiting for a reveal, so an email revealed in Apollo is pulled in free."""
    n = 0
    for c in rest.select_all("apollo_queue", "contact_urn", order="contact_urn", params={"state": "eq.not_found", "note": "eq.person found, email not available"}):
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "approved", "note": NEEDS_REVEAL, "checked_at": None})
        n += 1
    return n


CHECK_LOGIC_SINCE = "2026-11-20T14:55:00+00:00"   # review rows decided by an older, name-only search are re-checked by the job itself


def recheck_stale_review(rest):
    """People sent to the review list (a different practice) by an earlier version of the check go back to approved, so the current search judges them again. Nobody has to do it by hand."""
    n = 0
    for c in rest.select_all("apollo_queue", "contact_urn,matched_at", order="contact_urn", params={"state": "eq.review", "review_reason": "eq.different_practice", "apollo_email": "is.null"}):
        if str(c.get("matched_at") or "") < CHECK_LOGIC_SINCE:
            rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "approved", "match": None, "apollo_person_id": None, "apollo_org": None, "apollo_org_info": None, "suggested_ods": None,
                                                                                   "review_reason": None, "matched_at": None, "checked_at": None, "note": "re-checked automatically with the improved search"})
            n += 1
    return n


def run(rest, key, cap=MAX_PER_RUN, post=requests.post, now=None, mode="enrich", hub=None, only=None):
    """mode 'check': only verify approved contacts at Apollo (no credits). 'enrich': verify, then look up the email of each verified one. Both are capped at `cap` contacts a run."""
    now = (now or datetime.now(timezone.utc)).isoformat()
    applied = apply_accepted(rest, now)
    rechecked = recheck_stale_review(rest)
    reopened = reopen_unrevealed(rest)
    approved = rest.select_all("apollo_queue", "*", order="contact_urn", params={"state": "eq.approved"})
    main = main_titles(rest, [c.get("job_title") or "" for c in approved])
    for c in [c for c in approved if (c.get("job_title") or "") not in main]:   # the Settings rules changed since it was approved: only Main roles are looked up
        rest.patch("apollo_queue", {"contact_urn": f"eq.{c['contact_urn']}"}, {"state": "pending", "approved_by": None, "approved_at": None, "note": "no longer a Main role, taken back to waiting"})
    approved = [c for c in approved if (c.get("job_title") or "") in main]
    if only:   # a test on one named person: nobody else is looked up or paid for
        approved = [c for c in approved if only.strip().lower() in str(c.get("full_name") or "").lower()]
    approved.sort(key=lambda c: c.get("match") != "matched")   # already-verified ones first: they are the ones that can be enriched
    approved = approved[:max(0, min(cap, MAX_PER_RUN))]
    practices = {r["ods_code"]: r for r in rest.select_all("gp_practices", "ods_code,practice_name,website,postcode,town,hubspot_company_id", order="ods_code")}
    try:   # the practice's HubSpot company name is a second name to compare with Apollo's organisation
        hs_names = {r["ods_code"]: r.get("company_name") for r in rest.select_all("hubspot_links", "ods_code,company_name", order="ods_code")}
    except Exception:  # noqa: BLE001
        hs_names = {}
    pause = 0.3 if post is requests.post else 0   # Apollo rate-limits: a short pause between contacts
    out = {"checked": 0, "matched": 0, "no_match": 0, "looked_up": 0, "found": 0, "not_found": 0, "errors": 0, "waiting": 0, "applied_from_review": applied, "rechecked_review": rechecked, "reopened_for_reveal": reopened}
    for c in approved:
        pr = practices.get(c["ods_code"]) or {}
        alt = [hs_names.get(c["ods_code"])]
        pq = {"contact_urn": f"eq.{c['contact_urn']}"}
        time.sleep(pause)
        free, reused = False, False
        try:
            if c.get("apollo_email"):   # found on an earlier run but the contact could not be saved: reuse the email, never look it up (or pay) twice
                saved, reused = {"email": c["apollo_email"], "status": c.get("apollo_email_status")}, True
            else:
                try:   # step 0, free: already one of your Apollo contacts, at this practice?
                    saved = saved_contact(c, pr.get("practice_name"), pr.get("website"), key, post, alt)
                except Exception as e:  # noqa: BLE001  the saved-contacts search is a bonus: if it is refused, the normal check and enrich still work
                    saved = None
                    out["saved_search_error"] = str(e)[:160]
            if saved and saved.get("email"):   # enriched before: the email is just pulled, no credits
                email, status, note = saved["email"], saved.get("status"), None
                free = bool(c.get("free")) if reused else True
                if not reused:
                    out["from_apollo_contacts"] = out.get("from_apollo_contacts", 0) + 1
                    rest.patch("apollo_queue", pq, {"match": "matched", "matched_at": now})
            elif saved:   # a saved Apollo contact at this practice but with no email yet: a verified match, enriched below by its own Apollo id
                res = {"match": "matched", "apollo_person_id": saved.get("person_id"), "apollo_org": saved.get("org")}
                rest.patch("apollo_queue", pq, {**res, "matched_at": now})
                c.update(res)
                out["from_saved_contact_match"] = out.get("from_saved_contact_match", 0) + 1
            elif c.get("match") != "matched":   # step 1, free: is the person at Apollo, at this practice?
                res = check(c, pr.get("practice_name"), pr.get("website"), key, post, alt)
                out["checked"] += 1
                rest.patch("apollo_queue", pq, {**{k: v for k, v in res.items() if k != "apollo_looks_like_practice"}, "matched_at": now})
                c.update(res)
                if res["match"] == "company_mismatch":
                    sug = suggest_practices(res.get("apollo_org_info"), practices.values())
                    # a same-name person at another organisation is usually a namesake: only an organisation in the same place as the practice is worth a person's review
                    if not (sug and location_matches(res.get("apollo_org_info"), pr)):
                        out["no_match"] += 1
                        rest.patch("apollo_queue", pq, {"state": "not_found", "checked_at": now, "note": f"Apollo has a same-name person at {res.get('apollo_org') or 'another organisation'}, with nothing to show it is the same person"})
                        continue
                    out["review"] = out.get("review", 0) + 1   # a review list: move them to the matching practice, then they are re-queued for enrichment
                    rest.patch("apollo_queue", pq, {"state": "review", "review_reason": "different_practice", "checked_at": now, "suggested_ods": sug,
                                                    "note": f"Apollo has a same-name person at {res.get('apollo_org') or 'another organisation'}, in the same area as this practice"})
                    continue
                if res["match"] != "matched":
                    out["no_match"] += 1
                    rest.patch("apollo_queue", pq, {"state": "not_found", "checked_at": now, "note": "Apollo has no one of that name"})
                    continue
            if not free:
                out["matched"] += 1
                if mode == "check":
                    continue
                if str(c.get("note") or "").startswith("needs reveal in Apollo"):   # already tried through the API: it is waiting for a reveal in Apollo, which the saved-contact pull above picks up
                    out["needs_reveal"] = out.get("needs_reveal", 0) + 1
                    continue
                if not c.get("apollo_person_id"):   # no Apollo id to pin the lookup to: enriching from name and company text could land on a namesake and spend credits on the wrong person
                    out["needs_apollo_id"] = out.get("needs_apollo_id", 0) + 1
                    rest.patch("apollo_queue", pq, {"note": "matched at the practice, but Apollo gave no person id: not enriched, so credits cannot go to a namesake. Reveal the email in Apollo (it is then pulled free)."})
                    continue
                email, status, note = lookup(c, pr.get("practice_name"), key, post)   # step 2, uses credits when an email comes back
        except Exception as e:  # noqa: BLE001  the contact stays approved and is tried again next run; stop on repeated failures (a bad key, no credits)
            out["errors"] += 1
            out["last_error"] = str(e)[:200]
            if out["errors"] >= 3:
                break
            continue
        out["looked_up"] += 0 if (free or reused) else 1
        if not email and str(note or "").startswith(("person found", "no api match")):   # the person exists but the API revealed no email: wait for a reveal in Apollo, do not give up on them
            out["needs_reveal"] = out.get("needs_reveal", 0) + 1
            rest.patch("apollo_queue", pq, {"note": NEEDS_REVEAL, "checked_at": now})
            continue
        if not reused and email:   # kept straight away: if saving the contact fails below, the email is not lost and not paid for again
            rest.patch("apollo_queue", pq, {"apollo_email": email, "apollo_email_status": status, "free": free})
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
            if not reused:
                out["found_free" if free else "found"] = out.get("found_free" if free else "found", 0) + 1
            out["review_email"] = out.get("review_email", 0) + 1
            patch = {"state": "review", "review_reason": "different_email", "apollo_email": email, "apollo_email_status": status, "existing_email": other["email"], "existing_where": other["where"], "existing_urn": other["urn"], "free": free,
                     "checked_at": now, "note": f"Apollo found {email}; {other['where']} already has {other['email']}"}
            try:
                rest.patch("apollo_queue", pq, {**patch, **({"hubspot_contact_id": other["hubspot_id"]} if other.get("hubspot_id") and not c.get("hubspot_contact_id") else {})})
            except Exception:  # noqa: BLE001  the HubSpot id is already on another queue row
                rest.patch("apollo_queue", pq, patch)
            continue
        dup = rest.select_all("contacts", "contact_urn", order="contact_urn", params={"ods_code": f"eq.{c['ods_code']}", "email": f"eq.{email}"})
        if not dup:
            add_contact(rest, c, email)
        if not reused:
            out["found_free" if free else "found"] = out.get("found_free" if free else "found", 0) + 1
        rest.patch("apollo_queue", pq, {"state": "found", "apollo_email": email, "apollo_email_status": status, "free": free, "checked_at": now,
                                        "note": ("already a contact" if dup else None) or ("already in your Apollo contacts: no credits used" if free else None)})
    try:   # contacts added now or earlier must have a status row to appear in the NeverBounce tab
        out["status_rows_added"] = ensure_status(rest)
    except Exception as e:  # noqa: BLE001  not worth failing the run: it is retried on the next one
        out["status_error"] = str(e)[:120]
    out["addresses_found"] = out["found"]   # paid finds only; credits are worked out on the Apollo page from the credits-per-email setting
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
    mode = env.get("APOLLO_MODE") if env.get("APOLLO_MODE") in ("enrich", "check", "none") else "check"   # credits are only spent when enrich is asked for by name
    if env.get("APOLLO_API_KEY") and mode != "none":
        from .hubspot_sync import Hub
        out = run(rest, env["APOLLO_API_KEY"], int(env.get("APOLLO_CAP") or MAX_PER_RUN), mode=mode, hub=Hub(env["HUBSPOT_TOKEN"]) if env.get("HUBSPOT_TOKEN") else None, only=env.get("APOLLO_ONLY") or None)
        print("Apollo:", out)
        summary["run"] = out
    else:
        print("Apollo key not set or mode none: coverage only")
    rest.upsert("app_flags", [{"key": "apollo_status", "value": summary, "updated_at": summary["at"]}], "key")


if __name__ == "__main__":
    main()
