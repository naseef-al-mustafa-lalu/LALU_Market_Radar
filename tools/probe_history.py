"""One-off probe 2: list-size history for practices with no current list size, and how closed practices look in ODS."""
import json
import re
import sys

sys.path.insert(0, ".")
from src import sources  # noqa: E402
from tools.probe_ods_status import CODES, summary  # noqa: E402

PAGE = sources.GP_REG_PAGE
names = {i: m for m, i in sources.MONTHS.items()}
hist, order = {}, []
y, m = 2026, 9
for _ in range(14):
    url = f"{PAGE}/{names[m]}-{y}"
    try:
        html = sources.http_text(url)
        links = re.findall(r"""href=["']([^"']*gp-reg-pat-prac-all\.(?:csv|zip))["']""", html)
        if links:
            link = ("https://digital.nhs.uk" + links[0]) if links[0].startswith("/") else links[0]
            counts, month = sources.load_patients(sources.fetch(link))
            hist[f"{y}-{m:02d}"] = counts
            order.append(f"{y}-{m:02d}")
            print("loaded", y, m, "file month", month, "practices", len(counts))
        else:
            print("no file link on", url)
    except Exception as e:  # noqa: BLE001
        print("failed", url, str(e)[:120])
    m -= 1
    if m < 1:
        y, m = y - 1, 12

print("\n=== list size history for the 131 (months, newest first:", order, ") ===")
had_before = 0
rows = []
for c in CODES:
    series = [hist[k].get(c, 0) for k in order]
    rows.append((c, series))
    if any(series[1:]):
        had_before += 1
    print(c, series)
print("practices with a list size in an earlier month but not the latest:", had_before, "of", len(CODES))

print("\n=== practices that VANISHED from the patient file between months (list>0 earlier, 0/absent latest) ===")
latest = order[0] if order else None
if latest:
    gone = sorted(c for k in order[1:] for c, n in hist[k].items() if n > 0 and not hist[latest].get(c))
    gone = sorted(set(gone))
    print("count", len(gone), "sample", gone[:30])
    print("of which in the 131:", len(set(gone) & set(CODES)))

print("\n=== ODS: how do closed GP practices look? ===")
for params in ({"PrimaryRoleId": "RO177", "Status": "Inactive", "Limit": 25},
               {"PrimaryRoleId": "RO177", "NonPrimaryRoleId": "RO76", "Status": "Inactive", "Limit": 25},
               {"PrimaryRoleId": "RO177", "Status": "Inactive", "LastChangeDate": "2026-01-01", "Limit": 25}):
    try:
        orgs = sources.get_json(f"{sources.ODS_API}/organisations", params).get("Organisations", [])
        print("params", params, "->", len(orgs))
        for o in orgs[:12]:
            print(json.dumps(summary(o.get("OrgId")), default=str)[:700])
        if orgs:
            break
    except Exception as e:  # noqa: BLE001
        print("params", params, "failed:", str(e)[:200])
