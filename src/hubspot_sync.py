"""Daily HubSpot -> dashboard sync: link each practice to its HubSpot company (matched on the GP ODS Code field) and fill in
customer / engaged status, lifecycle stage and which of the practice's contacts already exist in HubSpot. Read-only on HubSpot.

Customer: company lifecycle stage is Customer, the company has a Commercial Model, or any associated deal is Closed Won, unless the company's Company Status is Ex-Customer.
Engaged: the company's lifecycle stage is past New / Prospecting (Engaged, MQL, SQL, Opportunity, Evangelist, Client Services).
"""
import difflib
import html
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

from . import oscar, segments, slack, sources
from .common import Rest, need_env, norm_ods, send_alert, title_case

BASE = "https://api.hubapi.com"
LIFECYCLE = {"6366279924": "Merged/Closed", "lead": "New", "2207373534": "Engaged", "marketingqualifiedlead": "Marketing Qualified Lead", "5640141025": "Prospecting",
             "salesqualifiedlead": "Sales Qualified Lead", "opportunity": "Opportunity", "customer": "Customer", "4726262995": "Past Customer",
             "evangelist": "Evangelist", "other": "Other", "4025181418": "Client Services"}
# Engaged = the COMPANY is past New / Prospecting in HubSpot (and is not a Customer, which is its own status): Engaged, MQL, SQL, Opportunity, Evangelist, Client Services.
ENGAGED_STAGES = {"2207373534", "marketingqualifiedlead", "salesqualifiedlead", "opportunity", "evangelist", "4025181418"}
SEARCH_CAP = 10000                                                       # HubSpot search cannot page past 10,000 results


class Hub:
    def __init__(self, token, sleep=time.sleep):
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        self.sleep = sleep

    def call(self, method, path, **kw):
        for attempt in range(6):
            r = self.s.request(method, BASE + path, timeout=60, **kw)
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 5:
                self.sleep(float(r.headers.get("Retry-After") or 2 * (attempt + 1)))
                continue
            if not r.ok:
                raise RuntimeError(f"HubSpot {method} {path} -> {r.status_code}: {r.text[:300]}")
            return r.json() if r.text else {}


def chunks(items, n):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def fetch_companies(hub):
    out, after = [], None
    while True:
        body = {"filterGroups": [{"filters": [{"propertyName": "partner_organisation_code", "operator": "HAS_PROPERTY"}]}], "limit": 100,
                "properties": ["name", "partner_organisation_code", "lifecyclestage", "company_status", "current_subscription", "zip", "createdate", "patient_list_size", "org_type", "operating_status", "website", "hs_parent_company_id"], "sorts": ["createdate"]}
        if after:
            body["after"] = after
        d = hub.call("POST", "/crm/v3/objects/companies/search", json=body)
        out += d.get("results", [])
        after = (d.get("paging") or {}).get("next", {}).get("after")
        if not after:
            return out, d.get("total", len(out))
        if len(out) >= SEARCH_CAP - 100:
            return out, d.get("total", len(out))


def associations(hub, to_type, company_ids):
    """{company id: [associated ids]} via the batch associations endpoint."""
    out = {}
    for ch in chunks(company_ids, 1000):
        d = hub.call("POST", f"/crm/v4/associations/companies/{to_type}/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            out[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
    return out


def read_objects(hub, obj, ids, props):
    out = {}
    for ch in chunks(sorted(set(ids)), 100):
        d = hub.call("POST", f"/crm/v3/objects/{obj}/batch/read", json={"properties": props, "inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            out[str(r["id"])] = r.get("properties", {})
    return out


PAST_CUSTOMER = "4726262995"   # Lifecycle Stage: Past Customer
MERGED_CLOSED = "6366279924"   # Lifecycle Stage: Merged/Closed (a practice that merged into another or closed): not a customer


def ended(c):
    """A company that is no longer a customer: Company Status Ex-Customer, or Lifecycle Stage Past Customer."""
    return c.get("company_status") == "Ex-Customer" or c.get("lifecyclestage") in (PAST_CUSTOMER, MERGED_CLOSED)


def classify(companies, contact_ids, contacts, deal_ids, deals):
    """One practice's flags from all HubSpot companies that carry its ODS code. Returns dict of the dashboard fields."""
    # HubSpot never moves a company back out of the Customer stage, so a company whose Company Status is Ex-Customer, or whose Lifecycle Stage has been set to Past Customer (eMR inactive), is not a customer
    live = [c for c in companies if not ended(c)]
    model = next((c.get("current_subscription") for c in live if c.get("current_subscription")), None)   # the company's Commercial Model: HubSpot clears it at churn
    customer = any(c.get("lifecyclestage") == "customer" for c in live) or bool(model) or (bool(live) and any(deals.get(d, {}).get("hs_is_closed_won") == "true" for d in deal_ids))
    engaged = any(c.get("lifecyclestage") in ENGAGED_STAGES for c in companies)
    primary = sorted(companies, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]
    stage = "Ex-customer" if primary.get("company_status") == "Ex-Customer" else LIFECYCLE.get(primary.get("lifecyclestage") or "", primary.get("lifecyclestage") or None)
    return {"hubspot_company_id": str(primary["id"]), "hubspot_company_imported_at": primary.get("createdate"), "hubspot_stage": stage,
            "hubspot_engaged": bool(engaged), "hubspot_customer": bool(customer), "hubspot_commercial_model": model}


SERVICE_OBJECT = "0-162"
# Service pipeline stages that are a live paying contract: In Contract, In contract, Renewal Period, Renewed, Within 4 weeks of Cancellation Notice Date. Pilots, freemium and churned/ceased stages are not contracted ARR.
LIVE_SERVICE_STAGES = {"2551571664", "4743369939", "4743369940", "2551571666", "2551571665"}
PIPELINE_SALES, PIPELINE_CONVERSION, PIPELINE_RENEWALS = "default", "2298660077", "3784347852"   # new business | freemium -> ReportSure conversion (Freemium was discontinued) | renewals
PIPELINE_WON = {PIPELINE_SALES, PIPELINE_CONVERSION}   # closed-won deals in these are contracted revenue


def _date(v):
    """YYYY-MM-DD from a HubSpot date value (ISO date / datetime, or epoch milliseconds); None if absent or unreadable."""
    v = str(v or "")
    if re.match(r"^\d{4}-\d{2}-\d{2}", v):
        return v[:10]
    if v.isdigit() and len(v) >= 12:
        return datetime.fromtimestamp(int(v) / 1000, timezone.utc).date().isoformat()
    return None


TERM_PROPS = ["closedate", "dealname", "size_discount", "speed_discount", "term_length_discount", "referral_discount", "total_discount", "term_length_years", "value_per_patient", "actual_value_per_patient_calculated", "product___service", "commercial_model", "contracted_patient_list_size"]


LALU_PRODUCTS = {"440423339237", "440425147578", "440434162881", "440498134244"}   # the four Lalu Care products: a deal's line item quantity is the patients it bills


def made_by_atlas(pr):
    """A HubSpot contact Atlas itself created (the NeverBounce run, from Oscar data): it is already in Atlas, so it is never stored again."""
    return (pr.get("um_source_detail_1") or "").strip().lower() in ("oscar ai", "lalu atlas") or str(pr.get("um_source_detail_2") or "").startswith("Lalu Atlas Import")


def contact_link_updates(ours, by_ods, hs_contacts, hs_ids):
    """Rows to write so each Atlas contact's HubSpot link matches HubSpot: found by email on its practice's companies, else kept when its HubSpot id is still on them (a contact with no email, a nurse say,
    is matched by id: clearing its link would make the next run store it again, which is how duplicates once built up)."""
    crow = []
    for c in ours:
        if c["ods_code"] not in by_ods:
            continue
        email = (c.get("email") or "").strip().lower()
        hit = hs_contacts[c["ods_code"]].get(email) if email else None
        if not hit and c.get("hubspot_contact_id") and str(c["hubspot_contact_id"]) in hs_ids.get(c["ods_code"], ()):
            continue
        want = ("Imported", hit[1], hit[0]) if hit else ("Not imported", None, None)
        if (c["hubspot_status"], c.get("hubspot_contact_id")) != (want[0], want[2]):
            crow.append({"contact_urn": c["contact_urn"], "ods_code": c["ods_code"], "hubspot_status": want[0], "hubspot_imported_at": want[1], "hubspot_contact_id": want[2]})
    return crow


def duplicate_contact_counts(rows):
    """What would show duplicate contacts: one HubSpot id twice at a practice, one email twice among HubSpot-sourced contacts at a practice, and HubSpot-sourced rows with neither an id nor an email."""
    ids, emails = {}, {}
    nameless = 0
    for r in rows:
        if r.get("hubspot_contact_id"):
            k = (r["ods_code"], str(r["hubspot_contact_id"])); ids[k] = ids.get(k, 0) + 1
        if r.get("source") == "hubspot":
            if r.get("email"):
                k = (r["ods_code"], r["email"].strip().lower()); emails[k] = emails.get(k, 0) + 1
            if not r.get("hubspot_contact_id") and not r.get("email"):
                nameless += 1
    return {"same_id_same_practice": sum(1 for v in ids.values() if v > 1), "same_email_same_practice": sum(1 for v in emails.values() if v > 1), "nameless_without_id": nameless}


def import_hubspot_contacts(rest, by_ods, to_contacts, contacts, known, cap=25000, known_emails=frozenset()):
    """Store the HubSpot contacts of practice companies that Atlas does not hold yet, source 'hubspot', with their address and role graded like every other contact (campaign eligibility is decided from that
    and the suppression rules, so nothing here makes a contact campaign-ready). Only contacts with an email address, on a practice company, that a person made in HubSpot (from any lead source) and Atlas does not already hold, by HubSpot id or email address;
    contacts Atlas created in HubSpot are skipped. Returns how many were added."""
    from . import contact_quality
    rows, now, seen = [], datetime.now(timezone.utc).isoformat(), set(known)
    for ods, cs in by_ods.items():
        for c in cs:
            for cid in to_contacts.get(str(c["id"]), []):
                cid = str(cid)
                pr = contacts.get(cid)
                email0 = (pr.get("email") or "").strip().lower() if pr else ""
                if cid in seen or not pr or not email0 or made_by_atlas(pr) or email0 in known_emails:   # only contacts with an email address, on a practice company, that Atlas does not hold
                    continue
                seen.add(cid)
                first, last, email = (pr.get("firstname") or "").strip(), (pr.get("lastname") or "").strip(), (pr.get("email") or "").strip().lower() or None
                quality, _ = contact_quality.email_quality(email, first, last)
                rows.append({"ods_code": ods, "full_name": (first + " " + last).strip() or None, "first_name": first or None, "last_name": last or None, "job_title": pr.get("jobtitle") or None, "email": email, "phone": pr.get("phone") or None,
                             "email_opt_out": False, "is_primary": False, "source": "hubspot", "hubspot_status": "Imported", "hubspot_contact_id": cid, "hubspot_imported_at": now,
                             "email_quality": quality if quality in ("direct", "likely_direct", "check", "shared") else None, "role_tier": contact_quality.role_tier(pr.get("jobtitle"))[0]})
    rows = rows[:cap]
    for i in range(0, len(rows), 500):
        rest.insert("contacts", rows[i:i + 500])
    return len(rows)


def link_open_deals(rest, by_ods, to_deals, deals):
    """A practice with no deal linked in Atlas (links are normally made by a pricing push) is linked to its open New Business or Freemium-conversion deal, newest first (else its latest signed one), so the profile shows the live deal
    (for example a Freemium customer's conversion deal) instead of 'no deal needed'. Existing links are never changed."""
    have = {r["ods_code"] for r in rest.select_all("hubspot_links", "ods_code", order="ods_code")}
    rows, now = [], datetime.now(timezone.utc).isoformat()
    for ods, cs in by_ods.items():
        if ods in have:
            continue
        open_ = sorted(((deals[d].get("hs_lastmodifieddate") or "", d) for c in cs for d in to_deals.get(str(c["id"]), []) if d in deals and deals[d].get("hs_is_closed") != "true"
                        and deals[d].get("pipeline") in (PIPELINE_SALES, PIPELINE_CONVERSION)), reverse=True)
        if not open_:   # no open deal: the latest signed one (a customer's contract), which the profile shows as won and locked
            open_ = sorted(((_date(deals[d].get("closedate")) or "", d) for c in cs for d in to_deals.get(str(c["id"]), []) if d in deals and deals[d].get("hs_is_closed_won") == "true"
                            and deals[d].get("pipeline") in PIPELINE_WON), reverse=True)
        if open_:
            primary = sorted(cs, key=lambda c: (c.get("createdate") or "", str(c.get("id"))))[0]
            rows.append({"ods_code": ods, "company_id": str(primary["id"]), "company_name": primary.get("name"), "deal_id": str(open_[0][1]), "deal_name": deals[open_[0][1]].get("dealname"), "linked_by": "daily sync", "linked_at": now})
    if rows:
        rest.upsert("hubspot_links", rows, "ods_code")
    return len(rows)


def won_deal_ids(deals):
    return [i for i, d in deals.items() if d.get("hs_is_closed_won") == "true" and d.get("pipeline") in PIPELINE_WON]


def deal_line_quantities(hub, deal_ids):
    """{deal id: patients on its Lalu Care line item}, read with the line item scope. A token without it (or any read failure) gives {} and the Contract section just omits the figure."""
    out = {}
    try:
        lines_of = {}
        for ch in chunks(sorted(set(deal_ids)), 1000):
            d = hub.call("POST", "/crm/v4/associations/deals/line_items/batch/read", json={"inputs": [{"id": i} for i in ch]})
            for r in d.get("results", []):
                lines_of[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
        lines = read_objects(hub, "line_items", [i for v in lines_of.values() for i in v], ["quantity", "hs_product_id"])
        for deal, ids in lines_of.items():
            q = sum(_num(lines[i].get("quantity")) or 0 for i in ids if lines.get(i, {}).get("hs_product_id") in LALU_PRODUCTS)
            if q > 0:
                out[deal] = int(q)
    except Exception as e:  # noqa: BLE001
        print("Line item quantities skipped:", str(e)[:200])
    return out


def contract_terms(deal_ids, deals, line_qty=None):
    """Pricing of the latest closed-won deal (discount fractions and £ per patient per month), for the practice's Contract section."""
    won = [(i, deals[i]) for i in deal_ids if i in deals and deals[i].get("hs_is_closed_won") == "true" and deals[i].get("pipeline") in PIPELINE_WON]
    if not won:
        return None
    did, d = max(won, key=lambda x: _date(x[1].get("closedate")) or "")
    out = {"deal": d.get("dealname"), "closed": _date(d.get("closedate")), "amount": _num(d.get("amount")), "years": _num(d.get("term_length_years")),
           "list_rate": _num(d.get("value_per_patient")), "net_rate": _num(d.get("actual_value_per_patient_calculated")), "line_qty": (line_qty or {}).get(did), "contracted": _num(d.get("contracted_patient_list_size"))}
    for k in ("size", "speed", "term_length", "referral"):
        out[k] = _num(d.get(f"{k}_discount"))
    out["total"] = _num(d.get("total_discount"))
    return out if any(v is not None for k, v in out.items() if k not in ("deal", "closed", "amount")) else None


def list_size(companies, company_id):
    """The Patient List Size on the practice's linked HubSpot company (a whole number), or None when blank."""
    for c in companies:
        if str(c.get("id")) == str(company_id):
            n = _num(c.get("patient_list_size"))
            return int(n) if n and n > 0 else None
    return None


def linked_properties(companies, company_id):
    """Org Type, Operating status and Website URL of the practice's linked HubSpot company, kept beside the NHS-derived values so the two can be compared."""
    c = next((c for c in companies if str(c.get("id")) == str(company_id)), {})
    return {"hubspot_org_type": c.get("org_type") or None, "hubspot_operating_status": c.get("operating_status") or None, "hubspot_website": (c.get("website") or "").strip() or None,
            "hubspot_parent_company_id": str(int(float(c["hs_parent_company_id"]))) if c.get("hs_parent_company_id") else None}


def pick_primary(contacts):
    """The most senior contactable decision-maker among a practice's HubSpot-sourced contacts (same ranking as Oscar's primary contact), or None."""
    ok = [c for c in contacts if c.get("email") and not c.get("email_opt_out")]
    junior = lambda c: bool(re.search(r"deputy|assistant", c.get("job_title") or "", re.I))
    return max(ok, key=lambda c: (oscar.score(c.get("job_title"), c.get("seniority")), not junior(c), c["contact_urn"]), default=None)


def fill_hubspot_managers(rest):
    """A practice's primary contact (the Manager column of the Practices table) comes from Oscar when Oscar has someone; otherwise from the HubSpot-sourced contacts. Returns how many practices changed."""
    try:
        cs = rest.select_all("contacts", "contact_urn,ods_code,full_name,job_title,seniority,email,phone,email_opt_out,is_primary,source", order="contact_urn")
        gp = {r["ods_code"]: r for r in rest.select_all("gp_practices", "ods_code,practice_name,manager_name,manager_email,manager_source", order="ods_code")}
    except Exception as e:  # noqa: BLE001 - the manager_source column arrives with migration 54
        print("Primary contacts skipped:", str(e)[:200])
        return 0
    by = {}
    for c in cs:
        if c.get("source") == "hubspot" and c["ods_code"] in gp:
            by.setdefault(c["ods_code"], []).append(c)
    prac, prim = [], []
    for ods, lst in by.items():
        g = gp[ods]
        if g.get("manager_source") == "oscar":
            continue
        best = pick_primary(lst)
        if best and (g.get("manager_email") or "").lower() != best["email"].lower():
            prac.append({"ods_code": ods, "practice_name": g["practice_name"], "manager_name": best["full_name"], "manager_title": best["job_title"], "manager_email": best["email"],
                         "manager_phone": best["phone"], "manager_email_opt_out": False, "manager_source": "hubspot"})
        prim += [{"contact_urn": c["contact_urn"], "ods_code": ods, "is_primary": bool(best and c["contact_urn"] == best["contact_urn"])} for c in lst
                 if bool(best and c["contact_urn"] == best["contact_urn"]) != bool(c.get("is_primary"))]
    if prac:
        rest.upsert("gp_practices", prac, "ods_code")
    if prim:
        rest.upsert("contacts", prim, "contact_urn")
    return len(prac)


SIZE_HOLD = 0.25   # a one-month jump bigger than this is almost always a merge, split or bad row: a person looks before HubSpot changes


def plan_list_sizes(practices, rows, include_customers=False):
    """(auto, held): companies whose HubSpot Patient List Size differs from the NHS figure. Customers are left alone unless the list_size_sync switch says include_customers (a contract's size lives on
    its line item and HubSpot's deal figures come from it, so their company size can follow NHS, but that is a choice the Data panel makes, off by default).
    A merged or closed practice whose NHS figure is 0 is written as 0 (its patients are counted at the successor, so HubSpot's own roll-ups must not count them twice); that is never held back."""
    auto, held = [], []
    for r in rows:
        p = practices.get(r["ods_code"])
        if not p or not r.get("hubspot_company_id"):
            continue
        if r.get("hubspot_customer") and not include_customers:
            continue
        now, base = int(p.get("total_patients") or 0), int(r.get("hubspot_list_size") or 0)
        item = {"ods": r["ods_code"], "id": str(r["hubspot_company_id"]), "name": p["practice_name"], "from": base or None, "to": now}
        if p.get("merged_into") or p.get("status") != "Active" or p.get("closure_confirmed_at"):
            if now == 0 and base > 0:
                succ = practices.get(p.get("merged_into") or "", {})
                auto.append({**item, "to": 0, "gone": expected_status(p), "successor": succ.get("practice_name") or p.get("merged_into")})
            continue
        if now <= 0 or now == base:
            continue
        (held if base and abs(now - base) / base > SIZE_HOLD else auto).append(item)
    return auto, held


def list_size_flag(rest):
    """The list_size_sync switch: {"enabled": bool, "last_month": the NHS data month already applied}. Empty when the table or row is missing."""
    try:
        return next((r.get("value") or {} for r in rest.select_all("app_flags", "key,value", order="key") if r.get("key") == "list_size_sync"), {})
    except Exception:  # noqa: BLE001 - the flag table is optional
        return {}


def _flags(rest):
    try:
        return rest.select_all("app_flags", "key,value", order="key")
    except Exception:  # noqa: BLE001 - the flag table is optional
        return []


EPCN_REFETCH_HOURS = 20


def ods_fetched_recently(rest, now, hours=EPCN_REFETCH_HOURS):
    """True when the NHS ODS PCN export was downloaded less than `hours` ago (app_flags.ods_pcn_fetch.at). The PCN records only change when NHS ODS does, so a repeat sync the same day skips it
    instead of calling NHS Digital again."""
    flag = next((r.get("value") or {} for r in _flags(rest) if r.get("key") == "ods_pcn_fetch"), {})
    try:
        return (datetime.fromisoformat(now) - datetime.fromisoformat(str(flag.get("at")).replace("Z", "+00:00"))).total_seconds() < hours * 3600
    except (TypeError, ValueError):
        return False


def network_audit_kept(rest):
    """The PCN / ICB audit rows from the last full run, carried over when the PCN step is skipped so write_audit does not clear them."""
    try:
        return [r for r in rest.select_all("hubspot_audit", "*", order="id") if r.get("issue") == "pcn_association" or r.get("object_type") in ("pcn", "icb")]
    except Exception:  # noqa: BLE001
        return []


def list_size_due(flag, month):
    """Sizes follow the NHS figure once per monthly load, not every day: due when the switch is on and this data month has not been applied yet."""
    return flag.get("enabled") is True and bool(month) and flag.get("last_month") != month


NOTE_TYPE = {"companies": 190}   # HubSpot-defined association type: note -> company; other objects (the PCN custom object) use the default association


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def note_text(headline, lines=()):
    """The audit note Atlas leaves on every HubSpot record it changes: who and when, then one line per field as 'Label: from → to'. HubSpot notes are HTML, so the lines are joined with <br>."""
    return "<br>".join([html.escape(f"Atlas, {stamp()}: {headline}")] + [html.escape("• " + x) for x in lines])


def change_line(label, was, now):
    show = lambda v: "blank" if v in (None, "") else f"{v:,}" if isinstance(v, int) else str(v)
    return f"{label}: {show(was)} → {show(now)}"


def add_notes(hub, object_type, items):
    """Put a note on each (record id, text). Returns how many could not be written: the change itself is already in HubSpot, so a missing note is reported, never fatal."""
    failed, when = 0, datetime.now(timezone.utc).isoformat()
    if object_type in NOTE_TYPE:
        for ch in chunks(list(items), 100):
            try:
                hub.call("POST", "/crm/v3/objects/notes/batch/create", json={"inputs": [{"properties": {"hs_timestamp": when, "hs_note_body": text},
                         "associations": [{"to": {"id": str(i)}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": NOTE_TYPE[object_type]}]}]} for i, text in ch]})
            except Exception as e:  # noqa: BLE001
                failed += len(ch)
                print("Notes skipped:", str(e)[:200])
        return failed
    for i, text in items:
        try:
            n = hub.call("POST", "/crm/v3/objects/notes", json={"properties": {"hs_timestamp": when, "hs_note_body": text}})
            hub.call("PUT", f"/crm/v4/objects/notes/{n['id']}/associations/default/{object_type}/{i}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("Note skipped:", str(e)[:200])
    return failed


def push_list_sizes(rest, hub, auto, month=""):
    """Write the changed sizes to HubSpot in batches; returns (written, error). A token without the company write scope stops here and says so.
    Every company changed gets a note with the old and new size (a company set to 0 because its practice merged or closed also says why), so HubSpot keeps its own history."""
    done, err = [], None
    for ch in chunks(auto, 100):
        try:
            hub.call("POST", "/crm/v3/objects/companies/batch/update", json={"inputs": [{"id": c["id"], "properties": {"patient_list_size": str(c["to"])}} for c in ch]})
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
            break
        rest.upsert("gp_practices", [{"ods_code": c["ods"], "practice_name": c["name"], "hubspot_list_size": c["to"]} for c in ch], "ods_code")
        notes = []
        for c in ch:
            why = (f"NHS data shows this practice as {c['gone']}" + (f", with its patients counted under {c['successor']}" if c.get("successor") else "") + ". Set to 0 so HubSpot does not count the same patients twice.") if c.get("gone") \
                else f"set from the NHS figure{' for ' + month if month else ''}."
            notes.append((c["id"], note_text("list size updated by the daily sync, " + why, [change_line("Patient List Size", c["from"], c["to"])])))
        add_notes(hub, "companies", notes)
        done += ch
    return done, err


ALIGN_MAX = 100   # more automatic Org Type / Operating status changes than this in one run wait for a person to approve the run (the first backfill, or a bad feed)
NAME_NOISE = {"surgery", "medical", "centre", "center", "practice", "health", "group", "partners", "partnership", "doctors", "care", "general", "the", "and"}


def name_keys(name):
    return [w for w in re.sub(r"[^a-z ]", " ", (name or "").lower()).split() if len(w) > 3 and w not in NAME_NOISE]


def site_move(p, branches):
    """The active ODS branch of another practice that carries on a closed or merged practice's site (same postcode and the practice's own name), or None. Mirrors siteMove() in js/hubspot-align.js."""
    pc, keys = re.sub(r"\s", "", (p.get("postcode") or "").upper()), name_keys(p.get("practice_name"))
    if not (p.get("merged_into") or p.get("status") != "Active" or p.get("closure_confirmed_at")) or not pc or not keys:
        return None
    for b in branches:
        res = "other" if b.get("match_status") == "rejected" else b.get("resolution") or "other"
        if res == "branch" and b.get("status") == "Active" and b.get("practice_code") and b["practice_code"] != p["ods_code"] and re.sub(r"\s", "", (b.get("postcode") or "").upper()) == pc \
                and set(name_keys(b.get("branch_name"))) & set(keys):
            return b
    return None


def expected_status(p):
    return "merged" if p.get("merged_into") else "closed" if p.get("status") != "Active" or p.get("closure_confirmed_at") else "active"


def plan_alignment(practices, rows, branches):
    """(auto, cases): companies whose Operating status differs from NHS data (or Org Type is blank) and can be fixed without a person; practices that have merged, or whose site goes on as a branch,
    need parent links and are left for the review list. Org Type is only filled when blank (a deliberate value such as Group is never overwritten)."""
    auto, cases = [], 0
    for r in rows:
        p = practices.get(r["ods_code"])
        if not p or not r.get("hubspot_company_id"):
            continue
        if p.get("merged_into") or site_move(p, branches):
            cases += 1
            continue
        props = {}
        if not r.get("hubspot_org_type"):
            props["org_type"] = "practice"
        want = expected_status(p)
        if (r.get("hubspot_operating_status") or "") != want:
            if want == "closed":   # the closure date goes in first, then the status: the churn workflow fires on the status and needs the date in place
                props["closure_date"] = str(p.get("operational_end_date") or "")[:10] or datetime.now(timezone.utc).date().isoformat()
            props["operating_status"] = want
        if props:
            auto.append({"ods": r["ods_code"], "id": str(r["hubspot_company_id"]), "name": p["practice_name"], "props": props, "was": {"org_type": r.get("hubspot_org_type"), "operating_status": r.get("hubspot_operating_status")}})
    return auto, cases


def align_due(flag, n):
    """On and small enough, or on and a person approved this larger run."""
    return flag.get("enabled") is True and n > 0 and (n <= ALIGN_MAX or flag.get("approve_once") is True)


def push_alignment(rest, hub, auto):
    done, err = [], None
    for ch in chunks(auto, 100):
        try:
            for step in (set().union(*(c["props"].keys() for c in ch)) - {"operating_status"}, {"operating_status"}):   # everything else first (Org Type, closure date), the Operating status last
                inputs = [{"id": c["id"], "properties": {k: v for k, v in c["props"].items() if k in step}} for c in ch]
                inputs = [i for i in inputs if i["properties"]]
                if inputs:
                    hub.call("POST", "/crm/v3/objects/companies/batch/update", json={"inputs": inputs})
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
            break
        rest.upsert("gp_practices", [{"ods_code": c["ods"], "practice_name": c["name"], **{"hubspot_" + k: v for k, v in c["props"].items() if k != "closure_date"}} for c in ch], "ods_code")
        labels = {"org_type": "Org Type", "operating_status": "Operating status", "closure_date": "Closure date"}
        add_notes(hub, "companies", [(c["id"], note_text("set from NHS data by the daily sync", [change_line(labels[k], (c.get("was") or {}).get(k), v) for k, v in c["props"].items()])) for c in ch])
        done += ch
    return done, err


def service_product(sv):
    """all | sar | self | payg | freemium from a Service's name and commercial model (the name is written at Closed Won, and the model is cleared at churn, so the name is the one to trust)."""
    t = f"{sv.get('hs_name') or ''} {sv.get('current_subscription') or ''}".lower()
    if "freemium" in t:
        return "freemium"
    if "payg" in t:
        return "payg"
    if "sar" in t:
        return "sar"
    if "self" in t or "gp emr" in t:
        return "self"
    return "all" if ("report" in t or "emr" in t or "ms" in t.split() or "managed" in t) else None


def _price(v):
    """A deal's price per patient per month from a value like '£0.08' (None for 'Other' or blank)."""
    try:
        return float(re.sub(r"[^0-9.]", "", str(v or "")) or "nan") or None
    except ValueError:
        return None


def contract_patients(deal, qty=None, ref=None):
    """Patients a won deal contracts for, best source first: the deal's own Contracted Patient List Size (a static figure that matches the signed contract; HubSpot's Patient List Size is synced
    from the company, so it drifts), then its Lalu Care line item quantity. Nothing is back-calculated from the Amount, so a number shown is always a contracted one."""
    fixed = _num(deal.get("contracted_patient_list_size"))
    if fixed and fixed > 0 and (not ref or 0.35 * ref <= fixed <= 2.5 * ref):   # a group deal's figure far from this practice's own size is not this practice's contract
        return int(fixed)
    if qty:
        return int(qty)
    return None   # never guessed from the Amount: a deal without a contracted size shows as "needs size" in Atlas


def lifecycle_fields(companies, deal_ids, deals, service_ids, services, line_qty, list_size_value):
    """What the Patients under management page needs for one practice: company status, its main Service (paid ones first, then the latest start), Product / Service from the latest won deal,
    when the first Service started, when it churned, and the size signed for (the won deal's line item quantity, else the company's list size)."""
    primary = sorted(companies, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]
    svs = [services[i] for i in service_ids if i in services]
    for sv in svs:
        sv["_product"] = service_product(sv)
        sv["_start"] = min((d for d in (_date(sv.get("contract_start_date")), _date(sv.get("hs_start_date"))) if d), default=None) or _date(sv.get("hs_createdate"))   # Freemium and PAYG Services have no start date: when the Service record was created
    paid = [sv for sv in svs if sv["_product"] in ("all", "sar", "self") or sv["_product"] is None]
    main = max(paid or svs, key=lambda sv: (sv["_start"] or "", sv.get("hs_name") or ""), default=None)
    won = [(i, deals[i]) for i in deal_ids if i in deals and deals[i].get("hs_is_closed_won") == "true" and deals[i].get("pipeline") in PIPELINE_WON]
    last = max(won, key=lambda x: _date(x[1].get("closedate")) or "", default=(None, {}))
    churned = [d for d in (_date(sv.get("date_churned")) for sv in (paid or svs)) if d]
    starts = [sv["_start"] for sv in (paid or svs) if sv["_start"]] or [_date(d.get("closedate")) for _, d in won if _date(d.get("closedate"))]
    ps = last[1].get("product___service") or None
    product = main["_product"] if main else None
    hist = sorted(((_date(d.get("closedate")), contract_patients(d, (line_qty or {}).get(i), list_size_value)) for i, d in ((i, deals[i]) for i in deal_ids if i in deals and deals[i].get("hs_is_closed_won") == "true"
                                                                                                       and deals[i].get("pipeline") in (PIPELINE_WON | {PIPELINE_RENEWALS}))), key=lambda x: x[0] or "")
    hist = [[d, n] for d, n in hist if d and n]
    qty = hist[-1][1] if hist else None
    # signed size: the contract; only contract-free products (freemium, PAYG, self service) fall back to the company list size
    return {"hubspot_company_status": primary.get("company_status") or None, "hubspot_service_name": (main or {}).get("hs_name") or None, "hubspot_product": product,
            "hubspot_product_service": ps or ({"self": "eMR"}.get(product, "eMR+") if product in ("all", "sar", "self") else None),
            "hubspot_first_start": min(starts) if starts else None, "hubspot_churned_date": max(churned) if churned and (ended(primary) or not any(
                sv.get("current_subscription") for sv in paid)) else None,
            "hubspot_signed_size": int(qty) if qty else (int(list_size_value) if list_size_value and product in ("freemium", "payg", "self") else None), "hubspot_size_history": hist or None}


def revenue_fields(deal_ids, deals, service_ids, services, customer, model, line_qty=None):
    """Contracted ARR (live Service ACV, else closed-won deal amounts flagged 'deal') and the open deal pipeline for one practice."""
    live = [services[s] for s in service_ids if services.get(s, {}).get("hs_pipeline_stage") in LIVE_SERVICE_STAGES]
    acv = sum(_num(sv.get("actual_annual_contract_value__acv_")) or 0 for sv in live)
    starts, ends = [d for d in (_date(sv.get("contract_start_date")) for sv in live) if d], [d for d in (_date(sv.get("contract_end_date")) for sv in live) if d]
    won = sum(_num(deals[d].get("amount")) or 0 for d in deal_ids if d in deals and deals[d].get("hs_is_closed_won") == "true" and deals[d].get("pipeline") in PIPELINE_WON)
    arr, src = (acv, "service") if acv > 0 else (won, "deal") if customer and model != "Freemium" and won > 0 else (None, None)
    open_ = [deals[d] for d in deal_ids if d in deals and deals[d].get("hs_is_closed") != "true"]
    return {"hubspot_contracted_arr": arr, "hubspot_contracted_src": src,
            "hubspot_contract_start": min(starts) if starts and src == "service" else None, "hubspot_contract_end": min(ends) if ends and src == "service" else None,
            "hubspot_pipeline": sum(_num(d.get("amount")) or 0 for d in open_ if d.get("pipeline") == PIPELINE_SALES) or None,
            "hubspot_conversion_pipeline": sum(_num(d.get("amount")) or 0 for d in open_ if d.get("pipeline") == PIPELINE_CONVERSION) or None,
            "hubspot_renewal_pipeline": sum(_num(d.get("amount")) or 0 for d in open_ if d.get("pipeline") == PIPELINE_RENEWALS) or None,
            "hubspot_contract_terms": contract_terms(deal_ids, deals, line_qty) if src else None}


PCN_OBJECT, ICB_OBJECT = "p145802630_pcns", "p145802630_icbs"
NETWORK_PROPS = ["name", "ods_code", "address_line_1", "status", "total_amount_in_open_deals", "total_amount_in_won_deals", "count_of_active_emr_practices", "count_of_associated_practices"]


def norm_icb(name):
    """'NHS Essex ICB - D7T5G' / 'Essex' / 'NHS Mid And South Essex ICB' -> comparable key."""
    s = re.sub(r"\s+-\s+[A-Z0-9]{3,6}$", "", str(name or "").strip()).lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(w for w in s.split() if w not in {"nhs", "icb", "integrated", "care", "board", "the"})


def fetch_custom(hub, object_type):
    out, after = [], None
    while True:
        body = {"limit": 100, "properties": NETWORK_PROPS}
        if after:
            body["after"] = after
        d = hub.call("POST", f"/crm/v3/objects/{object_type}/search", json=body)
        out += d.get("results", [])
        after = (d.get("paging") or {}).get("next", {}).get("after")
        if not after or len(out) >= SEARCH_CAP - 100:
            return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


MAX_PCN_CREATES = 25          # safety limit per run; anything beyond is reported and picked up the next day
MAX_PCN_REPAIRS = 25
MAX_ASSOCIATIONS = 3000
MAX_INACTIVATE = 50
PCN_CODE = re.compile(r"^U\d{5}$")
POSTCODE_RE = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$")
BAD_ADDRESS = re.compile(r"^\d{8}$")   # an early version wrote a date into address line 1; those records are repaired from the ODS API


def parse_epcn(data, icb_codes=None):
    """NHS ODS 'epcn' export (headerless) -> {pcn code: {name, icb_name, icb_ods_code}}. Only the columns the tool already relies on (code, name,
    parent ICB name) are read; address, dates and phone come from the ODS API, whose fields are named."""
    out = {}
    for row in sources._csv(data, header=None).values.tolist():
        code = str(row[0]).strip().upper()
        if not PCN_CODE.match(code):
            continue
        icb = title_case(sources.clean_icb(row[3])) if len(row) > 3 else ""
        out[code] = {"name": title_case(str(row[1]).strip()), "icb_name": icb, "icb_ods_code": (icb_codes or {}).get(norm_icb(icb), "")}
    return out


def ods_pcn_props(detail):
    """HubSpot PCN properties from an ODS API organisation record (named fields, each validated)."""
    o = (detail or {}).get("Organisation", {})
    loc = (o.get("GeoLoc") or {}).get("Location") or {}
    ops = [d for d in o.get("Date", []) if d.get("Type") == "Operational"]
    start = min((d.get("Start", "") for d in ops), default="")
    end = max((d.get("End", "") for d in ops), default="")
    tel = next((c.get("value") for c in (o.get("Contacts") or {}).get("Contact", []) if c.get("type") == "tel"), "")
    pc = str(loc.get("PostCode") or "").strip().upper()
    props = {"address_line_1": title_case(loc.get("AddrLn1")), "address_line_2": title_case(loc.get("AddrLn2")), "address_line_3": title_case(loc.get("AddrLn3")),
             "town": title_case(loc.get("Town")), "county": title_case(loc.get("County")), "postcode": pc if POSTCODE_RE.match(pc) else "", "country": "England",
             "operational_start_date": start if re.match(r"^\d{4}-\d{2}-\d{2}$", start) else "", "operational_end_date": end if re.match(r"^\d{4}-\d{2}-\d{2}$", end) else "",
             "phone": re.sub(r"[^0-9+ ]", "", str(tel or "")) if len(re.sub(r"\D", "", str(tel or ""))) >= 8 else "",
             "status": "active" if o.get("Status") == "Active" else "inactive"}
    return {k: v for k, v in props.items() if v not in ("", None)}


def load_inactive_pcns(getj, page=1000):
    out, offset = set(), 0
    while True:
        params = {"PrimaryRoleId": "RO272", "Status": "Inactive", "Limit": page}
        if offset:
            params["Offset"] = offset
        orgs = getj(f"{sources.ODS_API}/organisations", params).get("Organisations", [])
        before = len(out)
        out |= {str(o.get("OrgId", "")).upper() for o in orgs if PCN_CODE.match(str(o.get("OrgId", "")).upper())}
        if len(orgs) < page or len(out) == before:
            return out
        offset = len(out)


def sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of, getj=None, conflicts=None, unlink_wrong=False):
    """Keep HubSpot's PCN custom object in step with NHS ODS: create missing PCNs (capped), repair records with a bad address, mark closed ones
    inactive, and add missing company -> PCN associations. Add-only, except when unlink_wrong is set (a one-shot, switched on in Data > HubSpot integration): then a company's association with a PCN record
    that is not its own NHS PCN is removed. Returns (stats, lines for Slack)."""
    getj = getj or sources.get_json
    stats, lines, events = {"pcn_records_created": 0, "pcn_records_repaired": 0, "pcn_records_inactivated": 0, "pcn_associations_added": 0, "pcn_create_capped": 0}, [], []
    ev = lambda kind, c, name, hid, summary, detail=None: events.append({"kind": kind, "target": name, "hubspot_type": "pcn", "hubspot_id": str(hid), "summary": summary, "detail": {"ods": c, **(detail or {})}})
    ours = {c for c in (p.get("pcn_code") for p in practices.values()) if c}
    by_code = {pr["ods_code"].strip().upper(): pr for pr in hs_pcns if pr.get("ods_code")}
    inactive = load_inactive_pcns(getj)
    # 1. create PCNs the tool knows (they have active practices) that HubSpot lacks
    unnamed = {norm_name(pr.get("name")) for pr in hs_pcns if not (pr.get("ods_code") or "").strip()}   # HubSpot PCN records with no code: never create a twin of one
    missing = sorted(c for c in ours if c in epcn and c not in by_code and c not in inactive and norm_name(epcn[c]["name"]) not in unnamed)
    stats_skipped = sum(1 for c in ours if c in epcn and c not in by_code and c not in inactive and norm_name(epcn[c]["name"]) in unnamed)
    for c in missing[:MAX_PCN_CREATES]:
        props = {**ods_pcn_props(getj(f"{sources.ODS_API}/organisations/{c}")), **{k: v for k, v in epcn[c].items() if v}, "ods_code": c, "status": "active"}
        r = hub.call("POST", f"/crm/v3/objects/{PCN_OBJECT}", json={"properties": props})
        by_code[c] = {"id": r["id"], **props}
        stats["pcn_records_created"] += 1
        add_notes(hub, PCN_OBJECT, [(r["id"], note_text("PCN record created from NHS ODS by the daily sync", [change_line(k, None, v) for k, v in props.items() if k in ("name", "ods_code", "status")]))])
        lines.append(f"Created PCN {props['name']} ({c})")
        ev("pcn_created", c, props["name"], r["id"], f"Created PCN record {props['name']} ({c}) from NHS ODS", {"properties": props})
    stats["pcn_create_capped"] = max(0, len(missing) - MAX_PCN_CREATES)
    stats["pcn_create_skipped_name_match"] = stats_skipped   # a code-less HubSpot PCN with the same name exists: see the HubSpot audit
    # 2. repair records an early version wrote with a date in address line 1
    for c, pr in list(by_code.items())[:]:
        if BAD_ADDRESS.match(str(pr.get("address_line_1") or "")) and stats["pcn_records_repaired"] < MAX_PCN_REPAIRS:
            fix = ods_pcn_props(getj(f"{sources.ODS_API}/organisations/{c}"))
            blank = {k: "" for k in ("address_line_1", "address_line_2", "address_line_3", "town", "county", "postcode", "phone", "icb_ods_code") if k not in fix}
            if epcn.get(c, {}).get("icb_ods_code"):
                fix["icb_ods_code"], blank["icb_ods_code"] = epcn[c]["icb_ods_code"], None
            blank = {k: v for k, v in blank.items() if v is not None}
            fix.pop("status", None)
            hub.call("PATCH", f"/crm/v3/objects/{PCN_OBJECT}/{pr['id']}", json={"properties": {**blank, **fix}})
            add_notes(hub, PCN_OBJECT, [(pr["id"], note_text("address details corrected from NHS ODS by the daily sync", [change_line(k, pr.get(k), v) for k, v in {**blank, **fix}.items()]))])
            stats["pcn_records_repaired"] += 1
            lines.append(f"Corrected the address details of PCN {pr.get('name', c)} ({c})")
            ev("pcn_repaired", c, pr.get("name", c), pr["id"], f"Corrected the address details of PCN {pr.get('name', c)} ({c})", {"properties": {**blank, **fix}})
    # 3. mark PCNs closed in ODS as inactive in HubSpot
    for c, pr in by_code.items():
        if c in inactive and pr.get("status") != "inactive" and stats["pcn_records_inactivated"] < MAX_INACTIVATE:
            end = ods_pcn_props(getj(f"{sources.ODS_API}/organisations/{c}")).get("operational_end_date")
            hub.call("PATCH", f"/crm/v3/objects/{PCN_OBJECT}/{pr['id']}", json={"properties": {"status": "inactive", **({"operational_end_date": end} if end else {})}})
            add_notes(hub, PCN_OBJECT, [(pr["id"], note_text("marked inactive because NHS ODS shows it closed, by the daily sync", [change_line("Status", pr.get("status"), "inactive")] + ([change_line("Operational end date", pr.get("operational_end_date"), end)] if end else [])))])
            stats["pcn_records_inactivated"] += 1
            lines.append(f"Marked PCN {pr.get('name', c)} ({c}) inactive" + (f" (closed {end})" if end else ""))
            ev("pcn_inactivated", c, pr.get("name", c), pr["id"], f"Marked PCN {pr.get('name', c)} ({c}) inactive" + (f" (closed {end})" if end else ""), {"end": end})
    # 4. associate each linked practice company to its PCN record
    want = {}   # company id -> PCN record id
    for ods, cid in company_of.items():
        pcn = (practices.get(ods) or {}).get("pcn_code")
        if pcn and pcn in by_code:
            want[cid] = str(by_code[pcn]["id"])
    have = {}
    for ch in chunks(sorted(want), 1000):
        d = hub.call("POST", f"/crm/v4/associations/companies/{PCN_OBJECT}/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            have[str(r["from"]["id"])] = {str(t["toObjectId"]) for t in r.get("to", [])}
    if conflicts is not None:   # companies already associated with a PCN record that is not their own (add-only: the wrong one stays until someone removes it)
        names = {str(pr["id"]): pr.get("name") or pr.get("ods_code") or str(pr["id"]) for pr in hs_pcns}
        ods_of = {cid: o for o, cid in company_of.items()}
        for cid, pid in want.items():
            extra = sorted(names.get(i, i) for i in have.get(cid, set()) if i != pid)
            if extra:
                conflicts.append((cid, practices.get(ods_of.get(cid), {}).get("practice_name"), ods_of.get(cid), extra))
        wrong = {cid: sorted(i for i in have.get(cid, set()) if i != pid) for cid, pid in want.items() if any(i != pid for i in have.get(cid, set()))}
        if unlink_wrong and wrong:   # one-shot clean-up of links to a PCN that is not the practice's own: the right link stays
            for ch in chunks(sorted(wrong.items()), 100):
                hub.call("POST", f"/crm/v4/associations/companies/{PCN_OBJECT}/batch/archive", json={"inputs": [{"from": {"id": c}, "to": [{"id": i} for i in ids]} for c, ids in ch]})
                add_notes(hub, "companies", [(c, note_text("wrong PCN link removed by the daily sync", [change_line("PCN", ", ".join(names.get(i, i) for i in ids), None)])) for c, ids in ch])
            stats["pcn_links_removed"] = sum(len(v) for v in wrong.values())
            conflicts.clear()
    todo = [{"from": {"id": cid}, "to": {"id": pid}} for cid, pid in want.items() if pid not in have.get(cid, set())][:MAX_ASSOCIATIONS]
    pcn_name = {str(pr["id"]): f"{pr.get('name') or pr.get('ods_code')} ({pr.get('ods_code')})" for pr in by_code.values()}
    label = association_label(hub, PCN_OBJECT, "belongs to pcn")   # the practice-to-PCN label the account defines; the default (unlabelled) association is the fallback
    for ch in chunks(todo, 100):
        if label:
            hub.call("POST", f"/crm/v4/associations/companies/{PCN_OBJECT}/batch/create", json={"inputs": [{**t, "types": [{"associationCategory": label[0], "associationTypeId": label[1]}]} for t in ch]})
        else:
            hub.call("POST", f"/crm/v4/associations/companies/{PCN_OBJECT}/batch/associate/default", json={"inputs": ch})
        add_notes(hub, "companies", [(t["from"]["id"], note_text("linked to its PCN record by the daily sync", [change_line("PCN", None, pcn_name.get(t["to"]["id"], t["to"]["id"]))])) for t in ch])
    stats["pcn_associations_added"] = len(todo)
    if todo:
        lines.append(f"Associated {len(todo)} practice companies with their PCN record")
        events.append({"kind": "associations", "hubspot_type": "company", "summary": f"Associated {len(todo)} practice companies with their PCN record", "detail": {"count": len(todo)}})
    return stats, lines, events


def sync_networks(rest, hub, now):
    """Link PCN and ICB networks to HubSpot's PCN / ICB custom objects (PCN by ODS code, ICB by normalised name) and keep their HubSpot figures."""
    orgs = rest.select_all("organisations", "id,kind,name,source_key", order="id", params={"kind": "in.(pcn,icb)"})
    pcns = {}
    for o in fetch_custom(hub, PCN_OBJECT):
        pr = {"id": o["id"], **o.get("properties", {})}
        if pr.get("ods_code"):
            pcns[pr["ods_code"].strip().upper()] = pr
    icbs = {}
    for o in fetch_custom(hub, ICB_OBJECT):
        pr = {"id": o["id"], **o.get("properties", {})}
        icbs.setdefault(norm_icb(pr.get("name")), pr)
    rows = []
    for org in orgs:
        if org["kind"] == "pcn" and str(org.get("source_key") or "").startswith("ods:"):
            hit, typ, how = pcns.get(org["source_key"][4:].upper()), PCN_OBJECT, "ODS code"
        elif org["kind"] == "icb":
            hit, typ, how = icbs.get(norm_icb(org["name"])), ICB_OBJECT, "name"
        else:
            continue
        if hit:
            rows.append({"org_id": org["id"], "object_type": typ, "object_id": str(hit["id"]), "matched_on": how,
                         "open_deals_amount": _num(hit.get("total_amount_in_open_deals")), "won_deals_amount": _num(hit.get("total_amount_in_won_deals")),
                         "active_emr_practices": int(_num(hit.get("count_of_active_emr_practices")) or 0), "associated_practices": int(_num(hit.get("count_of_associated_practices")) or 0),
                         "synced_at": now})
    rest.upsert("hubspot_network_links", rows, "org_id")
    return {"networks_linked": len(rows), "pcns_linked": sum(r["object_type"] == PCN_OBJECT for r in rows), "icbs_linked": sum(r["object_type"] == ICB_OBJECT for r in rows),
            "networks_unmatched": len(orgs) - len(rows)}


def association_label(hub, to_type, name):
    """(category, type id) of the association label called `name` between companies and `to_type`, or None when the account has no such label (or it cannot be read)."""
    try:
        for x in hub.call("GET", f"/crm/v4/associations/companies/{to_type}/labels").get("results", []):
            if str(x.get("label") or "").strip().lower() == name:
                return x.get("category") or "USER_DEFINED", int(x["typeId"])
    except Exception:  # noqa: BLE001
        pass
    return None


SUCCESSOR_LABEL, PARENT_PRACTICE_LABEL = "successor practice", "parent practice"   # shown on a merged practice's record (its successor) and on a branch site's record (its practice)


def practice_role_links(hub, company_ids):
    """{company id: {"successor": id, "branch_parent": id}} from the Successor Practice / Parent Practice association labels (first of each)."""
    out = {}
    for cid, links in labelled_company_links(hub, company_ids).items():
        got = {}
        for to, labels in links:
            if SUCCESSOR_LABEL in labels:
                got.setdefault("successor", to)
            if PARENT_PRACTICE_LABEL in labels:
                got.setdefault("branch_parent", to)
        if got:
            out[cid] = got
    return out


def role_columns(role_links, company_id):
    r = role_links.get(str(company_id), {}) if company_id else {}
    return {"hubspot_successor_company_id": r.get("successor"), "hubspot_branch_parent_company_id": r.get("branch_parent")}


CONTACT_STATE_PROPS = ["lifecyclestage", "hs_sequences_is_enrolled", "hs_email_bounce", "hs_email_hard_bounce_reason_enum", "hs_email_last_send_date", "hs_email_optout", "hs_email_optout_621322507",
                       "hubspot_owner_id", "neverbounce_status", "hs_latest_sequence_enrolled", "hs_latest_sequence_enrolled_date", "hs_latest_sequence_ended_date", "hs_sales_email_last_replied",
                       "engagements_last_meeting_booked"]   # 621322507 is the Marketing Information subscription


def _ts(v):
    """A datetime from a HubSpot date-time value (ISO text, or epoch milliseconds); None when absent or unreadable."""
    v = str(v or "").strip()
    try:
        if v.isdigit():
            return datetime.fromtimestamp(int(v) / 1000, timezone.utc)
        return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None
    except ValueError:
        return None


def sequence_exit(props):
    """Why a contact is no longer in a HubSpot sequence, from what HubSpot holds: unsubscribed, bounced, replied, booked a meeting, else completed. None while enrolled or if never enrolled.
    HubSpot unenrols by its own rules (a reply, a booked call, a bounce, an unsubscribe); Atlas only records the reason."""
    if str(props.get("hs_sequences_is_enrolled") or "").lower() == "true":
        return None
    ended, started = _ts(props.get("hs_latest_sequence_ended_date")), _ts(props.get("hs_latest_sequence_enrolled_date"))
    if not ended:
        return None
    since = lambda k: (lambda t: bool(t and (not started or t >= started)))(_ts(props.get(k)))
    if str(props.get("hs_email_optout") or "").lower() == "true":
        return "unsubscribed"
    try:
        if float(props.get("hs_email_bounce") or 0) >= 1:
            return "bounced"
    except ValueError:
        pass
    return "replied" if since("hs_sales_email_last_replied") else "booked a meeting" if since("engagements_last_meeting_booked") else "completed"


def contact_state(props, urn, now, dq=None, lost=None):
    """One contact's HubSpot state in the columns of public.contacts (see migration 63). Blank means HubSpot has no value."""
    def flag(k):
        v = str(props.get(k) or "").strip().lower()
        return True if v == "true" else False if v == "false" else None
    try:
        bounces = float(props.get("hs_email_bounce") or 0)
    except ValueError:
        bounces = 0
    return {"contact_urn": urn, "hs_lifecycle": props.get("lifecyclestage") or None, "hs_in_sequence": flag("hs_sequences_is_enrolled"), "hs_bounced": bounces >= 1,
            "hs_bounce_reason": props.get("hs_email_hard_bounce_reason_enum") or None, "hs_last_sent": props.get("hs_email_last_send_date") or None,
            "hs_mkt_optout": flag("hs_email_optout_621322507"), "hs_optout_all": flag("hs_email_optout"), "hs_owner": props.get("hubspot_owner_id") or None,
            "hs_neverbounce": props.get("neverbounce_status") or None, "hs_state_at": now,
            "hs_seq_id": props.get("hs_latest_sequence_enrolled") or None, "hs_seq_enrolled_at": (_ts(props.get("hs_latest_sequence_enrolled_date")) or None) and _ts(props.get("hs_latest_sequence_enrolled_date")).isoformat(),
            "hs_seq_ended_at": (_ts(props.get("hs_latest_sequence_ended_date")) or None) and _ts(props.get("hs_latest_sequence_ended_date")).isoformat(), "hs_seq_exit": sequence_exit(props),
            "hs_dq_reason": (dq or {}).get("reason"), "hs_dq_note": (dq or {}).get("note"), "hs_dq_at": (dq or {}).get("at"), "hs_reengage_date": (dq or {}).get("reengage"),
            "hs_lost_reason": (lost or {}).get("reason"), "hs_lost_at": (lost or {}).get("at"), "hs_lost_deal": (lost or {}).get("deal"), "hs_lost_kind": (lost or {}).get("kind")}


LEAD_DQ_PROPS = ["hs_lead_disqualification_reason", "hs_lead_disqualification_note", "disqualified_lead_reengagement_date", "hs_lastmodifieddate"]


def disqualified_leads(hub, contact_ids):
    """{contact id: {reason, note, at, reengage}} from each contact's most recently changed lead that carries a Disqualification Reason (a Lead property, not a Contact one)."""
    links = {}
    for ch in chunks(sorted(set(contact_ids)), 1000):
        d = hub.call("POST", "/crm/v4/associations/contacts/leads/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            links[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
    leads = read_objects(hub, "leads", [i for v in links.values() for i in v], LEAD_DQ_PROPS)
    out = {}
    for cid, lids in links.items():
        best = sorted(((leads[i].get("hs_lastmodifieddate") or "", leads[i]) for i in lids if i in leads and leads[i].get("hs_lead_disqualification_reason")), key=lambda x: x[0], reverse=True)
        if best:
            at, lead = best[0]
            out[cid] = {"reason": lead.get("hs_lead_disqualification_reason"), "note": (lead.get("hs_lead_disqualification_note") or "")[:300] or None, "at": at or None,
                        "reengage": _date(lead.get("disqualified_lead_reengagement_date"))}
    return out


LOST_DEAL_PROPS = ["hs_is_closed_lost", "hs_is_closed", "um_closed_lost_reasons", "closed_lost_reason", "closedate", "dealname", "pipeline"]
LOST_KIND = {PIPELINE_SALES: "lead", PIPELINE_CONVERSION: "freemium", PIPELINE_RENEWALS: "customer"}   # what the contact was when the deal was lost: a prospect, a freemium user, or an existing customer up for renewal


def lost_deals(hub, contact_ids):
    """{contact id: {reason, at, deal, kind}} from the latest closed-lost deal of each contact (UM Closed Lost Reasons, else HubSpot's standard Closed Lost Reason). A contact with a deal still open is skipped: it is already being worked."""
    links = {}
    for ch in chunks(sorted(set(contact_ids)), 1000):
        d = hub.call("POST", "/crm/v4/associations/contacts/deals/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            links[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
    deals = read_objects(hub, "deals", [i for v in links.values() for i in v], LOST_DEAL_PROPS)
    out = {}
    for cid, dids in links.items():
        ds = [deals[i] | {"_id": i} for i in dids if i in deals]
        if any(d.get("hs_is_closed") != "true" for d in ds):
            continue
        lost = sorted((d for d in ds if d.get("hs_is_closed_lost") == "true"), key=lambda d: _date(d.get("closedate")) or "", reverse=True)
        if lost:
            d = lost[0]
            out[cid] = {"reason": d.get("um_closed_lost_reasons") or d.get("closed_lost_reason") or "No reason recorded", "at": _date(d.get("closedate")), "deal": (d.get("dealname") or "")[:200] or None, "kind": LOST_KIND.get(d.get("pipeline"), "lead")}
    return out


def sync_contact_state(rest, hub, now):
    """Copy what HubSpot knows about each of Atlas's HubSpot-linked contacts (lifecycle, sequence, bounce, unsubscribe, owner, NeverBounce) onto the contact, in batches of 100 reads."""
    mine = [r for r in rest.select_all("contacts", "contact_urn,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"}) if r.get("hubspot_contact_id")]
    props = read_objects(hub, "contacts", [r["hubspot_contact_id"] for r in mine], CONTACT_STATE_PROPS)
    try:   # disqualified leads for the Re-engagement view; a failure (for example a missing lead scope) must not stop the rest
        dq = disqualified_leads(hub, [r["hubspot_contact_id"] for r in mine])
    except Exception as e:  # noqa: BLE001
        dq = {}
        print("Disqualified leads skipped:", e)
    try:   # closed-lost deals for the Re-engagement view; a failure must not stop the rest
        lost = lost_deals(hub, [r["hubspot_contact_id"] for r in mine])
    except Exception as e:  # noqa: BLE001
        lost = {}
        print("Closed-lost deals skipped:", e)
    rows = [contact_state(props[str(r["hubspot_contact_id"])], r["contact_urn"], now, dq.get(str(r["hubspot_contact_id"])), lost.get(str(r["hubspot_contact_id"]))) for r in mine if str(r["hubspot_contact_id"]) in props]
    done = 0
    for ch in chunks(rows, 1000):
        done += int(rest.rpc("apply_contact_state", {"items": ch}) or 0)
    exits = 0
    try:   # an audience member enrolled in a sequence who has since left it: record when and why on the member
        by_hs = {str(r["hubspot_contact_id"]): row for r, row in zip(mine, rows) if row.get("hs_seq_exit") and row.get("hs_seq_ended_at")}
        for m in rest.select_all("audience_members", "audience_id,contact_id,state,enrolled_at,exit_reason", order="audience_id", params={"state": "eq.enrolled"}):
            row = by_hs.get(str(m.get("contact_id")))
            if row and not m.get("exit_reason") and (not m.get("enrolled_at") or row["hs_seq_ended_at"] >= m["enrolled_at"]):
                rest.patch("audience_members", {"audience_id": f"eq.{m['audience_id']}", "contact_id": f"eq.{m['contact_id']}"}, {"exit_reason": row["hs_seq_exit"], "exited_at": row["hs_seq_ended_at"]})
                exits += 1
    except Exception as e:  # noqa: BLE001
        print("Sequence exits skipped:", e)
    return {"contact_states": done, "contact_states_missing": len(mine) - len(rows), "sequence_exits_recorded": exits}


FED_LABELS = {"federation", "member practice"}                  # practice -> federation / federation -> practice
GROUP_LABELS = {"operating provider", "operated practice"}      # practice -> operating group / group -> practice
HS_ORG_PROPS = ["name", "org_type", "operating_status", "patient_list_size", "patient_list_rollup"]


def fetch_hubspot_orgs(hub):
    """Companies HubSpot holds as a Federation or a Group (these have no ODS code, so the practice sync never sees them)."""
    out, after = [], None
    while True:
        body = {"filterGroups": [{"filters": [{"propertyName": "org_type", "operator": "IN", "values": ["federation", "Group"]}]}], "limit": 100, "properties": HS_ORG_PROPS}
        if after:
            body["after"] = after
        d = hub.call("POST", "/crm/v3/objects/companies/search", json=body)
        out += [{"id": str(c["id"]), **c.get("properties", {})} for c in d.get("results", [])]
        after = (d.get("paging") or {}).get("next", {}).get("after")
        if not after:
            return out


def labelled_company_links(hub, company_ids):
    """{company id: [(associated company id, {lower-case association labels})]}: the batch associations endpoint with the labels kept."""
    out = {}
    for ch in chunks(list(company_ids), 1000):
        d = hub.call("POST", "/crm/v4/associations/companies/companies/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            out[str(r["from"]["id"])] = [(str(t["toObjectId"]), {str(x.get("label") or "").strip().lower() for x in t.get("associationTypes", [])} - {""}) for t in r.get("to", [])]
    return out


def plan_hubspot_orgs(orgs, links, company_ods):
    """Payload for apply_hubspot_orgs(). The association labels decide what a HubSpot organisation is: Member Practice / Federation links make a federation, Operating Provider /
    Operated Practice links make an operating group; Org Type only decides when there are no labelled links. Unlabelled company-to-practice links count for the kind chosen
    (a plain association is how the first federations were linked); Parent / Child Company, PCN and ICB labels are other relationships and are ignored here."""
    out = []
    for o in orgs:
        mine = [(company_ods[t], lab) for t, lab in links.get(o["id"], []) if t in company_ods]
        fed = sorted({ods for ods, lab in mine if lab & FED_LABELS}); grp = sorted({ods for ods, lab in mine if lab & GROUP_LABELS})
        if fed or grp:
            kind = "federation" if len(fed) >= len(grp) else "group"
            practices = fed if kind == "federation" else grp
        else:
            kind = "federation" if str(o.get("org_type")) == "federation" else "group"
            practices = sorted({ods for ods, lab in mine if not lab})
        name = str(o.get("name") or "").strip()
        seen = {}   # the labels on this organisation's links to practices we hold, so an empty result can be explained
        for _, lab in mine:
            for x in (lab or {"(no label)"}):
                seen[x] = seen.get(x, 0) + 1
        if name:
            out.append({"seen": seen, "company_id": o["id"], "name": name, "kind": kind, "org_type": o.get("org_type"), "operating_status": o.get("operating_status"),
                        "size": o.get("patient_list_size") or "", "rollup": o.get("patient_list_rollup") or "", "practices": practices})
    return out


def link_network_deals(rest, hub, org_company_ids, company_ods=None):
    """Deals made in HubSpot for a federation or group (associated with its company) are recorded against the organisations they cover, with the practices each covers (the practice companies on the deal).
    A deal covering practices of both a provider group and a federation sits on both. A deal that names no practice we hold stays on the organisation of the company it was made on. Only live deals (not lost) are kept;
    rows the tool wrote itself are never changed."""
    company_ods = company_ods or {}
    to_deals = associations(hub, "deals", list(org_company_ids))
    deals = read_objects(hub, "deals", [d for v in to_deals.values() for d in v], ["dealname", "hs_is_closed", "hs_is_closed_won", "hs_is_closed_lost"])
    live = sorted(d for d in deals if deals[d].get("hs_is_closed_lost") != "true")
    covered = {}
    for ch in chunks(live, 1000):
        d = hub.call("POST", "/crm/v4/associations/deals/companies/batch/read", json={"inputs": [{"id": i} for i in ch]})
        for r in d.get("results", []):
            covered[str(r["from"]["id"])] = {company_ods[str(t["toObjectId"])] for t in r.get("to", []) if str(t["toObjectId"]) in company_ods}
    org_of = {str(r["company_id"]): r["org_id"] for r in rest.select_all("hubspot_org_companies", "org_id,company_id", order="company_id")}
    practice_ods = {r["id"]: r["ods_code"] for r in rest.select_all("organisations", "id,ods_code", order="id", params={"kind": "eq.practice"}) if r.get("ods_code")}
    members = {}
    for r in rest.select_all("org_relationships", "from_org,to_org,rel_type", order="from_org", params={"rel_type": "in.(OPERATED_BY,MEMBER_OF_FEDERATION)"}):
        if r["from_org"] in practice_ods:
            members.setdefault(r["to_org"], set()).add(practice_ods[r["from_org"]])
    want = {}   # (deal, org) -> covered practices
    for c, ds in to_deals.items():
        for d in ds:
            if d not in live:
                continue
            cov = covered.get(d, set())
            hits = {o: sorted(cov & m) for o, m in members.items() if cov & m}
            if hits:
                for o, c_ in hits.items():
                    want[(d, o)] = c_
            elif c in org_of:
                want[(d, org_of[c])] = sorted(cov)
    have = {(r["deal_id"], r["org_id"]): r for r in rest.select_all("hubspot_network_deals", "deal_id,org_id,created_by,covers", order="deal_id")}
    rows = [{"deal_id": d, "org_id": o, "company_id": next((c for c, ds in to_deals.items() if d in ds), ""), "deal_name": (deals[d].get("dealname") or "")[:200] or None, "created_by": (have.get((d, o)) or {}).get("created_by") or "HubSpot sync", "covers": cv}
            for (d, o), cv in want.items() if (d, o) not in have or sorted(have[(d, o)].get("covers") or []) != cv]
    if rows:
        rest.upsert("hubspot_network_deals", rows, "deal_id,org_id")
    for (d, o), r in have.items():   # a sync-made row whose deal no longer covers that organisation (a practice taken off the deal, say) is removed
        if r.get("created_by") == "HubSpot sync" and d in live and (d, o) not in want:
            rest.delete_in("hubspot_network_deals", "deal_id", [d], extra={"org_id": f"eq.{o}"})
    return len(rows)


def sync_hubspot_orgs(rest, hub, by_ods):
    """Bring HubSpot's federations and operating groups, and their practices, into the organisation graph."""
    company_ods = {str(c["id"]): ods for ods, cs in by_ods.items() for c in cs}
    orgs = fetch_hubspot_orgs(hub)
    items = plan_hubspot_orgs(orgs, labelled_company_links(hub, [o["id"] for o in orgs]), company_ods)
    empty = {i["name"]: i["seen"] for i in items if not i["practices"] and i["seen"]}   # linked to practices in HubSpot, but none by a label that counts
    payload = [{k: v for k, v in i.items() if k != "seen"} for i in items]
    res = rest.rpc("apply_hubspot_orgs", {"items": payload})
    try:
        deals_linked = link_network_deals(rest, hub, [o["id"] for o in orgs], company_ods)
    except Exception as e:  # noqa: BLE001  deals are a convenience; the organisations are already saved
        deals_linked = 0
        print("Network deals skipped:", e)
    return {"hubspot_network_deals": deals_linked, "hubspot_orgs": len(items), "hubspot_org_links": sum(len(i["practices"]) for i in items), "hubspot_orgs_created": (res or {}).get("created", 0),
            **({"hubspot_orgs_no_counting_label": empty} if empty else {})}


AUDIT_NOISE = {"the", "and", "surgery", "practice", "medical", "centre", "center", "health", "group", "gp", "partners", "partnership", "dr", "drs", "clinic", "ltd", "limited", "nhs", "ctr", "ctre", "med", "hc", "mc", "family"}


def _stem(w):
    return re.sub(r"(ies|es|s)$", "", w) if len(w) > 5 else w   # surgeries and surgery, practices and practice compare equal


def name_tokens(name):
    words = [_stem(w) for w in re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower().replace("&", " and ")).split()]
    noise = AUDIT_NOISE | {_stem(w) for w in AUDIT_NOISE}
    return [w for w in words if w not in noise] or words


def names_match(a, b):
    """True when two practice names plausibly refer to the same place (ignores filler words, abbreviations such as Ctr, plurals, order and small spelling differences; two shared distinctive words is enough)."""
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return True   # nothing to compare
    sa, sb = set(ta), set(tb)
    if sa <= sb or sb <= sa or len({w for w in sa & sb if len(w) > 3}) >= 2:
        return True
    return difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio() >= 0.72


def norm_postcode(pc):
    return re.sub(r"[^A-Z0-9]", "", str(pc or "").upper())


NI_CODE = re.compile(r"^Z\d{5}$")   # Northern Ireland practices are named after their partners in ODS ("Dr. Large & Partners"), so a trading name never matches
WELSH_CODE = re.compile(r"^W9\d{4}$")   # Welsh GP practice codes; Atlas holds Welsh practices only once the Wales files are loaded


def audit_rows(raw, practices, now):
    """Mismatches between HubSpot companies (that carry a GP ODS Code) and the NHS practice list."""
    rows, by_code = [], {}
    for c in raw:
        p = {"id": str(c["id"]), **c.get("properties", {})}
        by_code.setdefault(norm_ods(p.get("partner_organisation_code")), []).append(p)

    def add(issue, c, ods, pr, detail):
        rows.append({"id": f"{issue}-{c['id']}", "issue": issue, "company_id": c["id"], "company_name": c.get("name"), "ods_code": ods, "nhs_name": (pr or {}).get("practice_name"),
                     "nhs_status": (pr or {}).get("status"), "detail": detail, "found_at": now, "object_type": "company"})
    for ods, cs in by_code.items():
        if not ods:
            continue
        pr = practices.get(ods)
        for c in cs:
            if pr is None:
                if WELSH_CODE.match(ods):
                    add("unknown_wales", c, ods, None, f"{ods} is a Welsh practice code that Atlas does not hold (load the Wales files on Data > Data sources)")
                else:
                    add("unknown_code", c, ods, None, f"{ods} is not a GP practice in the NHS list")
                continue
            if len(cs) > 1:
                add("duplicate_code", c, ods, pr, f"{len(cs)} HubSpot companies carry {ods}")
            if (pr.get("status") != "Active" or pr.get("merged_into")) and (c.get("operating_status") or "").lower() != expected_status(pr):   # already marked Closed or Merged in HubSpot: resolved
                add("closed_practice", c, ods, pr, "Merged into " + str(pr["merged_into"]) if pr.get("merged_into") else f"NHS status: {pr.get('status')}")
            same_place = norm_postcode(c.get("zip")) and norm_postcode(c.get("zip")) == norm_postcode(pr.get("postcode"))
            if not names_match(c.get("name"), pr.get("practice_name")) and not same_place and not NI_CODE.match(ods):   # a different name at the same postcode is the same practice under another name
                add("name_mismatch", c, ods, pr, "Names and postcodes both differ" if c.get("zip") else "Names differ and the company has no postcode")
    return rows


def lifecycle_audit(ods, name, cs, service_ids, services, churned, now):
    """A practice company whose Lifecycle Stage disagrees with its Services. Past Customer is right only when no Service is live and a Service carries a churn date;
    a Past Customer with a live Service is wrong the other way. Report only: Atlas writes nothing to HubSpot for this."""
    primary = sorted(cs, key=lambda c: (c.get("createdate") or "", str(c.get("id"))))[0]
    stage = primary.get("lifecyclestage")
    live = [services[i] for i in service_ids if services.get(i, {}).get("hs_pipeline_stage") in LIVE_SERVICE_STAGES]
    issue = detail = None
    if stage == PAST_CUSTOMER and live:
        issue, detail = "lifecycle_past_but_live", f"Lifecycle Stage is Past Customer but {len(live)} Service{'s are' if len(live) > 1 else ' is'} still live ({', '.join(sv.get('hs_name') or 'unnamed' for sv in live[:3])})"
    elif stage not in (PAST_CUSTOMER, MERGED_CLOSED) and primary.get("company_status") != "Ex-Customer" and not live and churned:
        issue, detail = "lifecycle_should_be_past", f"No live Service and churned {churned}, but Lifecycle Stage is {LIFECYCLE.get(stage or '', stage or 'blank')}. Past Customer is probably right: check the Services and the churn date, then change it in HubSpot"
    if not issue:
        return None
    return {"id": f"{issue}-{primary['id']}", "issue": issue, "company_id": str(primary["id"]), "company_name": primary.get("name"), "ods_code": ods, "nhs_name": name, "nhs_status": None, "detail": detail, "found_at": now, "object_type": "company"}


def norm_name(name):
    return " ".join(sorted(name_tokens(name)))


def network_audit_rows(hs_pcns, hs_icbs, epcn, now, conflicts=()):
    """Mismatches on HubSpot's PCN and ICB records against the NHS ODS list: records without a code, duplicates, codes NHS does not list, differing names,
    and practice companies associated to a PCN record other than their own PCN."""
    rows = []

    def add(issue, obj, rec, detail, nhs_name=None, ods=None):
        rows.append({"id": f"{issue}-{rec['id']}", "issue": issue, "object_type": obj, "company_id": str(rec["id"]), "company_name": rec.get("name"), "ods_code": ods or (rec.get("ods_code") or "").strip().upper() or None,
                     "nhs_name": nhs_name, "nhs_status": None, "detail": detail, "found_at": now})
    by_nhs_name = {}
    for code, e in epcn.items():
        by_nhs_name.setdefault(norm_name(e["name"]), []).append(code)
    codes = {}
    for pr in hs_pcns:
        code = (pr.get("ods_code") or "").strip().upper()
        if not code:
            guess = by_nhs_name.get(norm_name(pr.get("name")), [])
            add("pcn_no_code", "pcn", pr, f"No ODS code. Probably {guess[0]} ({epcn[guess[0]]['name']})" if len(guess) == 1 else "No ODS code, and no single NHS PCN has this name", epcn[guess[0]]["name"] if len(guess) == 1 else None)
            continue
        codes.setdefault(code, []).append(pr)
    for code, prs in codes.items():
        for pr in prs:
            if len(prs) > 1:
                add("pcn_duplicate", "pcn", pr, f"{len(prs)} PCN records carry {code}")
            if code not in epcn:
                add("pcn_unknown_code", "pcn", pr, f"{code} is not in the NHS PCN list")
            elif not names_match(pr.get("name"), epcn[code]["name"]):
                add("pcn_name_mismatch", "pcn", pr, "HubSpot and NHS names differ", epcn[code]["name"])
    seen_icb = {}
    for pr in hs_icbs:
        code = (pr.get("ods_code") or "").strip().upper()
        if not code:
            add("icb_issue", "icb", pr, "ICB record has no ODS code")
        seen_icb.setdefault(code or norm_icb(pr.get("name")), []).append(pr)
    for key, prs in seen_icb.items():
        if len(prs) > 1:
            for pr in prs:
                add("icb_issue", "icb", pr, f"{len(prs)} ICB records share the same {'code' if key == (pr.get('ods_code') or '').strip().upper() else 'name'}")
    for cid, name, ods, extra in conflicts:
        rows.append({"id": f"pcn_association-{cid}", "issue": "pcn_association", "object_type": "company", "company_id": cid, "company_name": name, "ods_code": ods, "nhs_name": None, "nhs_status": None,
                     "detail": "Also associated with: " + ", ".join(extra), "found_at": now})
    return rows


def write_audit(rest, rows):
    """Replace the stored mismatch list with today's; never stops the sync."""
    try:
        if rows:
            rest.upsert("hubspot_audit", rows, "id")
        have = {r["id"] for r in rest.select_all("hubspot_audit", "id", order="id")}
        stale = sorted(have - {r["id"] for r in rows})
        if stale:
            rest.delete_in("hubspot_audit", "id", stale)
        counts = {}
        for r in rows:
            counts[r["issue"]] = counts.get(r["issue"], 0) + 1
        return {"audit_issues": len(rows), "audit_by_issue": counts}
    except Exception as e:  # noqa: BLE001
        print("Audit skipped:", e)
        return {"audit_error": str(e)[:200]}


def sync_audit(rest, raw, practices, now):
    return write_audit(rest, audit_rows(raw, practices, now))


def record(rest, rows, actor):
    """Append rows to the HubSpot activity log; the log must never stop the sync."""
    try:
        rest.insert("hubspot_activity", [{"actor": actor, "ok": True, **r} for r in rows])
    except Exception as e:  # noqa: BLE001
        print("Activity log write skipped:", e)


def sync(rest, hub, now=None, actor="daily sync"):
    now = (now or datetime.now(timezone.utc)).isoformat()
    practices = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,total_patients,data_month,postcode,status,merged_into,closure_confirmed_at,operational_end_date,pcn_code,hubspot_company_id,hubspot_company_imported_at,hubspot_stage,hubspot_engaged,hubspot_customer", order="ods_code")}
    raw, total = fetch_companies(hub)
    by_ods = {}
    for c in raw:
        props = {"id": c["id"], **c.get("properties", {})}
        ods = norm_ods(props.get("partner_organisation_code"))
        if ods in practices:
            by_ods.setdefault(ods, []).append(props)
    cids = [str(c["id"]) for cs in by_ods.values() for c in cs]
    to_contacts, to_deals = associations(hub, "contacts", cids), associations(hub, "deals", cids)
    contacts = read_objects(hub, "contacts", [i for v in to_contacts.values() for i in v], ["lifecyclestage", "email", "createdate", "firstname", "lastname", "jobtitle", "phone", "um_source_detail_1", "um_source_detail_2"])
    deals = read_objects(hub, "deals", [i for v in to_deals.values() for i in v], ["hs_is_closed_won", "hs_is_closed", "amount", "pipeline", "dealname", "hs_lastmodifieddate", *TERM_PROPS])
    link_open_deals(rest, by_ods, to_deals, deals)
    line_qty = deal_line_quantities(hub, won_deal_ids(deals))
    to_services, services, service_error = {}, {}, None
    try:   # Service ACV is the contracted-ARR source; if the token cannot read Services, fall back to deals and say so in the run summary
        to_services = associations(hub, SERVICE_OBJECT, cids)
        services = read_objects(hub, SERVICE_OBJECT, [i for v in to_services.values() for i in v], ["hs_pipeline_stage", "actual_annual_contract_value__acv_", "contract_start_date", "contract_end_date", "hs_start_date", "hs_createdate", "hs_name", "current_subscription", "date_churned"])
    except Exception as e:  # noqa: BLE001
        service_error = str(e)[:300]

    try:   # merged-into / branch-of links, by association label; an unreadable result leaves the columns as they were
        role_links = practice_role_links(hub, cids)
    except Exception as e:  # noqa: BLE001
        role_links = None
        print("Role links skipped:", e)
    rows, flags, life_audit = [], {"customers": 0, "engaged": 0}, []
    hs_contacts = {}   # ods -> {email: (contact id, createdate)}
    hs_ids = {}   # ods -> HubSpot contact ids of its companies
    for ods, cs in by_ods.items():
        cset = [str(c["id"]) for c in cs]
        contact_ids = sorted({i for c in cset for i in to_contacts.get(c, [])})
        deal_ids = sorted({i for c in cset for i in to_deals.get(c, [])})
        f = classify(cs, contact_ids, contacts, deal_ids, deals)
        flags["customers"] += f["hubspot_customer"]; flags["engaged"] += f["hubspot_engaged"]
        service_ids = sorted({i for c in cset for i in to_services.get(c, [])})
        rows.append({"ods_code": ods, "practice_name": practices[ods]["practice_name"], **f, **revenue_fields(deal_ids, deals, service_ids, services, f["hubspot_customer"], f["hubspot_commercial_model"], line_qty), **lifecycle_fields(cs, deal_ids, deals, service_ids, services, line_qty, list_size(cs, f.get("hubspot_company_id"))), "hubspot_list_size": list_size(cs, f.get("hubspot_company_id")), **linked_properties(cs, f.get("hubspot_company_id")), **(role_columns(role_links, f.get("hubspot_company_id")) if role_links is not None else {}), "hubspot_synced_at": now})
        la = lifecycle_audit(ods, practices[ods]["practice_name"], cs, service_ids, services, rows[-1].get("hubspot_churned_date"), now) if to_services else None
        if la:
            life_audit.append(la)
        hs_contacts[ods] = {(contacts[i].get("email") or "").strip().lower(): (i, contacts[i].get("createdate")) for i in contact_ids if contacts.get(i, {}).get("email")}
        hs_ids[ods] = set(contact_ids)
    for ods, p in practices.items():   # a practice that had a company before but no longer does: clear the link and flags
        if ods not in by_ods and p.get("hubspot_company_id"):
            rows.append({"ods_code": ods, "practice_name": p["practice_name"], "hubspot_company_id": None, "hubspot_company_imported_at": None, "hubspot_stage": None,
                         "hubspot_engaged": False, "hubspot_customer": False, "hubspot_commercial_model": None, "hubspot_contracted_arr": None, "hubspot_contracted_src": None,
                         "hubspot_contract_terms": None, "hubspot_list_size": None, "hubspot_org_type": None, "hubspot_operating_status": None, "hubspot_website": None, "hubspot_parent_company_id": None, "hubspot_successor_company_id": None, "hubspot_branch_parent_company_id": None, "hubspot_contract_start": None, "hubspot_contract_end": None, "hubspot_pipeline": None, "hubspot_conversion_pipeline": None, "hubspot_renewal_pipeline": None, "hubspot_company_status": None, "hubspot_service_name": None, "hubspot_product": None, "hubspot_product_service": None, "hubspot_first_start": None, "hubspot_churned_date": None, "hubspot_signed_size": None, "hubspot_size_history": None, "hubspot_synced_at": now})
    rest.upsert("gp_practices", rows, "ods_code")
    flag, month = list_size_flag(rest), max((p.get("data_month") or "" for p in practices.values()), default="")
    auto, held = plan_list_sizes(practices, rows, flag.get("include_customers") is True)
    sizes = {"list_sizes_pending": len(auto), "list_sizes_held": len(held)}
    if list_size_due(flag, month):
        written, err = push_list_sizes(rest, hub, auto, month) if auto else ([], None)
        sizes["list_sizes_written"] = len(written)
        if err:
            sizes["list_size_error"] = err
        else:   # applied for this NHS data month: the daily runs leave it alone until the next monthly load
            rest.upsert("app_flags", [{"key": "list_size_sync", "value": {**flag, "last_month": month}, "updated_at": now}], "key")
        if auto or held or err:
            record(rest, [{"kind": "list_size_sync", "ok": not err, "summary": f"NHS {month}: updated {len(written):,} list sizes in HubSpot; {len(held)} held back for review" + (f"; stopped: {err}" if err else ""),
                           "detail": {"month": month, "changes": written[:300], "held": held[:100], "error": err}}], actor)
    flag2 = next((r.get("value") or {} for r in _flags(rest) if r.get("key") == "alignment_sync"), {})
    try:
        branches = rest.select_all("practice_branches", "branch_code,branch_name,postcode,resolution,match_status,practice_code,status", order="branch_code")
    except Exception:  # noqa: BLE001
        branches = []
    todo, cases = plan_alignment(practices, rows, [x for x in branches if x.get("status") == "Active"])
    sizes.update({"alignment_pending": len(todo), "alignment_cases": cases})
    if align_due(flag2, len(todo)):
        written, err = push_alignment(rest, hub, todo)
        sizes["alignment_written"] = len(written)
        if err:
            sizes["alignment_error"] = err
        elif flag2.get("approve_once"):
            rest.upsert("app_flags", [{"key": "alignment_sync", "value": {**flag2, "approve_once": False}, "updated_at": now}], "key")
        record(rest, [{"kind": "alignment_sync", "ok": not err, "summary": f"Set Org Type / Operating status on {len(written):,} HubSpot companies from NHS data; {cases} merged or moved sites need a person" + (f"; stopped: {err}" if err else ""),
                       "detail": {"changes": written[:300], "error": err, "cases": cases}}], actor)
    elif flag2.get("enabled") is True and len(todo) > ALIGN_MAX:
        sizes["alignment_held"] = len(todo)   # the Data panel offers "approve this run"
    audit_all = audit_rows(raw, practices, now) + life_audit
    conflicts = []

    ours = rest.select_all("contacts", "contact_urn,ods_code,email,hubspot_status,hubspot_contact_id", order="contact_urn")
    crow = contact_link_updates(ours, by_ods, hs_contacts, hs_ids)
    rest.upsert("contacts", crow, "contact_urn")
    try:   # contacts HubSpot holds on a practice's company that Atlas does not have yet (the export import only approved decision-makers with direct addresses)
        urn_id = {c["contact_urn"]: c.get("hubspot_contact_id") for c in ours}
        urn_id.update({r["contact_urn"]: r.get("hubspot_contact_id") for r in crow})
        contacts_added = import_hubspot_contacts(rest, by_ods, to_contacts, contacts, {str(v) for v in urn_id.values() if v}, known_emails={(c.get("email") or "").strip().lower() for c in ours if c.get("email")})
    except Exception as e:  # noqa: BLE001
        contacts_added = 0
        print("HubSpot contact import skipped:", e)
    try:   # a guard against the duplicate-contact problem coming back: counted after every run, said loudly in the log and on Slack when anything shows
        dupes = duplicate_contact_counts(rest.select_all("contacts", "contact_urn,ods_code,email,hubspot_contact_id,source", order="contact_urn"))
        if any(dupes.values()):
            print("DUPLICATE CONTACTS:", dupes)
            send_alert("Atlas contact duplicates found after the HubSpot sync", f"{dupes}")
    except Exception as e:  # noqa: BLE001
        dupes = {"check_error": str(e)[:120]}
    managers_set = fill_hubspot_managers(rest)
    pcn_stats = {}
    if ods_fetched_recently(rest, now):   # a repeat sync the same day does not call NHS ODS again; the PCN / ICB audit rows from the last full run are kept
        pcn_stats = {"pcn_sync_skipped": "NHS ODS was fetched in the last 20 hours"}
        audit_all += network_audit_kept(rest)
    else:
        try:   # mirror NHS ODS into HubSpot's PCN object; a failure here must not undo the practice sync above
            icb_objs = fetch_custom(hub, ICB_OBJECT)
            icb_codes = {norm_icb(o.get("properties", {}).get("name")): o["properties"]["ods_code"] for o in icb_objs if o.get("properties", {}).get("ods_code")}
            epcn = parse_epcn(sources.fetch(sources.ODS_EXPORT + "epcn"), icb_codes)
            rest.upsert("app_flags", [{"key": "ods_pcn_fetch", "value": {"at": now}, "updated_at": now}], "key")
            hs_pcns = [{"id": o["id"], **o.get("properties", {})} for o in fetch_custom(hub, PCN_OBJECT)]
            company_of = {ods: str(sorted(cs, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]["id"]) for ods, cs in by_ods.items()}
            unlink = bool(next((r.get("value") or {} for r in _flags(rest) if r.get("key") == "pcn_unlink"), {}).get("run_once"))
            pcn_stats, lines, events = sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of, conflicts=conflicts, unlink_wrong=unlink)
            if unlink:
                rest.upsert("app_flags", [{"key": "pcn_unlink", "value": {"run_once": False, "last_removed": pcn_stats.get("pcn_links_removed", 0), "at": now}, "updated_at": now}], "key")
            audit_all += network_audit_rows(hs_pcns, [{"id": o["id"], **o.get("properties", {})} for o in icb_objs], epcn, now, conflicts)
            record(rest, events, actor)
            if lines:
                try:
                    slack.post("HubSpot sync updated the PCN records:\n• " + "\n• ".join(slack.mrkdwn(x) for x in lines[:20]) + (f"\n…and {len(lines) - 20} more" if len(lines) > 20 else ""))
                except Exception as e:  # noqa: BLE001
                    print("Slack post skipped:", e)
        except Exception as e:  # noqa: BLE001
            pcn_stats = {"pcn_sync_error": str(e)[:300]}
    contact_stats = {}
    try:   # campaign eligibility needs each contact's HubSpot state; a failure here must not undo the practice sync above
        contact_stats = sync_contact_state(rest, hub, now)
    except Exception as e:  # noqa: BLE001
        contact_stats = {"contact_state_error": str(e)[:300]}
    try:   # the channels Atlas's Slack bot is in, for the audience alert channel picker (needs a bot token; without one the picker offers only the default)
        if os.environ.get("SLACK_BOT_TOKEN"):
            contact_stats["slack_channels"] = slack.sync_channels(rest)
    except Exception as e:  # noqa: BLE001
        contact_stats["slack_channels_error"] = str(e)[:200]
    try:   # HubSpot's contact segments and the members of the ones Atlas tracks (after the contact state, so a failure never blocks it)
        contact_stats.update(segments.sync(rest, hub))
    except Exception as e:  # noqa: BLE001
        contact_stats["segments_error"] = str(e)[:300]
    org_stats = {}
    try:   # federations and groups defined in HubSpot; a failure here must not undo the practice sync above
        org_stats = sync_hubspot_orgs(rest, hub, by_ods)
    except Exception as e:  # noqa: BLE001
        org_stats = {"hubspot_orgs_error": str(e)[:300]}
    audit = write_audit(rest, audit_all)
    nets = sync_networks(rest, hub, now)
    return {**nets, **pcn_stats, **org_stats, **contact_stats, "primary_contacts_set": managers_set, "hubspot_companies_with_ods": total, "practices_linked": len(by_ods), "customers": flags["customers"], "engaged": flags["engaged"],
            "contacts_updated": len(crow), "hubspot_contacts_added": contacts_added, "contact_duplicates": dupes, **sizes, **({"service_error": service_error} if service_error else {}), "search_capped": total > len(raw), **audit}


def main():
    if not os.environ.get("HUBSPOT_TOKEN"):
        print("HUBSPOT_TOKEN is not set; skipping the HubSpot sync")
        return
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    try:
        rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
        actor = "manual sync" if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" else "daily sync"
        stats = sync(rest, Hub(os.environ["HUBSPOT_TOKEN"]), actor=actor)
        print("OK", stats)
        record(rest, [{"kind": "sync_run", "summary": f"{stats['practices_linked']:,} practices linked, {stats['customers']} customers, {stats['engaged']} engaged, {stats.get('networks_linked', 0)} PCN/ICB records linked", "detail": stats}], actor)
        if stats["search_capped"]:
            send_alert("Lalu Atlas: HubSpot sync hit the 10,000 company search limit", f"{stats}. Some companies were not read; ask for the sync to be windowed by created date.")
    except Exception as e:  # noqa: BLE001
        try:
            record(Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]), [{"kind": "sync_run", "ok": False, "summary": "HubSpot sync failed: " + str(e)[:250], "detail": {"error": str(e)[:1000]}}],
                   "manual sync" if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" else "daily sync")
        except Exception:  # noqa: BLE001
            pass
        send_alert("Lalu Atlas: HubSpot sync FAILED", str(e))
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
