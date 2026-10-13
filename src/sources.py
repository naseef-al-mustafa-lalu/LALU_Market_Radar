"""Public NHS data sources: ODS practice list, PCN membership, registered patient counts."""
import io
import re
import zipfile
from datetime import date

import pandas as pd
import requests

from .common import ODS_RE, norm_ods

ODS_BASE = "https://files.digital.nhs.uk/assets/ods/current"
GP_REG_PAGE = "https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice"
UA = {"User-Agent": "LaluMarketRadar/1.0 (+https://lalu.co.uk)"}
BROWSER_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                   "Accept": "text/html,application/xhtml+xml,text/csv,*/*", "Accept-Language": "en-GB,en;q=0.9"}
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}


def fetch(url, timeout=120):
    r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
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


def load_ods_practices(data, patient_codes=None):
    """epraccur.csv (headerless). Returns {ods: {name, postcode, status}} for GP practices.

    Col 0 code, 1 name, 9 postcode, 12 status (A/C/D/P), 25 prescribing setting (4 = GP practice).
    """
    df = _csv(unzip_first(data), header=None)
    if df.shape[1] < 13:
        raise ValueError(f"epraccur format changed: only {df.shape[1]} columns")
    is_gp = (df[25] == "4") if df.shape[1] > 25 else pd.Series(False, index=df.index)
    if is_gp.sum() < 1000:  # setting column missing or moved: fall back to presence in the GP register
        if not patient_codes:
            raise ValueError("epraccur: cannot identify GP practices (setting column 25 empty)")
        is_gp = df[0].str.upper().isin(patient_codes)
    out = {}
    for _, r in df[is_gp].iterrows():
        code, status = norm_ods(r[0]), {"A": "Active", "C": "Closed"}.get(r[12].strip().upper())
        if code and status:
            out[code] = {"name": r[1], "postcode": r[9] if df.shape[1] > 9 else "", "status": status}
    if sum(v["status"] == "Active" for v in out.values()) < 5000:
        raise ValueError(f"epraccur yielded only {len(out)} practices; refusing to continue")
    return out


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


def _scan_rows(data):
    df = _csv(unzip_first(data), header=None)
    return df.values.tolist()


def load_pcn_map(members_data, names_data):
    """Best-effort PCN mapping, tolerant of column layout: finds Uxxxxx PCN codes and practice codes in each row.

    Returns {ods: (pcn_code, pcn_name)}. Where a practice has several rows the row with the latest date wins.
    """
    names = {}
    for row in _scan_rows(names_data):
        if re.match(r"^U\d{5}$", str(row[0]).strip().upper()):
            names[str(row[0]).strip().upper()] = str(row[1]).strip()
    best = {}
    for row in _scan_rows(members_data):
        cells = [str(c).strip().upper() for c in row]
        pcn = next((c for c in cells if re.match(r"^U\d{5}$", c)), None)
        prac = next((c for c in cells if ODS_RE.match(c)), None)
        if not (pcn and prac):
            continue
        dates = [c for c in cells if re.match(r"^20\d{6}$", c)]
        key = max(dates) if dates else "0"
        if prac not in best or key >= best[prac][0]:
            best[prac] = (key, pcn)
    return {p: (pcn, names.get(pcn, pcn)) for p, (_, pcn) in best.items()}


def today_iso():
    return date.today().isoformat()
