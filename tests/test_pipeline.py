"""End-to-end ingest with an in-memory fake of the Supabase REST client."""
from src import ingest, sources
from tests.conftest import make_epraccur, make_oscar, make_patients, zipped


class FakeRest:
    def __init__(self):
        self.t = {"gp_practices": {}, "contacts": {}, "ingest_runs": [], "ingest_rejects": []}

    def select_all(self, table, columns="*", order="id", params=None, page=1000):
        rows = self.t[table]
        rows = list(rows.values()) if isinstance(rows, dict) else rows
        if params and "status" in params:
            rows = [r for r in rows if r["status"] == params["status"].split(".")[1]]
        return [dict(r) for r in rows]

    def upsert(self, table, rows, on_conflict, batch=500):
        for r in rows:
            cur = self.t[table].setdefault(r[on_conflict], {})
            cur.update(r)
            if table == "gp_practices":
                cur.setdefault("lead_status", "Cold")

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


def patch_sources(monkeypatch, patients, oscar_bytes, ods=None):
    ods = ods or make_epraccur()
    store = {"epraccur.zip": zipped("epraccur.csv", ods), "epcmem.zip": b"A10000,U11111,20240101\n",
             "epcn.zip": b"U11111,PCN ONE\n", "gp": patients, "oscar": oscar_bytes}
    def fetch(url, timeout=0):
        return store["gp"] if url == "http://gp" else store["oscar"] if "oscar" in url else store[url.rsplit("/", 1)[-1]]
    monkeypatch.setattr(sources, "fetch", fetch)
    monkeypatch.setenv("GP_REG_URL", "http://gp")
    monkeypatch.setenv("OSCAR_API_URL", "http://oscar")
    monkeypatch.setattr(ingest.software, "check_many", lambda d: {k: "Unknown" for k in d})


def test_full_run_baseline_then_changes(monkeypatch, oscar_rows):
    rest = FakeRest()
    patch_sources(monkeypatch, make_patients(), make_oscar(oscar_rows))
    stats = ingest.sync(rest, 1)
    db = rest.t["gp_practices"]
    assert len(db) == 5199  # historic closed practice never loaded
    assert db["A10000"]["manager_name"] == "Casper Fons" and db["A10000"]["pcn_name"] == "PCN ONE"
    assert db["A10001"]["manager_email_opt_out"] is True
    assert len(rest.t["contacts"]) == 3 and stats["oscar_suppressed"] == 1
    assert len(rest.t["ingest_rejects"]) == 2  # bad URN, bad ODS code

    # unchanged second run writes nothing
    rest.t["ingest_runs"].append({"status": "success"})
    before = {k: dict(v) for k, v in db.items()}
    recs, _ = ingest.build_records(sources.load_ods_practices(zipped("e.csv", make_epraccur()), set()),
                                   sources.load_patients(make_patients())[0], "2026-10", db, {}, None, None)
    assert recs == [] and before == db


def test_guards(monkeypatch, oscar_rows):
    import pytest
    patch_sources(monkeypatch, make_patients(n=2000), make_oscar(oscar_rows))
    with pytest.raises(ValueError):
        ingest.sync(FakeRest(), 1)  # too few patient rows


def test_oscar_failure_keeps_existing_managers(monkeypatch, oscar_rows):
    rest = FakeRest()
    patch_sources(monkeypatch, make_patients(), make_oscar(oscar_rows))
    ingest.sync(rest, 1)
    patch_sources(monkeypatch, make_patients(), b"garbage")
    stats = ingest.sync(rest, 2)
    assert "oscar_error" in stats and rest.t["gp_practices"]["A10000"]["manager_name"] == "Casper Fons"


def test_runs_without_oscar_url(monkeypatch):
    rest = FakeRest()
    patch_sources(monkeypatch, make_patients(), b"")
    monkeypatch.delenv("OSCAR_API_URL")
    stats = ingest.sync(rest, 1)
    assert "OSCAR_API_URL not set" in stats["oscar_error"] and len(rest.t["gp_practices"]) == 5199
    assert rest.t["contacts"] == {}
