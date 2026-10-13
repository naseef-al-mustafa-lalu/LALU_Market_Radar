"""Shared helpers: config, Supabase REST client, text cleaning, alert mail."""
import html
import os
import re
import sys

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ODS_RE = re.compile(r"^[A-Z][0-9]{5}$")  # GP practice ODS code: 1 letter + 5 digits
ACRONYMS = {"NHS", "GP", "PCN", "ICB", "UK", "CCG", "LLP", "PMS", "GMS", "HC", "MC", "OOH"}
SMALL_WORDS = {"AND", "OF", "THE", "AT", "IN", "ON", "FOR"}


def need_env(*names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        sys.exit(f"Missing required environment variables: {', '.join(missing)}")


def norm_ods(value):
    """Return a normalised ODS code or None if it is not a valid GP practice code."""
    code = str(value or "").strip().upper()
    return code if ODS_RE.match(code) else None


def title_case(text):
    """Title-case NHS-style ALL CAPS names; leave mixed-case text untouched."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text or text != text.upper():
        return text
    first = True

    def fix(m):
        nonlocal first
        w = m.group(0)
        if w in ACRONYMS:
            out = w
        elif w in SMALL_WORDS and not first:
            out = w.lower()
        else:
            out = w.capitalize()
        first = False
        return out

    return re.sub(r"[A-Za-z][A-Za-z']*", fix, text)


def esc(value):
    return html.escape(str(value if value is not None else ""), quote=True)


class Rest:
    """Minimal PostgREST client using the service-role key (bypasses RLS)."""

    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})
        retry = Retry(total=5, backoff_factor=1.5, status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=None)
        self.s.mount("https://", HTTPAdapter(max_retries=retry))

    @staticmethod
    def _ok(r):
        if not r.ok:
            raise RuntimeError(f"{r.request.method} {r.url.split('?')[0]} -> {r.status_code}: {r.text[:300]}")
        return r

    def select_all(self, table, columns="*", order="id", params=None, page=1000):
        rows, offset = [], 0
        while True:
            q = {"select": columns, "order": order, "limit": page, "offset": offset, **(params or {})}
            chunk = self._ok(self.s.get(f"{self.base}/{table}", params=q, timeout=60)).json()
            rows += chunk
            if len(chunk) < page:
                return rows
            offset += page

    def upsert(self, table, rows, on_conflict, batch=500):
        for i in range(0, len(rows), batch):
            self._ok(self.s.post(
                f"{self.base}/{table}", params={"on_conflict": on_conflict}, json=rows[i:i + batch], timeout=120,
                headers={"Prefer": "resolution=merge-duplicates,missing=default,return=minimal"}))

    def insert(self, table, rows, batch=500, returning=False):
        out = []
        for i in range(0, len(rows), batch):
            r = self._ok(self.s.post(
                f"{self.base}/{table}", json=rows[i:i + batch], timeout=60,
                headers={"Prefer": "return=representation" if returning else "return=minimal"}))
            if returning:
                out += r.json()
        return out

    def patch(self, table, filters, values):
        self._ok(self.s.patch(f"{self.base}/{table}", params=filters, json=values, timeout=60,
                              headers={"Prefer": "return=minimal"}))

    def rpc(self, name, args=None):
        return self._ok(self.s.post(f"{self.base}/rpc/{name}", json=args or {}, timeout=300)).json()

    def delete_in(self, table, column, values, chunk=200):
        for i in range(0, len(values), chunk):
            ids = ",".join(str(v) for v in values[i:i + chunk])
            self._ok(self.s.delete(f"{self.base}/{table}", params={column: f"in.({ids})"}, timeout=60))


def send_email(subject, html_body, to):
    r = requests.post(
        "https://api.resend.com/emails", timeout=30,
        headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}"},
        json={"from": os.environ.get("DIGEST_FROM") or "Lalu Market Radar <radar@lalu.co.uk>",
              "to": to, "subject": subject, "html": html_body})
    if r.status_code not in (200, 201, 202):
        raise RuntimeError(f"Resend rejected email: {r.status_code} {r.text[:300]}")


def recipients():
    return [x.strip() for x in os.environ.get("DIGEST_TO", "sales-leads@lalu.co.uk").split(",") if x.strip()]


def send_alert(subject, body):
    """Best-effort failure notification; never raises."""
    try:
        send_email(subject, f"<pre style='font-family:monospace'>{esc(body)}</pre>", recipients())
    except Exception as e:  # noqa: BLE001
        print(f"alert email failed: {e}", file=sys.stderr)
