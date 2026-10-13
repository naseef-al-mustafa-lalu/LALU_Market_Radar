"""Round 2: find patient counts + ODS API shape from sources reachable from GitHub runners."""
import json
import requests

H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def get(u, **kw):
    try:
        return requests.get(u, headers=H, timeout=60, **kw)
    except Exception as e:  # noqa: BLE001
        print("ERR", u, e)


print("== data.gov.uk datasets ==")
r = get("https://data.gov.uk/api/action/package_search?q=registered+patients+gp+practice&rows=15")
if r is not None and r.ok:
    for d in r.json()["result"]["results"]:
        print("-", d["title"][:80], "|", d.get("organization", {}).get("title", "")[:30])
        for x in d.get("resources", [])[:6]:
            print("     ", x.get("format"), x.get("url")[:150])

print("== NHSBSA datasets matching list/practice/patient ==")
r = get("https://opendata.nhsbsa.net/api/3/action/package_list")
if r is not None and r.ok:
    names = r.json()["result"]
    print([n for n in names if any(k in n for k in ("list", "practice", "patient", "gp", "demograph", "population"))])

print("== ODS API ==")
for u in ["https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations?PrimaryRoleId=RO177&NonPrimaryRoleId=RO76&Status=Active&Limit=2",
          "https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations?PrimaryRoleId=RO98&Status=Active&Limit=2",
          "https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations?PrimaryRoleId=RO272&Status=Active&Limit=2",
          "https://directory.spineservices.nhs.uk/ORD/2-0-0/roles"]:
    r = get(u)
    if r is not None:
        print(r.status_code, r.headers.get("X-Total-Count"), u[-110:])
        print("    ", r.text[:300].replace("\n", " "))
r = get("https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations/A81001")
if r is not None and r.ok:
    o = r.json()["Organisation"]
    print("A81001 keys:", list(o), "| Rels:", json.dumps(o.get("Rels"))[:500], "| Roles:", json.dumps(o.get("Roles"))[:300])

print("== other hosts ==")
for u in ["https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=epraccur",
          "https://fingertips.phe.org.uk/api/area_types",
          "https://api.cqc.org.uk/public/v1/providers?perPage=1",
          "https://www.nhs.uk/"]:
    r = get(u)
    if r is not None:
        print(r.status_code, len(r.content), r.headers.get("content-type", "")[:30], u)
