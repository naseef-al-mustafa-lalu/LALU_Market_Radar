"""HubSpot segments (lists) of contacts, kept in Atlas: every list's name, type, size and a readable summary of its filters; the members of the ones Atlas tracks. Tracked segments carry editable
criteria (lifecycle stages, NeverBounce statuses, job roles). The two campaign segments start tracked: UM | Campaign List Template (dynamic) and ICP | Nov-Jan Sprint (static)."""
from datetime import datetime, timezone

DEFAULT_TRACKED = {"2675", "4584"}
CRITERIA_PROPS = {"lifecyclestage": "lifecycle", "neverbounce_status": "neverbounce", "job_role_standardised": "roles"}


def fetch_lists(hub):
    out, offset = [], 0
    while True:
        d = hub.call("POST", "/crm/v3/lists/search", json={"query": "", "count": 100, "offset": offset, "additionalProperties": ["hs_list_size", "hs_last_record_added_at"]})
        out += [x for x in d.get("lists", []) if str(x.get("objectTypeId")) == "0-1"]
        if not d.get("hasMore"):
            return out
        offset = d.get("offset", offset + 100)


def walk(branch):
    """Every property filter in a HubSpot filter branch, as (property, operator, values)."""
    found = []
    for f in (branch or {}).get("filters", []):
        if f.get("filterType") == "PROPERTY":
            op = f.get("operation") or {}
            vals = op.get("values") if op.get("values") is not None else ([op["value"]] if op.get("value") is not None else [])
            found.append((f.get("property"), op.get("operator") or op.get("operationType"), [str(v) for v in vals]))
        else:
            found.append((f.get("filterType", "filter").lower(), f.get("listId") and "list " + str(f["listId"]) or "", []))
    for b in (branch or {}).get("filterBranches", []):
        found += walk(b)
    return found


def summarize(branch):
    """(text, criteria) from a filter branch: the criteria Atlas lets you edit, and a readable line per filter."""
    crit, lines = {}, []
    for prop, op, vals in walk(branch):
        lines.append(f"{prop} {op} {', '.join(vals)}".strip())
        if prop in CRITERIA_PROPS and vals:
            crit.setdefault(CRITERIA_PROPS[prop], vals)
    return "; ".join(lines), crit


def members(hub, list_id):
    out, after = [], None
    while True:
        d = hub.call("GET", f"/crm/v3/lists/{list_id}/memberships", params={"limit": 250, **({"after": after} if after else {})})
        out += [str(r["recordId"]) for r in d.get("results", [])]
        after = (d.get("paging") or {}).get("next", {}).get("after")
        if not after:
            return out


def sync(rest, hub):
    """Refresh every contact list's row and the member ids of tracked lists. Returns counts."""
    have = {r["list_id"]: r for r in rest.select_all("hubspot_segments", "list_id,tracked,criteria", order="list_id")}
    lists, rows, tracked_ids = fetch_lists(hub), [], []
    for x in lists:
        lid, props = str(x["listId"]), x.get("additionalProperties") or {}
        old = have.get(lid)
        tracked = bool(old["tracked"]) if old else lid in DEFAULT_TRACKED
        row = {"list_id": lid, "name": x.get("name") or lid, "processing_type": x.get("processingType"), "size": int(float(props.get("hs_list_size") or 0)), "tracked": tracked,
               "synced_at": datetime.now(timezone.utc).isoformat(), "filter_text": (old or {}).get("filter_text"), "filters": None, "criteria": (old or {}).get("criteria")}
        if tracked or not old:
            try:
                branch = (hub.call("GET", f"/crm/v3/lists/{lid}", params={"includeFilters": "true"}).get("list") or {}).get("filterBranch")
                text, crit = summarize(branch)
                row.update(filter_text=text, filters=branch)
                if crit and not row["criteria"]:
                    row["criteria"] = crit
            except Exception:  # noqa: BLE001  a list whose filters cannot be read still appears
                pass
        rows.append(row)
        if tracked:
            tracked_ids.append(lid)
    keys = ["list_id", "name", "processing_type", "size", "tracked", "synced_at", "filter_text", "filters", "criteria"]
    rest.upsert("hubspot_segments", [{k: r.get(k) for k in keys} for r in rows], "list_id")
    n_members = 0
    for lid in tracked_ids:
        ids = set(members(hub, lid))
        cur = {r["contact_id"] for r in rest.select_all("hubspot_segment_members", "contact_id", order="contact_id", params={"list_id": f"eq.{lid}"})}
        if ids - cur:
            rest.upsert("hubspot_segment_members", [{"list_id": lid, "contact_id": c} for c in sorted(ids - cur)], "list_id,contact_id")
        if cur - ids:
            rest.delete_in("hubspot_segment_members", "contact_id", sorted(cur - ids), extra={"list_id": f"eq.{lid}"})
        n_members += len(ids)
    return {"segments": len(rows), "segments_tracked": len(tracked_ids), "segment_members": n_members}
