"""Daily HubSpot -> dashboard sync: link each practice to its HubSpot company (matched on the GP ODS Code field) and fill in
customer / engaged status, lifecycle stage and which of the practice's contacts already exist in HubSpot. Read-only on HubSpot.

Customer: company lifecycle stage is Customer, or any associated deal is Closed Won.
Engaged: any associated contact whose lifecycle stage is not New, Prospecting, Past Customer or Other.
"""
import os
import sys
import time
from datetime import datetime, timezone

import requests

from .common import Rest, need_env, norm_ods, send_alert

BASE = "https://api.hubapi.com"
LIFECYCLE = {"lead": "New", "2207373534": "Engaged", "marketingqualifiedlead": "Marketing Qualified Lead", "5640141025": "Prospecting",
             "salesqualifiedlead": "Sales Qualified Lead", "opportunity": "Opportunity", "customer": "Customer", "4726262995": "Past Customer",
             "evangelist": "Evangelist", "other": "Other", "4025181418": "Client Services"}
NOT_ENGAGED = {"lead", "5640141025", "4726262995", "other", "", None}   # New, Prospecting, Past Customer, Other (or unset)
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
                "properties": ["name", "partner_organisation_code", "lifecyclestage", "createdate"], "sorts": ["createdate"]}
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
    customer = any((c.get("lifecyclestage") == "customer") for c in companies) or any(deals.get(d, {}).get("hs_is_closed_won") == "true" for d in deal_ids)
    engaged = any(contacts.get(c, {}).get("lifecyclestage") not in NOT_ENGAGED for c in contact_ids)
    primary = sorted(companies, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]
    stage = LIFECYCLE.get(primary.get("lifecyclestage") or "", primary.get("lifecyclestage") or None)
    return {"hubspot_company_id": str(primary["id"]), "hubspot_company_imported_at": primary.get("createdate"), "hubspot_stage": stage,
            "hubspot_engaged": bool(engaged), "hubspot_customer": bool(customer)}


def sync(rest, hub, now=None):
    now = (now or datetime.now(timezone.utc)).isoformat()
    practices = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,hubspot_company_id,hubspot_company_imported_at,hubspot_stage,hubspot_engaged,hubspot_customer", order="ods_code")}
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
    deals = read_objects(hub, "deals", [i for v in to_deals.values() for i in v], ["hs_is_closed_won"])

    rows, flags = [], {"customers": 0, "engaged": 0}
    hs_contacts = {}   # ods -> {email: (contact id, createdate)}
    for ods, cs in by_ods.items():
        cset = [str(c["id"]) for c in cs]
        contact_ids = sorted({i for c in cset for i in to_contacts.get(c, [])})
        deal_ids = sorted({i for c in cset for i in to_deals.get(c, [])})
        f = classify(cs, contact_ids, contacts, deal_ids, deals)
        flags["customers"] += f["hubspot_customer"]; flags["engaged"] += f["hubspot_engaged"]
        rows.append({"ods_code": ods, "practice_name": practices[ods]["practice_name"], **f, "hubspot_synced_at": now})
        hs_contacts[ods] = {(contacts[i].get("email") or "").strip().lower(): (i, contacts[i].get("createdate")) for i in contact_ids if contacts.get(i, {}).get("email")}
    for ods, p in practices.items():   # a practice that had a company before but no longer does: clear the link and flags
        if ods not in by_ods and p.get("hubspot_company_id"):
            rows.append({"ods_code": ods, "practice_name": p["practice_name"], "hubspot_company_id": None, "hubspot_company_imported_at": None, "hubspot_stage": None,
                         "hubspot_engaged": False, "hubspot_customer": False, "hubspot_synced_at": now})
    rest.upsert("gp_practices", rows, "ods_code")

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
    return {"hubspot_companies_with_ods": total, "practices_linked": len(by_ods), "customers": flags["customers"], "engaged": flags["engaged"],
            "contacts_updated": len(crow), "search_capped": total > len(raw)}


def main():
    if not os.environ.get("HUBSPOT_TOKEN"):
        print("HUBSPOT_TOKEN is not set; skipping the HubSpot sync")
        return
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    try:
        stats = sync(Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]), Hub(os.environ["HUBSPOT_TOKEN"]))
        print("OK", stats)
        if stats["search_capped"]:
            send_alert("Lalu Market Radar: HubSpot sync hit the 10,000 company search limit", f"{stats}. Some companies were not read; ask for the sync to be windowed by created date.")
    except Exception as e:  # noqa: BLE001
        send_alert("Lalu Market Radar: HubSpot sync FAILED", str(e))
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
