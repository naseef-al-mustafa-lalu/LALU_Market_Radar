"""Daily ingestion: NHS public data + Oscar contacts -> Supabase (diffed, batched, guarded)."""
import os
import sys
import traceback
from datetime import date, datetime, timedelta, timezone

from . import branches, cqc, jobs, maintenance, oscar, software, sources
from .common import Rest, need_env, send_alert, title_case

TRACKED = ["practice_name", "postcode", "website", "pcn_code", "pcn_name", "icb_name", "total_patients",
           "status", "clinical_software", "software_source", "manager_name", "manager_title", "manager_email",
           "manager_phone", "manager_email_opt_out", "data_month"] + oscar.ORG_KEYS
CONTACT_FIELDS = ["ods_code", "full_name", "job_title", "seniority", "email", "phone", "email_opt_out", "is_primary",
                  "org_urn", "title", "first_name", "last_name", "quals", "dept", "categories", "data_types", "main_site"]
SOFTWARE_DAILY_CAP = 400
SOFTWARE_RECHECK = timedelta(days=90)
DATES_DAILY_CAP = 2500
DATES_RECHECK = timedelta(days=180)
BRANCH_DAILY_CAP = 2000
BRANCH_RECHECK = timedelta(days=90)
BRANCH_MIN = 1000   # ODS holds ~2,500 active branches; a far smaller list means the API misbehaved
BRANCH_COLS = ["branch_code", "branch_name", "address", "town", "county", "postcode", "phone", "opened", "status", "parent_code", "parent_name", "parent_role", "parent_role_name", "kind", "practice_code", "resolution", "matched_branch_code", "match_status", "match_note", "checked_at"]


def build_records(ods, patients, month, existing, pcn_map, oscar_info, check_software, pcn_checked=frozenset(), dates=None):
    """Merge sources into upsert rows (only rows that changed). Pure function: no I/O except software checks."""
    now = datetime.now(timezone.utc)
    recs = {}
    for code, o in ods.items():
        old = existing.get(code)
        if o["status"] == "Closed" and not old:
            continue  # never load historic closures
        r = dict(old) if old else {"pcn_code": None, "pcn_name": "Unallocated PCN", "icb_name": "Unallocated ICB",
                                   "clinical_software": "Unknown", "software_source": None,
                                   "software_checked_at": None, "website": None, "total_patients": 0,
                                   "manager_name": None, "manager_title": None, "manager_email": None,
                                   "manager_phone": None, "manager_email_opt_out": False,
                                   **dict.fromkeys(oscar.ORG_KEYS), "main_email_opt_out": False}
        r.update(ods_code=code, practice_name=title_case(o["name"]), postcode=o["postcode"] or r.get("postcode"),
                 status=o["status"], data_month=month if code in patients else r.get("data_month"))
        if dates and code in dates:
            r["operational_start_date"], r["operational_end_date"], r["ods_dates_checked_at"] = dates[code][0], dates[code][1], now.isoformat()
        if o["status"] == "Active" and code in patients:
            r["total_patients"] = patients[code]
        pcn_icb = None
        if code in pcn_checked:
            r["pcn_checked_at"] = now.isoformat()
            r["pcn_code"], r["pcn_name"] = pcn_map[code][:2] if code in pcn_map else (None, "Unallocated PCN")
            pcn_icb = pcn_map[code][2] if code in pcn_map else None
        elif code in pcn_map:
            r["pcn_code"], r["pcn_name"], pcn_icb = pcn_map[code]
        if old and old.get("network_locked"):  # cluster / health board came from a manual upload: ODS must not overwrite it
            r["pcn_code"], r["pcn_name"], r["icb_name"] = old["pcn_code"], old["pcn_name"], old["icb_name"]
            pcn_icb = None
        if oscar_info is not None:
            info = oscar_info.get(code)
            p = info["primary"] if info else None
            r.update(manager_name=p["full_name"] if p else None, manager_title=p["job_title"] if p else None,
                     manager_email=p["email"] if p else None, manager_phone=p["phone"] if p else None,
                     manager_email_opt_out=bool(p and p["email_opt_out"]))
            if info:
                for k, v in info["org"].items():
                    if v not in (None, ""):
                        r[k] = v
                r["website"] = info["website"] or r.get("website")
                if not r.get("pcn_code") and not r.get("network_locked"):  # practices in a PCN keep the ODS-derived ICB name
                    r["icb_name"] = info["icb"] or r["icb_name"]
        if pcn_icb:  # ODS-derived ICB names are consistent across practices, so they win over Oscar's wording
            r["icb_name"] = pcn_icb
        recs[code] = r

    # software hint: only unknown, active, has website, not checked recently; capped per run
    due = []
    for code, r in recs.items():
        url = software.normalise_url(r.get("website"))
        checked = r.get("software_checked_at")
        stale = not checked or datetime.fromisoformat(checked.replace("Z", "+00:00")) < now - SOFTWARE_RECHECK
        if url and r["status"] == "Active" and r["clinical_software"] == "Unknown" and stale:
            due.append((code, url))
    due = due[:SOFTWARE_DAILY_CAP]
    if due and check_software:
        for code, result in check_software(dict(due)).items():
            recs[code]["software_checked_at"] = now.isoformat()
            if result != "Unknown":
                recs[code]["clinical_software"], recs[code]["software_source"] = result, "website-hint"

    changed = []
    for code, r in recs.items():
        old = existing.get(code)
        if not old or any(r.get(k) != old.get(k) for k in TRACKED) or r.get("software_checked_at") != old.get("software_checked_at") or r.get("pcn_checked_at") != old.get("pcn_checked_at") or r.get("ods_dates_checked_at") != old.get("ods_dates_checked_at"):
            changed.append({k: v for k, v in r.items() if k not in ("lead_status", "first_seen", "last_updated", "sales_segment", "price_tier", "base_price", "est_arr")})
    return changed, len(due)


PCN_REFRESH = timedelta(days=30)
PCN_DAILY_CAP = 600


def pcn_due(active_codes, existing, now):
    """Practices whose PCN we have never looked up (all of them, first run) or last checked > 30 days ago (capped)."""
    never, stale = [], []
    for c in sorted(active_codes):
        if (existing.get(c) or {}).get("network_locked"):
            continue
        checked = (existing.get(c) or {}).get("pcn_checked_at")
        if not checked:
            never.append(c)
        elif datetime.fromisoformat(checked.replace("Z", "+00:00")) < now - PCN_REFRESH:
            stale.append(c)
    return never + stale[:PCN_DAILY_CAP]


def mass_change_guard(env, closing):
    if closing > 50 and env.get("ALLOW_MASS_CHANGE") != "1":
        raise RuntimeError(f"{closing} practices closing in one run looks like a feed error; set ALLOW_MASS_CHANGE=1 to override")


def plan_closures(active, existing, env, stats):
    """ODS view of every practice: the active list plus England rows that dropped off it (Scotland / Wales rows come from uploads, not ODS)."""
    ods = {c: {"name": v["name"], "postcode": v["postcode"], "status": "Active"} for c, v in active.items()}
    closed = [c for c, r in existing.items() if r["status"] == "Active" and c not in active and (r.get("country") or "England") == "England"]
    for c in closed:
        ods[c] = {"name": existing[c]["practice_name"], "postcode": existing[c].get("postcode"), "status": "Closed"}
    stats.update(ods_active=len(active), closures=len(closed))
    mass_change_guard(env, len(closed))
    return ods


def read_patient_counts(rest, now, stats):
    """Counts are loaded monthly (dashboard upload or the office-PC runner) and read from Supabase."""
    counts = rest.select_all("patient_counts", "ods_code,patients,data_month", order="ods_code")
    patients = {r["ods_code"]: r["patients"] for r in counts}
    month = max((r["data_month"] for r in counts if r["data_month"]), default=None)
    stats.update(patients_rows=len(patients), data_month=month)
    if not patients:
        stats["patients_missing"] = True
    elif month and (now.date() - date.fromisoformat(month + "-01")).days > 75:
        stats["patients_stale"] = month
    return patients, month


def pcn_step(active, existing, now, stats):
    try:
        pcn_names = sources.load_pcn_names(sources.fetch(sources.ODS_EXPORT + "epcn"))
        looked_up = sources.fetch_pcn_codes(pcn_due(active, existing, now))
        pcn_map = {}
        for c, pcn in looked_up.items():
            if pcn:
                name, icb = pcn_names.get(pcn, (pcn, ""))
                pcn_map[c] = (pcn, title_case(name), title_case(icb))
        stats.update(pcn_lookups=len(looked_up), pcn_mapped=len(pcn_map))
        return pcn_map, frozenset(looked_up)
    except Exception as e:  # noqa: BLE001  PCN is enrichment, not critical
        stats["pcn_error"] = str(e)[:200]
        return {}, frozenset()


def dates_due(ods, existing, now):
    """Practices whose ODS operational dates are missing for a closed one, never fetched, or older than DATES_RECHECK (capped per run)."""
    first, never, stale = [], [], []
    for c in sorted(ods):
        old = existing.get(c) or {}
        checked = old.get("ods_dates_checked_at")
        if old.get("status") == "Closed" and not old.get("operational_end_date"):
            first.append(c)
        elif not checked:
            never.append(c)
        elif datetime.fromisoformat(checked.replace("Z", "+00:00")) < now - DATES_RECHECK:
            stale.append(c)
    return (first + never + stale)[:DATES_DAILY_CAP]


def dates_step(ods, existing, now, stats):
    try:
        dates = sources.fetch_ods_dates(dates_due(ods, existing, now))
        stats["ods_dates_fetched"] = len(dates)
        return dates
    except Exception as e:  # noqa: BLE001  enrichment, not critical
        stats["ods_dates_error"] = str(e)[:200]
        return {}


def branch_kind(parent_code, parent_role, existing):
    return "gp_practice" if parent_code in existing else "gp_not_held" if parent_role == "RO177" else "non_gp"


def branches_due(listing, stored, now):
    """Branches never fetched first, then those last fetched more than BRANCH_RECHECK ago (capped per run)."""
    never = [c for c in sorted(listing) if not (stored.get(c) or {}).get("checked_at")]
    stale = [c for c in sorted(listing) if (stored.get(c) or {}).get("checked_at")
             and datetime.fromisoformat(stored[c]["checked_at"].replace("Z", "+00:00")) < now - BRANCH_RECHECK]
    return (never + stale)[:BRANCH_DAILY_CAP]


def branches_step(rest, existing, ods, now, stats):
    """Branch surgeries (ODS RO96) with their parent. Parents we do not hold as practices are looked up so the branch still says what it belongs to."""
    try:
        held = {**existing, **{c: {"practice_name": title_case(o["name"])} for c, o in ods.items() if c not in existing}}   # today's ODS practices count too, so a brand-new parent is not reported as missing
        listing = sources.load_active_branches()
        if len(listing) < BRANCH_MIN:
            raise ValueError(f"ODS returned only {len(listing)} active branches; skipping")
        stored = {r["branch_code"]: r for r in rest.select_all("practice_branches", ",".join(BRANCH_COLS), order="branch_code")}
        rows = {c: dict(r) for c, r in stored.items()}
        for c, rec in sources.fetch_branch_details(branches_due(listing, stored, now)).items():
            rows[c] = {**{k: None for k in BRANCH_COLS}, **rows.get(c, {}), **rec, "status": "Active", "checked_at": now.isoformat()}
        for c, r in rows.items():
            if c not in listing:
                r["status"] = "Closed"
        missing = {r["parent_code"] for r in rows.values() if r.get("parent_code") and r["parent_code"] not in held and not r.get("parent_name")}
        names = sources.fetch_parent_info(sorted(missing)) if missing else {}
        roles = {}
        try:
            roles = sources.role_names()
        except Exception:  # noqa: BLE001  the role id is stored as-is
            pass
        changed = []
        for c, r in rows.items():
            if r.get("parent_code") in held:
                r["parent_name"] = held[r["parent_code"]]["practice_name"]
            elif r.get("parent_code") in names:
                r["parent_name"] = names[r["parent_code"]]
            r["kind"] = branch_kind(r.get("parent_code"), r.get("parent_role"), held)
        pool = {c: {"name": p["practice_name"], "postcode": p.get("postcode")} for c, p in existing.items() if p.get("status") == "Active" and not p.get("merged_into")}
        pool.update({c: {"name": title_case(o["name"]), "postcode": o.get("postcode")} for c, o in ods.items() if o["status"] == "Active" and c not in pool})
        resolved = branches.resolve(rows, pool, stored)
        for c, r in rows.items():
            r.update(resolved[c])
            r["parent_role_name"] = roles.get(r.get("parent_role"), r.get("parent_role"))
            if c not in stored or any(r.get(k) != stored[c].get(k) for k in BRANCH_COLS):
                changed.append({k: r.get(k) for k in BRANCH_COLS})
        rest.upsert("practice_branches", changed, "branch_code")
        stats.update(branches_active=len(listing), branches_changed=len(changed), branches_not_gp=sum(r["kind"] == "non_gp" for r in rows.values()),
                     branches_parent_not_held=sum(r["kind"] == "gp_not_held" for r in rows.values()), branches_no_parent=sum(not r.get("parent_code") for r in rows.values()),
                     **{f"branches_{k}": sum(r["resolution"] == k for r in rows.values()) for k in branches.RESOLUTIONS}, branches_to_review=sum(r["match_status"] in ("probable", "review") for r in rows.values()))
    except Exception as e:  # noqa: BLE001  enrichment, not critical
        stats["branches_error"] = str(e)[:200]


def oscar_step(env, active, stats, rejects):
    try:
        if not env.get("OSCAR_API_URL"):
            raise ValueError("OSCAR_API_URL not set: running without contact data")
        contacts, oscar_info, o_rejects, suppressed = oscar.parse(sources.fetch(env["OSCAR_API_URL"], timeout=180))
        rejects += o_rejects
        stats.update(oscar_contacts=len(contacts), oscar_practices=len(oscar_info), oscar_suppressed=suppressed)
        if not set(oscar_info) & set(active):
            raise ValueError("Oscar file matched zero NHS practices: wrong file?")
        return contacts, oscar_info
    except Exception as e:  # noqa: BLE001  keep existing contact data if Oscar is unavailable
        stats["oscar_error"] = str(e)[:200]
        return [], None


def merged_view(existing, records):
    """Every practice as it will look after this run's upsert."""
    return {**existing, **{r["ods_code"]: {**existing.get(r["ods_code"], {}), **r} for r in records}}


def cqc_step(rest, env, existing, records, now, stats):
    if not env.get("CQC_API_KEY"):
        return
    try:
        cqc_rows, cstats = cqc.sync(rest, merged_view(existing, records), cqc.make_client(env["CQC_API_KEY"]), now)
        rest.upsert("gp_practices", cqc_rows, "ods_code")
        stats.update(cstats)
    except Exception as e:  # noqa: BLE001  CQC is enrichment: never block the main load
        stats["cqc_error"] = str(e)[:300]


def contacts_step(rest, contacts, existing, records, stats, rejects):
    known = set(existing) | {r["ods_code"] for r in records}
    feed = [c for c in contacts if c["ods_code"] in known]
    rejects += [("oscar", str(c["contact_urn"]), f"practice {c['ods_code']} not in NHS GP list") for c in contacts if c["ods_code"] not in known]
    db = {r["contact_urn"]: r for r in rest.select_all("contacts", order="contact_urn")}
    changed = [c for c in feed if c["contact_urn"] not in db or any(c[k] != db[c["contact_urn"]][k] for k in CONTACT_FIELDS)]
    rest.upsert("contacts", changed, "contact_urn")
    stale = sorted(set(db) - {c["contact_urn"] for c in feed})
    if stale and len(feed) >= 0.5 * len(db):
        rest.delete_in("contacts", "contact_urn", stale)
    elif stale:
        stats["contacts_delete_skipped"] = len(stale)
    stats.update(contacts_changed=len(changed), contacts_removed=len(stale))


JOBS_MIN_INTERVAL = timedelta(hours=18)   # the feed is ~125 requests: never rescan within a day, however often the pipeline is run (JOBS_FORCE=1 overrides)


def jobs_step(rest, env, existing, records, stats):
    try:
        if env.get("NHS_JOBS", "1") == "0":
            raise ValueError("NHS_JOBS=0: jobs scan skipped")
        pause = rest.select_all("kv_state", "key,value", order="key", params={"key": "eq.jobs_pause"})
        if pause and datetime.now(timezone.utc) < datetime.fromisoformat(pause[0]["value"]["until"]):
            stats["jobs_skipped"] = f"paused until {pause[0]['value']['until'][:16]}Z: {pause[0]['value'].get('why', '')}"[:200]
            return
        last = rest.select_all("kv_state", "key,value", order="key", params={"key": "eq.jobs_scan"})
        last_at = datetime.fromisoformat(last[0]["value"]["at"]) if last else None
        if last_at and datetime.now(timezone.utc) - last_at < JOBS_MIN_INTERVAL and env.get("JOBS_FORCE") != "1":
            stats["jobs_skipped"] = f"scanned {last_at.isoformat()[:16]}Z, within {int(JOBS_MIN_INTERVAL.total_seconds() // 3600)}h"
            return
        fallback = jobs.proxy_get(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]) if env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_ROLE_KEY") else None
        stats.update(jobs.sync(rest, list(merged_view(existing, records).values()), fetch=lambda: jobs.fetch_all(fallback=fallback)))
        rest.upsert("kv_state", [{"key": "jobs_scan", "value": {"at": datetime.now(timezone.utc).isoformat(), "via": jobs.SCAN["via"]}}], "key")
    except Exception as e:  # noqa: BLE001  the jobs feed is enrichment: never block the main load
        stats["jobs_error"] = str(e)[:300]
        send_alert("Lalu Atlas: NHS Jobs scan failed", f"{e}\n\nThe scan reads the feed directly, then through the jobs-feed edge function if NHS Jobs blocks GitHub. No job signals are raised until it works.")


def other_uk_step(rest, existing, stats):
    """Northern Ireland (ODS role RO315) and the Isle of Man's practices: added and kept current from ODS. List sizes come from uploads (Data > Data sources)."""
    try:
        ni = sources.load_ni_gp_practices()
        todo = [(c, "Northern Ireland") for c in sorted(ni) if c not in existing] + [(c, "Isle of Man") for c in sources.IOM_CODES if c not in existing]
        rows = []
        for country in ("Northern Ireland", "Isle of Man"):
            rows += list(sources.fetch_other_uk([c for c, k in todo if k == country], country).values())
        for i in range(0, len(rows), 500):
            stats["other_uk_new"] = stats.get("other_uk_new", 0) + rest.rpc("ingest_other_uk", {"p_rows": rows[i:i + 500]}).get("new", 0)
        stats.update(other_uk_ni_active=len(ni), other_uk_pending=len(todo) - len(rows))
    except Exception as e:  # noqa: BLE001  enrichment, not critical
        stats["other_uk_error"] = str(e)[:200]


def graph_step(rest, stats):
    """Housekeeping plus the derived organisation graph. Never fails the run."""
    try:
        stats["junk_rows_removed"] = maintenance.purge_never_loaded_closed(rest)
    except Exception as e:  # noqa: BLE001
        stats["maintenance_error"] = str(e)[:200]
    try:
        stats["graph"] = rest.rpc("refresh_org_graph")
        stats["graph_nodes_pruned"] = maintenance.prune_closed_practice_nodes(rest)
    except Exception as e:  # noqa: BLE001
        stats["graph_error"] = str(e)[:200]


def sync(rest, run_id):
    """One daily load, as named steps. Core steps (ODS, counts, upsert) raise; enrichment steps record an error in stats and carry on."""
    stats, rejects, env, now = {}, [], os.environ, datetime.now(timezone.utc)

    active = sources.load_active_gp_practices()
    existing = {r["ods_code"]: r for r in rest.select_all("gp_practices", order="ods_code")}
    ods = plan_closures(active, existing, env, stats)
    patients, month = read_patient_counts(rest, now, stats)
    pcn_map, pcn_checked = pcn_step(active, existing, now, stats)
    contacts, oscar_info = oscar_step(env, active, stats, rejects)
    dates = dates_step(ods, existing, now, stats)

    records, checked = build_records(ods, patients, month, existing, pcn_map, oscar_info, software.check_many, pcn_checked, dates)
    stats.update(practices_changed=len(records), software_checked=checked)
    rest.upsert("gp_practices", records, "ods_code")

    cqc_step(rest, env, existing, records, now, stats)
    if oscar_info is not None:
        contacts_step(rest, contacts, existing, records, stats, rejects)
    jobs_step(rest, env, existing, records, stats)
    other_uk_step(rest, existing, stats)
    graph_step(rest, stats)
    branches_step(rest, existing, ods, now, stats)

    if rejects:
        stats["rejects"] = len(rejects)
        rest.insert("ingest_rejects", [{"run_id": run_id, "source": s, "key": k, "reason": r} for s, k, r in rejects[:1000]])
    return stats


def main():
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    first = not rest.select_all("ingest_runs", "id", order="id", params={"status": "eq.success"})
    run_id = rest.insert("ingest_runs", [{}], returning=True)[0]["id"]
    try:
        stats = sync(rest, run_id)
        stats["baseline"] = first
        rest.patch("ingest_runs", {"id": f"eq.{run_id}"},
                   {"status": "success", "finished_at": datetime.now(timezone.utc).isoformat(), "stats": stats})
        print("OK", stats)
        if stats.get("patients_stale"):
            send_alert("Lalu Atlas: patient counts are stale",
                       "Patient counts come from the 'Monthly patient counts' workflow (self-hosted runner). "
                       f"The latest data loaded is for {stats['patients_stale']}; check that the runner is online.")
    except Exception as e:  # noqa: BLE001
        msg = f"{e}\n\n{traceback.format_exc()}"
        rest.patch("ingest_runs", {"id": f"eq.{run_id}"},
                   {"status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(), "error": msg[:4000]})
        send_alert("Lalu Atlas: ingestion FAILED", msg)
        print(msg, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
