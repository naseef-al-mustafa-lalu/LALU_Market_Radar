"""End-to-end ingest with in-memory fakes of the Supabase REST client and NHS sources."""
import pytest

from src import ingest, sources
from tests.conftest import make_oscar, make_patients


class FakeRest:
    def __init__(self):
        self.t = {"gp_practices": {}, "contacts": {}, "patient_counts": {}, "kv_state": {}, "ingest_runs": [], "ingest_rejects": [], "practice_branches": {}}

    def select_all(self, table, columns="*", order="id", params=None, page=1000):
        rows = self.t[table]
        rows = list(rows.values()) if isinstance(rows, dict) else rows
        if table == "kv_state" and params and "key" in params:
            k = params["key"].split(".", 1)[1]
            return [dict(self.t[table][k])] if k in self.t[table] else []
        if params and "status" in params:
            rows = [r for r in rows if r["status"] == params["status"].split(".")[1]]
        return [dict(r) for r in rows]

    def upsert(self, table, rows, on_conflict, batch=500):
        for r in rows:
            cur = self.t[table].setdefault(r[on_conflict], {})
            cur.update(r)
            if table == "gp_practices":
                cur.setdefault("lead_status", "Cold")

    def rpc(self, name, args=None):
        self.t.setdefault("rpc_calls", []).append(name)
        return {"organisations": 0, "relationships": 0}

    def insert(self, table, rows, batch=500, returning=False):
        if table == "ingest_runs":
            rows = [{"id": len(self.t[table]) + 1, "status": "running"}]
        self.t[table] += rows
        return rows if returning else []

    def patch(self, table, filters, values):
        self.t[table][int(filters["id"].split(".")[1]) - 1].update(values)

    def delete_in(self, table, column, values, chunk=200):
        for v in values:
            self.t[table].pop(v)


def patch_sources(monkeypatch, oscar_bytes, n=5200, with_counts=True, rest=None):
    active = {f"A{i + 10000:05d}": {"name": f"TEST SURGERY {i}", "postcode": "AB1 2CD"} for i in range(n)}
    monkeypatch.setattr(sources, "load_active_gp_practices", lambda: active)
    monkeypatch.setattr(sources, "fetch", lambda url, timeout=0: b'"U11111","PCN ONE","X","NHS TEST ICB - 99Z","2024"\n' if "epcn" in url else oscar_bytes)
    monkeypatch.setattr(sources, "fetch_pcn_codes", lambda codes: {c: ("U11111" if c == "A10000" else "") for c in codes})
    monkeypatch.setattr(sources, "fetch_ods_dates", lambda codes: {c: ("2013-04-01", None) for c in codes})
    monkeypatch.setattr(ingest, "DATES_DAILY_CAP", 10**6)
    monkeypatch.setattr(sources, "load_active_branches", lambda: {"J4Q3U": {"name": "BRANCH", "postcode": "AB1 2CD"}, "J4Q3V": {"name": "OTHER", "postcode": "AB1 2CD"}})
    monkeypatch.setattr(ingest, "BRANCH_MIN", 1)
    monkeypatch.setattr(sources, "fetch_branch_details", lambda codes: {c: {"branch_code": c, "branch_name": "Branch " + c, "parent_code": "A10000" if c == "J4Q3U" else "Y06528", "parent_role": "RO177" if c == "J4Q3U" else "RO98"} for c in codes})
    monkeypatch.setattr(sources, "fetch_parent_info", lambda codes: {c: "Some CCG" for c in codes})
    monkeypatch.setattr(sources, "role_names", lambda: {"RO177": "Prescribing Cost Centre", "RO98": "Clinical Commissioning Group"})
    monkeypatch.setattr(ingest.software, "check_many", lambda d: {k: "Unknown" for k in d})
    monkeypatch.setenv("OSCAR_API_URL", "http://oscar")
    if rest is not None and with_counts:
        pats, month = sources.load_patients(make_patients(n))
        rest.t["patient_counts"] = {c: {"ods_code": c, "patients": v, "data_month": "2099-01"} for c, v in pats.items()}
    return active


def test_full_run_then_idempotent(monkeypatch, oscar_rows):
    rest = FakeRest()
    patch_sources(monkeypatch, make_oscar(oscar_rows), rest=rest)
    stats = ingest.sync(rest, 1)
    db = rest.t["gp_practices"]
    assert len(db) == 5200 and db["A10000"]["practice_name"] == "Test Surgery 0" and db["A10000"]["total_patients"] == 5000
    assert db["A10000"]["manager_name"] == "Casper Fons" and db["A10000"]["pcn_code"] == "U11111" and db["A10000"]["pcn_name"] == "PCN One"
    assert db["A10000"]["icb_name"] == "NHS Test ICB" and db["A10001"]["pcn_name"] == "Unallocated PCN"
    assert db["A10001"]["manager_email_opt_out"] is True and len(rest.t["contacts"]) == 3
    b = rest.t["practice_branches"]
    assert b["J4Q3U"]["kind"] == "gp_practice" and b["J4Q3U"]["parent_name"] == "Test Surgery 0" and b["J4Q3U"]["parent_role_name"] == "Prescribing Cost Centre"
    assert b["J4Q3V"]["kind"] == "non_gp" and b["J4Q3V"]["parent_name"] == "Some CCG" and stats["branches_not_gp"] == 1
    assert stats["oscar_suppressed"] == 1 and len(rest.t["ingest_rejects"]) == 2 and stats["pcn_mapped"] == 1
    # second run: nothing changed except lookups already recorded -> no practice writes
    stats2 = ingest.sync(rest, 2)
    assert stats2["practices_changed"] == 0 and stats2["contacts_changed"] == 0


def test_runs_without_patient_counts_or_oscar(monkeypatch):
    rest = FakeRest()
    patch_sources(monkeypatch, b"", rest=rest, with_counts=False)
    monkeypatch.delenv("OSCAR_API_URL")
    stats = ingest.sync(rest, 1)
    assert stats["patients_missing"] and "OSCAR_API_URL not set" in stats["oscar_error"]
    assert len(rest.t["gp_practices"]) == 5200 and rest.t["gp_practices"]["A10000"]["total_patients"] == 0


def test_closure_detected_and_mass_closure_guard(monkeypatch, oscar_rows):
    rest = FakeRest()
    active = patch_sources(monkeypatch, make_oscar(oscar_rows), rest=rest)
    ingest.sync(rest, 1)
    gone = dict(active); gone.pop("A10005")
    monkeypatch.setattr(sources, "load_active_gp_practices", lambda: gone)
    ingest.sync(rest, 2)
    assert rest.t["gp_practices"]["A10005"]["status"] == "Closed"
    few = {k: v for i, (k, v) in enumerate(active.items()) if i < 5100}
    monkeypatch.setattr(sources, "load_active_gp_practices", lambda: few)
    with pytest.raises(RuntimeError, match="feed error"):
        ingest.sync(rest, 3)


def test_oscar_failure_keeps_existing_managers(monkeypatch, oscar_rows):
    rest = FakeRest()
    patch_sources(monkeypatch, make_oscar(oscar_rows), rest=rest)
    ingest.sync(rest, 1)
    patch_sources(monkeypatch, b"garbage", rest=rest)
    stats = ingest.sync(rest, 2)
    assert "oscar_error" in stats and rest.t["gp_practices"]["A10000"]["manager_name"] == "Casper Fons"


def test_cqc_wired_into_daily_run(monkeypatch, oscar_rows):
    from tests.test_cqc_oscar import FakeCqc
    rest = FakeRest()
    patch_sources(monkeypatch, make_oscar(oscar_rows), rest=rest)
    api = FakeCqc()
    api.pc = {"1-1": "AB1 2CD", "1-2": "ZZ9 9ZZ", "1-3": "AB1 2CD", "1-4": "AB1 2CD"}
    monkeypatch.setattr(ingest.cqc, "make_client", lambda key: api)
    monkeypatch.setenv("CQC_API_KEY", "x")
    stats = ingest.sync(rest, 1)
    db = rest.t["gp_practices"]
    assert "cqc_error" not in stats and stats["cqc_matched"] == 2
    assert db["A10000"]["cqc_rating"] == "Good" and db["A10000"]["cqc_location_id"] == "1-1" and db["A10000"]["practice_name"] == "Test Surgery 0"
    assert db["A10001"]["cqc_rating"] == "Requires improvement"
