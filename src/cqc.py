"""CQC public API: registration status, overall rating and inspection dates for GP practices, matched by ODS code.

The API cannot filter by ODS code or service type, so the first run (spread over as many days as needed) lists all
locations, keeps those whose postcode matches a practice, and confirms by ODS code. After that, the daily changes feed
tells us which locations changed and only those are fetched.
"""
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import requests

from .common import norm_ods

BASE = "https://api.service.cqc.org.uk/public/v1"
FIELDS = ["cqc_location_id", "cqc_provider_id", "cqc_status", "cqc_rating", "cqc_last_inspection", "cqc_manager_absent_date", "cqc_brand_name", "address", "town", "county"]
GROUP_FIELDS = ["group_name", "group_size"]
PROVIDER_NAME_CAP = 300
BACKFILL_BUDGET_SECONDS = 25 * 60


def make_client(key):
    s = requests.Session()
    s.headers.update({"Ocp-Apim-Subscription-Key": key, "User-Agent": "LaluMarketRadar/1.0", "Accept": "application/json"})

    def getj(path, params=None):
        for attempt in range(6):
            r = s.get(BASE + path, params=params, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, float(r.headers.get("Retry-After", 2 * (attempt + 1)))))
                continue
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"CQC API kept failing for {path}")
    return getj


def norm_postcode(pc):
    return re.sub(r"\s+", "", str(pc or "")).upper()


def _date(v):
    return str(v)[:10] if v else None


def summarise(detail):
    overall = (detail.get("currentRatings") or {}).get("overall") or {}
    return {"cqc_location_id": detail.get("locationId"), "cqc_provider_id": detail.get("providerId"),
            "cqc_status": detail.get("registrationStatus"), "cqc_rating": overall.get("rating"),
            "cqc_last_inspection": _date((detail.get("lastInspection") or {}).get("date")),
            "cqc_manager_absent_date": _date(detail.get("registeredManagerAbsentDate")),
            "cqc_brand_name": (detail.get("brandName") or "").removeprefix("BRAND ").strip() or None,
            "address": ", ".join(x.strip() for x in (detail.get("postalAddressLine1"), detail.get("postalAddressLine2")) if x and x.strip()) or None,
            "town": (detail.get("postalAddressTownCity") or "").strip() or None, "county": (detail.get("postalAddressCounty") or "").strip() or None}


def paged(getj, path, key, params=None, per_page=1000):
    page = 1
    while True:
        data = getj(path, {**(params or {}), "page": page, "perPage": per_page}) or {}
        yield from data.get(key, [])
        if page >= int(data.get("totalPages") or 0):
            return
        page += 1


def candidate_ids(getj, postcodes):
    return sorted({loc["locationId"] for loc in paged(getj, "/locations", "locations")
                   if norm_postcode(loc.get("postalCode")) in postcodes})


def changed_ids(getj, since, until):
    stamp = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    return sorted(set(paged(getj, "/changes/location", "changes", {"startTimestamp": stamp(since), "endTimestamp": stamp(until)})))


def fetch_details(getj, ids, workers=8):
    with ThreadPoolExecutor(workers) as ex:
        return [d for d in ex.map(lambda i: getj(f"/locations/{i}"), ids) if d]


def match(details, codes):
    """{ods: summary} for details whose ODS code is one of ours; a Registered location beats a Deregistered one."""
    out = {}
    for d in details:
        ods = norm_ods(d.get("odsCode"))
        if ods in codes:
            s = summarise(d)
            if ods not in out or (out[ods]["cqc_status"] != "Registered" and s["cqc_status"] == "Registered"):
                out[ods] = s
    return out


def _kv_get(rest, key, default=None):
    rows = rest.select_all("kv_state", "key,value", order="key", params={"key": f"eq.{key}"})
    return rows[0]["value"] if rows else default


def _kv_set(rest, key, value):
    rest.upsert("kv_state", [{"key": key, "value": value}], "key")


def sync(rest, practices, getj, now, budget=BACKFILL_BUDGET_SECONDS):
    """Returns (rows to upsert into gp_practices, stats). `practices` is {ods: practice row}."""
    codes, stats, found = set(practices), {}, {}
    started = time.monotonic()
    if _kv_get(rest, "cqc_last_sync") is None:
        _kv_set(rest, "cqc_last_sync", now.isoformat())  # the changes feed covers everything after this moment
    if not _kv_get(rest, "cqc_backfill_complete", False):
        postcodes = {norm_postcode(p.get("postcode")) for p in practices.values() if p.get("postcode")}
        cands = candidate_ids(getj, postcodes)
        done = set(_kv_get(rest, "cqc_backfill_done", []))
        todo = [i for i in cands if i not in done]
        for i in range(0, len(todo), 200):
            if time.monotonic() - started > budget:
                break
            chunk = todo[i:i + 200]
            found.update(match(fetch_details(getj, chunk), codes))
            done.update(chunk)
        _kv_set(rest, "cqc_backfill_done", sorted(done))
        complete = all(i in done for i in cands)
        _kv_set(rest, "cqc_backfill_complete", complete)
        stats.update(cqc_mode="backfill", cqc_candidates=len(cands), cqc_done=len(done), cqc_backfill_complete=complete)
    else:
        from datetime import datetime
        since = datetime.fromisoformat(_kv_get(rest, "cqc_last_sync"))
        ids = changed_ids(getj, since - timedelta(minutes=5), now)
        found.update(match(fetch_details(getj, ids), codes))
        _kv_set(rest, "cqc_last_sync", now.isoformat())
        stats.update(cqc_mode="changes", cqc_changed_locations=len(ids))
    return build_rows(rest, practices, found, getj, now, stats)


def group_assignments(view, names):
    """{ods: (group_name, group_size)}: a group is a CQC provider running 2+ of our active practices."""
    members = {}
    for ods, p in view.items():
        if p.get("status", "Active") == "Active" and p.get("cqc_provider_id"):
            members.setdefault(p["cqc_provider_id"], []).append(ods)
    out = {}
    for pid, codes in members.items():
        for c in codes:
            out[c] = (names.get(pid), len(codes)) if len(codes) >= 2 else (None, None)
    return out, {pid: codes for pid, codes in members.items() if len(codes) >= 2}


def build_rows(rest, practices, found, getj, now, stats):
    view = {c: {**p, **found.get(c, {})} for c, p in practices.items()}
    names = _kv_get(rest, "cqc_provider_names", {}) or {}
    _, groups = group_assignments(view, names)
    # a practice that changed operator needs both operators' names so the signal can say who took over from whom
    switched = {c: (practices[c].get("cqc_provider_id"), v["cqc_provider_id"]) for c, v in found.items()
                if practices[c].get("cqc_provider_id") and v.get("cqc_provider_id") and practices[c]["cqc_provider_id"] != v["cqc_provider_id"]}
    need = list(dict.fromkeys([pid for pair in switched.values() for pid in pair if pid not in names] + [pid for pid in groups if pid not in names]))[:PROVIDER_NAME_CAP]
    for pid in need:
        d = getj(f"/providers/{pid}") or {}
        names[pid] = d.get("name") or d.get("providerName") or ""
    if need:
        _kv_set(rest, "cqc_provider_names", names)
    assigned, groups = group_assignments(view, names)
    rows = []
    for ods, old in practices.items():
        new = {**{k: old.get(k) for k in FIELDS}, **found.get(ods, {})}
        for k in ("address", "town", "county"):  # CQC fills gaps only: never replace an address we already hold (Oscar, devolved loads)
            new[k] = old.get(k) or new.get(k)
        grp = dict(zip(GROUP_FIELDS, assigned.get(ods, (None, None))))
        if grp["group_name"] == "":
            grp["group_name"] = None
        moved = switched.get(ods)
        pname = names.get(new.get("cqc_provider_id")) or old.get("cqc_provider_name")
        prev = (names.get(moved[0]) or None) if moved else old.get("cqc_prev_provider_name")
        extra = {"cqc_provider_name": pname or None, "cqc_prev_provider_name": prev or None}
        changed = any(new[k] != old.get(k) for k in FIELDS) or any(grp[k] != old.get(k) for k in GROUP_FIELDS) or any(extra[k] != old.get(k) for k in extra)
        if changed:  # every row carries the same keys so the bulk upsert never blanks a column
            rows.append({"ods_code": ods, "practice_name": old["practice_name"], **new, **grp, **extra,
                         "cqc_checked_at": now.isoformat() if ods in found else old.get("cqc_checked_at")})
    stats.update(cqc_matched=len(found), cqc_updated=len(rows), cqc_groups=len(groups), cqc_provider_names_fetched=len(need))
    return rows, stats
