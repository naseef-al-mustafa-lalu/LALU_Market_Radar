"""NeverBounce: new Oscar contacts that match the rules wait in an approval queue (Atlas > Contacts > NeverBounce); once a person approves them, the Monday run verifies each address, records the
result in Atlas and in HubSpot (property neverbounce_status), creates passing contacts in HubSpot on their practice's company, and adds them to the tracked static segments they fit.
Valid and Accept All (Unverifiable) pass; Unknown, Disposable and Invalid do not. Credit use is read from the account and logged on every run."""
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests

from . import slack
from .common import Rest

API = "https://api.neverbounce.com/v4"
HS_STATUS = {"valid": "Valid", "catchall": "Accept All (Unverifiable)", "unknown": "Unknown", "disposable": "Disposable", "invalid": "Invalid"}
PASS = {"Valid", "Accept All (Unverifiable)"}
MAX_PER_RUN = 1500
ROLE_RULES = [   # HubSpot's Job Role (job_role_standardised) from a job title, first match wins
    ("Senior Partner / Managing Partner", r"senior partner|managing partner"), ("GP Partner", r"\bgp\b.*partner|partner.*\bgp\b|^partner$|general practitioner.*partner"),
    ("PCN Clinical Director", r"clinical director|pcn.*director"), ("Operations Manager", r"operations?\s+manager|operational manager"),
    ("Practice Manager", r"practice\s*(/\s*business\s*)?manager|general manager|deputy practice|assistant practice"), ("Business Manager", r"business manager|business\s*/\s*practice"),
    ("Advanced Nurse Practitioner", r"advanced (nurse|clinical) practitioner|\banp\b"), ("Nurse Practitioner", r"nurse practitioner|practice nurse"),
    ("General Practitioner (GP)", r"\bgp\b|general practitioner|doctor|salaried|locum"), ("Administrator / Secretary", r"administrator|secretary|reception|admin\b")]


def standard_role(title):
    t = str(title or "").lower()
    return next((role for role, rx in ROLE_RULES if re.search(rx, t)), "Other")


def uk_monday_morning(now):
    """The run window: Monday before 09:00 UK time (UTC in winter, UTC+1 in summer, so 08:00 UTC is the latest safe start)."""
    uk = now + timedelta(hours=1) if 3 < now.month < 11 else now
    return uk.weekday() == 0 and uk.hour < 9


def verify(email, key, get=requests.get):
    r = get(f"{API}/single/check", params={"key": key, "email": email}, timeout=60)
    d = r.json()
    if d.get("status") != "success":
        raise RuntimeError(f"NeverBounce: {d.get('message') or d.get('status')}")
    return HS_STATUS.get(d.get("result"), "Unknown")


def credits_left(key, get=requests.get):
    try:
        d = get(f"{API}/account/info", params={"key": key}, timeout=60).json()
        c = d.get("credits_info") or {}
        return int(c.get("paid_credits_remaining", 0)) + int(c.get("free_credits_remaining", 0))
    except Exception:  # noqa: BLE001  credit tracking is informational
        return None


def queue_new(rest):
    """Put new Oscar contacts that qualify (a direct address, not opted out, a decision-maker or secondary role, not in HubSpot, never checked) in the approval queue. Returns how many were added."""
    rows = rest.select_all("contacts", "contact_urn,role_tier,email", order="contact_urn", params={"source": "eq.oscar", "held_reason": "is.null", "email_quality": "eq.direct", "email_opt_out": "eq.false",
                                                                                            "hubspot_contact_id": "is.null", "nb_state": "is.null", "email": "not.is.null"})
    known = {str(r["email"]).strip().lower() for r in rest.select_all("contacts", "contact_urn,email", order="contact_urn", params={"hubspot_contact_id": "not.is.null", "email": "not.is.null"})}   # an address HubSpot already holds needs no check
    urns = [r["contact_urn"] for r in rows if r.get("role_tier") in ("A", "B") and str(r.get("email") or "").strip().lower() not in known]
    for i in range(0, len(urns), 200):
        rest.patch("contacts", {"contact_urn": "in.(" + ",".join(map(str, urns[i:i + 200])) + ")"}, {"nb_state": "pending"})
    return len(urns)


def creation_props(detail1="Oscar AI", today=None):
    """What every contact Atlas creates in HubSpot carries: where it came from, no marketing status, and a legal basis for processing. First and latest touch are the same, since Atlas is the first touch."""
    d = f"Lalu Atlas Import: {(today or datetime.now(timezone.utc)).date().isoformat()}"
    return {"source_category": "Import", "um_source_detail_1": detail1, "um_source_detail_2": d, "um_lt_source_category": "Import", "um_lt_source_detail_1": detail1, "um_lt_source_detail_2": d,
            "hs_marketable_status": "false", "hs_legal_basis": "Legitimate interest \u2013 prospect/lead"}


def hubspot_contact(hub, c, company_id, status):
    """Find or create the contact in HubSpot by email, record the NeverBounce status, and associate it with its practice's company. Returns (id, created)."""
    email = c["email"].strip().lower()
    found = hub.call("POST", "/crm/v3/objects/contacts/search", json={"limit": 1, "properties": ["email"], "filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}]}).get("results", [])
    props = {"neverbounce_status": status}
    if found:
        cid, created = str(found[0]["id"]), False
        hub.call("PATCH", f"/crm/v3/objects/contacts/{cid}", json={"properties": props})
    else:
        props.update(email=email, firstname=c.get("first_name") or (c.get("full_name") or "").split(" ")[0] or None, lastname=c.get("last_name") or " ".join((c.get("full_name") or "").split(" ")[1:]) or None,
                     jobtitle=c.get("job_title"), phone=c.get("phone"), job_role_standardised=standard_role(c.get("job_title")), **creation_props())
        cid, created = str(hub.call("POST", "/crm/v3/objects/contacts", json={"properties": {k: v for k, v in props.items() if v}})["id"]), True
    if company_id:
        hub.call("PUT", f"/crm/v4/objects/contacts/{cid}/associations/default/companies/{company_id}")
    return cid, created


def run(rest, hub, key, now=None, get=requests.get, force=False):
    now = now or datetime.now(timezone.utc)
    if not force and not uk_monday_morning(now):
        return {"skipped": "outside Monday before 09:00 UK"}
    approved = rest.select_all("contacts", "contact_urn,ods_code,full_name,first_name,last_name,job_title,email,phone", order="contact_urn", params={"nb_state": "eq.approved"})
    if not approved:
        return {"checked": 0}
    left = credits_left(key, get)
    todo = approved[:MAX_PER_RUN] if left is None else approved[:max(0, min(MAX_PER_RUN, left))]
    companies = {r["ods_code"]: r.get("hubspot_company_id") for r in rest.select_all("gp_practices", "ods_code,hubspot_company_id", order="ods_code")}
    tracked = [s for s in rest.select_all("hubspot_segments", "list_id,processing_type,criteria", order="list_id", params={"tracked": "eq.true"}) if s.get("processing_type") in ("MANUAL", "SNAPSHOT")]
    out = {"checked": 0, "passed": 0, "failed": 0, "created": 0, "enrolled": 0, "errors": 0, "by_status": {}}
    for c in todo:
        try:
            status = verify(c["email"], key, get)
        except Exception as e:  # noqa: BLE001  one address failing leaves it approved for the next run
            out["errors"] += 1
            out["last_error"] = str(e)[:200]
            if out["errors"] >= 5:
                break
            continue
        out["checked"] += 1
        out["by_status"][status] = out["by_status"].get(status, 0) + 1
        patch = {"nb_state": "checked", "nb_result": status, "nb_checked_at": now.isoformat(), "hs_neverbounce": status}
        if status in PASS:
            out["passed"] += 1
            try:
                cid, created = hubspot_contact(hub, c, companies.get(c["ods_code"]), status)
                patch.update(hubspot_contact_id=cid, hubspot_status="Imported", hubspot_imported_at=now.isoformat())
                out["created"] += int(created)
                for s in tracked:
                    if fits(s.get("criteria") or {}, status, c):
                        hub.call("PUT", f"/crm/v3/lists/{s['list_id']}/memberships/add", json=[cid])
                        out["enrolled"] += 1
            except Exception as e:  # noqa: BLE001  the result is still recorded in Atlas; HubSpot is retried by hand
                out["errors"] += 1
                out["last_error"] = str(e)[:200]
        else:
            out["failed"] += 1
        rest.patch("contacts", {"contact_urn": f"eq.{c['contact_urn']}"}, patch)
    out["credits_remaining"] = credits_left(key, get)
    out["waiting"] = len(approved) - out["checked"]
    return out


def fits(criteria, status, c):
    """Does a new, passing contact meet a tracked static segment's criteria (NeverBounce statuses and job roles)? Lifecycle is New for a newly created contact, which every tracked segment accepts."""
    nb = criteria.get("neverbounce")
    roles = criteria.get("roles")
    return (not nb or status in nb) and (not roles or standard_role(c.get("job_title")) in roles)


def report(out, link=""):
    if out.get("skipped"):
        return None
    st = ", ".join(f"{k} {v}" for k, v in sorted(out.get("by_status", {}).items())) or "nothing checked"
    return (f":white_check_mark: *NeverBounce run*: {out.get('checked', 0)} checked ({st}); {out.get('created', 0)} created in HubSpot, {out.get('enrolled', 0)} added to segments"
            f"{'; ' + str(out['waiting']) + ' still waiting' if out.get('waiting') else ''}{'; credits left ' + str(out['credits_remaining']) if out.get('credits_remaining') is not None else ''}"
            f"{'; ' + str(out['errors']) + ' errors, last: ' + slack.mrkdwn(out.get('last_error', '')) if out.get('errors') else ''}{' ' + link if link else ''}")


def main():
    from .hubspot_sync import Hub
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN", "NEVERBOUNCE_API_KEY"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rest, hub = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"])
    now = datetime.now(timezone.utc)
    out = run(rest, hub, env["NEVERBOUNCE_API_KEY"], now, force=env.get("NB_FORCE") == "1")
    print(out)
    if out.get("skipped") or not out.get("checked") and not out.get("errors"):
        return
    rest.insert("neverbounce_runs", [{"kind": "weekly", "checked": out.get("checked", 0), "passed": out.get("passed", 0), "failed": out.get("failed", 0), "created_in_hubspot": out.get("created", 0),
                                      "enrolled": out.get("enrolled", 0), "credits_remaining": out.get("credits_remaining"), "summary": out, "error": out.get("last_error")}])
    msg = report(out, env.get("ATLAS_URL", ""))
    if msg and slack.atlas_configured():
        try:
            slack.post_atlas(msg)
        except Exception as e:  # noqa: BLE001
            print(f"Slack failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
