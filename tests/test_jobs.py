from datetime import date

from src import jobs

XML = """<?xml version='1.0'?><nhsJobs><vacancyDetails><id>1</id><reference>A0095-26-0006</reference><title>Medical Secretary</title>
<employer>Little Common Surgery</employer><closeDate>2026-10-30</closeDate><postDate>2026-10-14T12:59:07</postDate>
<url>https://x/1</url><locations><location>Bexhill-on-sea, TN39 4SP</location></locations></vacancyDetails>
<vacancyDetails><id>2</id><reference>C9409-26-1</reference><title>Nurse</title><employer>Big Trust</employer><postDate>2026-10-01</postDate>
<url>u</url><locations><location>Prescot, L35 5DR</location></locations></vacancyDetails><totalPages>1</totalPages><totalResults>2</totalResults></nhsJobs>"""


class FakeRest:
    def __init__(self):
        self.t = {"job_employers": {}, "job_adverts": {}, "sales_triggers": [], "organisations": {}}

    def select_all(self, table, columns="*", order="id", params=None, page=1000):
        v = self.t[table]
        return [dict(r) for r in (v.values() if isinstance(v, dict) else v)]

    def upsert(self, table, rows, key, batch=500):
        for r in rows:
            self.t[table].setdefault(r[key], {}).update(r)

    def insert(self, table, rows, returning=False):
        self.t[table].extend(rows)


PRACT = [{"ods_code": "G83053", "practice_name": "Little Common Surgery", "postcode": "TN39 4SP", "status": "Active"},
         {"ods_code": "G11111", "practice_name": "Other Surgery", "postcode": "TN39 4SP", "status": "Active"}]


def test_parse_and_roles():
    total, rows = jobs.parse_page(XML)
    assert total == 2 and rows[0]["employer_code"] == "A0095" and rows[0]["post_date"] == "2026-10-14"
    assert jobs.role_of("Medical Secretary / Workflow Administrator") == "medical secretary"
    assert jobs.role_of("SAR Administrator") == "subject access / SAR"
    assert jobs.role_of("Digital Transformation Lead") == "digital transformation" and jobs.role_of("Primary Care Informatics Manager") == "digital transformation"
    assert jobs.role_of("Digital & Data Programme Officer") == "digital transformation" and jobs.role_of("IT Project Manager") == "digital transformation"
    assert jobs.role_of("Medical Records Clerk") == "records / summarising"      # a records role wins over a digital one
    assert jobs.role_of("Healthcare Assistant") is None and jobs.role_of("Receptionist") is None
    assert jobs.is_primary_employer("A0095", "x") and jobs.is_primary_employer("W0001", "Acclaim NHS PCN") and not jobs.is_primary_employer("C9409", "Big Trust")


def run(rest, today=date(2026, 10, 16)):
    adverts = jobs.parse_page(XML)[1]
    return jobs.sync(rest, PRACT, today=today, fetch=lambda: (adverts, len(adverts)))


def test_exact_match_signals_once_and_trust_ignored():
    rest = FakeRest()
    s = run(rest)
    assert s["job_employer_status"]["auto"] == 1 and s["job_role_adverts"] == 1 and s["job_signals"] == 1
    assert rest.t["job_employers"]["A0095"]["ods_code"] == "G83053" and "C9409" not in rest.t["job_employers"]
    assert rest.t["sales_triggers"][0]["trigger_type"] == "JOB_REPORT_ROLE" and rest.t["sales_triggers"][0]["ods_code"] == "G83053"
    assert run(rest)["job_signals"] == 0 and len(rest.t["sales_triggers"]) == 1       # never twice


def test_unlinked_employer_still_signals_and_decisions_survive():
    rest = FakeRest()
    p = [dict(PRACT[0], practice_name="Little Common Practice")]
    jobs_sync = lambda: jobs.sync(rest, p, today=date(2026, 10, 16), fetch=lambda: (jobs.parse_page(XML)[1], 2))
    s = jobs_sync()
    assert s["job_employer_status"]["review"] == 1 and s["job_signals"] == 1
    sig = rest.t["sales_triggers"][0]
    assert sig["employer_code"] == "A0095" and "ods_code" not in sig and "org_id" not in sig          # filed as unlinked, not lost
    assert rest.t["job_employers"]["A0095"]["candidates"][0]["ods_code"] == "G83053"                   # offered, not assumed
    rest.t["job_employers"]["A0095"].update(match_status="confirmed", ods_code="G83053")               # what link_job_employer does
    assert jobs_sync()["job_signals"] == 0                                                              # no duplicate after linking
    rest.t["job_employers"]["A0095"].update(match_status="rejected", ods_code=None)
    assert jobs_sync()["job_employer_status"]["rejected"] == 1                                          # decisions survive reruns


def test_pcn_employer_links_to_exact_network_name():
    xml = XML.replace("A0095-26-0006", "W0099-26-1").replace("Little Common Surgery", "Acclaim NHS PCN").replace("Medical Secretary", "Records Administrator")
    rest = FakeRest()
    rest.t["organisations"] = {"n1": {"id": "n1", "kind": "pcn", "name": "Acclaim PCN"}, "n2": {"id": "n2", "kind": "pcn", "name": "Other PCN"}}
    s = jobs.sync(rest, PRACT, today=date(2026, 10, 16), fetch=lambda: (jobs.parse_page(xml)[1], 2))
    assert s["job_employer_status"]["auto"] == 1 and rest.t["job_employers"]["W0099"]["org_id"] == "n1"
    assert rest.t["sales_triggers"][0]["org_id"] == "n1" and "ods_code" not in rest.t["sales_triggers"][0]
    rest2 = FakeRest(); rest2.t["organisations"] = {"n1": {"id": "n1", "kind": "pcn", "name": "Acclaim PCN"}, "n3": {"id": "n3", "kind": "federation", "name": "Acclaim Primary Care Network"}}
    s2 = jobs.sync(rest2, PRACT, today=date(2026, 10, 16), fetch=lambda: (jobs.parse_page(xml)[1], 2))
    assert s2["job_employer_status"]["network"] == 1 and rest2.t["sales_triggers"][0]["employer_code"] == "W0099"      # two equal names: not guessed


def test_old_adverts_load_silently():
    rest = FakeRest()
    assert run(rest, today=date(2026, 12, 1))["job_signals"] == 0 and rest.t["job_adverts"]["1"]["signalled"] is True


def test_signal_batch_rows_share_the_same_keys():
    """One run with a linked and an unlinked advert must insert rows with identical keys (PostgREST rejects mixed keys)."""
    rest = FakeRest()
    inserted = []
    orig = rest.insert
    rest.insert = lambda table, rows, **kw: (inserted.append(rows) if table == "sales_triggers" else None) or orig(table, rows, **kw)
    ads = jobs.parse_page(XML)[1]
    extra = dict(ads[0], advert_id="99", reference="A7777-26-0001", employer_code="A7777", employer="Nowhere Surgery", title="Digital Transformation Lead", post_date="2026-10-15", url="https://x/99", locations=[])
    jobs.sync(rest, PRACT, today=date(2026, 10, 16), fetch=lambda: (ads + [extra], len(ads) + 1))
    rows = [r for batch in inserted for r in batch]
    assert len(rows) >= 2 and len({tuple(sorted(r)) for r in rows}) == 1


class _R:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


def test_blocked_feed_falls_back_without_retrying_the_block(monkeypatch):
    monkeypatch.setattr(jobs, "MIN_EXPECTED", 1)
    monkeypatch.setattr(jobs.time, "sleep", lambda s: None)
    empty = "<results><totalResults>1</totalResults></results>"
    direct = []
    def blocked(url, **kw):
        direct.append(kw["params"]["page"]); return _R(403, "blocked")
    proxied = []
    def via_proxy(url, **kw):
        proxied.append(kw["params"]["page"]); return _R(200, XML if kw["params"]["page"] == 1 else empty)
    adverts, _ = jobs.fetch_all(get=blocked, fallback=via_proxy)
    assert len(direct) == 1 and proxied == [1, 2] and jobs.SCAN["via"] == "supabase" and adverts      # one direct try (a 403 is not retried), then every page via the fallback
    import pytest
    with pytest.raises(RuntimeError, match="HTTP 403"):
        jobs.fetch_all(get=blocked)                                                                     # no fallback: fails, naming the status


def test_scan_guard_skips_a_recent_scan():
    from datetime import datetime, timezone
    from src import ingest
    rest = FakeRest()
    rest.t.setdefault("kv_state", {})["jobs_scan"] = {"key": "jobs_scan", "value": {"at": datetime.now(timezone.utc).isoformat()}}
    stats = {}
    ingest.jobs_step(rest, {}, {}, {}, stats)
    assert "jobs_skipped" in stats and "jobs_error" not in stats
