"""Keep HubSpot in step with Atlas: write each Atlas contact's eligibility to a HubSpot contact property, so a HubSpot segment that filters on it is exactly Atlas's Eligible list.
Property `atlas_contact_eligibility` (Atlas eligibility): Main / Other / Not eligible. It is written for every contact Atlas has linked to HubSpot, only where it differs, so a daily run is small.
Atlas decides it from public.contact_status (the same rules as the Contacts tab, standard view); HubSpot only reads it."""
import os
import sys

from .common import Rest
from .hubspot_sync import Hub, chunks, read_objects

PROP = "atlas_contact_eligibility"
OPTIONS = [("main", "Main"), ("other", "Other"), ("none", "Not eligible")]


def value_for(status, section):
    """The property value for one contact from its Atlas status and section."""
    if status == "eligible" and section in ("main", "other"):
        return section
    return "none"


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
        out[hid] = value_for(s.get("status"), s.get("section"))
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


def run(rest, hub, apply=True):
    prop = ensure_property(hub)
    want = desired(rest)
    have = {i: (p.get(PROP) or "") for i, p in read_objects(hub, "contacts", list(want), [PROP]).items()}
    todo = [(i, v) for i, v in want.items() if have.get(i, "") != v]
    written = 0
    if apply:
        for ch in chunks(todo, 100):
            hub.call("POST", "/crm/v3/objects/contacts/batch/update", json={"inputs": [{"id": i, "properties": {PROP: v}} for i, v in ch]})
            written += len(ch)
    counts = {v: sum(1 for x in want.values() if x == v) for v, _ in OPTIONS}
    return {"property": prop, "linked_contacts": len(want), "now_in_hubspot": counts, "to_update": len(todo), "written": written}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("Eligibility:", run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"]), apply=env.get("APPLY", "1") != "0"))


if __name__ == "__main__":
    main()
