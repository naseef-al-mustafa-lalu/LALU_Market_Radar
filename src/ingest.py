"""Daily ingestion: NHS public data + Oscar contacts -> Supabase (diffed, batched, guarded)."""
import os
import sys
import traceback
from datetime import datetime, timedelta, timezone

from . import oscar, software, sources
from .common import Rest, need_env, send_alert, title_case

TRACKED = ["practice_name", "postcode", "website", "pcn_code", "pcn_name", "icb_name", "total_patients",
           "status", "clinical_software", "software_source", "manager_name", "manager_title", "manager_email",
           "manager_phone", "manager_email_opt_out", "data_month"]
CONTACT_FIELDS = ["ods_code", "full_name", "job_title", "seniority", "email", "phone", "email_opt_out", "is_primary"]
SOFTWARE_DAILY_CAP = 400
SOFTWARE_RECHECK = timedelta(days=90)


def build_records(ods, patients, month, existing, pcn_map, oscar_info, check_software):
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
                                   "manager_phone": None, "manager_email_opt_out": False}
        r.update(ods_code=code, practice_name=title_case(o["name"]), postcode=o["postcode"] or r.get("postcode"),
                 status=o["status"], data_month=month or r.get("data_month"))
        if o["status"] == "Active" and code in patients:
            r["total_patients"] = patients[code]
        if pcn_map and code in pcn_map:
            r["pcn_code"], r["pcn_name"] = pcn_map[code]
        if oscar_info is not None:
            info = oscar_info.get(code)
            p = info["primary"] if info else None
            r.update(manager_name=p["full_name"] if p else None, manager_title=p["job_title"] if p else None,
                     manager_email=p["email"] if p else None, manager_phone=p["phone"] if p else None,
                     manager_email_opt_out=bool(p and p["email_opt_out"]))
            if info:
                r["website"] = info["website"] or r.get("website")
                r["icb_name"] = info["icb"] or r["icb_name"]
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
        if not old or any(r.get(k) != old.get(k) for k in TRACKED) or r.get("software_checked_at") != old.get("software_checked_at"):
            changed.append({k: v for k, v in r.items() if k not in ("lead_status", "first_seen", "last_updated", "sales_segment")})
    return changed, len(due)


def sync(rest, run_id):
    stats, rejects = {}, []
    env = os.environ

    reg_url = env.get("GP_REG_URL") or sources.discover_gp_reg_url(sources.http_text)
    patients, month = sources.load_patients(sources.fetch(reg_url))
    ods = sources.load_ods_practices(sources.fetch(f"{sources.ODS_BASE}/epraccur.zip"), set(patients))
    stats.update(ods_practices=len(ods), patients_rows=len(patients), data_month=month, gp_reg_url=reg_url)

    active = [c for c, v in ods.items() if v["status"] == "Active"]
    coverage = sum(c in patients for c in active) / len(active)
    if coverage < 0.90:
        raise RuntimeError(f"Only {coverage:.0%} of active ODS practices have a patient count: feed mismatch, aborting")

    try:
        pcn_map = sources.load_pcn_map(sources.fetch(f"{sources.ODS_BASE}/epcmem.zip"), sources.fetch(f"{sources.ODS_BASE}/epcn.zip"))
        stats["pcn_mapped"] = len(pcn_map)
    except Exception as e:  # noqa: BLE001  PCN is enrichment, not critical
        pcn_map, stats["pcn_error"] = {}, str(e)[:200]

    try:
        if not env.get("OSCAR_API_URL"):
            raise ValueError("OSCAR_API_URL not set: running without contact data")
        contacts, oscar_info, o_rejects, suppressed = oscar.parse(sources.fetch(env["OSCAR_API_URL"], timeout=180))
        rejects += o_rejects
        stats.update(oscar_contacts=len(contacts), oscar_practices=len(oscar_info), oscar_suppressed=suppressed)
        if not set(oscar_info) & set(ods):
            raise ValueError("Oscar file matched zero NHS practices: wrong file?")
    except Exception as e:  # noqa: BLE001  keep existing contact data if Oscar is unavailable
        contacts, oscar_info, stats["oscar_error"] = [], None, str(e)[:200]

    existing = {r["ods_code"]: r for r in rest.select_all("gp_practices", order="ods_code")}
    closing = sum(1 for c, v in ods.items() if v["status"] == "Closed" and existing.get(c, {}).get("status") == "Active")
    stats["closures"] = closing
    if closing > 50 and env.get("ALLOW_MASS_CHANGE") != "1":
        raise RuntimeError(f"{closing} practices closing in one run looks like a feed error; set ALLOW_MASS_CHANGE=1 to override")

    records, checked = build_records(ods, patients, month, existing, pcn_map, oscar_info, software.check_many)
    stats.update(practices_changed=len(records), software_checked=checked)
    rest.upsert("gp_practices", records, "ods_code")

    if oscar_info is not None:
        known = set(existing) | {r["ods_code"] for r in records}
        feed = [c for c in contacts if c["ods_code"] in known]
        rejects += [("oscar", str(c["contact_urn"]), f"practice {c['ods_code']} not in NHS GP list")
                    for c in contacts if c["ods_code"] not in known]
        db = {r["contact_urn"]: r for r in rest.select_all("contacts", order="contact_urn")}
        changed = [c for c in feed if c["contact_urn"] not in db or any(c[k] != db[c["contact_urn"]][k] for k in CONTACT_FIELDS)]
        rest.upsert("contacts", changed, "contact_urn")
        stale = sorted(set(db) - {c["contact_urn"] for c in feed})
        if stale and len(feed) >= 0.5 * len(db):
            rest.delete_in("contacts", "contact_urn", stale)
        elif stale:
            stats["contacts_delete_skipped"] = len(stale)
        stats.update(contacts_changed=len(changed), contacts_removed=len(stale))

    if rejects:
        stats["rejects"] = len(rejects)
        rest.insert("ingest_rejects", [{"run_id": run_id, "source": s, "key": k, "reason": r} for s, k, r in rejects[:1000]])
    return stats


def main():
    need_env("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY")
    rest = Rest(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    first = not rest.select_all("ingest_runs", "id", order="id", params={"status": "eq.success"})
    run_id = rest.insert("ingest_runs", [{}], returning=True)[0]["id"]
    try:
        stats = sync(rest, run_id)
        stats["baseline"] = first
        rest.patch("ingest_runs", {"id": f"eq.{run_id}"},
                   {"status": "success", "finished_at": datetime.now(timezone.utc).isoformat(), "stats": stats})
        print("OK", stats)
    except Exception as e:  # noqa: BLE001
        msg = f"{e}\n\n{traceback.format_exc()}"
        rest.patch("ingest_runs", {"id": f"eq.{run_id}"},
                   {"status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(), "error": msg[:4000]})
        send_alert("Lalu Market Radar: ingestion FAILED", msg)
        print(msg, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
