"""Diagnostic: which public data sources are reachable from this machine (GitHub runner)?"""
import requests

H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
URLS = [
    "https://files.digital.nhs.uk/assets/ods/current/epraccur.zip",
    "https://files.digital.nhs.uk/assets/ods/current/epcmem.zip",
    "https://files.digital.nhs.uk/assets/ods/current/epcn.zip",
    "https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice",
    "https://data.gov.uk/api/action/package_search?q=patients+registered+at+a+gp+practice&rows=5",
    "https://openprescribing.net/api/1.0/org_code/?org_type=practice&q=A81001&format=json",
    "https://openprescribing.net/api/1.0/org_details/?org_type=practice&org=A81001&keys=total_list_size&format=csv",
    "https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations/A81001",
    "https://opendata.nhsbsa.net/api/3/action/package_list",
    "https://www.england.nhs.uk/statistics/",
]
for u in URLS:
    try:
        r = requests.get(u, headers=H, timeout=40)
        print(f"{r.status_code} {len(r.content):>9}B {r.headers.get('content-type', '')[:40]:<40} {u}")
        if r.ok and "text" in r.headers.get("content-type", "") or "json" in r.headers.get("content-type", ""):
            print("    ", r.text[:400].replace("\n", " "))
    except Exception as e:  # noqa: BLE001
        print(f"ERR {type(e).__name__}: {str(e)[:120]} {u}")
