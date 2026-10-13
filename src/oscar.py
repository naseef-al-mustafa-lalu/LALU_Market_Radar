"""Parse the Oscar Research contact file (one row per contact) into contacts, per-practice org details and a primary contact."""
from .common import norm_ods, title_case
from .sources import _csv, unzip_first

ROLE_SCORES = [("practice manager", 100), ("business manager", 90), ("general manager", 85),
               ("operations manager", 80), ("executive manager", 80), ("managing partner", 75),
               ("manager", 60), ("partner", 40)]
SENIORITY = {"chief officer": 5, "director": 4, "senior manager": 3, "manager": 2}
REQUIRED = ["ContactURN", "NHSGPPracticeCode", "Suppress", "ContactEmail", "ContactEmailOptOut"]
# Practice-level (organisation) fields kept from Oscar, as {database column: Oscar column}
ORG_FIELDS = {"oscar_org_urn": "OrgURN", "oscar_site_urn": "SiteURN", "kk_org_urn": "KKOrgUrn", "town": "Town",
              "county": "County", "region": "Region", "main_phone": "MainPhone", "main_email": "MainEmail",
              "num_employees": "NumEmployees", "annual_spend": "AnnualSpend", "org_notes": "OrgNotes",
              "nhs_num_gp": "NHSNumGP", "gp_federation": "NHSGPFed", "oscar_categories": "OrgTypes"}
ORG_KEYS = list(ORG_FIELDS) + ["address", "main_email_opt_out"]


def _yes(v):
    return str(v).strip().lower() in ("yes", "y", "true", "1")


def _txt(r, col):
    return (r.get(col) or "").strip() or None


def _int(v):
    v = str(v or "").strip()
    return int(v) if v.isdigit() else None


def person_name(text):
    return " ".join(title_case(w) if w.isupper() else w.capitalize() if w.islower() else w for w in str(text).split())


def score(job_title, seniority):
    jt = (job_title or "").lower()
    base = next((s for k, s in ROLE_SCORES if k in jt), 10)
    return base * 10 + SENIORITY.get(str(seniority or "").strip().lower(), 0)


def org_details(r):
    """Practice-level fields from one Oscar row."""
    out = {k: _txt(r, c) for k, c in ORG_FIELDS.items()}
    for k in ("oscar_org_urn", "oscar_site_urn"):
        out[k] = _int(r.get(ORG_FIELDS[k]))
    for k in ("town", "county"):
        out[k] = person_name(out[k]) if out[k] else None
    out["address"] = ", ".join(person_name(r[c].strip()) for c in ("Add1", "Add2", "Add3", "Add4") if (r.get(c) or "").strip()) or None
    out["main_email"] = out["main_email"].lower() if out["main_email"] else None
    out["main_email_opt_out"] = _yes(r.get("MainEmailOptOut", ""))
    return out


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
        first, last = person_name(r.get("FirstName", "")), person_name(r.get("LastName", ""))
        name = " ".join(p for p in (first, last) if p) or person_name(r.get("Salutation", ""))
        contacts.append({
            "contact_urn": urn, "ods_code": code, "full_name": name or None,
            "job_title": _txt(r, "JobTitle"), "seniority": _txt(r, "Seniority"),
            "email": (r["ContactEmail"] or "").strip().lower() or None,
            "phone": (r.get("ContactPhone") or r.get("MainPhone") or "").strip() or None,
            "email_opt_out": _yes(r["ContactEmailOptOut"]), "is_primary": False,
            "org_urn": _int(r.get("OrgURN")), "title": _txt(r, "Title"), "first_name": first or None, "last_name": last or None,
            "quals": _txt(r, "Quals"), "dept": _txt(r, "Dept"), "categories": _txt(r, "AllCategories"),
            "data_types": _txt(r, "DataTypes"), "main_site": _yes(r.get("MainSite", "")),
            "_score": score(r.get("JobTitle"), r.get("Seniority")), "_website": (r.get("WebsiteURL") or "").strip(),
            "_icb": (r.get("ParentOrg") or "").strip(), "_org": org_details(r)})
    info = {}
    for c in sorted(contacts, key=lambda c: (-c["_score"], c["contact_urn"])):  # deterministic: lowest URN wins ties
        p = info.setdefault(c["ods_code"], {"primary": c, "website": "", "icb": "", "org": dict.fromkeys(ORG_KEYS)})
        p["website"] = p["website"] or c["_website"]
        p["icb"] = p["icb"] or c["_icb"]
        for k, v in c["_org"].items():  # primary contact's values first, blanks filled from the practice's other contacts
            if p["org"][k] in (None, False) and v not in (None, False):
                p["org"][k] = v
    for p in info.values():
        p["primary"]["is_primary"] = True
    for c in contacts:
        for k in ("_score", "_website", "_icb", "_org"):
            c.pop(k)
    return contacts, info, rejects, suppressed
