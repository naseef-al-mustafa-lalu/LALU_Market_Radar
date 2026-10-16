"""Probe 3: size of the whole NHS Jobs feed, max page size, GP-like employers, newest-first scanning. Read-only."""
import re
import time
from collections import Counter

import requests

U = "https://www.jobs.nhs.uk/api/v1/search_xml"
H = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)"}


def get(p):
    r = requests.get(U, params=p, headers=H, timeout=90)
    return r.text


def tag(t, n):
    m = re.search(rf"<{n}>(\d+)</{n}>", t)
    return int(m.group(1)) if m else None


t = get({})
print("no params: totalResults", tag(t, "totalResults"), "totalPages", tag(t, "totalPages"))
for lim in (50, 100, 250, 500, 1000):
    t = get({"limit": lim})
    print(f"limit={lim}: adverts={len(re.findall('<vacancyDetails>', t))} totalResults={tag(t,'totalResults')} totalPages={tag(t,'totalPages')} bytes={len(t):,}")

print("\nfull scan, limit=100, newest first")
GP = re.compile(r"surgery|practice|medical (?:centre|group)|health (?:centre|center)|primary care network|\bpcn\b|federation|group practice|partnership|medical", re.I)
seen, emp, rows = set(), Counter(), []
pg, t0, total = 1, time.time(), None
while pg <= 400:
    t = get({"limit": 100, "page": pg, "sort": "publicationDateDesc"})
    total = total or tag(t, "totalResults")
    blocks = re.findall(r"<vacancyDetails>.*?</vacancyDetails>", t, re.S)
    if not blocks:
        break
    new = 0
    for b in blocks:
        i = re.search(r"<id>(\d+)</id>", b).group(1)
        if i in seen:
            continue
        seen.add(i); new += 1
        e = re.search(r"<employer>([^<]*)</employer>", b); ref = re.search(r"<reference>([^<]*)</reference>", b); ti = re.search(r"<title>([^<]*)</title>", b)
        pd = re.search(r"<postDate>([^<]*)</postDate>", b); loc = re.findall(r"<location>([^<]*)</location>", b)
        rows.append((e.group(1) if e else "", ref.group(1) if ref else "", ti.group(1) if ti else "", pd.group(1)[:10] if pd else "", loc[:1]))
    if pg in (1, 2, 5, 10, 20, 40, 60, 80, 100, 150, 200) or not new:
        print(f"  page {pg}: {len(blocks)} adverts, {new} new, unique so far {len(seen)}, elapsed {round(time.time()-t0)}s")
    if not new:
        break
    pg += 1
    time.sleep(0.2)
print(f"\nscan ended page {pg}; unique adverts {len(seen)}; feed says total {total}; elapsed {round(time.time()-t0)}s")
dates = sorted(r[3] for r in rows if r[3])
print("posted dates span:", dates[:1], "to", dates[-1:], "| posted in last 2 days:", sum(1 for d in dates if d >= "2026-10-14"))
emps = Counter(r[0] for r in rows)
print("distinct employers:", len(emps))
gp = Counter({e: c for e, c in emps.items() if GP.search(e) and not re.search(r"nhs (?:foundation )?trust|university", e, re.I)})
print("GP-like employers:", len(gp), "adverts:", sum(gp.values()))
print("sample GP-like employers:", [(e[:40], c) for e, c in gp.most_common(25)])
ROLE = re.compile(r"subject access|\bsar\b|medico.?legal|summaris|medical records|medical report|insurance report|medical secretary|records (?:clerk|officer|administrator)|information governance|data protection", re.I)
hits = [r for r in rows if ROLE.search(r[2])]
print("\nadverts with a role keyword IN THE TITLE:", len(hits), "| of which GP-like employers:", sum(1 for r in hits if r[0] in gp))
for r in hits[:40]:
    print("  ", r[3], "|", r[0][:40], "|", r[2][:60], "|", r[1], "|", r[4])
code = Counter(r[1].split("-")[0] for r in rows)
print("\nemployer-code prefixes seen:", len(code), "| codes per employer name (max):", max(Counter(frozenset([(r[0], r[1].split('-')[0])]) and r[0] for r in rows).values()))
