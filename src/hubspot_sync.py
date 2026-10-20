"""Daily HubSpot -> dashboard sync: link each practice to its HubSpot company (matched on the GP ODS Code field) and fill in
customer / engaged status, lifecycle stage and which of the practice's contacts already exist in HubSpot. Read-only on HubSpot.

Customer: company lifecycle stage is Customer, or any associated deal is Closed Won.
Engaged: any associated contact whose lifecycle stage is not New, Prospecting, Past Customer or Other.
"""
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

from . import slack, sources
from .common import Rest, need_env, norm_ods, send_alert, title_case

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


def sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of, getj=None):
    """Keep HubSpot's PCN custom object in step with NHS ODS: create missing PCNs (capped), repair records with a bad address, mark closed ones
    inactive, and add missing company -> PCN associations. Add-only: nothing is deleted or de-associated. Returns (stats, lines for Slack)."""
    getj = getj or sources.get_json
    stats, lines, events = {"pcn_records_created": 0, "pcn_records_repaired": 0, "pcn_records_inactivated": 0, "pcn_associations_added": 0, "pcn_create_capped": 0}, [], []
    ev = lambda kind, c, name, hid, summary, detail=None: events.append({"kind": kind, "target": name, "hubspot_type": "pcn", "hubspot_id": str(hid), "summary": summary, "detail": {"ods": c, **(detail or {})}})
    ours = {c for c in (p.get("pcn_code") for p in practices.values()) if c}
    by_code = {pr["ods_code"].strip().upper(): pr for pr in hs_pcns if pr.get("ods_code")}
    inactive = load_inactive_pcns(getj)
    # 1. create PCNs the tool knows (they have active practices) that HubSpot lacks
    missing = sorted(c for c in ours if c in epcn and c not in by_code and c not in inactive)
    for c in missing[:MAX_PCN_CREATES]:
        props = {**ods_pcn_props(getj(f"{sources.ODS_API}/organisations/{c}")), **{k: v for k, v in epcn[c].items() if v}, "ods_code": c, "status": "active"}
        r = hub.call("POST", f"/crm/v3/objects/{PCN_OBJECT}", json={"properties": props})
        by_code[c] = {"id": r["id"], **props}
        stats["pcn_records_created"] += 1
        lines.append(f"Created PCN {props['name']} ({c})")
        ev("pcn_created", c, props["name"], r["id"], f"Created PCN record {props['name']} ({c}) from NHS ODS", {"properties": props})
    stats["pcn_create_capped"] = max(0, len(missing) - MAX_PCN_CREATES)
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


def record(rest, rows, actor):
    """Append rows to the HubSpot activity log; the log must never stop the sync."""
    try:
        rest.insert("hubspot_activity", [{"actor": actor, "ok": True, **r} for r in rows])
    except Exception as e:  # noqa: BLE001
        print("Activity log write skipped:", e)


def sync(rest, hub, now=None, actor="daily sync"):
    now = (now or datetime.now(timezone.utc)).isoformat()
    practices = {p["ods_code"]: p for p in rest.select_all("gp_practices", "ods_code,practice_name,pcn_code,hubspot_company_id,hubspot_company_imported_at,hubspot_stage,hubspot_engaged,hubspot_customer", order="ods_code")}
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
    pcn_stats = {}
    try:   # mirror NHS ODS into HubSpot's PCN object; a failure here must not undo the practice sync above
        icb_codes = {norm_icb(o.get("properties", {}).get("name")): o["properties"]["ods_code"] for o in fetch_custom(hub, ICB_OBJECT) if o.get("properties", {}).get("ods_code")}
        epcn = parse_epcn(sources.fetch(sources.ODS_EXPORT + "epcn"), icb_codes)
        hs_pcns = [{"id": o["id"], **o.get("properties", {})} for o in fetch_custom(hub, PCN_OBJECT)]
        company_of = {ods: str(sorted(cs, key=lambda c: (c.get("createdate") or "", c.get("id")))[0]["id"]) for ods, cs in by_ods.items()}
        pcn_stats, lines, events = sync_pcn_records(rest, hub, epcn, hs_pcns, practices, company_of)
        record(rest, events, actor)
        if lines:
            try:
                slack.post("HubSpot sync updated the PCN records:\n• " + "\n• ".join(slack.mrkdwn(x) for x in lines[:20]) + (f"\n…and {len(lines) - 20} more" if len(lines) > 20 else ""))
            except Exception as e:  # noqa: BLE001
                print("Slack post skipped:", e)
    except Exception as e:  # noqa: BLE001
        pcn_stats = {"pcn_sync_error": str(e)[:300]}
    nets = sync_networks(rest, hub, now)
    return {**nets, **pcn_stats, "hubspot_companies_with_ods": total, "practices_linked": len(by_ods), "customers": flags["customers"], "engaged": flags["engaged"],
            "contacts_updated": len(crow), "search_capped": total > len(raw)}


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
            send_alert("Lalu Market Radar: HubSpot sync hit the 10,000 company search limit", f"{stats}. Some companies were not read; ask for the sync to be windowed by created date.")
    except Exception as e:  # noqa: BLE001
        try:
            record(Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]), [{"kind": "sync_run", "ok": False, "summary": "HubSpot sync failed: " + str(e)[:250], "detail": {"error": str(e)[:1000]}}],
                   "manual sync" if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" else "daily sync")
        except Exception:  # noqa: BLE001
            pass
        send_alert("Lalu Market Radar: HubSpot sync FAILED", str(e))
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
