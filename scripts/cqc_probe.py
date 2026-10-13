"""Diagnostic: what does the CQC public API return for our key? (key is never printed)"""
import json
import os
import requests

KEY = os.environ["CQC_API_KEY"]
H = {"Ocp-Apim-Subscription-Key": KEY, "User-Agent": "LaluMarketRadar/1.0", "Accept": "application/json"}
BASES = ["https://api.service.cqc.org.uk/public/v1", "https://api.cqc.org.uk/public/v1"]


def show(label, url, params=None):
    try:
        r = requests.get(url, headers=H, params=params, timeout=60)
        body = r.text
        print(f"[{r.status_code}] {label}: {r.url.replace(KEY, '***')}")
        try:
            j = r.json()
            print("   keys:", list(j)[:15] if isinstance(j, dict) else type(j).__name__)
            print("   ", json.dumps(j)[:700])
            return j
        except ValueError:
            print("   ", body[:300].replace("\n", " "))
    except Exception as e:  # noqa: BLE001
        print(f"[ERR] {label}: {e}")


for base in BASES:
    print("=====", base)
    j = show("locations list", f"{base}/locations", {"perPage": 2})
    if not (isinstance(j, dict) and j.get("locations")):
        continue
    lid = j["locations"][0]["locationId"]
    d = show("location detail", f"{base}/locations/{lid}")
    if isinstance(d, dict):
        print("   detail keys:", sorted(d))
        print("   odsCode:", d.get("odsCode"), "| status:", d.get("registrationStatus"), "| ratings:", json.dumps(d.get("currentRatings"))[:200],
              "| lastInspection:", d.get("lastInspection"), "| lastReport:", d.get("lastReport"))
    show("by ODS code", f"{base}/locations", {"odsCode": "A81001", "perPage": 2})
    show("GP category filter", f"{base}/locations", {"inspectionCategory": "S2", "perPage": 2})
    show("GP service type filter", f"{base}/locations", {"gacServiceType": "Doctors/GPs", "perPage": 2})
    show("changes feed", f"{base}/changes/location", {"startTimestamp": "2026-10-12T00:00:00Z", "endTimestamp": "2026-10-13T00:00:00Z"})
    show("providers", f"{base}/providers", {"perPage": 1})
    break
