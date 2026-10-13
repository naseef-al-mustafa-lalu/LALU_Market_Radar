"""Parse the Oscar Research contact file (one row per contact) into contacts + a primary contact per practice."""
from .common import norm_ods, title_case
from .sources import _csv, unzip_first

ROLE_SCORES = [("practice manager", 100), ("business manager", 90), ("general manager", 85),
               ("operations manager", 80), ("executive manager", 80), ("managing partner", 75),
               ("manager", 60), ("partner", 40)]
SENIORITY = {"chief officer": 5, "director": 4, "senior manager": 3, "manager": 2}
REQUIRED = ["ContactURN", "NHSGPPracticeCode", "Suppress", "ContactEmail", "ContactEmailOptOut"]


def _yes(v):
    return str(v).strip().lower() in ("yes", "y", "true", "1")


def person_name(text):
    return " ".join(title_case(w) if w.isupper() else w.capitalize() if w.islower() else w for w in str(text).split())


def score(job_title, seniority):
    jt = (job_title or "").lower()
    base = next((s for k, s in ROLE_SCORES if k in jt), 10)
    return base * 10 + SENIORITY.get(str(seniority or "").strip().lower(), 0)


def parse(data):
    """Returns (contacts, practice_info, rejects, suppressed_count)."""
    df = _csv(unzip_first(data))
    df.columns = [c.strip() for c in df.columns]
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"Oscar file missing columns {missing}")
    contacts, rejects, suppressed, seen = [], [], 0, set()
    for r in df.to_dict("records"):
        urn_raw = str(r["ContactURN"]).strip()
        code = norm_ods(r["NHSGPPracticeCode"])
        if not urn_raw.isdigit():
            rejects.append(("oscar", urn_raw, "bad ContactURN")); continue
        if not code:
            rejects.append(("oscar", urn_raw, f"invalid ODS code {r['NHSGPPracticeCode']!r}")); continue
        if _yes(r["Suppress"]):
            suppressed += 1; continue
        urn = int(urn_raw)
        if urn in seen:
            rejects.append(("oscar", urn_raw, "duplicate ContactURN")); continue
        seen.add(urn)
        name = " ".join(p for p in (r.get("FirstName", ""), r.get("LastName", "")) if p.strip()) or r.get("Salutation", "")
        email = (r["ContactEmail"] or "").strip().lower() or None
        contacts.append({
            "contact_urn": urn, "ods_code": code, "full_name": person_name(name) or None,
            "job_title": (r.get("JobTitle") or "").strip() or None,
            "seniority": (r.get("Seniority") or "").strip() or None,
            "email": email, "phone": (r.get("ContactPhone") or r.get("MainPhone") or "").strip() or None,
            "email_opt_out": _yes(r["ContactEmailOptOut"]),
            "is_primary": False, "_score": score(r.get("JobTitle"), r.get("Seniority")),
            "_website": (r.get("WebsiteURL") or "").strip(), "_icb": (r.get("ParentOrg") or "").strip()})
    info = {}
    for c in sorted(contacts, key=lambda c: (-c["_score"], c["contact_urn"])):  # deterministic: lowest URN wins ties
        p = info.setdefault(c["ods_code"], {"primary": c, "website": "", "icb": ""})
        p["website"] = p["website"] or c["_website"]
        p["icb"] = p["icb"] or c["_icb"]
    for p in info.values():
        p["primary"]["is_primary"] = True
    for c in contacts:
        for k in ("_score", "_website", "_icb"):
            c.pop(k)
    return contacts, info, rejects, suppressed
