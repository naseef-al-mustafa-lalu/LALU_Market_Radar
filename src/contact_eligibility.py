"""Keep HubSpot in step with Atlas: write each Atlas contact's eligibility to a HubSpot contact property, so a HubSpot segment that filters on it is exactly Atlas's Eligible list.
Property `atlas_contact_eligibility` (Atlas eligibility): Main / Other / Not eligible. It is written for every contact Atlas has linked to HubSpot, only where it differs, so a daily run is small.
Atlas decides it from public.contact_status (the same rules as the Contacts tab, standard view); HubSpot only reads it.
Two more properties say why: `atlas_status` (Eligible / Suppressed / Held back) and `atlas_reason` (the main reason in plain words), so a segment can include or leave out a group, for example shared mailboxes, by filtering on it."""
import os
import sys
import time
from datetime import datetime, timezone

from .common import Rest
from .hubspot_sync import Hub, chunks, read_objects

PROP = "atlas_contact_eligibility"
OPTIONS = [("main", "Main"), ("other", "Other"), ("none", "Not eligible")]
STATUS = "atlas_status"
STATUS_OPTIONS = [("eligible", "Eligible"), ("suppressed", "Suppressed"), ("held", "Held back")]
REASON = "atlas_reason"
SUPPRESSED_REASONS = [("optout", "Unsubscribed from all email"), ("mkt_optout", "Opted out of marketing information"), ("not_subscribed", "Not subscribed to marketing information"), ("bounced", "Bounced email"), ("neverbounce", "Failed NeverBounce"),
                      ("disqualified", "Disqualified lead"), ("closed_lost", "Closed lost deal"), ("customer", "Customer practice"), ("closed", "Practice closed"), ("owner", "Excluded contact owner"),
                      ("sequence", "In a sales sequence"), ("in_audience", "In an Atlas audience"), ("lifecycle", "Lifecycle stage not allowed")]   # most serious first
HELD_REASONS = [("shared_mailbox", "Shared mailbox, not a person"), ("not_this_person", "Address does not clearly belong to this person"), ("partial_match", "Address only partly matches the name"),
                ("no_email", "No usable email"), ("role_off", "Role switched off"), ("import_held", "Held back at import, not a direct address"), ("not_in_atlas", "Not held in Atlas")]
REASON_OPTIONS = SUPPRESSED_REASONS + HELD_REASONS
_SEVERITY = {"eligible": 0, "held": 1, "suppressed": 2}
_ORDER = [v for v, _ in REASON_OPTIONS]


def status_for(status, excluded, reasons):
    """(atlas_status, atlas_reason) for one Atlas row. A suppressed row gives its most serious reason; an excluded row with a suppression reason is Suppressed too; otherwise an excluded row says why the address or role was held back; an eligible row has no reason."""
    if status == "eligible":
        return "eligible", ""
    rs = [r for r, _ in SUPPRESSED_REASONS if r in (reasons or [])]
    if status == "suppressed" or (status == "excluded" and rs):   # a held contact that also has a person-level block is Suppressed
        return "suppressed", rs[0] if rs else (reasons or [""])[0]
    t = (excluded or "").lower()
    if t.startswith("held back at import"):
        return "held", "shared_mailbox" if "shared mailbox" in t else "import_held"
    for key, reason in (("shared mailbox", "shared_mailbox"), ("does not clearly belong", "not_this_person"), ("only partly matches", "partial_match"), ("no usable email", "no_email"), ("role switched off", "role_off")):
        if key in t:
            return "held", reason
    return "held", "no_email"


def merge_status(old, new):
    """A HubSpot contact shared by several Atlas rows shows its worst row: Suppressed, then Held back, then Eligible; ties go to the more serious reason."""
    if old is None:
        return new
    ko = (_SEVERITY[old[0]], -_ORDER.index(old[1]) if old[1] in _ORDER else -99)
    kn = (_SEVERITY[new[0]], -_ORDER.index(new[1]) if new[1] in _ORDER else -99)
    return new if kn > ko else old


def value_for(status, section):
    """The property value for one contact from its Atlas status and section."""
    if status == "eligible" and section in ("main", "other"):
        return section
    return "none"


def merge_values(old, new):
    """Two Atlas rows can point at one HubSpot contact (a duplicate). The contact is only as eligible as its least eligible row: "Not eligible" wins, then Other, then Main, so the result never depends on row order."""
    if old is None:
        return new
    rank = {"none": 0, "other": 1, "main": 2}
    return old if rank[old] <= rank[new] else new


def desired(rest):
    """{hubspot contact id: value} for every Atlas contact linked to HubSpot."""
    contacts = rest.select_all("contacts", "contact_urn,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})
    status = {s["contact_urn"]: s for s in rest.select_all("contact_status", "contact_urn,status,section", order="contact_urn")}
    out = {}
    for c in contacts:
        hid = str(c.get("hubspot_contact_id") or "").strip()
        if not hid:
            continue
        s = status.get(c["contact_urn"]) or {}
        out[hid] = merge_values(out.get(hid), value_for(s.get("status"), s.get("section")))
    return out


def desired_status(rest):
    """{hubspot contact id: (atlas_status, atlas_reason)} for every Atlas contact linked to HubSpot."""
    contacts = rest.select_all("contacts", "contact_urn,hubspot_contact_id", order="contact_urn", params={"hubspot_contact_id": "not.is.null"})
    status = {s["contact_urn"]: s for s in rest.select_all("contact_status", "contact_urn,status,excluded,reasons", order="contact_urn")}
    out = {}
    for c in contacts:
        hid = str(c.get("hubspot_contact_id") or "").strip()
        if not hid:
            continue
        s = status.get(c["contact_urn"]) or {}
        out[hid] = merge_status(out.get(hid), status_for(s.get("status"), s.get("excluded"), s.get("reasons")))
    return out


def ensure_property(hub):
    """Create the HubSpot property if it is not there yet (needs the contact property write scope). Returns 'exists' or 'created'."""
    try:
        hub.call("GET", f"/crm/v3/properties/contacts/{PROP}")
        return "exists"
    except RuntimeError as e:
        if "404" not in str(e):
            raise
    hub.call("POST", "/crm/v3/properties/contacts", json={"name": PROP, "label": "Atlas eligibility", "groupName": "contactinformation", "type": "enumeration", "fieldType": "select",
             "description": "Set by Lalu Atlas each day: Main or Other when the contact is eligible for campaigns under Atlas's rules, otherwise Not eligible. Do not edit by hand.",
             "options": [{"label": label, "value": value, "displayOrder": i, "hidden": False} for i, (value, label) in enumerate(OPTIONS)]})
    return "created"


def ensure_extra_properties(hub):
    """Create atlas_status and atlas_reason if they are not there yet. Returns {name: 'exists' | 'created'}."""
    out = {}
    for name, label, options, desc in ((STATUS, "Atlas status", STATUS_OPTIONS, "Set by Lalu Atlas each day: Eligible, Suppressed (a person-level block such as an opt-out) or Held back (not a person's own address, or a role switched off). Do not edit by hand."),
                                       (REASON, "Atlas reason", REASON_OPTIONS, "Set by Lalu Atlas each day: the main reason a contact is Suppressed or Held back. Blank when Eligible. Do not edit by hand.")):
        try:
            cur = hub.call("GET", f"/crm/v3/properties/contacts/{name}")
            have = {o.get("value") for o in cur.get("options", [])}
            missing = [(v, lb) for v, lb in options if v not in have]
            if missing and cur.get("options") is not None:   # a reason added since the property was made
                hub.call("PATCH", f"/crm/v3/properties/contacts/{name}", json={"options": cur["options"] + [{"label": lb, "value": v, "displayOrder": len(have) + k, "hidden": False} for k, (v, lb) in enumerate(missing)]})
                out[name] = "options added: " + ", ".join(v for v, _ in missing)
            else:
                out[name] = "exists"
            continue
        except RuntimeError as e:
            if "404" not in str(e):
                raise
        hub.call("POST", "/crm/v3/properties/contacts", json={"name": name, "label": label, "groupName": "contactinformation", "type": "enumeration", "fieldType": "select", "description": desc,
                 "options": [{"label": lb, "value": v, "displayOrder": i, "hidden": False} for i, (v, lb) in enumerate(options)]})
        out[name] = "created"
    return out


def fill_unlinked(hub, skip, apply=True, budget_seconds=1500, now=time.monotonic):
    """HubSpot contacts Atlas does not hold have no eligibility at all, so HubSpot shows them as Unassigned. Atlas cannot vouch for them, so they get "Not eligible"; if Atlas later holds one, the next
    run above sets its real value. Works through the blank ones in id order, 100 a call, and stops after budget_seconds (the rest go on the next run). Returns (blank found, written)."""
    seen = written = 0
    last, started = "0", now()
    while now() - started < budget_seconds:
        d = hub.call("POST", "/crm/v3/objects/contacts/search", json={"limit": 100, "properties": [PROP, STATUS], "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
                     "filterGroups": [{"filters": [{"propertyName": STATUS, "operator": "NOT_HAS_PROPERTY"}, {"propertyName": "hs_object_id", "operator": "GT", "value": last}]}]})
        page = d.get("results", [])
        if not page:
            break
        last = str(page[-1]["id"])
        ids = [str(r["id"]) for r in page if str(r["id"]) not in skip]
        seen += len(ids)
        if apply and ids:
            hub.call("POST", "/crm/v3/objects/contacts/batch/update", json={"inputs": [{"id": i, "properties": {PROP: "none", STATUS: "held", REASON: "not_in_atlas"}} for i in ids]})
            written += len(ids)
    return seen, written


def run(rest, hub, apply=True):
    prop = ensure_property(hub)
    extra = ensure_extra_properties(hub)
    want = desired(rest)
    why = desired_status(rest)
    props = [PROP, STATUS, REASON]
    have = read_objects(hub, "contacts", list(want), props)
    todo = []
    for i, v in want.items():
        target = {PROP: v, STATUS: why.get(i, ("held", "not_in_atlas"))[0], REASON: why.get(i, ("held", "not_in_atlas"))[1]}
        cur = have.get(i, {})
        diff = {k: t for k, t in target.items() if (cur.get(k) or "") != t}
        if diff:
            todo.append((i, diff))
    written = 0
    if apply:
        for ch in chunks(todo, 100):
            hub.call("POST", "/crm/v3/objects/contacts/batch/update", json={"inputs": [{"id": i, "properties": d} for i, d in ch]})
            written += len(ch)
    counts = {v: sum(1 for x in want.values() if x == v) for v, _ in OPTIONS}
    by_status = {v: sum(1 for x in why.values() if x[0] == v) for v, _ in STATUS_OPTIONS}
    by_reason = {}
    for st, r in why.values():
        if r:
            by_reason[r] = by_reason.get(r, 0) + 1
    blank, filled = fill_unlinked(hub, set(want), apply)
    return {"property": prop, "extra_properties": extra, "linked_contacts": len(want), "now_in_hubspot": counts, "status": by_status, "reasons": by_reason, "to_update": len(todo), "written": written,
            "not_in_atlas_blank": blank, "not_in_atlas_set_to_not_eligible": filled}


def save_owners(rest, hub):
    """HubSpot owner names by id (people who left included), kept in app_flags.hubspot_owners so Atlas Settings can show names instead of ids."""
    names = {}
    for archived in ("false", "true"):
        after = None
        while True:
            d = hub.call("GET", "/crm/v3/owners", params={"limit": 100, "archived": archived, **({"after": after} if after else {})})
            for o in d.get("results", []):
                names[str(o["id"])] = (f"{o.get('firstName') or ''} {o.get('lastName') or ''}".strip() or o.get("email") or str(o["id"])) + (" (left)" if archived == "true" else "")
            after = ((d.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                break
    rest.upsert("app_flags", [{"key": "hubspot_owners", "value": names, "updated_at": datetime.now(timezone.utc).isoformat()}], "key")
    return len(names)


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    rest, hub = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"])
    try:
        print("Owner names saved:", save_owners(rest, hub))
    except Exception as e:  # noqa: BLE001  names are a convenience; eligibility must still run
        print(f"Owner names not saved: {e}", file=sys.stderr)
    print("Eligibility:", run(rest, hub, apply=env.get("APPLY", "1") != "0"))


if __name__ == "__main__":
    main()
