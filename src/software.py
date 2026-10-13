"""Conservative clinical-system hint from a practice website. Only explicit vendor markers count."""
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import requests

MARKERS = {
    "EMIS Web": ("emisaccess.co.uk", "emishealth.com", "emis web"),
    "SystmOne": ("tpp-uk.com", "systmonline", "systmone"),
    "Vision": ("visionhealth.co.uk", "vision online services"),
}


def classify(html):
    text = html.lower()
    hits = [name for name, keys in MARKERS.items() if any(k in text for k in keys)]
    return hits[0] if len(hits) == 1 else "Unknown"  # no marker, or conflicting markers


def normalise_url(url):
    url = (url or "").strip()
    if not url or url.lower() in ("none", "nan"):
        return None
    if "://" not in url:
        if ":" in url.split("/")[0]:  # javascript:, mailto:, tel: ...
            return None
        url = "https://" + url
    p = urlparse(url)
    return url if p.scheme in ("http", "https") and p.netloc else None


def check_one(url):
    try:
        r = requests.get(url, timeout=8, headers={"User-Agent": "LaluMarketRadar/1.0"}, stream=True)
        if r.status_code != 200:
            return "Unknown"
        return classify(r.raw.read(600_000, decode_content=True).decode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001  (any network failure just means 'no hint')
        return "Unknown"


def check_many(urls_by_ods, workers=16):
    items = list(urls_by_ods.items())
    with ThreadPoolExecutor(workers) as ex:
        return dict(zip((k for k, _ in items), ex.map(check_one, (u for _, u in items))))
