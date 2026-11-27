"""Keep First Touch Source Detail 2 (um_source_detail_2) saying "Lalu Atlas Import: <date>" on every contact Atlas created in HubSpot, whatever its source.
Atlas writes that label at creation, but HubSpot's own source workflow blanks it on the Oscar contacts shortly afterwards, so this fills it back in. Only a blank value is ever filled: a contact that already carries its
own first-touch detail keeps it. Dry run unless APPLY=1; prints counts only (no names or addresses)."""
import json
import os
import sys

from .common import Rest
from .hubspot_sync import Hub, chunks, read_objects

LABEL = "Lalu Atlas Import"


def label(day):
    return f"{LABEL}: {day}"


def created_by_atlas(rest):
    """{hubspot contact id: 'YYYY-MM-DD'} for contacts Atlas created in HubSpot: Oscar and Apollo contacts that went through NeverBounce and the push, and contacts added from a practice or network profile."""
    out = {}
    checked = {r["contact_urn"] for r in rest.select_all("contact_nb", "contact_urn,nb_state", order="contact_urn", params={"nb_state": "eq.checked"})}
    for r in rest.select_all("contacts", "contact_urn,hubspot_contact_id,hubspot_imported_at,source", order="contact_urn", params={"hubspot_contact_id": "not.is.null"}):
        if (r.get("source") or "oscar") in ("oscar", "apollo") and r["contact_urn"] in checked and r.get("hubspot_imported_at"):
            out[str(r["hubspot_contact_id"])] = str(r["hubspot_imported_at"])[:10]
    try:
        for r in rest.select_all("hubspot_activity", "kind,detail,at", order="id", params={"kind": "eq.add_contacts"}):
            d = r.get("detail") or {}
            for c in (d.get("contacts") or d.get("done") or []):
                if c.get("id") and c.get("existed") is False:
                    out.setdefault(str(c["id"]), str(r.get("at") or "")[:10] or None)
    except Exception:  # noqa: BLE001
        pass
    return out


def plan(created, current):
    """(to fill, already labelled, left alone because it holds its own value). `current` is {hubspot id: um_source_detail_2}."""
    fill, have, other = {}, 0, 0
    for hid, day in created.items():
        v = str(current.get(hid) or "").strip()
        if not v:
            fill[hid] = label(day) if day else LABEL
        elif v.startswith(LABEL):
            have += 1
        else:
            other += 1
    return fill, have, other


def run(rest, hub, apply=False):
    created = created_by_atlas(rest)
    props = read_objects(hub, "contacts", list(created), ["um_source_detail_2"])
    fill, have, other = plan(created, {h: (p or {}).get("um_source_detail_2") for h, p in props.items()})
    written = 0
    if apply:
        for ch in chunks(sorted(fill.items()), 100):
            hub.call("POST", "/crm/v3/objects/contacts/batch/update", json={"inputs": [{"id": h, "properties": {"um_source_detail_2": v}} for h, v in ch]})
            written += len(ch)
    return {"atlas_created": len(created), "already_labelled": have, "own_value_left_alone": other, "to_fill": len(fill), "filled": written, "apply": apply, "not_read": len(created) - len(props)}


def main():
    env = os.environ
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HUBSPOT_TOKEN"):
        if not env.get(k):
            print(f"{k} is not set", file=sys.stderr)
            sys.exit(2)
    print("RESULT " + json.dumps(run(Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]), Hub(env["HUBSPOT_TOKEN"]), apply=env.get("APPLY", "0") == "1"), default=str))


if __name__ == "__main__":
    main()
