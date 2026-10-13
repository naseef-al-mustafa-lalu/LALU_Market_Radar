"""Public NHS data sources: ODS practice list, PCN membership, registered patient counts."""
import io
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pandas as pd
import requests

from .common import ODS_RE, norm_ods

GP_REG_PAGE = "https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice"
UA = {"User-Agent": "LaluMarketRadar/1.0 (+https://lalu.co.uk)"}
BROWSER_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                   "Accept": "text/html,application/xhtml+xml,text/csv,*/*", "Accept-Language": "en-GB,en;q=0.9"}
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}


def fetch(url, timeout=120):
    r = requests.get(url, headers={"User-Agent": BROWSER_HEADERS["User-Agent"]}, timeout=timeout)
    r.raise_for_status()
    return r.content


def unzip_first(data, suffix=".csv"):
    if data[:2] != b"PK":
        return data
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(suffix)] or z.namelist()
        return z.read(names[0])


def _csv(data, **kw):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(io.BytesIO(data), dtype=str, keep_default_na=False, encoding=enc, **kw)
        except UnicodeDecodeError:
            continue
    raise ValueError("Could not decode CSV")


def load_patients(data):
    """gp-reg-pat-prac-all.csv -> ({ods: patients}, 'YYYY-MM')."""
    df = _csv(unzip_first(data))
    df.columns = [c.strip().upper() for c in df.columns]
    for need in ("CODE", "NUMBER_OF_PATIENTS"):
        if need not in df.columns:
            raise ValueError(f"GP registration file missing column {need}; has {list(df.columns)}")
    if "TYPE" in df.columns:
        df = df[df["TYPE"].str.upper() == "GP"]
    for col in ("SEX", "AGE"):
        if col in df.columns:
            df = df[df[col].str.upper() == "ALL"]
    df = df.assign(CODE=df["CODE"].map(norm_ods), N=pd.to_numeric(df["NUMBER_OF_PATIENTS"], errors="coerce"))
    df = df.dropna(subset=["CODE", "N"])
    if len(df) < 5000:
        raise ValueError(f"GP registration file yielded only {len(df)} practices")
    month = None
    if "EXTRACT_DATE" in df.columns:
        d = pd.to_datetime(df["EXTRACT_DATE"].iloc[0], dayfirst=True, errors="coerce")
        month = None if pd.isna(d) else d.strftime("%Y-%m")
    return df.groupby("CODE")["N"].sum().astype(int).to_dict(), month


def http_text(url, timeout=60):
    """GET a page as text with a browser-like UA (digital.nhs.uk rejects unknown clients); raises on HTTP errors."""
    r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
    r.raise_for_status()
    return r.text


def _absolute(link):
    return "https://digital.nhs.uk" + link if link.startswith("/") else link


def discover_gp_reg_url(get_text, today=None):
    """Find the newest gp-reg-pat-prac-all file link from the NHS monthly publication pages.

    Candidate month pages come from links on the landing page plus URLs built from the last 4 calendar months,
    so a change in landing-page markup alone cannot break discovery. Newest page that has the file wins.
    """
    today = today or date.today()
    names = {i: m for m, i in MONTHS.items()}
    cands, notes = {}, []
    for back in range(5):
        y, m = today.year, today.month - back
        if m < 1:
            y, m = y - 1, m + 12
        cands[(y, m)] = f"{GP_REG_PAGE}/{names[m]}-{y}"
    try:
        page = get_text(GP_REG_PAGE)
        for m in re.finditer(r"""href=["']([^"']*patients-registered-at-a-gp-practice/([a-z]+)-(\d{4}))/?["']""", page):
            if m.group(2) in MONTHS:
                cands[(int(m.group(3)), MONTHS[m.group(2)])] = _absolute(m.group(1))
    except Exception as e:  # noqa: BLE001  fall back to constructed URLs
        notes.append(f"landing page: {e}")
    for key in sorted(cands, reverse=True):
        try:
            files = re.findall(r"""href=["']([^"']*gp-reg-pat-prac-all\.(?:csv|zip))["']""", get_text(cands[key]))
        except Exception as e:  # noqa: BLE001
            notes.append(f"{cands[key]}: {e}")
            continue
        if files:
            return _absolute(files[0])
        notes.append(f"{cands[key]}: page loaded but no gp-reg-pat-prac-all link")
    raise ValueError("Could not find the GP registration file link. Set the GP_REG_URL variable to a direct link. Tried: "
                     + " | ".join(notes[:8]))


ODS_API = "https://directory.spineservices.nhs.uk/ORD/2-0-0"
ODS_EXPORT = "https://www.odsdatasearchandexport.nhs.uk/api/getReport?report="


ODS_HEADERS = {"User-Agent": BROWSER_HEADERS["User-Agent"]}  # exactly what was verified against the ODS API from GitHub runners


def get_json(url, params=None):
    last = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=ODS_HEADERS, timeout=60)
            if not r.ok:
                raise RuntimeError(f"{r.status_code} for {r.url}: {r.text[:300]}")
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def load_active_gp_practices(getj=get_json, page=500):
    """All active GP practices from the ODS API: {ods: {name, postcode}}."""
    out, offset = {}, 0
    while True:
        data = getj(f"{ODS_API}/organisations", {"PrimaryRoleId": "RO177", "NonPrimaryRoleId": "RO76",
                                                 "Status": "Active", "Limit": page, "Offset": offset})
        orgs = data.get("Organisations", [])
        before = len(out)
        for o in orgs:
            code = norm_ods(o.get("OrgId"))
            if code:
                out[code] = {"name": o.get("Name", ""), "postcode": o.get("PostCode", "")}
        if len(orgs) < page or len(out) == before:  # last page, or the API ignored Offset
            break
        offset += page
    if len(out) < 5000:
        raise ValueError(f"ODS API returned only {len(out)} active GP practices; refusing to continue")
    return out


def clean_icb(name):
    return re.sub(r"\s*-\s*[0-9A-Z]{3}$", "", str(name or "")).strip()


def load_pcn_names(data):
    """epcn export (headerless): col 0 PCN code, 1 name, 3 ICB name. Returns {pcn: (name, icb)}."""
    out = {}
    for row in _csv(data, header=None).values.tolist():
        code = str(row[0]).strip().upper()
        if re.match(r"^U\d{5}$", code):
            out[code] = (str(row[1]).strip(), clean_icb(row[3]) if len(row) > 3 else "")
    return out


def pcn_for_practice(detail):
    """Active PCN relationship (role RO272) from an ODS organisation record, newest first. None if absent."""
    rels = (detail.get("Organisation", {}).get("Rels") or {}).get("Rel") or []
    best = None
    for rel in rels:
        t = rel.get("Target", {})
        if rel.get("Status") != "Active" or t.get("PrimaryRoleId", {}).get("id") != "RO272":
            continue
        start = max((d.get("Start", "") for d in rel.get("Date", [])), default="")
        code = str(t.get("OrgId", {}).get("extension", "")).upper()
        if re.match(r"^U\d{5}$", code) and (best is None or start >= best[0]):
            best = (start, code)
    return best[1] if best else None


def fetch_pcn_codes(codes, getj=get_json, workers=12):
    """{ods: pcn_code or ''} for each practice looked up; practices whose lookup failed are omitted."""
    def one(code):
        try:
            return code, pcn_for_practice(getj(f"{ODS_API}/organisations/{code}")) or ""
        except Exception:  # noqa: BLE001  retried on a later run
            return code, None
    with ThreadPoolExecutor(workers) as ex:
        return {c: v for c, v in ex.map(one, codes) if v is not None}


def today_iso():
    return date.today().isoformat()
