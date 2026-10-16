"""Probe 4: validate the NHS Jobs employer-code approach against our practice list. Read-only."""
import os
import re
import sys
import time
from collections import Counter, defaultdict

import requests

sys.path.insert(0, ".")
from src.common import Rest  # noqa: E402

U = "https://www.jobs.nhs.uk/api/v1/search_xml"
H = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)"}
norm_pc = lambda s: re.sub(r"[^A-Z0-9]", "", (s or "").upper())
norm_nm = lambda s: re.sub(r"\b(the|and|&|ltd|limited|llp|cic|nhs)\b|[^a-z0-9 ]", "", (s or "").lower().replace("&amp;", "and")).split().__len__() and " ".join(re.sub(r"\b(the|and|ltd|limited|llp|cic)\b|[^a-z0-9 ]", " ", (s or "").lower().replace("&amp;", "and")).split())

rows, pg = [], 1
while True:
    t = requests.get(U, params={"limit": 100, "page": pg, "sort": "publicationDateDesc"}, headers=H, timeout=90).text
    blocks = re.findall(r"<vacancyDetails>.*?</vacancyDetails>", t, re.S)
    if not blocks:
        break
    for b in blocks:
        g = lambda n: (re.search(rf"<{n}>([^<]*)</{n}>", b) or [None, ""])[1].replace("&amp;", "&")
        rows.append(dict(id=g("id"), ref=g("reference"), title=g("title"), emp=g("employer"), post=g("postDate")[:10], url=g("url"),
                         locs=re.findall(r"<location>([^<]*)</location>", b), desc=g("description")))
    pg += 1
    time.sleep(0.2)
print("adverts scanned:", len(rows), "pages:", pg - 1)

# 1. employer-code first letter vs employer type
code = lambda r: r["ref"].split("-")[0]
by_letter = defaultdict(set)
for r in rows:
    by_letter[code(r)[:1]].add((code(r), r["emp"]))
print("\n[1] employer-code first letter -> employers / sample names")
for L, s in sorted(by_letter.items(), key=lambda x: -len(x[1])):
    names = sorted({e for _, e in s})
    print(f"  {L}: {len({c for c,_ in s})} codes, {len(names)} employers, e.g. {[n[:32] for n in names[:6]]}")
A_names = sorted({r['emp'] for r in rows if code(r).startswith('A')})
print("  all 'A' employers that do NOT look like a practice/PCN/federation/GP org:",
      [n for n in A_names if not re.search(r"surgery|practice|medical|health|centre|center|pcn|network|federation|partnership|gp|doctors|clinic|care|group", n, re.I)][:40])
print("  non-'A' employers that DO look like a practice:", sorted({r['emp'] for r in rows if not code(r).startswith('A') and re.search(r"surgery|medical practice|health centre|primary care network|\bpcn\b", r['emp'], re.I)})[:40])
one_code = defaultdict(set)
for r in rows:
    one_code[r["emp"]].add(code(r))
print("  employers with >1 code:", sum(1 for v in one_code.values() if len(v) > 1), "of", len(one_code))

# 2. match A-code employers to our practice list
url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if url and key:
    rest = Rest(url, key)
    prac = rest.select_all("gp_practices", "ods_code,practice_name,postcode,pcn_name,status", order="ods_code")
    by_pc = defaultdict(list)
    for p in prac:
        by_pc[norm_pc(p["postcode"])].append(p)
    emp_loc = defaultdict(lambda: {"pcs": set(), "n": 0})
    for r in rows:
        if code(r).startswith("A"):
            e = emp_loc[(code(r), r["emp"])]
            e["n"] += 1
            for l in r["locs"]:
                m = re.search(r"([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$", l.upper())
                if m:
                    e["pcs"].add(norm_pc(m.group(1)))
    exact_both = one_pc = amb = none = 0
    samples = {"exact_both": [], "pc_only": [], "ambiguous": [], "none": []}
    for (c, name), e in emp_loc.items():
        cands = {p["ods_code"]: p for pc in e["pcs"] for p in by_pc.get(pc, [])}
        eq = [p for p in cands.values() if norm_nm(p["practice_name"]) == norm_nm(name)]
        if len(eq) == 1:
            exact_both += 1; samples["exact_both"].append((c, name[:30], eq[0]["ods_code"]))
        elif len(cands) == 1:
            one_pc += 1; samples["pc_only"].append((c, name[:30], list(cands.values())[0]["practice_name"][:30]))
        elif len(cands) > 1:
            amb += 1; samples["ambiguous"].append((c, name[:30], [p["practice_name"][:20] for p in cands.values()][:3]))
        else:
            none += 1; samples["none"].append((c, name[:30], sorted(e["pcs"])[:2]))
    tot = len(emp_loc)
    print(f"\n[2] A-code employers: {tot}. exact postcode+name: {exact_both} | postcode-only single candidate: {one_pc} | several practices share the postcode: {amb} | no postcode match: {none}")
    for k, v in samples.items():
        print(f"  {k}:", v[:8])
else:
    print("\n[2] SUPABASE secrets not set; skipped")

# 3. role keywords in TITLE for A employers, and description length
ROLE = re.compile(r"subject access|\bsar\b|medico.?legal|summaris|medical records|health records|medical report|insurance report|medical secretary|records (?:clerk|officer|administrator|manager)|workflow|document|information governance|data protection|correspondence|coding", re.I)
hits = [r for r in rows if code(r).startswith("A") and ROLE.search(r["title"])]
print(f"\n[3] role-keyword titles at A-code employers: {len(hits)} (all board: {sum(1 for r in rows if ROLE.search(r['title']))})")
for r in hits[:30]:
    print("  ", r["post"], "|", r["emp"][:34], "|", r["title"][:60])
print("  description length max/avg:", max(len(r["desc"]) for r in rows), round(sum(len(r["desc"]) for r in rows) / len(rows)))
print("  descriptions mentioning SAR/subject access/reports among A-code:", sum(1 for r in rows if code(r).startswith("A") and re.search(r"subject access|\bsar\b|medico|reports", r["desc"], re.I)))

# 4. advert page: does it expose an ODS code / employer details?
if hits:
    u = hits[0]["url"]
    pg = requests.get(u, headers=H, timeout=60)
    txt = re.sub(r"<[^>]+>", " ", pg.text)
    txt = re.sub(r"\s+", " ", txt)
    print(f"\n[4] advert page {u} -> {pg.status_code}, {len(pg.text):,} bytes")
    print("  ODS-like codes in page:", sorted(set(re.findall(r"\b[A-Z]\d{5}\b", txt)))[:10])
    print("  mentions 'ODS':", "ODS" in txt, "| 'Employer name' block:", re.findall(r"Employer name\s*(.{0,80})", txt)[:2], "| 'Employer's website':", "website" in txt.lower())
    for m in re.finditer(r"(Address|Employer name|Job reference|Postcode)\s*[:]?\s*(.{0,70})", txt):
        print("  ", m.group(0)[:100]); break

# 5. terms
for tu in ["https://www.jobs.nhs.uk/terms", "https://www.jobs.nhs.uk/candidate/terms", "https://www.jobs.nhs.uk/robots.txt"]:
    try:
        r = requests.get(tu, headers=H, timeout=30)
        txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
        print(f"\n[5] {tu}: {r.status_code}, {len(txt)} chars; mentions scrap/automat/robot/api:", [w for w in ("scrap", "automat", "robot", "api", "bulk", "commercial") if w in txt.lower()])
    except Exception as e:  # noqa: BLE001
        print(tu, "ERR", e)
