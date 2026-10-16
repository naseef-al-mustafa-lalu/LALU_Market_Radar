"""Probe 6: is the advert's 'contact for further information' in the API, and what does the advert page show? Read-only."""
import io
import re
import zipfile

import requests

H = {"User-Agent": "Mozilla/5.0 (compatible; LaluMarketRadarProbe/1.0)"}
SPEC = "https://www.nhsbsa.nhs.uk/sites/default/files/2026-05/NHS%20Jobs%20Self-Serve%20Job%20Adverts%20API%20V1.07_0.docx"
z = zipfile.ZipFile(io.BytesIO(requests.get(SPEC, headers=H, timeout=60).content))
xml = z.read("word/document.xml").decode("utf8", "ignore")
paras = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", p)).strip() for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)]
print("SPEC paragraphs mentioning contact / email / phone / telephone:")
for p in paras:
    if re.search(r"contact|e-?mail|phone|telephone", p, re.I):
        print(" -", p[:240])
print("\nSPEC: field names listed (short paragraphs that look like tags):")
print([p for p in paras if re.fullmatch(r"[a-zA-Z]{3,30}", p)][:80])

# one live advert from a GP practice, and what its page shows about contacts
t = requests.get("https://www.jobs.nhs.uk/api/v1/search_xml", params={"keyword": "medical secretary", "limit": 40, "sort": "publicationDateDesc"}, headers=H, timeout=60).text
pairs = re.findall(r"<reference>(A\d{4}-[^<]+)</reference>.*?<url>([^<]+)</url>", t, re.S)
print("\nadverts from A-code employers found:", len(pairs))
for ref, url in pairs[:5]:
    html = requests.get(url, headers=H, timeout=60).text
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
    i = txt.lower().find("contact")
    print("\n==", ref, url, len(html), "bytes")
    for m in re.finditer(r"(Job contact|Contact details|For further details|Name\s|Job title\s|Email address|Telephone number|Phone)", txt):
        pass
    j = re.search(r"(Contact details|Job contact|further details)", txt, re.I)
    print("  contact block:", txt[j.start(): j.start() + 420] if j else "NO CONTACT SECTION FOUND")
    print("  emails on page:", sorted(set(re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", txt)))[:5], "| phones:", sorted(set(re.findall(r"\b0\d{3,4}[ ]?\d{3}[ ]?\d{3,4}\b", txt)))[:5])
