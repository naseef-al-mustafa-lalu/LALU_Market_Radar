"""Daily HubSpot -> dashboard sync: link each practice to its HubSpot company (matched on the GP ODS Code field) and fill in
customer / engaged status, lifecycle stage and which of the practice's contacts already exist in HubSpot. Read-only on HubSpot.

Customer: company lifecycle stage is Customer, the company has a Commercial Model, or any associated deal is Closed Won, unless the company's Company Status is Ex-Customer.
Engaged: the company's lifecycle stage is past New / Prospecting (Engaged, MQL, SQL, Opportunity, Evangelist, Client Services).
"""
import difflib
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

from . import oscar, slack, sources
from .common import Rest, need_env, norm_ods, send_alert, title_case

BASE = "https://api.hubapi.com"
LIFECYCLE = {"lead": "New", "2207373534": "Engaged", "marketingqualifiedlead": "Marketing Qualified Lead", "5640141025": "Prospecting",
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


def classify(companies, contact_ids, contacts, deal_ids, deals):
    """One practice's flags from all HubSpot companies that carry its ODS code. Returns dict of the dashboard fields."""
    # HubSpot never moves a company back out of the Customer stage, so a company whose Company Status is Ex-Customer is not a customer
    live = [c for c in companies if c.get("company_status") != "Ex-Customer"]
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


TERM_PROPS = ["closedate", "dealname", "size_discount", "speed_discount", "term_length_discount", "referral_discount", "total_discount", "term_length_years", "value_per_patient", "actual_value_per_patient_calculated", "product___service", "commercial_model"]


LALU_PRODUCTS = {"440423339237", "440425147578", "440434162881", "440498134244"}   # the four Lalu Care products: a deal's line item quantity is the patients it bills


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
           "list_rate": _num(d.get("value_per_patient")), "net_rate": _num(d.get("actual_value_per_patient_calculated")), "line_qty": (line_qty or {}).get(did)}
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


def contract_basis(r):
    """(has a paying contract, its signed patients): a customer with contracted ARR or a Lalu Care line item. The line item quantity is the record of what they signed for."""
    qty = int(((r.get("hubspot_contract_terms") or {}).get("line_qty")) or 0)
    return bool(r.get("hubspot_customer")) and (qty > 0 or float(r.get("hubspot_contracted_arr") or 0) > 0), qty


def plan_list_sizes(practices, rows):
    """(auto, held): companies whose HubSpot Patient List Size differs from the NHS figure. Non-customers follow it, and so do customers whose contract is recorded on a line item
    (the line item quantity holds what they signed for, so the company can track ODS). A paying customer with no line item is left alone: nothing else records their contract size.
    A merged or closed practice whose NHS figure is 0 is written as 0 (its patients are counted at the successor, so HubSpot's own roll-ups must not count them twice); a paying customer is never zeroed. Neither is held back."""
    auto, held = [], []
    for r in rows:
        p = practices.get(r["ods_code"])
        if not p or not r.get("hubspot_company_id"):
            continue
        paying, qty = contract_basis(r)
        if paying and not qty:
            continue
        now, base = int(p.get("total_patients") or 0), int(r.get("hubspot_list_size") or 0)
        item = {"ods": r["ods_code"], "id": str(r["hubspot_company_id"]), "name": p["practice_name"], "from": base or None, "to": now}
        if p.get("merged_into") or p.get("status") != "Active" or p.get("closure_confirmed_at"):
            if now == 0 and base > 0 and not paying:
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


def list_size_due(flag, month):
    """Sizes follow the NHS figure once per monthly load, not every day: due when the switch is on and this data month has not been applied yet."""
    return flag.get("enabled") is True and bool(month) and flag.get("last_month") != month


def company_note(hub, company_id, text):
    hub.call("POST", "/crm/v3/objects/notes", json={"properties": {"hs_timestamp": datetime.now(timezone.utc).isoformat(), "hs_note_body": text},
                                                    "associations": [{"to": {"id": str(company_id)}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 190}]}]})


def push_list_sizes(rest, hub, auto):
    """Write the changed sizes to HubSpot in batches; returns (written, error). A token without the company write scope stops here and says so.
    A company set to 0 because its practice merged or closed gets a note with the old size, so the history is not lost."""
    done, err, day = [], None, datetime.now(timezone.utc).date().isoformat()
    for ch in chunks(auto, 100):
        try:
            hub.call("POST", "/crm/v3/objects/companies/batch/update", json={"inputs": [{"id": c["id"], "properties": {"patient_list_size": str(c["to"])}} for c in ch]})
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
            break
        rest.upsert("gp_practices", [{"ods_code": c["ods"], "practice_name": c["name"], "hubspot_list_size": c["to"]} for c in ch], "ods_code")
        for c in ch:
            if c.get("gone"):
                try:
                    company_note(hub, c["id"], f"Atlas, {day}: list size set to 0 (was {c['from']:,}). NHS data shows this practice as {c['gone']}"
                                 + (f", with its patients counted under {c['successor']}" if c.get("successor") else "") + ". Setting it to 0 stops HubSpot counting the same patients twice. The previous size is kept in this note.")
                except Exception as e:  # noqa: BLE001 - the size is already written; a missing note is not worth failing the run
                    print("Note skipped:", str(e)[:200])
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
            hub.call("POST", "/crm/v3/objects/companies/batch/update", json={"inputs": [{"id": c["id"], "properties": c["props"]} for c in ch]})
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
            break
        rest.upsert("gp_practices", [{"ods_code": c["ods"], "practice_name": c["name"], **{"hubspot_" + k: v for k, v in c["props"].items()}} for c in ch], "ods_code")
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
    """Patients a won deal contracts for: its Lalu Care line item quantity when there is one, else the Amount (a year's price) over twelve months of the net price per patient.
    The deal's own Patient List Size is no use: HubSpot keeps syncing it from the company, so it drifts after signing."""
    if qty:
        return int(qty)
    amount, net, tot = _num(deal.get("amount")), _num(deal.get("actual_value_per_patient_calculated")), _num(deal.get("total_discount"))
    lst = _price(deal.get("value_per_patient"))
    rate = net or (lst * (1 - (tot / 100 if tot and tot > 1 else tot or 0)) if lst else None)
    if amount and rate and rate > 0:
        n = round(amount / (12 * rate))
        if ref and not 0.35 * ref <= n <= 2.5 * ref:   # far from the practice's own list size: a group deal or a part-year Amount, not this practice's contract
            return None
        return n if 50 <= n <= 200000 else None
    return None


def lifecycle_fields(companies, deal_ids, deals, service_ids, services, line_qty, list_size_value):
    """What the Patients under management page needs for one practice: company status, its main Service (paid ones first, then the latest start), Product / Service from the latest won deal,
    when the first Service started, when it churned, and the size signed for (the won deal's line item quantity, else the company's list size)."""
    primary = sorted(companies, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]
    svs = [services[i] for i in service_ids if i in services]
    for sv in svs:
        sv["_product"], sv["_start"] = service_product(sv), min((d for d in (_date(sv.get("contract_start_date")), _date(sv.get("hs_start_date"))) if d), default=None)
    paid = [sv for sv in svs if sv["_product"] in ("all", "sar", "self") or sv["_product"] is None]
    main = max(paid or svs, key=lambda sv: (sv["_start"] or "", sv.get("hs_name") or ""), default=None)
    won = [(i, deals[i]) for i in deal_ids if i in deals and deals[i].get("hs_is_closed_won") == "true" and deals[i].get("pipeline") in PIPELINE_WON]
    last = max(won, key=lambda x: _date(x[1].get("closedate")) or "", default=(None, {}))
    churned = [d for d in (_date(sv.get("date_churned")) for sv in (paid or svs)) if d]
    starts = [sv["_start"] for sv in paid if sv["_start"]] or [_date(d.get("closedate")) for _, d in won if _date(d.get("closedate"))]
    ps = last[1].get("product___service") or None
    product = main["_product"] if main else None
    hist = sorted(((_date(d.get("closedate")), contract_patients(d, (line_qty or {}).get(i), list_size_value)) for i, d in ((i, deals[i]) for i in deal_ids if i in deals and deals[i].get("hs_is_closed_won") == "true"
                                                                                                       and deals[i].get("pipeline") in (PIPELINE_WON | {PIPELINE_RENEWALS}))), key=lambda x: x[0] or "")
    hist = [[d, n] for d, n in hist if d and n]
    qty = hist[-1][1] if hist else None
    return {"hubspot_company_status": primary.get("company_status") or None, "hubspot_service_name": (main or {}).get("hs_name") or None, "hubspot_product": product,
            "hubspot_product_service": ps or ({"self": "eMR"}.get(product, "eMR+") if product in ("all", "sar", "self") else None),
            "hubspot_first_start": min(starts) if starts else None, "hubspot_churned_date": max(churned) if churned and (primary.get("company_status") == "Ex-Customer" or not any(
                sv.get("current_subscription") for sv in paid)) else None,
            "hubspot_signed_size": int(qty) if qty else (int(list_size_value) if list_size_value else None), "hubspot_size_history": hist or None}


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


def sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of, getj=None, conflicts=None):
    """Keep HubSpot's PCN custom object in step with NHS ODS: create missing PCNs (capped), repair records with a bad address, mark closed ones
    inactive, and add missing company -> PCN associations. Add-only: nothing is deleted or de-associated. Returns (stats, lines for Slack)."""
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
            stats["pcn_records_repaired"] += 1
            lines.append(f"Corrected the address details of PCN {pr.get('name', c)} ({c})")
            ev("pcn_repaired", c, pr.get("name", c), pr["id"], f"Corrected the address details of PCN {pr.get('name', c)} ({c})", {"properties": {**blank, **fix}})
    # 3. mark PCNs closed in ODS as inactive in HubSpot
    for c, pr in by_code.items():
        if c in inactive and pr.get("status") != "inactive" and stats["pcn_records_inactivated"] < MAX_INACTIVATE:
            end = ods_pcn_props(getj(f"{sources.ODS_API}/organisations/{c}")).get("operational_end_date")
            hub.call("PATCH", f"/crm/v3/objects/{PCN_OBJECT}/{pr['id']}", json={"properties": {"status": "inactive", **({"operational_end_date": end} if end else {})}})
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
    todo = [{"from": {"id": cid}, "to": {"id": pid}} for cid, pid in want.items() if pid not in have.get(cid, set())][:MAX_ASSOCIATIONS]
    for ch in chunks(todo, 100):
        hub.call("POST", f"/crm/v4/associations/companies/{PCN_OBJECT}/batch/associate/default", json={"inputs": ch})
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
    practices = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,total_patients,data_month,postcode,status,merged_into,closure_confirmed_at,pcn_code,hubspot_company_id,hubspot_company_imported_at,hubspot_stage,hubspot_engaged,hubspot_customer", order="ods_code")}
    raw, total = fetch_companies(hub)
    by_ods = {}
    for c in raw:
        props = {"id": c["id"], **c.get("properties", {})}
        ods = norm_ods(props.get("partner_organisation_code"))
        if ods in practices:
            by_ods.setdefault(ods, []).append(props)
    cids = [str(c["id"]) for cs in by_ods.values() for c in cs]
    to_contacts, to_deals = associations(hub, "contacts", cids), associations(hub, "deals", cids)
    contacts = read_objects(hub, "contacts", [i for v in to_contacts.values() for i in v], ["lifecyclestage", "email", "createdate"])
    deals = read_objects(hub, "deals", [i for v in to_deals.values() for i in v], ["hs_is_closed_won", "hs_is_closed", "amount", "pipeline", *TERM_PROPS])
    line_qty = deal_line_quantities(hub, won_deal_ids(deals))
    to_services, services, service_error = {}, {}, None
    try:   # Service ACV is the contracted-ARR source; if the token cannot read Services, fall back to deals and say so in the run summary
        to_services = associations(hub, SERVICE_OBJECT, cids)
        services = read_objects(hub, SERVICE_OBJECT, [i for v in to_services.values() for i in v], ["hs_pipeline_stage", "actual_annual_contract_value__acv_", "contract_start_date", "contract_end_date", "hs_start_date", "hs_name", "current_subscription", "date_churned"])
    except Exception as e:  # noqa: BLE001
        service_error = str(e)[:300]

    rows, flags = [], {"customers": 0, "engaged": 0}
    hs_contacts = {}   # ods -> {email: (contact id, createdate)}
    for ods, cs in by_ods.items():
        cset = [str(c["id"]) for c in cs]
        contact_ids = sorted({i for c in cset for i in to_contacts.get(c, [])})
        deal_ids = sorted({i for c in cset for i in to_deals.get(c, [])})
        f = classify(cs, contact_ids, contacts, deal_ids, deals)
        flags["customers"] += f["hubspot_customer"]; flags["engaged"] += f["hubspot_engaged"]
        service_ids = sorted({i for c in cset for i in to_services.get(c, [])})
        rows.append({"ods_code": ods, "practice_name": practices[ods]["practice_name"], **f, **revenue_fields(deal_ids, deals, service_ids, services, f["hubspot_customer"], f["hubspot_commercial_model"], line_qty), **lifecycle_fields(cs, deal_ids, deals, service_ids, services, line_qty, list_size(cs, f.get("hubspot_company_id"))), "hubspot_list_size": list_size(cs, f.get("hubspot_company_id")), **linked_properties(cs, f.get("hubspot_company_id")), "hubspot_synced_at": now})
        hs_contacts[ods] = {(contacts[i].get("email") or "").strip().lower(): (i, contacts[i].get("createdate")) for i in contact_ids if contacts.get(i, {}).get("email")}
    for ods, p in practices.items():   # a practice that had a company before but no longer does: clear the link and flags
        if ods not in by_ods and p.get("hubspot_company_id"):
            rows.append({"ods_code": ods, "practice_name": p["practice_name"], "hubspot_company_id": None, "hubspot_company_imported_at": None, "hubspot_stage": None,
                         "hubspot_engaged": False, "hubspot_customer": False, "hubspot_commercial_model": None, "hubspot_contracted_arr": None, "hubspot_contracted_src": None,
                         "hubspot_contract_terms": None, "hubspot_list_size": None, "hubspot_org_type": None, "hubspot_operating_status": None, "hubspot_website": None, "hubspot_parent_company_id": None, "hubspot_contract_start": None, "hubspot_contract_end": None, "hubspot_pipeline": None, "hubspot_conversion_pipeline": None, "hubspot_renewal_pipeline": None, "hubspot_company_status": None, "hubspot_service_name": None, "hubspot_product": None, "hubspot_product_service": None, "hubspot_first_start": None, "hubspot_churned_date": None, "hubspot_signed_size": None, "hubspot_size_history": None, "hubspot_synced_at": now})
    rest.upsert("gp_practices", rows, "ods_code")
    auto, held = plan_list_sizes(practices, rows)
    sizes = {"list_sizes_pending": len(auto), "list_sizes_held": len(held)}
    flag, month = list_size_flag(rest), max((p.get("data_month") or "" for p in practices.values()), default="")
    if list_size_due(flag, month):
        written, err = push_list_sizes(rest, hub, auto) if auto else ([], None)
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
    audit_all = audit_rows(raw, practices, now)
    conflicts = []

    ours = rest.select_all("contacts", "contact_urn,ods_code,email,hubspot_status,hubspot_contact_id", order="contact_urn")
    crow = []
    for c in ours:
        if c["ods_code"] not in by_ods:
            continue
        hit = hs_contacts[c["ods_code"]].get((c.get("email") or "").strip().lower())
        want = ("Imported", hit[1], hit[0]) if hit else ("Not imported", None, None)
        if (c["hubspot_status"], c.get("hubspot_contact_id")) != (want[0], want[2]):
            crow.append({"contact_urn": c["contact_urn"], "ods_code": c["ods_code"], "hubspot_status": want[0], "hubspot_imported_at": want[1], "hubspot_contact_id": want[2]})
    rest.upsert("contacts", crow, "contact_urn")
    managers_set = fill_hubspot_managers(rest)
    pcn_stats = {}
    try:   # mirror NHS ODS into HubSpot's PCN object; a failure here must not undo the practice sync above
        icb_objs = fetch_custom(hub, ICB_OBJECT)
        icb_codes = {norm_icb(o.get("properties", {}).get("name")): o["properties"]["ods_code"] for o in icb_objs if o.get("properties", {}).get("ods_code")}
        epcn = parse_epcn(sources.fetch(sources.ODS_EXPORT + "epcn"), icb_codes)
        hs_pcns = [{"id": o["id"], **o.get("properties", {})} for o in fetch_custom(hub, PCN_OBJECT)]
        company_of = {ods: str(sorted(cs, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]["id"]) for ods, cs in by_ods.items()}
        pcn_stats, lines, events = sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of, conflicts=conflicts)
        audit_all += network_audit_rows(hs_pcns, [{"id": o["id"], **o.get("properties", {})} for o in icb_objs], epcn, now, conflicts)
        record(rest, events, actor)
        if lines:
            try:
                slack.post("HubSpot sync updated the PCN records:\n• " + "\n• ".join(slack.mrkdwn(x) for x in lines[:20]) + (f"\n…and {len(lines) - 20} more" if len(lines) > 20 else ""))
            except Exception as e:  # noqa: BLE001
                print("Slack post skipped:", e)
    except Exception as e:  # noqa: BLE001
        pcn_stats = {"pcn_sync_error": str(e)[:300]}
    audit = write_audit(rest, audit_all)
    nets = sync_networks(rest, hub, now)
    return {**nets, **pcn_stats, "primary_contacts_set": managers_set, "hubspot_companies_with_ods": total, "practices_linked": len(by_ods), "customers": flags["customers"], "engaged": flags["engaged"],
            "contacts_updated": len(crow), **sizes, **({"service_error": service_error} if service_error else {}), "search_capped": total > len(raw), **audit}


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
