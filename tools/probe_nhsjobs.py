"""One-off probe 2: how to page and filter NHS Jobs search_xml, and whether the whole board can be scanned. Read-only."""
import re
import time

import requests

U = "https://www.jobs.nhs.uk/api/v1/search_xml"
H = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)"}


def get(params=None, url=U):
    t = time.time()
    r = requests.get(url, params=params, headers=H, timeout=60)
    ids = re.findall(r"<id>(\d+)</id>", r.text)
    emp = re.findall(r"<employer>([^<]*)</employer>", r.text)
    return r, ids, emp, round(time.time() - t, 2)


def show(label, params):
    try:
        r, ids, emp, dt = get(params)
        print(f"{label:38} {r.status_code} n={len(ids):3} t={dt}s first={ids[:1]} emp={[e[:28] for e in emp[:2]]}")
        return r, ids, emp
    except Exception as e:  # noqa: BLE001
        print(label, "ERROR", str(e)[:150]); return None, [], []


r, ids0, _ = show("no params", {})
print("  root/head:", re.sub(r"\s+", " ", r.text[:300]) if r is not None else "")
print("  any totals/paging tags:", set(re.findall(r"<(total\w*|page\w*|count\w*|next\w*|results\w*)[ >]", r.text)) if r is not None else "")
print("  all tag names:", sorted(set(re.findall(r"<([A-Za-z]+)[ >/]", r.text)))[:40] if r is not None else "")

print("\n--- paging parameter candidates (does the first id change vs page 1?)")
for name in ["page", "pageNumber", "pageNo", "p", "start", "offset", "startIndex", "pageIndex"]:
    for v in ([2] if name not in ("start", "offset", "startIndex") else [10]):
        r2, ids2, _ = show(f"{name}={v}", {name: v})
        print("   changed:", bool(ids2) and ids2[:3] != ids0[:3])

print("\n--- filters (does the result set change?)")
for label, p in [("employerCode=A0095", {"employerCode": "A0095"}), ("employer_code=A0095", {"employer_code": "A0095"}),
                 ("employer=Little Common Surgery", {"employer": "Little Common Surgery"}),
                 ("keyword=\"subject access\" (quoted)", {"keyword": '"subject access"'}),
                 ("keyword=SAR", {"keyword": "SAR"}), ("jobTitle=Medical Secretary", {"jobTitle": "Medical Secretary"}),
                 ("title=Medical Secretary", {"title": "Medical Secretary"}),
                 ("postcode=TN39 4SP", {"postcode": "TN39 4SP"}), ("location=Bexhill", {"location": "Bexhill"}),
                 ("distance=5 postcode", {"postcode": "TN39 4SP", "distance": 5}),
                 ("staffGroup=Administrative", {"staffGroup": "ADMIN_AND_CLERICAL"}), ("sort=publicationDateDesc", {"sort": "publicationDateDesc"}),
                 ("postedDays=1", {"postedDays": 1}), ("datePosted=2026-10-15", {"datePosted": "2026-10-15"}),
                 ("limit=100", {"limit": 100}), ("perPage=100", {"perPage": 100}), ("pageSize=100", {"pageSize": 100}), ("size=100", {"size": 100})]:
    r2, ids2, emp2 = show(label, p)
    print("   differs from unfiltered:", bool(ids2) and ids2[:3] != ids0[:3], "| same employer:", len(set(emp2)) == 1 if emp2 else None)

print("\n--- scan depth: page through everything with the best-guess paging param")
best = None
for name in ["page", "pageNumber", "pageNo", "p"]:
    a = get({name: 2})[1]; b = get({name: 3})[1]
    if a and b and a[:1] != ids0[:1] and a[:1] != b[:1]:
        best = name; break
print("paging param that works:", best)
if best:
    seen, t0, end = set(), time.time(), None
    for pg in range(1, 301):
        r2, ids2, emp2, dt = get({best: pg})
        new = [i for i in ids2 if i not in seen]
        seen.update(ids2)
        if pg in (1, 2, 5, 10, 25, 50, 100, 200, 300) or not ids2:
            print(f"  page {pg:3}: {len(ids2)} adverts, {len(new)} new, total unique {len(seen)}, {dt}s")
        if not ids2 or not new:
            end = pg; break
        time.sleep(0.3)
    print(f"stopped at page {end}; unique adverts seen {len(seen)}; elapsed {round(time.time()-t0)}s")

print("\n--- main website results page (paging and count text)")
w = "https://www.jobs.nhs.uk/candidate/search/results"
for p in [{"keyword": "medical secretary", "language": "en"}, {"keyword": "medical secretary", "language": "en", "page": 2}]:
    r2 = requests.get(w, params=p, headers=H, timeout=60)
    txt = re.sub(r"<[^>]+>", " ", r2.text)
    m = re.search(r"([\d,]+)\s+(?:search\s+)?results?", txt, re.I)
    print(r2.status_code, len(r2.text), "count text:", m.group(0) if m else None, "| robots?", r2.headers.get("x-robots-tag"))
rb = requests.get("https://www.jobs.nhs.uk/robots.txt", headers=H, timeout=30)
print("\nrobots.txt", rb.status_code, rb.text[:700])
