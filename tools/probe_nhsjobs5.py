"""Probe 5: read the public NHS Jobs Self-Serve API spec (docx) for parameters and any usage terms. Read-only."""
import io
import re
import zipfile

import requests

H = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)"}
URLS = ["https://www.nhsbsa.nhs.uk/sites/default/files/2026-05/NHS%20Jobs%20Self-Serve%20Job%20Adverts%20API%20V1.07_0.docx",
        "https://www.nhsbsa.nhs.uk/sites/default/files/2023-07/NHS%20Jobs%20External%20Job%20Board%20Vacancy%20API%20specification.docx"]
for u in URLS:
    print("\n=====", u.split("/")[-1])
    try:
        r = requests.get(u, headers=H, timeout=60)
        print("status", r.status_code, len(r.content), "bytes")
        z = zipfile.ZipFile(io.BytesIO(r.content))
        xml = z.read("word/document.xml").decode("utf8", "ignore")
        paras = [re.sub(r"<[^>]+>", "", p) for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)]
        paras = [re.sub(r"\s+", " ", p).strip() for p in paras if p.strip()]
        print("paragraphs:", len(paras))
        KEYS = re.compile(r"employerCode|employer code|ODS|licen[cs]e|terms|rate limit|throttl|requests per|commercial|third.part|public|permitted|attribution|must not|not be used|confidential|NDA|page|limit|sort|keyword|totalResults|api key|authentic", re.I)
        shown = 0
        for p in paras:
            if KEYS.search(p) and shown < 70:
                print(" -", p[:260]); shown += 1
    except Exception as e:  # noqa: BLE001
        print("ERR", str(e)[:200])
