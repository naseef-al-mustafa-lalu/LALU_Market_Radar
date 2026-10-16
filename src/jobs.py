"""NHS Jobs vacancy feed -> 'hiring for reports / records' signal.

The public search_xml feed lists every live NHS Jobs advert (limit=100 per page). Employers are identified by their NHS Jobs
employer code (the prefix of the advert reference, e.g. A0095-26-0006). We keep primary-care employers, link each employer code to
a practice ONCE (exact postcode + exact normalised name, otherwise it waits in a review list), and raise a signal for adverts whose
TITLE matches a report / records role. Nothing is guessed at run time.
"""
import re
import time
from datetime import date, timedelta
from xml.etree import ElementTree as ET

import requests

FEED = "https://www.jobs.nhs.uk/api/v1/search_xml"
HEADERS = {"User-Agent": "LaluMarketRadar/1.0 (+daily read of the public NHS Jobs feed)"}
MIN_EXPECTED = 3000          # a healthy scan returns >10,000; fewer means the feed misbehaved
SIGNAL_WINDOW_DAYS = 7       # only adverts this recent raise a signal (older ones load silently)

ROLES = [
    ("subject access / SAR", r"subject access|\bsars?\b"),
    ("medico-legal / reports", r"medico.?legal|medical reports?|insurance reports?|reports? (?:administrator|clerk|coordinator|officer)"),
    ("medical secretary", r"medical secretary|medical secretaries|\bmed(?:ical)? sec\b"),
    ("records / summarising", r"summaris|medical records?|health records?|records? (?:clerk|officer|administrator|manager|assistant)|lloyd george|notes summar"),
    ("workflow / document management", r"workflow|document (?:management|handler|administrator)|correspondence"),
    ("information governance", r"information governance|data protection|\bdpo\b"),
]
ROLE_RES = [(label, re.compile(rx, re.I)) for label, rx in ROLES]
NETWORK_NAME = re.compile(r"\bpcn\b|primary care network|gp federation|federated gps|gp network|gp collaborative|gp alliance|general practice (?:network|federation)", re.I)
PRIMARY_NAME = re.compile(r"surgery|surgeries|medical (?:centre|center|practice|group|partnership)|health (?:centre|center)|doctors|\bgp\b|family practice|group practice|primary care", re.I)
POSTCODE = re.compile(r"([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$")


def norm_postcode(s):
    m = POSTCODE.search((s or "").upper().strip())
    return m.group(1) + m.group(2) if m else None


def norm_name(s):
    s = (s or "").lower().replace("&amp;", "and").replace("&", "and").replace("’", "").replace("'", "")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(w for w in s.split() if w not in {"the", "ltd", "limited", "llp", "cic"})


def role_of(title):
    for label, rx in ROLE_RES:
        if rx.search(title or ""):
            return label
    return None


def is_primary_employer(code, name):
    """Primary care employers carry an 'A' employer code; PCNs and federations registered as companies use other letters."""
    return (code or "").startswith("A") or bool(NETWORK_NAME.search(name or ""))


def parse_page(xml_text):
    root = ET.fromstring(xml_text)
    total = int(root.findtext("totalResults") or 0)
    out = []
    for v in root.iter("vacancyDetails"):
        ref = (v.findtext("reference") or "").strip()
        out.append({
            "advert_id": (v.findtext("id") or "").strip(), "reference": ref, "employer_code": ref.split("-")[0],
            "employer": (v.findtext("employer") or "").strip(), "title": (v.findtext("title") or "").strip(),
            "post_date": (v.findtext("postDate") or "")[:10] or None, "close_date": (v.findtext("closeDate") or "")[:10] or None,
            "url": (v.findtext("url") or "").strip(), "locations": [(l.text or "").strip() for l in v.iter("location")],
        })
    return total, out


def fetch_all(get=requests.get, pause=0.5, max_pages=400):
    """Every live advert, newest first. Raises if the scan looks incomplete."""
    adverts, seen = [], set()
    total = None
    for page in range(1, max_pages + 1):
        r = None
        for attempt in range(3):
            try:
                r = get(FEED, params={"limit": 100, "page": page, "sort": "publicationDateDesc"}, headers=HEADERS, timeout=90)
                if r.status_code == 200:
                    break
            except requests.RequestException:
                r = None
            time.sleep(2 * (attempt + 1))
        if r is None or r.status_code != 200:
            raise RuntimeError(f"NHS Jobs feed failed on page {page}")
        t, rows = parse_page(r.text)
        total = total or t
        if not rows:
            break
        for a in rows:
            if a["advert_id"] and a["advert_id"] not in seen:
                seen.add(a["advert_id"]); adverts.append(a)
        time.sleep(pause)
    if len(adverts) < MIN_EXPECTED or (total and len(adverts) < 0.9 * total):
        raise RuntimeError(f"NHS Jobs scan incomplete: {len(adverts)} adverts, feed says {total}")
    return adverts, total


def candidates_for(name, postcodes, by_postcode):
    """Practices at the employer's postcodes. Returns (status, ods_code or None, candidate list)."""
    cands = {p["ods_code"]: p for pc in postcodes for p in by_postcode.get(pc, [])}
    cand_list = [{"ods_code": p["ods_code"], "name": p["practice_name"], "postcode": p.get("postcode")} for p in cands.values()]
    exact = [p for p in cands.values() if norm_name(p["practice_name"]) == norm_name(name)]
    if len(exact) == 1:
        return "auto", exact[0]["ods_code"], cand_list
    return ("network" if NETWORK_NAME.search(name or "") else "review"), None, cand_list


def sync(rest, practices, today=None, fetch=fetch_all):
    """Returns stats. `practices` = iterable of gp_practices rows (ods_code, practice_name, postcode, status)."""
    today = today or date.today()
    adverts, total = fetch()
    by_postcode = {}
    for p in practices:
        if p.get("status", "Active") == "Active" and p.get("postcode"):
            by_postcode.setdefault(norm_postcode(p["postcode"]) or "", []).append(p)

    # employers (primary care only)
    emp = {}
    for a in adverts:
        if not is_primary_employer(a["employer_code"], a["employer"]):
            continue
        e = emp.setdefault(a["employer_code"], {"employer_code": a["employer_code"], "employer_name": a["employer"], "postcodes": set()})
        e["postcodes"].update(filter(None, (norm_postcode(l) for l in a["locations"])))
    existing = {r["employer_code"]: r for r in rest.select_all("job_employers", order="employer_code")}
    now_iso = today.isoformat()
    emp_rows, counts = [], {"auto": 0, "confirmed": 0, "review": 0, "network": 0, "rejected": 0}
    for code, e in emp.items():
        old = existing.get(code)
        keep = old and old["match_status"] in ("confirmed", "rejected")
        status, ods, cands = candidates_for(e["employer_name"], e["postcodes"], by_postcode)
        row = {"employer_code": code, "employer_name": e["employer_name"], "postcodes": sorted(e["postcodes"]), "candidates": cands, "last_seen": now_iso}
        if keep:
            row.update(match_status=old["match_status"], ods_code=old["ods_code"])
        else:
            row.update(match_status=status, ods_code=ods)
        counts[row["match_status"]] += 1
        emp_rows.append(row)
    rest.upsert("job_employers", emp_rows, "employer_code")
    ods_of = {r["employer_code"]: (r["ods_code"] if r["match_status"] in ("auto", "confirmed") else None) for r in emp_rows}

    # role adverts
    rows = []
    for a in adverts:
        if a["employer_code"] not in emp:
            continue
        role = role_of(a["title"])
        if role:
            rows.append({"advert_id": a["advert_id"], "employer_code": a["employer_code"], "ods_code": ods_of.get(a["employer_code"]),
                         "reference": a["reference"], "title": a["title"], "matched_role": role, "post_date": a["post_date"],
                         "close_date": a["close_date"], "url": a["url"], "locations": a["locations"], "last_seen": now_iso})
    known = {r["advert_id"]: r["signalled"] for r in rest.select_all("job_adverts", "advert_id,signalled", order="advert_id")}
    cutoff = (today - timedelta(days=SIGNAL_WINDOW_DAYS)).isoformat()
    signals = []
    for r in rows:
        r["signalled"] = known.get(r["advert_id"], False)
        if r["signalled"] or not r["ods_code"]:
            continue              # already signalled, or employer not linked to a practice yet (signalled once it is)
        if (r["post_date"] or "") >= cutoff:
            signals.append({"ods_code": r["ods_code"], "trigger_type": "JOB_REPORT_ROLE", "headline": f"Hiring: {r['title']}",
                            "description": f"{emp[r['employer_code']]['employer_name']} advertised \"{r['title']}\" ({r['matched_role']}) on NHS Jobs"
                                           f"{', closing ' + r['close_date'] if r['close_date'] else ''}. {r['url']}"})
        r["signalled"] = True     # older adverts load silently
    rest.upsert("job_adverts", rows, "advert_id")
    if signals:
        rest.insert("sales_triggers", signals)
    return {"jobs_scanned": len(adverts), "jobs_feed_total": total, "job_employers": len(emp_rows), "job_employer_status": counts,
            "job_role_adverts": len(rows), "job_signals": len(signals)}
