"""One-off probe: can GitHub's runners reach candidate data sources, and what do they return? Prints a short report; changes nothing."""
import os
import re
import sys

import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)", "Accept": "*/*"}
KW = ["subject access", "medico-legal", "medical secretary", "summariser", "medical records", "medical reports", "insurance reports"]


def hit(name, url, params=None, headers=None, want=None, show=500, auth=None):
    print(f"\n=== {name}\n{url} {params or ''}")
    try:
        r = requests.get(url, params=params, headers={**UA, **(headers or {})}, timeout=45, auth=auth)
    except Exception as e:  # noqa: BLE001
        print("  ERROR:", str(e)[:200]); return None
    body = r.text
    print(f"  status={r.status_code} type={r.headers.get('content-type', '?')[:40]} bytes={len(r.content):,}")
    blocked = r.status_code in (403, 429) or "cloudflare" in body[:3000].lower() or "just a moment" in body[:3000].lower()
    print("  looks blocked:" , blocked)
    if want:
        print("  contains:", {w: (w.lower() in body.lower()) for w in want})
    print("  start:", re.sub(r"\s+", " ", body[:show]))
    return r


# --- NHS Jobs ---
hit("NHS Jobs search_xml (no filter)", "https://www.jobs.nhs.uk/api/v1/search_xml", {"keyword": "subject access"}, want=["<vacancy", "employer"])
for k in KW[:4]:
    r = hit(f"NHS Jobs search_xml keyword={k}", "https://www.jobs.nhs.uk/api/v1/search_xml", {"keyword": k}, show=200)
    if r is not None and r.ok:
        print("  vacancies in page:", len(re.findall(r"<vacancy", r.text)), "| employer tags:", re.findall(r"<employer[^>]*>[^<]{0,60}", r.text)[:3])
r = hit("NHS Jobs search_xml xml sample (full first vacancy)", "https://www.jobs.nhs.uk/api/v1/search_xml", {"keyword": "medical secretary"}, show=0)
if r is not None and r.ok:
    m = re.search(r"<vacancy.*?</vacancy>", r.text, re.S)
    print("  first vacancy:", re.sub(r"\s+", " ", (m.group(0) if m else r.text[:1500]))[:1800])
hit("NHS Jobs website search page", "https://www.jobs.nhs.uk/candidate/search/results", {"keyword": "subject access", "language": "en"}, want=["subject access"], show=300)
hit("NHS Jobs vacancy API (needs key)", "https://www.jobs.nhs.uk/api/v1/vacancies", show=200)

# --- Companies House (key optional) ---
ch = os.environ.get("COMPANIES_HOUSE_API_KEY")
if ch:
    hit("Companies House advanced search SIC 86210", "https://api.company-information.service.gov.uk/advanced-search/companies",
        {"sic_codes": "86210", "incorporated_from": "2026-07-01", "size": 5}, auth=(ch, ""), show=700)
else:
    print("\n=== Companies House: COMPANIES_HOUSE_API_KEY not set, skipped")

# --- NHS England / NHSBSA / data.gov.uk ---
hit("NHS England GP workforce page", "https://digital.nhs.uk/data-and-information/publications/statistical/general-and-personal-medical-services", want=["workforce", "csv"], show=200)
hit("NHS England appointments in general practice", "https://digital.nhs.uk/data-and-information/publications/statistical/appointments-in-general-practice", want=["practice level", "csv"], show=200)
hit("NHS England GP workforce (england.nhs.uk stats)", "https://www.england.nhs.uk/statistics/statistical-work-areas/", show=150)
hit("GP Patient Survey data", "https://www.gp-patient.co.uk/practices-search", show=200)
hit("NHSBSA open data portal API", "https://opendata.nhsbsa.net/api/3/action/package_list", show=300)
hit("data.gov.uk CKAN: GP workforce", "https://data.gov.uk/api/action/package_search", {"q": "general practice workforce practice level", "rows": 5}, show=900)
hit("CQC ratings list", "https://api.service.cqc.org.uk/public/v1/providers", {"perPage": 1}, show=150)
sys.exit(0)
