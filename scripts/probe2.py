"""Round 3: any reachable source of practice list size? ODS export report names?"""
import re
import requests

H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def get(u):
    try:
        return requests.get(u, headers=H, timeout=90)
    except Exception as e:  # noqa: BLE001
        print("ERR", u, e)


print("== Fingertips indicators mentioning list size / registered / population ==")
r = get("https://fingertips.phe.org.uk/api/indicator_names")
if r is not None and r.ok:
    names = r.json()
    hits = [(k, v) for k, v in names.items() if re.search(r"list size|registered patients|patients registered|practice population|number of patients", v, re.I)]
    print(len(names), "indicators;", len(hits), "hits")
    for k, v in hits[:25]:
        print(" ", k, v[:110])

print("== ODS export reports ==")
for rep in ["epraccur", "epcn", "epcmem", "epcnmem", "egpcur", "ePCN", "ecsmem"]:
    r = get(f"https://www.odsdatasearchandexport.nhs.uk/api/getReport?report={rep}")
    if r is not None:
        print(rep, r.status_code, len(r.content), r.headers.get("content-type", "")[:25], "|", r.text[:160].replace("\n", " ").replace("\r", " "))
for u in ["https://www.odsdatasearchandexport.nhs.uk/api/getReports", "https://www.odsdatasearchandexport.nhs.uk/api/getReportList"]:
    r = get(u)
    if r is not None:
        print(r.status_code, len(r.content), u, r.text[:300].replace("\n", " "))

print("== misc ==")
for u in ["https://raw.githubusercontent.com/ebmdatalab/openprescribing/main/README.md"]:
    r = get(u)
    if r is not None:
        print(r.status_code, len(r.content), u)
