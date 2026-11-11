import pytest

from src import notify, oscar, slack, software, sources
from src.common import esc, norm_ods, title_case
from tests.conftest import make_oscar, make_patients


def test_ods_and_title_case():
    assert norm_ods(" l81051 ") == "L81051"
    assert norm_ods("ZZZ") is None and norm_ods("L8105") is None and norm_ods(None) is None
    assert title_case("ST MARY'S MEDICAL CENTRE") == "St Mary's Medical Centre"
    assert title_case("THE NHS GP GROUP AND PARTNERS") == "The NHS GP Group and Partners"
    assert title_case("McDonald Surgery") == "McDonald Surgery"  # mixed case untouched
    assert esc("<b>&'") == "&lt;b&gt;&amp;&#x27;"


def test_oscar_parse(oscar_rows):
    contacts, info, rejects, suppressed = oscar.parse(make_oscar(oscar_rows))
    assert suppressed == 1 and len(rejects) == 2
    prim = info["A10000"]["primary"]
    assert prim["contact_urn"] == 1 and prim["email"] == "casper.fons@nhs.net" and prim["full_name"] == "Casper Fons"
    assert info["A10001"]["primary"]["email_opt_out"] is True
    assert sum(c["is_primary"] for c in contacts) == 2
    assert info["A10000"]["website"] == "https://a.example" and info["A10000"]["icb"] == "ICB One"
    assert "A10002" not in info  # suppressed contact never surfaces


def test_oscar_missing_columns():
    with pytest.raises(ValueError):
        oscar.parse(b"A,B\n1,2")


def test_patients_file():
    patients, month = sources.load_patients(make_patients())
    assert len(patients) == 5200 and patients["A10000"] == 5000 and month == "2026-10"  # MALE rows ignored
    with pytest.raises(ValueError):
        sources.load_patients(make_patients(n=100))


@pytest.mark.parametrize("one_based", [False, True])
def test_ods_api_paging(one_based):
    codes = [f"A{i + 10000:05d}" for i in range(5301)]

    def api(url, params):
        assert params.get("Offset", 1) >= 1  # the real API rejects Offset=0
        start = params["Offset"] - 1 if "Offset" in params and one_based else params.get("Offset", 0)
        return {"Organisations": [{"OrgId": c, "Name": c, "PostCode": "X1"} for c in codes[start:start + int(params["Limit"])]]}
    act = sources.load_active_gp_practices(api)
    assert len(act) == 5301 and "A10000" in act and "A15300" in act  # first and last record both present
    with pytest.raises(ValueError):
        sources.load_active_gp_practices(lambda u, p: {"Organisations": []})


def test_ods_pcn_and_icb():
    names = sources.load_pcn_names(b'"U00000","WEST NORWICH PCN","26A","NHS NORFOLK AND SUFFOLK ICB - 26A","20240401"\n"X","bad"\n')
    assert names == {"U00000": ("WEST NORWICH PCN", "NHS NORFOLK AND SUFFOLK ICB")}
    assert sources.clean_icb("NHS WEST AND NORTH LONDON ICB - W2U3Z") == "NHS WEST AND NORTH LONDON ICB"  # 5-character codes too
    detail = {"Organisation": {"Rels": {"Rel": [
        {"Status": "Inactive", "Date": [{"Start": "2020"}], "Target": {"OrgId": {"extension": "U11111"}, "PrimaryRoleId": {"id": "RO272"}}},
        {"Status": "Active", "Date": [{"Start": "2022"}], "Target": {"OrgId": {"extension": "U00000"}, "PrimaryRoleId": {"id": "RO272"}}},
        {"Status": "Active", "Date": [{"Start": "2023"}], "Target": {"OrgId": {"extension": "16C"}, "PrimaryRoleId": {"id": "RO98"}}}]}}}
    assert sources.pcn_for_practice(detail) == "U00000" and sources.pcn_for_practice({"Organisation": {}}) is None
    got = sources.fetch_pcn_codes(["A10000", "A10001"], lambda u: detail if u.endswith("A10000") else (_ for _ in ()).throw(RuntimeError("x")))
    assert got == {"A10000": "U00000"}  # failed lookups omitted so they are retried later


def test_discover_url():
    from datetime import date
    pages = {
        sources.GP_REG_PAGE: "<a href='/data/patients-registered-at-a-gp-practice/september-2026/'>x</a>",
        "https://digital.nhs.uk/data/patients-registered-at-a-gp-practice/september-2026/": "nothing here",
        sources.GP_REG_PAGE + "/october-2026":
            "<a href='https://files.digital.nhs.uk/ab/CD/gp-reg-pat-prac-all.csv'>csv</a>"}

    def get(url):
        if url not in pages:
            raise RuntimeError("404")
        return pages[url]
    assert sources.discover_gp_reg_url(get, date(2026, 10, 13)).endswith("/ab/CD/gp-reg-pat-prac-all.csv")
    # landing page unavailable: constructed month URLs still work
    pages.pop(sources.GP_REG_PAGE)
    assert sources.discover_gp_reg_url(get, date(2026, 10, 13)).endswith(".csv")
    with pytest.raises(ValueError, match="GP_REG_URL"):
        sources.discover_gp_reg_url(lambda u: (_ for _ in ()).throw(RuntimeError("403")), date(2026, 10, 13))


def test_software_classify():
    assert software.classify("<p>Our premises are open</p>") == "Unknown"  # old 'emis' substring bug
    assert software.classify("https://systmonline.tpp-uk.com/x") == "SystmOne"
    assert software.classify("patient.emisaccess.co.uk and systmonline") == "Unknown"  # conflict
    assert software.normalise_url("javascript:alert(1)") is None and software.normalise_url("a.co.uk") == "https://a.co.uk"


TIERS = [{"tier": 1, "threshold": 20000}, {"tier": 2, "threshold": 15000}, {"tier": 3, "threshold": 10000}, {"tier": 4, "threshold": 5000}, {"tier": 5, "threshold": 0}]


def test_notify_select_and_slack_escaping():
    def trig(i, n, lead="Cold", name="<b>x</b> & co"):
        return {"id": i, "trigger_type": "NEW_PRACTICE", "headline": "H <1>", "description": "D & D",
                "gp_practices": {"ods_code": "A10000", "practice_name": name, "pcn_name": "P", "icb_name": "I",
                                 "total_patients": n, "clinical_software": "Unknown",
                                 "manager_name": None, "manager_title": None, "manager_email": "a@b.c",
                                 "manager_phone": None, "manager_email_opt_out": True, "lead_status": lead, "status": "Active"}}
    ts = [trig("1", 100), trig("2", 21000), trig("3", 16000, lead="Do-Not-Contact")]
    send, skip = notify.select(ts, "Tier 2", TIERS)
    assert [t["id"] for t in send] == ["2"] and {t["id"] for t in skip} == {"1", "3"}
    txt = notify.signal_text(send[0], TIERS, "https://x/app/")
    assert "<b>" not in txt and "&lt;b&gt;x&lt;/b&gt; &amp; co" in txt and "a@b.c" not in txt and "email opt-out" in txt and "<https://x/app/?open=A10000|" in txt


def test_slack_messages_split_and_cap():
    p = dict(ods_code="A1", practice_name="P", total_patients=9000, manager_name=None, manager_title=None, manager_email=None, manager_phone=None,
             manager_email_opt_out=False, clinical_software="EMIS Web", pcn_name="N", lead_status="Cold", status="Active", pcn_code=None, icb_name="I")
    sigs = [{"id": str(i), "trigger_type": "RAPID_GROWTH", "headline": "H", "description": "D", "gp_practices": p} for i in range(notify.MAX_SIGNALS + 5)]
    msgs = notify.messages(sigs, [], TIERS, "https://x/")
    assert len(msgs) == -(-notify.MAX_SIGNALS // notify.PER_MESSAGE) and all(len(b) <= 50 for _, b in msgs)
    assert "showing the first" in msgs[0][0] and msgs[0][1][1]["type"] == "actions"


def test_signal_text_next_step_and_link_separate():
    p = dict(ods_code="A1", practice_name="P", total_patients=9000, manager_name=None, manager_title=None, manager_email=None, manager_phone=None,
             manager_email_opt_out=False, clinical_software="EMIS Web", pcn_name="N", lead_status="Cold", status="Active", pcn_code=None, icb_name="I")
    txt = notify.signal_text({"trigger_type": "JOB_REPORT_ROLE", "headline": "Hiring: X", "description": "Practice advertised X.", "action": "Offer cover.",
                              "url": "https://www.jobs.nhs.uk/a/1", "gp_practices": p}, [dict(route="practice", tier=1, threshold=0)])
    assert "*Next step:* Offer cover." in txt and "<https://www.jobs.nhs.uk/a/1|Open source>" in txt
    bad = notify.signal_text({"trigger_type": "X", "headline": "h", "description": "d", "url": "javascript:alert(1)", "organisations": {"name": "Net", "kind": "pcn"}}, TIERS)
    assert "javascript" not in bad and "Net" in bad
    assert slack.link("https://a.b/c|d>", "x") == "x"


def test_uploaded_network_is_not_overwritten_by_ods_sync():
    from src import ingest
    old = {"ods_code": "W93001", "practice_name": "St Lukes", "postcode": "NP11 5GX", "status": "Active", "pcn_code": "WC60103",
           "pcn_name": "Wales cluster 60103", "icb_name": "Aneurin Bevan", "network_locked": True, "country": "Wales",
           "total_patients": 0, "clinical_software": "Unknown", "software_checked_at": None, "website": None}
    ods = {"W93001": {"name": "ST LUKES", "postcode": "NP11 5GX", "status": "Active"}}
    recs, _ = ingest.build_records(ods, {}, "2026-09", {"W93001": old}, {}, None, None, pcn_checked=frozenset({"W93001"}))
    assert not recs or (recs[0]["pcn_code"], recs[0]["pcn_name"], recs[0]["icb_name"]) == ("WC60103", "Wales cluster 60103", "Aneurin Bevan")
    assert ingest.pcn_due({"W93001"}, {"W93001": old}, __import__("datetime").datetime.now(__import__("datetime").timezone.utc)) == []


def test_purge_only_removes_never_loaded_closed_welsh_rows():
    from src import maintenance

    class R:
        def __init__(self): self.deleted = []
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            assert params == {"status": "eq.Closed", "country": "eq.Wales", "total_patients": "eq.0", "data_month": "is.null"}      # the filter is the safety
            return [{"ods_code": "W00001"}, {"ods_code": "W00003"}]
        def delete_in(self, table, column, values, chunk=200): self.deleted.append((table, column, list(values)))
    r = R()
    assert maintenance.purge_never_loaded_closed(r) == 2
    assert r.deleted == [("organisations", "ods_code", ["W00001", "W00003"]), ("gp_practices", "ods_code", ["W00001", "W00003"])]

    class Big(R):
        def select_all(self, *a, **k): return [{"ods_code": f"W{i:05d}"} for i in range(1500)]
    import pytest
    with pytest.raises(RuntimeError):
        maintenance.purge_never_loaded_closed(Big())


def test_prune_closed_practice_nodes_only_touches_stale_practice_nodes():
    from src import maintenance

    class R:
        def __init__(self): self.deleted = []
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            if table == "gp_practices": return [{"ods_code": "A1"}]
            return [{"id": "n1", "ods_code": "A1"}, {"id": "n2", "ods_code": "B2"}]
        def delete_in(self, table, column, values, chunk=200, extra=None): self.deleted.append((table, column, list(values), extra))
    r = R()
    assert maintenance.prune_closed_practice_nodes(r) == 1
    assert r.deleted == [("organisations", "id", ["n2"], {"kind": "eq.practice"})]


def test_slack_post_webhook_and_failures(monkeypatch):
    class Resp:
        def __init__(self, status, text="ok", js=None): self.status_code, self.text, self._js, self.ok = status, text, js or {}, status < 400
        def json(self): return self._js
    calls = []
    monkeypatch.setattr(slack.time, "sleep", lambda s: None)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x")
    monkeypatch.setattr(slack.requests, "post", lambda url, **kw: (calls.append((url, kw["json"])), Resp(200))[1])
    slack.post("hello", [{"type": "divider"}])
    assert calls[0][0].startswith("https://hooks.slack.com/") and calls[0][1]["text"] == "hello" and calls[0][1]["blocks"]
    monkeypatch.setattr(slack.requests, "post", lambda url, **kw: Resp(404, "no_service"))
    import pytest
    with pytest.raises(RuntimeError):
        slack.post("x")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-1")
    monkeypatch.setattr(slack.requests, "post", lambda url, **kw: (calls.append((url, kw["json"])), Resp(200, js={"ok": True}))[1])
    slack.post("hi")
    assert calls[-1][0].endswith("chat.postMessage") and calls[-1][1]["channel"] == "lalu_market_radar"
    monkeypatch.setattr(slack.requests, "post", lambda url, **kw: Resp(200, js={"ok": False, "error": "not_in_channel"}))
    with pytest.raises(RuntimeError, match="not_in_channel"):
        slack.post("hi")
    monkeypatch.delenv("SLACK_BOT_TOKEN"); monkeypatch.delenv("SLACK_WEBHOOK_URL")
    slack.alert("t", "b")   # not configured: prints, never raises


def test_job_employer_without_postcode_match_gets_name_candidates():
    from src import jobs
    practices = [dict(ods_code="M1", practice_name="Station Street Surgery", postcode="CV9 1DB", status="Active"),
                 dict(ods_code="M2", practice_name="Grange Medical Centre", postcode="CV11 6AB", status="Active")]
    status, ods, cands, _ = jobs.candidates_for("Station Street Surgery", {"CV116HH"}, {}, None, jobs.build_pool(practices))
    assert status == "review" and ods is None and [c["ods_code"] for c in cands] == ["M1"]   # offered for review, never auto-linked


def test_pricing_calculator_all_combinations():
    """Runs the dashboard's real price code over every product x billing x term x speed combination at the tier boundaries."""
    import re, shutil, subprocess, pathlib
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    out = subprocess.run([node, str(pathlib.Path(__file__).parent / "pricing_audit.js")], capture_output=True, text=True, timeout=60)
    assert re.search(r"combinations checked: \d+ mismatches: 0\b", out.stdout) and "sheet 1-year base mismatches: 0" in out.stdout and "matrix mismatches: 0" in out.stdout and "list price mismatches: 0" in out.stdout and "speed-only mismatches: 0" in out.stdout, out.stdout + out.stderr


def test_hubspot_sync_flags_and_contact_matching():
    from src import hubspot_sync as hsy

    class FakeRest:
        def __init__(self):
            self.up = {}
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            if table == "organisations":
                return [dict(id="o1", kind="pcn", name="West PCN", source_key="ods:U00001"), dict(id="o2", kind="icb", name="NHS Essex ICB - D7T5G", source_key="icb:x"), dict(id="o3", kind="pcn", name="Scot cluster", source_key="ods:SC-aberd")]
            if table == "gp_practices":
                return [dict(ods_code=c, practice_name=c, hubspot_company_id=None, pcn_code={"A10002": "U00001", "A10003": "U99999"}.get(c)) for c in ("A10001", "A10002", "A10003")] + [dict(ods_code="A10004", practice_name="Old", hubspot_company_id="9")]
            return [dict(contact_urn=1, ods_code="A10001", email="Ann@x.nhs", hubspot_status="Not imported", hubspot_contact_id=None),
                    dict(contact_urn=2, ods_code="A10001", email="bob@x.nhs", hubspot_status="Imported", hubspot_contact_id="77")]
        def upsert(self, table, rows, on_conflict, batch=500):
            self.up[table] = rows
        def insert(self, table, rows, **kw):
            self.up.setdefault("ins_" + table, []).extend(rows)

    class FakeHub:
        def call(self, method, path, **kw):
            if "companies/search" in path:
                return {"total": 3, "results": [
                    {"id": "1", "properties": {"partner_organisation_code": "a10001", "lifecyclestage": "opportunity", "createdate": "2026-01-01T00:00:00Z"}},
                    {"id": "2", "properties": {"partner_organisation_code": "A10002", "lifecyclestage": "lead", "createdate": "2026-01-02T00:00:00Z"}},
                    {"id": "3", "properties": {"partner_organisation_code": "A10003", "lifecyclestage": "lead", "createdate": "2026-01-03T00:00:00Z"}}]}
            if "objects/p145802630_pcns/search" in path:
                return {"results": [{"id": "501", "properties": {"ods_code": "U00001", "total_amount_in_won_deals": "1200", "count_of_active_emr_practices": "2"}}]}
            if "objects/p145802630_icbs/search" in path:
                return {"results": [{"id": "601", "properties": {"ods_code": "D7T5G", "name": "Essex"}}]}
            if "associations/companies/contacts" in path:
                return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": 11}]}, {"from": {"id": "2"}, "to": [{"toObjectId": 12}]}]}
            if "associations/companies/deals" in path:
                return {"results": [{"from": {"id": "3"}, "to": [{"toObjectId": 31}]}]}
            if "objects/contacts/batch/read" in path:
                return {"results": [{"id": "11", "properties": {"lifecyclestage": "salesqualifiedlead", "email": "ann@x.nhs", "createdate": "2026-02-01T00:00:00Z"}},
                                    {"id": "12", "properties": {"lifecyclestage": "lead", "email": "z@x.nhs"}}]}
            if "associations/companies/0-162" in path:
                return {"results": []}
            if "objects/deals/batch/read" in path:
                return {"results": [{"id": "31", "properties": {"hs_is_closed_won": "true"}}]}
            raise AssertionError(path)

    epcn_csv = b"U00001,WEST PCN,x,NHS ESSEX ICB - D7T5G,20260901,A,B\nU99999,NEW PCN,x,Essex,20260901,A,B\nU88888,CLOSED PCN,x,NHS ESSEX ICB - D7T5G\n"
    hsy.sources.fetch = lambda url, timeout=120: epcn_csv
    def ods_get(url, params=None):
        if url.endswith("/organisations") and params and params.get("Status") == "Inactive":
            return {"Organisations": [{"OrgId": "U88888"}]}
        if url.endswith("/organisations/U99999") or url.endswith("/organisations/U00001"):
            return {"Organisation": {"Status": "Active", "Date": [{"Type": "Operational", "Start": "2025-01-01"}], "GeoLoc": {"Location": {"AddrLn1": "2 LOW ST", "Town": "CHELMSFORD", "PostCode": "CM1 1QH"}},
                                     "Contacts": {"Contact": [{"type": "tel", "value": "01245 123456"}]}}}
        if url.endswith("/organisations/U88888"):
            return {"Organisation": {"Status": "Inactive", "Date": [{"Type": "Operational", "Start": "2020-01-01", "End": "2024-03-31"}]}}
        raise AssertionError(url)
    hsy.sources.get_json = ods_get
    hsy.slack.post = lambda text, blocks=None: posted.append(text)
    posted = []
    rest = FakeRest()
    created, patched, assoc = [], [], []
    base_call = FakeHub.call
    def call(self, method, path, **kw):
        if "p145802630_pcns/search" in path:
            return {"results": [{"id": "501", "properties": {"ods_code": "U00001", "name": "West PCN", "address_line_1": "20260901", "total_amount_in_won_deals": "1200", "count_of_active_emr_practices": "2"}},
                                {"id": "502", "properties": {"ods_code": "U88888", "name": "Closed PCN", "status": "active"}}]}
        if method == "POST" and path == "/crm/v3/objects/p145802630_pcns":
            created.append(kw["json"]["properties"]); return {"id": "700"}
        if method == "PATCH" and "p145802630_pcns" in path:
            patched.append((path, kw["json"]["properties"])); return {}
        if "associations/companies/p145802630_pcns/batch/read" in path:
            return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": 501}]}]}
        if "batch/associate/default" in path:
            assoc.extend(kw["json"]["inputs"]); return {}
        return base_call(self, method, path, **kw)
    FakeHub.call = call
    stats = hsy.sync(rest, FakeHub())
    g = {r["ods_code"]: r for r in rest.up["gp_practices"]}
    assert g["A10001"]["hubspot_engaged"] and not g["A10001"]["hubspot_customer"] and g["A10001"]["hubspot_stage"] == "Opportunity"
    assert not g["A10002"]["hubspot_engaged"] and not g["A10002"]["hubspot_customer"]          # only a New lead contact
    assert g["A10003"]["hubspot_customer"]                                                      # closed-won deal, lifecycle never updated
    assert g["A10004"]["hubspot_company_id"] is None                                            # link cleared when the company is gone
    c = {r["contact_urn"]: r for r in rest.up["contacts"]}
    assert c[1]["hubspot_status"] == "Imported" and c[1]["hubspot_contact_id"] == "11" and c[2]["hubspot_status"] == "Not imported"   # matched by email, case-insensitive
    assert stats["practices_linked"] == 3 and stats["customers"] == 1 and stats["engaged"] == 1
    nl = {r["org_id"]: r for r in rest.up["hubspot_network_links"]}
    assert nl["o1"]["object_id"] == "501" and nl["o1"]["object_type"].endswith("pcns") and nl["o1"]["won_deals_amount"] == 1200 and nl["o2"]["object_id"] == "601" and "o3" not in nl   # PCN by ODS code, ICB by name, Scottish cluster unmatched
    assert stats["networks_linked"] == 2 and stats["networks_unmatched"] == 1
    kinds = {e["kind"] for e in rest.up["ins_hubspot_activity"]}
    assert {"pcn_created", "pcn_repaired", "pcn_inactivated", "associations"} <= kinds and all(e["actor"] == "daily sync" for e in rest.up["ins_hubspot_activity"])   # every change is logged
    assert [c["ods_code"] for c in created] == ["U99999"] and created[0]["address_line_1"] == "2 Low St" and created[0]["postcode"] == "CM1 1QH" and created[0]["status"] == "active" and created[0]["operational_start_date"] == "2025-01-01"   # created from the named ODS API fields
    fixed = next(p for path, p in patched if path.endswith("/501"))
    assert fixed["address_line_1"] == "2 Low St" and fixed["postcode"] == "CM1 1QH"        # the early bad address (a date) is repaired
    closed = next(p for path, p in patched if path.endswith("/502"))
    assert closed["status"] == "inactive" and closed["operational_end_date"] == "2024-03-31"


def test_hubspot_sync_ex_customer_is_not_a_customer():
    from src import hubspot_sync as hsy
    ex = {"id": "9", "company_status": "Ex-Customer", "lifecyclestage": "customer", "createdate": "2025-01-01T00:00:00Z"}
    cur = {"id": "8", "company_status": "Current Customer", "lifecyclestage": "customer", "createdate": "2025-01-01T00:00:00Z"}
    won = {"d1": {"hs_is_closed_won": "true"}}
    f = hsy.classify([ex], [], {}, [], {})
    assert f["hubspot_customer"] is False and f["hubspot_stage"] == "Ex-customer"
    assert hsy.classify([ex], [], {}, ["d1"], won)["hubspot_customer"] is False   # an old won deal does not make an ex-customer current
    assert hsy.classify([cur], [], {}, [], {})["hubspot_customer"] is True
    assert hsy.classify([ex, cur], [], {}, [], {})["hubspot_customer"] is True      # another live company with the same ODS code still counts


def test_hubspot_contracted_arr_and_pipeline():
    from src import hubspot_sync as hsy
    deals = {"w": {"hs_is_closed_won": "true", "amount": "900", "pipeline": "default", "hs_is_closed": "true"},
             "o": {"hs_is_closed_won": "false", "hs_is_closed": "false", "amount": "500", "pipeline": "2298660077"},
             "r": {"hs_is_closed": "false", "amount": "700", "pipeline": "3784347852"}}
    svc = {"s1": {"hs_pipeline_stage": "2551571664", "actual_annual_contract_value__acv_": "4000"},
           "s2": {"hs_pipeline_stage": "2551571667", "actual_annual_contract_value__acv_": "9999"},   # churned: ignored
           "s3": {"hs_pipeline_stage": "2551571663", "actual_annual_contract_value__acv_": "800"}}    # pilot: ignored
    f = hsy.revenue_fields(["w", "o", "r"], deals, ["s1", "s2", "s3"], svc, True, "eMR Plus")
    svc["s1"].update(contract_start_date="2025-02-01", contract_end_date="1801440000000")
    f = hsy.revenue_fields(["w", "o", "r"], deals, ["s1", "s2", "s3"], svc, True, "eMR Plus")
    assert f == {"hubspot_contracted_arr": 4000.0, "hubspot_contracted_src": "service", "hubspot_contract_start": "2025-02-01", "hubspot_contract_end": "2027-02-01",
                 "hubspot_pipeline": None, "hubspot_conversion_pipeline": 500.0, "hubspot_renewal_pipeline": 700.0, "hubspot_contract_terms": None}
    g = hsy.revenue_fields(["w"], deals, [], {}, True, "eMR Plus")                  # no Service: fall back to the won deal, flagged
    assert g["hubspot_contracted_arr"] == 900.0 and g["hubspot_contracted_src"] == "deal"
    deals["w"].update(size_discount="0.05", speed_discount="0.05", term_length_discount="0.025", referral_discount="0.02", total_discount="0.145", term_length_years="2",
                      value_per_patient="0.08", actual_value_per_patient_calculated="0.0684", closedate="2025-03-04T00:00:00Z", dealname="Test Surgery")
    t = hsy.revenue_fields(["w"], deals, [], {}, True, "eMR Plus")["hubspot_contract_terms"]       # the latest won deal's pricing
    assert t["size"] == 0.05 and t["referral"] == 0.02 and t["total"] == 0.145 and t["years"] == 2 and t["net_rate"] == 0.0684 and t["closed"] == "2025-03-04", t
    assert hsy.revenue_fields(["w"], deals, [], {}, True, "Freemium")["hubspot_contracted_arr"] is None   # freemium has no revenue
    assert hsy.revenue_fields(["w"], deals, [], {}, False, None)["hubspot_contracted_arr"] is None


def test_hubspot_audit_names_and_issues():
    from src import hubspot_sync as hsy
    assert hsy.names_match("The Grantham Practice", "Grantham Medical Practice")
    assert hsy.names_match("St Mary's Surgery", "St Marys Surgery")
    assert hsy.names_match("Dr Smith & Partners", "Smith and Partners Medical Centre")
    assert not hsy.names_match("Dr Jefferies & Partners", "GP at Hand")
    practices = {"A10001": {"practice_name": "Alpha Surgery", "status": "Active", "merged_into": None, "postcode": "LS1 1AA"}, "B20002": {"practice_name": "Beta Health Centre", "status": "Closed", "merged_into": None, "postcode": "LS2 2BB"},
                 "C30003": {"practice_name": "Gamma Practice", "status": "Active", "merged_into": None, "postcode": "LS3 3CC"}}
    raw = [{"id": 1, "properties": {"name": "Alpha Surgery", "partner_organisation_code": "a10001"}},
           {"id": 2, "properties": {"name": "Beta Health Centre", "partner_organisation_code": "B20002"}},
           {"id": 3, "properties": {"name": "Something Else Ltd", "partner_organisation_code": "C30003", "zip": "M1 1AA"}},
           {"id": 4, "properties": {"name": "Gamma Practice", "partner_organisation_code": "C30003"}},
           {"id": 5, "properties": {"name": "Nowhere", "partner_organisation_code": "Z90009"}},
           {"id": 6, "properties": {"name": "Dr Smith & Partners", "partner_organisation_code": "A10001", "zip": "ls1 1aa"}},
           {"id": 7, "properties": {"name": "Cardiff Surgery", "partner_organisation_code": "W95001"}}]
    got = {(r["issue"], r["company_id"]) for r in hsy.audit_rows(raw, practices, "now")}
    assert got == {("closed_practice", "2"), ("name_mismatch", "3"), ("duplicate_code", "3"), ("duplicate_code", "4"), ("unknown_code", "5"), ("unknown_wales", "7"), ("duplicate_code", "1"), ("duplicate_code", "6")}, got


def test_hubspot_network_audit():
    from src import hubspot_sync as hsy
    epcn = {"U00001": {"name": "West PCN"}, "U00002": {"name": "East Health Network"}}
    pcns = [{"id": "1", "name": "West PCN", "ods_code": "U00001"}, {"id": "2", "name": "East Health Network"}, {"id": "3", "name": "Old Name", "ods_code": "U00009"},
            {"id": "4", "name": "Totally Different", "ods_code": "U00002"}, {"id": "5", "name": "West PCN", "ods_code": "u00001"}]
    icbs = [{"id": "10", "name": "NHS Essex ICB", "ods_code": "D7T5G"}, {"id": "11", "name": "NHS Essex ICB", "ods_code": "D7T5G"}, {"id": "12", "name": "NHS Kent ICB"}]
    rows = hsy.network_audit_rows(pcns, icbs, epcn, "now", [("77", "Alpha Surgery", "A10001", ["East Health Network"])])
    got = {(r["issue"], r["company_id"]) for r in rows}
    assert got == {("pcn_no_code", "2"), ("pcn_unknown_code", "3"), ("pcn_name_mismatch", "4"), ("pcn_duplicate", "1"), ("pcn_duplicate", "5"), ("icb_issue", "10"), ("icb_issue", "11"), ("icb_issue", "12"),
                   ("pcn_association", "77")}, got
    nocode = next(r for r in rows if r["issue"] == "pcn_no_code")
    assert "U00002" in nocode["detail"] and nocode["nhs_name"] == "East Health Network"   # the code-less record is matched to its NHS PCN by name


def test_hubspot_sync_commercial_model_makes_a_customer():
    from src import hubspot_sync as hsy
    free = {"id": "1", "lifecyclestage": "lead", "company_status": "Current Customer", "current_subscription": "Freemium", "createdate": "2025-01-01T00:00:00Z"}
    f = hsy.classify([free], [], {}, [], {})
    assert f["hubspot_customer"] is True and f["hubspot_commercial_model"] == "Freemium"   # a customer with no deal and a lead lifecycle stage
    ex = dict(free, company_status="Ex-Customer")
    f = hsy.classify([ex], [], {}, [], {})
    assert f["hubspot_customer"] is False and f["hubspot_commercial_model"] is None        # an ex-customer keeps no model
    assert hsy.classify([{"id": "2", "lifecyclestage": "customer", "createdate": "2025-01-01T00:00:00Z"}], [], {}, [], {})["hubspot_commercial_model"] is None


def test_ods_operational_dates():
    from datetime import datetime, timezone
    from src import ingest, sources
    d = {"Organisation": {"Date": [{"Type": "Legal", "Start": "2001-01-01"}, {"Type": "Operational", "Start": "2013-04-01", "End": "2024-03-31"}]}}
    assert sources.operational_dates(d) == ("2013-04-01", "2024-03-31")
    assert sources.operational_dates({"Organisation": {"Date": [{"Type": "Operational", "Start": "bad"}]}}) == (None, None)
    now = datetime(2026, 10, 21, tzinfo=timezone.utc)
    existing = {"A": {"status": "Closed"}, "B": {"status": "Active"}, "C": {"status": "Active", "ods_dates_checked_at": "2026-10-01T00:00:00+00:00"},
                "D": {"status": "Active", "ods_dates_checked_at": "2025-01-01T00:00:00+00:00"}}
    assert ingest.dates_due(existing, existing, now) == ["A", "B", "D"]   # closed without an end date first, then never fetched, then stale; C is fresh


def test_branch_record_and_parent():
    from src import sources
    d = {"Organisation": {"Name": "HOLYCROFT SURGERY", "Date": [{"Type": "Operational", "Start": "2022-04-01"}], "GeoLoc": {"Location": {"AddrLn1": "OAKWORTH ROAD", "Town": "KEIGHLEY", "PostCode": "bd21 1sa"}},
                         "Rels": {"Rel": [{"id": "RE6", "Status": "Inactive", "Target": {"OrgId": {"extension": "OLD01"}, "PrimaryRoleId": {"id": "RO177"}}},
                                          {"id": "RE6", "Status": "Active", "Target": {"OrgId": {"extension": "Y06528"}, "PrimaryRoleId": {"id": "RO98"}}},
                                          {"id": "RE6", "Status": "Active", "Target": {"OrgId": {"extension": "B83033"}, "PrimaryRoleId": {"id": "RO177"}}}]}}}
    r = sources.branch_record("J4Q3U", d)
    assert r["parent_code"] == "B83033" and r["parent_role"] == "RO177"      # an active GP practice parent wins over another active target; inactive links are ignored
    assert r["branch_name"] == "Holycroft Surgery" and r["postcode"] == "BD21 1SA" and r["opened"] == "2022-04-01" and r["phone"] is None
    from src import ingest
    assert ingest.branch_kind("B83033", "RO177", {"B83033": {}}) == "gp_practice"
    assert ingest.branch_kind("X99999", "RO177", {}) == "gp_not_held" and ingest.branch_kind("Y06528", "RO98", {}) == "non_gp"


def test_branch_resolution_cases():
    from src import branches
    pool = {"M85624": {"name": "Perry Park Surgery", "postcode": "B44 0HL"}, "M85026": {"name": "Ashfield Surgery", "postcode": "B76 1QN"}, "B87021": {"name": "Ash Grove", "postcode": "WF11 0JA"},
            "M85028": {"name": "Lordswood House Group Medical Practice", "postcode": "B17 9DB"}, "Y03035": {"name": "Queenswood Medical Practice", "postcode": "N8 8JD"},
            "B83033": {"name": "Arg Healthcare", "postcode": "BB6 7QQ"}, "F83033": {"name": "Barnsbury Medical Practice", "postcode": "N1 0AL"}, "Y03103": {"name": "Medicus Select Care", "postcode": "N1 0AL"}}
    def row(code, name, pc, parent, status="Active"):
        return {"branch_code": code, "branch_name": name, "postcode": pc, "parent_code": parent, "status": status}
    rows = {c: r for c, r in [("M85624001", row("M85624001", "Kingsdale Surgery", "B44 0UJ", "M85624")),            # real branch: code = practice code + suffix
        ("Q8F5U", row("Q8F5U", "Kingsdale Surgery", "B44 0UJ", "Y06528")),                                         # operator listing of that same site
        ("S0O9H", row("S0O9H", "Great Harwood Surgery", "BB6 7PX", "B83033")),                                     # 5-char code, but operated by a practice we hold: a real branch
        ("V5E4B", row("V5E4B", "Ashfield Surgery", "B76 1QN", "Y06528")),                                          # operator listing of a practice, exact name
        ("Y05959001", row("Y05959001", "Ash Grove Medical Centre", "WF11 0JA", "Y05959")),                         # 9-char but its parent is not a practice we hold
        ("K6M6K", row("K6M6K", "Lordswood Medical Practice", "B17 9DB", "Y06528")),                                # similar name
        ("N5N9N", row("N5N9N", "Hornsey Central Neighbourhood Health Centre", "N8 8JD", "Y02785")),               # one practice there, different name
        ("S3D2F", row("S3D2F", "Bingfield Primary Care Centre", "N1 0AL", "Y02785")),                              # shared building
        ("T1Z1F", row("T1Z1F", "Moseley Hall Hospital", "B13 8JL", "Y06528"))]}                                    # nothing there
    r = branches.resolve(rows, pool)
    assert (r["M85624001"]["resolution"], r["M85624001"]["practice_code"]) == ("branch", "M85624")
    assert (r["S0O9H"]["resolution"], r["S0O9H"]["practice_code"], r["S0O9H"]["match_status"]) == ("branch", "B83033", "auto")      # not judged by address: ODS names its operator
    assert (r["Q8F5U"]["resolution"], r["Q8F5U"]["practice_code"], r["Q8F5U"]["matched_branch_code"], r["Q8F5U"]["match_status"]) == ("duplicate_branch", "M85624", "M85624001", "auto")
    assert (r["V5E4B"]["resolution"], r["V5E4B"]["practice_code"], r["V5E4B"]["match_status"]) == ("duplicate_practice", "M85026", "auto")
    assert (r["Y05959001"]["resolution"], r["Y05959001"]["practice_code"], r["Y05959001"]["match_status"]) == ("duplicate_practice", "B87021", "probable")
    assert (r["K6M6K"]["practice_code"], r["K6M6K"]["match_status"]) == ("M85028", "probable")
    assert (r["N5N9N"]["resolution"], r["N5N9N"]["practice_code"], r["N5N9N"]["match_status"]) == ("hosted", "Y03035", "review")
    assert (r["S3D2F"]["resolution"], r["S3D2F"]["practice_code"]) == ("shared", None) and "Barnsbury" in r["S3D2F"]["match_note"]
    assert (r["T1Z1F"]["resolution"], r["T1Z1F"]["practice_code"]) == ("other", None)
    # a person's decision stands while the match is unchanged, and lapses when the match changes
    kept = branches.resolve(rows, pool, {"N5N9N": {"match_status": "confirmed", "resolution": "hosted", "practice_code": "Y03035"}})
    assert kept["N5N9N"]["match_status"] == "confirmed"
    gone = branches.resolve(rows, pool, {"N5N9N": {"match_status": "confirmed", "resolution": "hosted", "practice_code": "OTHER1"}})
    assert gone["N5N9N"]["match_status"] == "review"


def test_branch_listing_by_a_pcn_enhanced_access_service_is_worded_as_such():
    from src import branches
    pool = {"F82022": {"name": "The Rosewood Medical Centre", "postcode": "RM12 5NJ"}}
    row = {"branch_code": "F4A2Q", "branch_name": "Rosewood Medical Centre", "postcode": "RM12 5NJ", "parent_code": "Y07579", "parent_name": "Havering North PCN Eas", "status": "Active"}
    r = branches.resolve({"F4A2Q": row}, pool)["F4A2Q"]
    assert r["resolution"] == "duplicate_practice" and r["practice_code"] == "F82022" and "enhanced-access service" in r["match_note"] and "F82022" in r["match_note"]


def test_other_uk_records_and_step():
    from src import ingest, sources
    z1 = {"Organisation": {"Name": "DR. HOEY & PARTNERS", "Status": "Active", "GeoLoc": {"Location": {"AddrLn1": "HARLAND MEDICAL PRACTICE", "AddrLn2": "HOLYWOOD ARCHES HEALTH CENTRE", "AddrLn3": "WESTMINSTER AVENUE",
          "Town": "BELFAST", "County": "COUNTY DOWN", "PostCode": "BT4 1NS", "Country": "NORTHERN IRELAND"}}}}
    r = sources.other_uk_record("Z00001", z1, "Northern Ireland")
    assert r["code"] == "Z00001" and r["postcode"] == "BT4 1NS" and r["town"] == "Belfast" and r["country"] == "Northern Ireland" and r["address"].startswith("Harland Medical Practice"), r
    assert sources.other_uk_record("Z00002", {"Organisation": {"Name": "X", "Status": "Inactive"}}, "Northern Ireland") is None and sources.other_uk_record("Z00003", {}, "Northern Ireland") is None

    def getj(url, params=None):
        if url.endswith("/organisations"):
            return {"Organisations": [{"OrgId": f"Z{i:05d}", "Name": f"N{i}", "PostCode": "BT1 1AA"} for i in range(1, 121)]}
        return z1
    assert len(sources.load_ni_gp_practices(getj=getj)) == 120
    try:
        sources.load_ni_gp_practices(getj=lambda u, p=None: {"Organisations": []})
        raise AssertionError("an empty ODS answer must be refused")
    except ValueError:
        pass

    calls, stats = [], {}

    class Rest:
        def rpc(self, name, args=None):
            calls.append((name, len(args["p_rows"]))); return {"new": len(args["p_rows"])}
    orig_ni, orig_fetch = sources.load_ni_gp_practices, sources.fetch_other_uk
    try:
        sources.load_ni_gp_practices = lambda: {f"Z{i:05d}": {} for i in range(1, 121)}
        sources.fetch_other_uk = lambda codes, country: {c: {"code": c, "country": country} for c in codes}
        ingest.other_uk_step(Rest(), {"Z00001": {}, "Y00001": {}}, stats)
    finally:
        sources.load_ni_gp_practices, sources.fetch_other_uk = orig_ni, orig_fetch
    assert calls == [("ingest_other_uk", 119 + 11)] and stats["other_uk_new"] == 130 and "other_uk_error" not in stats, (calls, stats)


def test_list_size_of_the_linked_company():
    from src import hubspot_sync as hsy
    cs = [{"id": "1", "patient_list_size": "9000"}, {"id": "3"}]
    assert hsy.list_size(cs, "1") == 9000 and hsy.list_size(cs, 3) is None and hsy.list_size(cs, "9") is None


def test_list_size_plan_holds_big_jumps_and_customers_follow_the_switch():
    from src import hubspot_sync as hsy
    pr = {c: dict(ods_code=c, practice_name=c, status="Active", merged_into=None, total_patients=n) for c, n in [("A", 10500), ("B", 10000), ("C", 20000), ("D", 9000), ("E", 8000), ("F", 0)]}
    pr["E"]["merged_into"] = "A"
    pr["E"]["total_patients"] = 0      # NHS counts a merged practice at 0
    rows = [dict(ods_code="A", hubspot_company_id="1", hubspot_customer=False, hubspot_list_size=10000), dict(ods_code="B", hubspot_company_id="2", hubspot_customer=False, hubspot_list_size=10000),
            dict(ods_code="C", hubspot_company_id="3", hubspot_customer=False, hubspot_list_size=10000), dict(ods_code="D", hubspot_company_id="4", hubspot_customer=True, hubspot_contracted_arr=5000, hubspot_contract_terms=None, hubspot_list_size=8000),
            dict(ods_code="E", hubspot_company_id="5", hubspot_customer=False, hubspot_list_size=7000), dict(ods_code="F", hubspot_company_id="6", hubspot_customer=False, hubspot_list_size=7000)]
    auto, held = hsy.plan_list_sizes(pr, rows)
    assert [c["ods"] for c in auto] == ["A", "E"] and auto[0]["to"] == 10500 and auto[1]["to"] == 0 and auto[1]["gone"] == "merged" and [c["ods"] for c in held] == ["C"]      # B unchanged, F has no size; customer D is left alone by default; the merged E (NHS 0, HubSpot 7,000) is zeroed, never held
    auto, held = hsy.plan_list_sizes(pr, rows, include_customers=True)
    assert [c["ods"] for c in auto] == ["A", "D", "E"] and auto[1]["to"] == 9000      # the switch in the Data panel lets customers follow NHS too


def test_list_size_push_batches_and_stops_on_error():
    from src import hubspot_sync as hsy
    class R:
        def __init__(self): self.up = []
        def upsert(self, table, rows, on_conflict, batch=500): self.up += rows
    class H:
        def __init__(self, fail_at=None): self.calls, self.fail_at = [], fail_at
        def call(self, method, path, **kw):
            if "/notes" in path: return {}
            self.calls.append(kw["json"])
            if self.fail_at == len(self.calls): raise RuntimeError("403 missing scope")
    auto = [dict(ods=f"A{i}", id=str(i), name="n", **{"from": 1, "to": 2}) for i in range(150)]
    r, h = R(), H()
    done, err = hsy.push_list_sizes(r, h, auto)
    assert len(done) == 150 and err is None and len(h.calls) == 2 and h.calls[0]["inputs"][0]["properties"] == {"patient_list_size": "2"} and len(r.up) == 150
    r, h = R(), H(fail_at=2)
    done, err = hsy.push_list_sizes(r, h, auto)
    assert len(done) == 100 and "403" in err      # the first 100 are recorded, the failure stops the rest


def test_linked_company_properties():
    from src import hubspot_sync as hsy
    cs = [{"id": "1", "org_type": "practice", "operating_status": "active", "website": " https://x.nhs.uk ", "hs_parent_company_id": "127032478946.0"}, {"id": "2"}]
    assert hsy.linked_properties(cs, "1") == {"hubspot_org_type": "practice", "hubspot_operating_status": "active", "hubspot_website": "https://x.nhs.uk", "hubspot_parent_company_id": "127032478946"}
    assert hsy.linked_properties(cs, "2") == {"hubspot_org_type": None, "hubspot_operating_status": None, "hubspot_website": None, "hubspot_parent_company_id": None}


def test_line_item_quantity_is_the_contract_basis():
    from src import hubspot_sync as hsy

    class H:
        def call(self, method, path, **kw):
            if "associations/deals/line_items" in path:
                return {"results": [{"from": {"id": "d1"}, "to": [{"toObjectId": 11}, {"toObjectId": 12}]}, {"from": {"id": "d2"}, "to": [{"toObjectId": 13}]}]}
            if "objects/line_items/batch/read" in path:
                return {"results": [{"id": "11", "properties": {"quantity": "9500", "hs_product_id": "440423339237"}}, {"id": "12", "properties": {"quantity": "1", "hs_product_id": "999"}},
                                    {"id": "13", "properties": {"quantity": "5", "hs_product_id": "999"}}]}
            raise AssertionError(path)
    q = hsy.deal_line_quantities(H(), ["d1", "d2"])
    assert q == {"d1": 9500}      # only the Lalu Care product counts
    deals = {"d1": {"hs_is_closed_won": "true", "pipeline": "default", "closedate": "2026-01-01", "value_per_patient": "0.08"}}
    assert hsy.contract_terms(["d1"], deals, q)["line_qty"] == 9500
    deals["d1"]["contracted_patient_list_size"] = "9400"
    assert hsy.contract_terms(["d1"], deals, q)["contracted"] == 9400
    assert hsy.deal_line_quantities(type("Bad", (), {"call": lambda *a, **k: (_ for _ in ()).throw(RuntimeError("403"))})(), ["d1"]) == {}      # no scope: the figure is simply absent


def test_list_size_sync_runs_once_per_nhs_month():
    from src import hubspot_sync as hsy
    assert hsy.list_size_due({"enabled": True}, "2026-10")                                  # switched on, this month not applied yet
    assert not hsy.list_size_due({"enabled": True, "last_month": "2026-10"}, "2026-10")     # the daily runs after that leave it alone
    assert hsy.list_size_due({"enabled": True, "last_month": "2026-09"}, "2026-10")         # a new monthly load makes it due again
    assert not hsy.list_size_due({"enabled": False, "last_month": "2026-09"}, "2026-10") and not hsy.list_size_due({}, "2026-10") and not hsy.list_size_due({"enabled": True}, "")

    class R:
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            return [dict(contact_urn=1), dict(key="list_size_sync", value={"enabled": True, "last_month": "2026-09"})]
    assert hsy.list_size_flag(R()) == {"enabled": True, "last_month": "2026-09"}


def test_alignment_plan_fills_status_and_leaves_merges_and_moved_sites_to_a_person():
    from src import hubspot_sync as hsy
    base = dict(status="Active", merged_into=None, closure_confirmed_at=None, postcode="AB1 2CD")
    pr = {"A": dict(ods_code="A", practice_name="Alpha Surgery", **base), "B": dict(ods_code="B", practice_name="Beta Medical Centre", operational_end_date="2026-03-31", **{**base, "status": "Closed"}),
          "C": dict(ods_code="C", practice_name="Gamma Practice", **{**base, "merged_into": "A"}), "D": dict(ods_code="D", practice_name="Delta Medical Centre", **{**base, "status": "Closed", "postcode": "ZZ9 9ZZ"}),
          "E": dict(ods_code="E", practice_name="Echo Surgery", **base), "F": dict(ods_code="F", practice_name="Foxtrot Surgery", **{**base, "closure_confirmed_at": "2026-01-01"})}
    rows = [dict(ods_code=c, hubspot_company_id=str(i), hubspot_org_type=o, hubspot_operating_status=s) for i, (c, o, s) in enumerate([("A", None, None), ("B", "practice", "active"), ("C", None, None), ("D", "group", "active"), ("E", "practice", "active"), ("F", "practice", "closed")], 1)]
    branches = [dict(branch_code="T1", branch_name="Delta Medical Centre", postcode="ZZ9 9ZZ", resolution="branch", match_status="auto", practice_code="A", status="Active")]
    auto, cases = hsy.plan_alignment(pr, rows, branches)
    got = {c["ods"]: c["props"] for c in auto}
    assert got == {"A": {"org_type": "practice", "operating_status": "active"}, "B": {"closure_date": "2026-03-31", "operating_status": "closed"}}, got      # E and F already match; D (a moved site) and C (merged) wait for a person
    assert cases == 2 and "D" not in got and "C" not in got
    assert hsy.site_move(pr["D"], branches)["branch_code"] == "T1" and hsy.site_move(pr["B"], branches) is None


def test_alignment_run_size_guard():
    from src import hubspot_sync as hsy
    assert hsy.align_due({"enabled": True}, 50) and not hsy.align_due({"enabled": True}, 500) and hsy.align_due({"enabled": True, "approve_once": True}, 500)
    assert not hsy.align_due({"enabled": False}, 5) and not hsy.align_due({}, 5) and not hsy.align_due({"enabled": True}, 0)


def test_zeroing_a_merged_company_leaves_a_note_with_the_old_size():
    from src import hubspot_sync as hsy
    pr = {"M": dict(ods_code="M", practice_name="Old Surgery", status="Active", merged_into="P", total_patients=0), "P": dict(ods_code="P", practice_name="Parent Practice", status="Active", merged_into=None, total_patients=9000),
          "X": dict(ods_code="X", practice_name="No Data", status="Active", merged_into=None, total_patients=0), "K": dict(ods_code="K", practice_name="Paying", status="Active", merged_into="P", total_patients=0)}
    rows = [dict(ods_code="M", hubspot_company_id="1", hubspot_customer=False, hubspot_list_size=3717), dict(ods_code="X", hubspot_company_id="2", hubspot_customer=False, hubspot_list_size=500),
            dict(ods_code="K", hubspot_company_id="3", hubspot_customer=True, hubspot_contracted_arr=None, hubspot_contract_terms=None, hubspot_list_size=7879)]
    auto, held = hsy.plan_list_sizes(pr, rows, include_customers=True)
    assert [(c["ods"], c["to"], c.get("successor")) for c in auto] == [("M", 0, "Parent Practice"), ("K", 0, "Parent Practice")] and not held      # a practice with no NHS data is not zeroed; with the switch on a customer is zeroed like anyone else
    assert [c["ods"] for c in hsy.plan_list_sizes(pr, rows)[0]] == ["M"]      # with it off (the default) the customer's company is not touched, merged or not
    pr["P"]["total_patients"] = 9500
    rows.append(dict(ods_code="P", hubspot_company_id="9", hubspot_customer=True, hubspot_contracted_arr=4227, hubspot_contract_terms=None, hubspot_list_size=9000))
    assert [(c["ods"], c["to"]) for c in hsy.plan_list_sizes(pr, rows, True)[0]] == [("M", 0), ("K", 0), ("P", 9500)] and [c["ods"] for c in hsy.plan_list_sizes(pr, rows)[0]] == ["M"]
    rows.pop(); rows[2].update(hubspot_customer=False, hubspot_contracted_arr=None)
    auto = [c for c in hsy.plan_list_sizes(pr, rows)[0] if c["ods"] == "M"]
    class H:
        def __init__(self): self.calls = []
        def call(self, method, path, **kw): self.calls.append((path, kw.get("json")))
    class R:
        def upsert(self, *a, **k): pass
    h = H(); done, err = hsy.push_list_sizes(R(), h, auto, "2026-10")
    note = [c for c in h.calls if c[0] == "/crm/v3/objects/notes/batch/create"][0][1]["inputs"][0]
    body = note["properties"]["hs_note_body"]
    assert err is None and "Patient List Size: 3,717 → 0" in body and "Parent Practice" in body and "merged" in body and body.startswith("Atlas, ") and note["associations"][0]["to"]["id"] == "1"


def test_every_atlas_write_to_hubspot_leaves_a_note_with_the_old_and_new_values():
    from src import hubspot_sync as hsy
    class R:
        def upsert(self, *a, **k): pass
    class H:
        def __init__(self): self.calls = []
        def call(self, method, path, **kw):
            self.calls.append((method, path, kw.get("json")))
            return {"id": "n1"}
    h = H()
    done, err = hsy.push_list_sizes(R(), h, [dict(ods="A", id="7", name="Alpha", **{"from": None, "to": 12000}), dict(ods="B", id="8", name="Beta", **{"from": 9000, "to": 9500})], "2026-10")
    notes = [i["properties"]["hs_note_body"] for c in h.calls if c[1] == "/crm/v3/objects/notes/batch/create" for i in c[2]["inputs"]]
    assert err is None and len(notes) == 2 and "Patient List Size: blank → 12,000" in notes[0] and "Patient List Size: 9,000 → 9,500" in notes[1] and "NHS figure for 2026-10" in notes[1]
    h = H()
    auto = [dict(ods="A", id="7", name="Alpha", props={"operating_status": "active", "org_type": "practice"}, was={"org_type": None, "operating_status": "closed"})]
    hsy.push_alignment(R(), h, auto)
    body = [i["properties"]["hs_note_body"] for c in h.calls if c[1] == "/crm/v3/objects/notes/batch/create" for i in c[2]["inputs"]][0]
    assert "Operating status: closed → active" in body and "Org Type: blank → practice" in body
    h = H()
    hsy.push_alignment(R(), h, [dict(ods="B", id="9", name="Beta", props={"closure_date": "2026-03-31", "operating_status": "closed"}, was={})])
    upd = [c[2]["inputs"][0]["properties"] for c in h.calls if c[1] == "/crm/v3/objects/companies/batch/update"]
    assert upd == [{"closure_date": "2026-03-31"}, {"operating_status": "closed"}]      # the closure date first, the Operating status last (it triggers the churn workflow)
    h = H()
    assert hsy.add_notes(h, "p1_pcns", [("55", hsy.note_text("PCN record created", ["Status: blank → active"]))]) == 0      # a custom object gets the note, then the default association
    assert [c[:2] for c in h.calls] == [("POST", "/crm/v3/objects/notes"), ("PUT", "/crm/v4/objects/notes/n1/associations/default/p1_pcns/55")]
    class Bad:
        def call(self, *a, **k): raise RuntimeError("403")
    assert hsy.add_notes(Bad(), "companies", [("1", "x"), ("2", "y")]) == 2      # a failed note is counted, never raised
    assert "&lt;b&gt;" in hsy.note_text("a <b> practice")


def test_contact_email_quality_and_role():
    from src import contact_quality as cq
    assert cq.email_quality("alex.sample@nhs.net", "Alex", "Sample")[0] == "direct" and cq.email_quality("s.example2@nhs.net", "Samuel", "Example")[0] == "direct"
    assert cq.email_quality("enquiries@nhs.net", "Anne", "Lee")[0] == "shared" and cq.email_quality("practicemanager.z00001@nhs.net", "Pat", "Example")[0] == "shared"
    assert cq.email_quality("examplemedicalcentre@nhs.net", "Kim", "Example")[0] == "shared" and cq.email_quality("test@x.nhs.uk")[0] == "reject"
    assert cq.email_quality("pat.example@nhs.net", "", "")[0] == "likely_direct" and cq.email_quality("charlotte.other@nhs.net", "Charlotte", "Sample")[0] == "likely_direct"
    assert cq.email_quality("", "A", "B")[0] == "no_email" and cq.email_quality("not-an-email")[0] == "invalid"
    assert [cq.role_tier(*a)[0] for a in [("Practice Manager", ""), ("Senior Partner", ""), ("Deputy Practice Manager", ""), ("Practice Nurse", ""), ("Advanced Nurse Practitioner", ""), ("", "Practice Manager"),
            ("Receptionist", ""), ("dropped on 2019-06-11", ""), ("", ""), ("Salaried GP", ""), ("Assistant Practice Manager", ""), ("Finance Manager", ""), ("Assistant Manager", ""), ("Service Manager", ""), ("Senior Partner / PCN Clinical Director", ""), ("IT Manager", ""), ("Practice Data Lead", ""), ("Digital Transformation Lead", ""), ("Site Manager", ""), ("IT Support Technician", ""), ("Data Analyst", ""), ("PM", ""), ("IT & Data Quality Manager", ""), ("Ops manager", "")]] == ["A", "A", "A", "x", "x", "A", "x", "x", "?", "x", "A", "B", "B", "A", "A", "A", "A", "A", "A", "?", "?", "A", "A", "A"]


def test_contact_status_suggestion():
    from src import contact_quality as cq
    s = cq.suggest
    assert s("direct", "A")[0] == "approved" and s("likely_direct", "A")[0] == "approved" and s("direct", "x")[0] == "rejected" and s("shared", "A")[0] == "generic"
    assert s("direct", "?")[0] == "review" and "role unknown" in s("direct", "?")[1] and "secondary" in s("direct", "B")[1] and s("check", "A", why="personal-style address, name differs")[1].endswith("does not match the name") and s("check", "A", why="unclear")[1].endswith("unclear")
    assert s("direct", "A", opted_out=True)[0] == "suppressed" and s("direct", "A", bounce="Unknown user")[0] == "suppressed" and s("direct", "A", bounce="Mailbox full")[0] == "approved"
    assert s("direct", "A", has_practice=False)[0] == "rejected" and s("no_email", "A")[0] == "rejected"


def test_oscar_contacts_step_keeps_hubspot_contacts_adopts_by_email_and_gates_new_ones():
    from src import ingest
    class R:
        def __init__(self, rows, generic): self.rows, self.generic, self.up, self.deleted = rows, generic, {}, []
        def select_all(self, table, columns="*", order="id", params=None, page=1000): return self.rows if table == "contacts" else self.generic
        def upsert(self, table, rows, on_conflict, batch=500): self.up.setdefault(table, []).extend(rows)
        def delete_in(self, table, column, values, chunk=200, extra=None): self.deleted += [(table, v) for v in values]
    base = dict(ods_code="A1", seniority=None, phone=None, email_opt_out=False, is_primary=False, org_urn=None, title=None, quals=None, dept=None, categories=None, data_types=None, main_site=False)
    db = [dict(base, contact_urn=-1, source="hubspot", email="jane.doe@nhs.net", full_name="Jane Doe", job_title="Practice Manager", first_name="Jane", last_name="Doe", hubspot_contact_id="777", hubspot_imported_at="2026-10-27"),
          dict(base, contact_urn=-2, source="hubspot", email="other.person@nhs.net", full_name="Other Person", job_title="Practice Manager", first_name="Other", last_name="Person", hubspot_contact_id="778")]
    def oc(urn, first, last, email, title="Practice Manager"):
        return dict(base, contact_urn=urn, full_name=f"{first} {last}", first_name=first, last_name=last, email=email, job_title=title)
    feed = [oc(10, "Jane", "Doe", "jane.doe@nhs.net", "Business Manager"), oc(11, "Sam", "Lee", "sam.lee@nhs.net"), oc(12, "A", "B", "enquiries@nhs.net"), oc(13, "C", "D", "reception@nhs.net"), oc(14, "Dan", "Roe", "d.r@nhs.net")]
    rest, stats, rejects = R(db, []), {}, []
    ingest.contacts_step(rest, feed, {"A1": {}}, [], stats, rejects)
    up = {c["contact_urn"]: c for c in rest.up["contacts"]}
    assert set(up) == {10, 11, 12, 13, 14} and up[10]["held_reason"] is None and up[11]["held_reason"] is None and up[12]["held_reason"] and up[13]["held_reason"] and up[14]["held_reason"] and up[10]["hubspot_contact_id"] == "777" and up[10]["hubspot_status"] == "Imported" and up[10]["job_title"] == "Business Manager"      # Oscar's details win; the HubSpot id is kept
    assert rest.deleted == [("contacts", -1)] and stats["contacts_adopted"] == 1      # the adopted HubSpot row goes; the other HubSpot-sourced contact is never touched, never deleted as "stale"
    assert [g["email"] for g in rest.up["practice_generic_emails"]] == ["enquiries@nhs.net"] and stats["generic_emails_added"] == 1      # one generic address per practice
    assert stats["contacts_held"] == 2 and up[13]["held_reason"].startswith("shared") and "not a direct address" in up[14]["held_reason"], up      # the second shared mailbox and the unclear address are stored, flagged as held back
    rest2 = R(db, [dict(ods_code="A1", email="old@nhs.net", source="oscar")]); ingest.contacts_step(rest2, [oc(12, "A", "B", "enquiries@nhs.net")], {"A1": {}}, [], {}, [])
    assert "practice_generic_emails" not in rest2.up      # the practice already has an Oscar generic address: nothing more is ingested


def test_oscar_load_does_not_undo_a_review_decision():
    from src import ingest
    class R:
        def __init__(self, rows): self.rows, self.up = rows, {}
        def select_all(self, table, columns="*", order="id", params=None, page=1000): return self.rows if table == "contacts" else []
        def upsert(self, table, rows, on_conflict, batch=500): self.up.setdefault(table, []).extend(rows)
        def delete_in(self, *a, **k): pass
    base = dict(ods_code="A1", seniority=None, phone=None, email_opt_out=False, is_primary=False, org_urn=None, title=None, quals=None, dept=None, categories=None, data_types=None, main_site=False, source="oscar", full_name="Pat Smith", first_name="Pat", last_name="Smith", email="psmith2@nhs.net", job_title="Practice Manager")
    db = [dict(base, contact_urn=21, email_quality="direct", held_reason=None, reviewed_by="a@lalu.co.uk"), dict(base, contact_urn=22, email_quality="check", held_reason="rejected in review", reviewed_by="a@lalu.co.uk", email="x@nhs.net"),
          dict(base, contact_urn=23, email_quality="check", held_reason="email is not a direct address (check)", reviewed_by=None, email="y@nhs.net")]
    feed = [dict(base, contact_urn=21), dict(base, contact_urn=22, email="x@nhs.net"), dict(base, contact_urn=23, email="y@nhs.net")]
    r = R(db); ingest.contacts_step(r, feed, {"A1": {}}, [], {}, [])
    up = {c["contact_urn"]: c for c in r.up.get("contacts", [])}
    assert up[21]["email_quality"] == "direct" and up[21]["held_reason"] is None      # accepted in review: the load keeps it direct, so it does not come back to the queue
    assert up[22]["held_reason"] == "rejected in review"      # rejected in review: stays rejected
    db2 = [dict(base, contact_urn=31, email=None, email_quality=None, held_reason="email is not a direct address (no_email)", reviewed_by=None), dict(base, contact_urn=32, email="psmith2@nhs.net", email_quality="likely_direct", held_reason="email is not a direct address (likely_direct)", reviewed_by=None)]
    r2 = R(db2); ingest.contacts_step(r2, [dict(base, contact_urn=31, email=None), dict(base, contact_urn=32, email="pat.smith@nhs.net")], {"A1": {}}, [], {}, [])
    up2 = {c["contact_urn"]: c for c in r2.up.get("contacts", [])}
    assert up2[31]["held_reason"] == "email is not a direct address (no_email)"      # the load does not clear the reason a stored contact was held for, which rewrote every held contact the next day
    assert up2[32]["held_reason"] is None      # an address that has become direct is released


def test_primary_contact_is_picked_from_hubspot_sourced_contacts():
    from src import hubspot_sync as hsy
    c = lambda urn, title, **k: dict(contact_urn=urn, job_title=title, seniority=None, email=f"p{urn}@nhs.net", email_opt_out=False, **k)
    best = hsy.pick_primary([c(-1, "Receptionist"), c(-2, "Practice Manager"), c(-3, "Deputy Practice Manager")])
    assert best["contact_urn"] == -2      # the practice manager, as Oscar would rank them
    assert hsy.pick_primary([c(-1, "Practice Manager", **{})]) ["contact_urn"] == -1 and hsy.pick_primary([dict(c(-1, "Practice Manager"), email_opt_out=True)]) is None

    class R:
        def __init__(self): self.up = {}
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            if table == "contacts":
                return [dict(c(-1, "Practice Manager"), ods_code="A1", full_name="A One", phone=None, is_primary=False, source="hubspot"), dict(c(-2, "Practice Manager"), ods_code="A2", full_name="B Two", phone=None, is_primary=False, source="hubspot")]
            return [dict(ods_code="A1", practice_name="One", manager_name=None, manager_email=None, manager_source=None), dict(ods_code="A2", practice_name="Two", manager_name="Oscar Person", manager_email="o@nhs.net", manager_source="oscar")]
        def upsert(self, table, rows, on_conflict, batch=500): self.up[table] = rows
    r = R()
    assert hsy.fill_hubspot_managers(r) == 1 and r.up["gp_practices"][0]["manager_name"] == "A One" and r.up["gp_practices"][0]["manager_source"] == "hubspot"      # a practice with an Oscar manager is left alone
    assert r.up["contacts"] == [dict(contact_urn=-1, ods_code="A1", is_primary=True)]


def test_audit_skips_closed_practices_already_marked_in_hubspot():
    from src import hubspot_sync as hsy
    pr = {"M10001": dict(ods_code="M10001", practice_name="Old Surgery", status="Active", merged_into="P10001", postcode="LS1 1AA"), "C10001": dict(ods_code="C10001", practice_name="Shut Surgery", status="Inactive", merged_into=None, postcode="LS1 1AB"),
          "C10002": dict(ods_code="C10002", practice_name="Other Shut", status="Inactive", merged_into=None, postcode="LS1 1AC")}
    raw = [dict(id=1, properties=dict(name="Old Surgery", partner_organisation_code="M10001", zip="LS1 1AA", operating_status="merged")),
           dict(id=2, properties=dict(name="Shut Surgery", partner_organisation_code="C10001", zip="LS1 1AB", operating_status="closed")),
           dict(id=3, properties=dict(name="Other Shut", partner_organisation_code="C10002", zip="LS1 1AC", operating_status="active"))]
    rows = hsy.audit_rows(raw, pr, "2026-10-27")
    assert [(r["issue"], r["company_id"]) for r in rows] == [("closed_practice", "3")]      # merged and closed companies already marked as such are resolved; an Active one is still flagged


def test_audit_name_matching_ignores_abbreviations_and_skips_northern_ireland():
    from src import hubspot_sync as hsy
    same = [("MPA Group Practices - Princes Park Medical Centre", "Princes Park Medical Ctr"), ("King Street Medical Centre - Dr Bello's Surgery", "King Street Medical Ctr"),
            ("Pike View Medical Centre & Westhoughton Surgery", "Pike View, Dr Malhotra & Partners"), ("Sidda Family Practice", "Dr Sidda's Surgery, Waters Meeting HC"), ("The Eston Surgery", "Eston Surgery")]
    diff = [("Scarva Street Surgery", "Burnbrae Medical Practice"), ("Valens Medical Partnership", "Npc Central Northumberland"), ("Chorley Health Centre", "Dr Jacobs Surgery"), ("Chapel Street Surgery", "Newhaven Medical Centre")]
    assert all(hsy.names_match(a, b) for a, b in same) and not any(hsy.names_match(a, b) for a, b in diff)
    pr = {"Z00017": dict(ods_code="Z00017", practice_name="Dr. Large & Partners", status="Active", merged_into=None, postcode="BT1 1AA"), "S62986": dict(ods_code="S62986", practice_name="Burnbrae Medical Practice", status="Active", merged_into=None, postcode="G1 1AA")}
    raw = [dict(id=1, properties=dict(name="Holywood Road Surgery", partner_organisation_code="Z00017", zip="BT9 9ZZ")), dict(id=2, properties=dict(name="Scarva Street Surgery", partner_organisation_code="S62986", zip="BT8 8ZZ"))]
    assert [(r["issue"], r["ods_code"]) for r in hsy.audit_rows(raw, pr, "2026-10-27")] == [("name_mismatch", "S62986")]      # NI names are the partners' names, so only the Scottish mismatch is flagged


def test_lifecycle_fields_for_customers_and_churned_practices():
    from src import hubspot_sync as hsy
    sv = {"s1": {"hs_name": "ReportSure - MS - SAR Only", "current_subscription": "eMR+ SAR Only", "contract_start_date": "2024-03-01", "hs_start_date": None, "date_churned": None},
          "s2": {"hs_name": "ReportSure - MS - All reports", "current_subscription": None, "contract_start_date": "2022-05-01", "hs_start_date": "2022-04-20", "date_churned": "2025-06-30"},
          "s3": {"hs_name": "ReportSure Freemium", "current_subscription": "Freemium", "contract_start_date": "2021-01-01", "hs_start_date": None, "date_churned": None}}
    deals = {"d1": {"hs_is_closed_won": "true", "pipeline": next(iter(hsy.PIPELINE_WON)), "closedate": "2024-02-20", "product___service": "eMR+", "amount": "7776", "actual_value_per_patient_calculated": "0.072"}}
    live = hsy.lifecycle_fields([{"id": "1", "company_status": "Current Customer"}], ["d1"], deals, ["s1", "s3"], sv, {"d1": 9000}, 8800)
    assert (live["hubspot_product"], live["hubspot_product_service"], live["hubspot_first_start"], live["hubspot_churned_date"], live["hubspot_signed_size"], live["hubspot_company_status"]) == ("sar", "eMR+", "2024-03-01", None, 9000, "Current Customer") and live["hubspot_size_history"] == [["2024-02-20", 9000]]
    gone = hsy.lifecycle_fields([{"id": "2", "company_status": "Ex-Customer"}], [], {}, ["s2"], sv, {}, 7000)
    assert (gone["hubspot_product"], gone["hubspot_product_service"], gone["hubspot_first_start"], gone["hubspot_churned_date"], gone["hubspot_signed_size"]) == ("all", "eMR+", "2022-04-20", "2025-06-30", None)      # a paid customer with no contracted size is not guessed from the company list size
    assert hsy.service_product({"hs_name": "ReportSure Self Service"}) == "self" and hsy.service_product({"hs_name": "x", "current_subscription": "PAYG"}) == "payg"


def test_contract_patients_come_from_the_contract_not_the_synced_deal_size():
    from src import hubspot_sync as hsy
    c = hsy.contract_patients
    assert c({"amount": "3840.00", "value_per_patient": "£0.08", "patient_list_size": "3653"}) is None and c({"amount": "12096", "actual_value_per_patient_calculated": "0.0720"}) is None      # never back-calculated from the Amount
    assert c({"amount": "1", "value_per_patient": "£0.08"}, 9500) == 9500      # a line item quantity is a contract figure
    assert c({"contracted_patient_list_size": "17300", "amount": "12456", "value_per_patient": "£0.08"}, 17151, 17151) == 17300      # the signed figure on the deal wins over the line item and the Amount
    assert c({"contracted_patient_list_size": "500000"}, None, 15369) is None and c({"contracted_patient_list_size": "500000"}, 9500, 15369) == 9500      # a group figure far from the practice's own size is ignored


def test_freemium_services_start_when_the_service_record_was_created():
    from src import hubspot_sync as hsy
    sv = {"f1": {"hs_name": "ReportSure Freemium", "current_subscription": "Freemium", "contract_start_date": None, "hs_start_date": None, "hs_createdate": "2025-03-05T10:00:00Z", "date_churned": None}}
    f = hsy.lifecycle_fields([{"id": "1", "company_status": "Current Customer"}], [], {}, ["f1"], sv, {}, 6200)
    assert (f["hubspot_product"], f["hubspot_first_start"], f["hubspot_signed_size"]) == ("freemium", "2025-03-05", 6200)


def test_graph_step_applies_pcn_federations_around_the_graph_and_survives_their_failure():
    from src import ingest, maintenance
    calls = []
    class R:
        def __init__(self, fail): self.fail = fail
        def rpc(self, name, *a, **k):
            calls.append(name)
            if self.fail and name == "apply_federation_pcns": raise RuntimeError("function missing")
            return {"ok": True}
    maintenance.purge_never_loaded_closed = lambda rest: 0
    maintenance.prune_closed_practice_nodes = lambda rest: 0
    stats = {}
    ingest.graph_step(R(False), stats)
    assert calls == ["apply_federation_pcns", "refresh_org_graph", "apply_federation_pcns"] and "graph_error" not in stats      # set before the graph is built, linked again after it
    calls.clear(); stats = {}
    ingest.graph_step(R(True), stats)
    assert "refresh_org_graph" in calls and "federations_error" in stats and "graph_error" not in stats      # a missing function never stops the graph


def test_plan_hubspot_orgs_uses_association_labels():
    from src import hubspot_sync as hsy
    orgs = [{"id": "1", "name": "CBC Health Federation", "org_type": "federation"}, {"id": "2", "name": "Hurley Group", "org_type": "Group", "patient_list_size": "123000"},
            {"id": "3", "name": "Suffolk GP Federation", "org_type": "Group"}, {"id": "4", "name": "Plain Alliance", "org_type": "federation"}, {"id": "5", "name": " ", "org_type": "Group"}]
    links = {"1": [("c1", {"member practice"}), ("c2", {"member practice"}), ("c9", {"member practice"})],       # c9 is not a practice we hold
             "2": [("c1", {"operated practice"}), ("c3", {"operated practice"}), ("c2", {"child company"})],         # a Parent / Child link is not an operating link
             "3": [("c1", {"federation"}), ("c2", {"federation"}), ("c3", {"operated practice"})],                   # Org Type says Group, the labels say federation
             "4": [("c1", set()), ("c2", {"belongs to pcn"})]}                                                       # a plain association counts; another relationship's label does not
    plan = {p["company_id"]: p for p in hsy.plan_hubspot_orgs(orgs, links, {"c1": "A1", "c2": "A2", "c3": "A3"})}
    assert plan["1"]["kind"] == "federation" and plan["1"]["practices"] == ["A1", "A2"]
    assert plan["2"]["kind"] == "group" and plan["2"]["practices"] == ["A1", "A3"] and plan["2"]["size"] == "123000"
    assert plan["3"]["kind"] == "federation" and plan["3"]["practices"] == ["A1", "A2"]
    assert plan["4"]["kind"] == "federation" and plan["4"]["practices"] == ["A1"]
    assert "5" not in plan      # no name, nothing to create


def test_sync_hubspot_orgs_sends_the_plan():
    from src import hubspot_sync as hsy
    calls = []

    class H:
        def call(self, method, path, **kw):
            calls.append(path)
            if "companies/search" in path:
                return {"results": [{"id": 7, "properties": {"name": "ELM Alliance", "org_type": "federation"}}]}
            return {"results": [{"from": {"id": "7"}, "to": [{"toObjectId": 11, "associationTypes": [{"category": "USER_DEFINED", "typeId": 1, "label": "Member Practice"}]}]}]}

    class R:
        def rpc(self, name, args=None):
            calls.append((name, args)); return {"created": 1}

    out = hsy.sync_hubspot_orgs(R(), H(), {"A1": [{"id": 11}]})
    assert out == {"hubspot_network_deals": 0, "hubspot_orgs": 1, "hubspot_org_links": 1, "hubspot_orgs_created": 1}
    rpc = [c for c in calls if isinstance(c, tuple)][-1]
    assert rpc[0] == "apply_hubspot_orgs" and rpc[1]["items"][0]["practices"] == ["A1"]


def test_association_label_lookup():
    from src import hubspot_sync as hsy

    class H:
        def call(self, method, path, **kw):
            assert method == "GET" and path == "/crm/v4/associations/companies/p1_pcns/labels"
            return {"results": [{"category": "HUBSPOT_DEFINED", "typeId": 1, "label": None}, {"category": "USER_DEFINED", "typeId": 77, "label": "Belongs to PCN"}]}

    assert hsy.association_label(H(), "p1_pcns", "belongs to pcn") == ("USER_DEFINED", 77)
    assert hsy.association_label(H(), "p1_pcns", "belongs to icb") is None
    assert hsy.association_label(type("Bad", (), {"call": lambda *a, **k: (_ for _ in ()).throw(RuntimeError("403"))})(), "p1_pcns", "x") is None      # unreadable: fall back to the default association


def test_practice_role_links_read_the_labels():
    from src import hubspot_sync as hsy

    class H:
        def call(self, method, path, **kw):
            return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": 9, "associationTypes": [{"label": "Successor Practice"}]}, {"toObjectId": 8, "associationTypes": [{"label": "Federation"}]}]},
                                {"from": {"id": "2"}, "to": [{"toObjectId": 7, "associationTypes": [{"label": "Parent Practice"}, {"label": "Successor Practice"}]}]},
                                {"from": {"id": "3"}, "to": [{"toObjectId": 6, "associationTypes": [{"category": "HUBSPOT_DEFINED", "typeId": 14}]}]}]}

    links = hsy.practice_role_links(H(), ["1", "2", "3"])
    assert links == {"1": {"successor": "9"}, "2": {"branch_parent": "7", "successor": "7"}}      # one company can hold both roles; plain parent / child links are not these roles
    assert hsy.role_columns(links, "1") == {"hubspot_successor_company_id": "9", "hubspot_branch_parent_company_id": None}
    assert hsy.role_columns(links, "5") == {"hubspot_successor_company_id": None, "hubspot_branch_parent_company_id": None}


def test_past_customer_lifecycle_is_not_a_customer():
    from src import hubspot_sync as hsy
    deals = {"d1": {"hs_is_closed_won": "true"}}
    live = [{"id": "1", "lifecyclestage": "customer", "createdate": "2025-01-01"}]
    past = [{"id": "1", "lifecyclestage": hsy.PAST_CUSTOMER, "createdate": "2025-01-01"}]
    assert hsy.classify(live, [], {}, ["d1"], deals)["hubspot_customer"] is True
    f = hsy.classify(past, [], {}, ["d1"], deals)      # eMR inactive: set to Past Customer, so its old closed-won deal no longer makes it a customer
    assert f["hubspot_customer"] is False and f["hubspot_stage"] == "Past Customer" and f["hubspot_engaged"] is False
    assert hsy.classify([{**past[0], "current_subscription": "Subscription"}], [], {}, ["d1"], deals)["hubspot_customer"] is False      # nor does a Commercial Model that was not cleared


def test_upsert_posts_rows_with_different_keys_separately():
    from src.common import Rest
    posts = []

    class Resp:
        ok = True
        status_code = 201
        text = ""

        def json(self):
            return []

    class Sess:
        def post(self, url, params=None, json=None, timeout=None, headers=None):
            posts.append(json); return Resp()

    r = Rest.__new__(Rest); r.s = Sess(); r.base = "https://x/rest/v1"
    r.upsert("contacts", [{"contact_urn": "1", "a": 1}, {"contact_urn": "2", "a": 2, "hubspot_status": "Imported"}, {"contact_urn": "3", "a": 3}], "contact_urn", batch=2)
    assert sorted(len(p) for p in posts) == [1, 2] and all(len({tuple(sorted(x)) for x in p}) == 1 for p in posts)      # no post mixes key sets


def test_ran_recently_guard():
    from datetime import datetime, timedelta, timezone
    from src import ingest
    now = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)

    class R:
        def __init__(self, rows): self.rows = rows
        def select_all(self, *a, **k): return self.rows

    ago = lambda h: [{"finished_at": (now - timedelta(hours=h)).isoformat()}]
    assert ingest.ran_recently(R(ago(3)), now) is True       # a manual re-run the same morning: do not call the public feeds again
    assert ingest.ran_recently(R(ago(23.9)), now) is False   # the next scheduled run
    assert ingest.ran_recently(R([]), now) is False          # nothing has succeeded yet


def test_hubspot_sync_does_not_refetch_nhs_ods_the_same_day():
    from src import hubspot_sync as hsy
    now = "2026-11-03T12:00:00+00:00"

    class R:
        def __init__(self, at): self.at = at
        def select_all(self, table, *a, **k):
            if table == "app_flags":
                return [{"key": "ods_pcn_fetch", "value": {"at": self.at}}] if self.at else []
            return [{"id": "pcn_association-1", "issue": "pcn_association", "object_type": "company"}, {"id": "x", "issue": "name_mismatch", "object_type": "company"}, {"id": "p", "issue": "pcn_name_mismatch", "object_type": "pcn"}]

    assert hsy.ods_fetched_recently(R("2026-11-03T08:30:00+00:00"), now) is True       # a manual re-run: skip the NHS download
    assert hsy.ods_fetched_recently(R("2026-11-02T08:30:00+00:00"), now) is False      # yesterday's: fetch again
    assert hsy.ods_fetched_recently(R(None), now) is False
    assert [r["id"] for r in hsy.network_audit_kept(R(None))] == ["pcn_association-1", "p"]      # the PCN / ICB audit rows survive a skipped step


def test_hubspot_contact_state_reads_the_exclusion_facts():
    from datetime import datetime, timezone

    from src.hubspot_sync import contact_state

    now = datetime(2026, 11, 3, tzinfo=timezone.utc)
    st = contact_state({"lifecyclestage": "lead", "hs_sequences_is_enrolled": "true", "hs_email_bounce": "1", "hs_email_hard_bounce_reason_enum": "UNKNOWN_USER",
                        "hs_email_optout": "false", "hs_email_optout_621322507": "true", "hubspot_owner_id": "78343211", "neverbounce_status": "Valid"}, 7, now)
    assert st["contact_urn"] == 7 and st["hs_lifecycle"] == "lead" and st["hs_in_sequence"] is True and st["hs_bounced"] is True
    assert st["hs_bounce_reason"] == "UNKNOWN_USER" and st["hs_mkt_optout"] is True and st["hs_optout_all"] is False and st["hs_owner"] == "78343211" and st["hs_neverbounce"] == "Valid"
    blank = contact_state({}, 8, now)
    assert blank["hs_in_sequence"] is None and blank["hs_bounced"] is False and blank["hs_lifecycle"] is None


def test_org_kind_separates_non_gp_services_from_practices_without_a_list_yet():
    from src.ingest import org_kind

    assert org_kind("Y00570", 0, False, None, "GP Led Dermatology Service") == "non_gp"
    assert org_kind("Y01822", 0, False, None, "I.C.B. (Oxford City)") == "non_gp"
    assert org_kind("Y02469", 9556, False, None, "Heron GP Practice") == "gp"        # has a list
    assert org_kind("Y05733", 0, False, "123", "Parkfields Surgery") == "gp"        # in HubSpot and named like a surgery
    assert org_kind("C81039", 0, False, None, "Eyam Surgery") == "gp"               # only Y codes are candidates
    assert org_kind("Y00001", 0, True, None, "Some Service") == "gp"                # a customer is never reclassified


def test_slack_atlas_alerts_use_their_own_channel(monkeypatch):
    import importlib

    from src import slack

    importlib.reload(slack)   # an earlier test replaces slack.post without restoring it
    sent = []

    class R:
        ok = True
        status_code = 200
        text = "ok"

        def json(self):
            return {"ok": True}

    monkeypatch.setattr(slack.requests, "post", lambda url, **kw: sent.append((url, kw.get("json"))) or R())
    monkeypatch.setattr(slack.time, "sleep", lambda s: None)
    for k in ("SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL", "SLACK_ATLAS_WEBHOOK_URL", "SLACK_ATLAS_CHANNEL", "SLACK_CHANNEL"):
        monkeypatch.delenv(k, raising=False)
    assert not slack.atlas_configured()
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_CHANNEL", "lalu_market_radar")
    assert slack.atlas_configured()
    slack.post_atlas("hello")
    assert sent[-1][1]["channel"] == "lalu_atlas"           # the bot token reaches #lalu_atlas by name; signals keep their own channel
    slack.post("signal")
    assert sent[-1][1]["channel"] == "lalu_market_radar"


def test_neverbounce_queue_run_and_results():
    from datetime import datetime, timezone
    from src import neverbounce as nb

    assert nb.standard_role("Deputy Practice Manager") == "Practice Manager" and nb.standard_role("GP Partner") == "GP Partner" and nb.standard_role("Health Care Assistant") == "Other"
    assert nb.uk_monday_morning(datetime(2026, 11, 9, 7, 0, tzinfo=timezone.utc)) and not nb.uk_monday_morning(datetime(2026, 11, 9, 9, 30, tzinfo=timezone.utc)) and not nb.uk_monday_morning(datetime(2026, 11, 10, 7, 0, tzinfo=timezone.utc))
    assert nb.uk_monday_morning(datetime(2026, 7, 6, 7, 30, tzinfo=timezone.utc)) and not nb.uk_monday_morning(datetime(2026, 7, 6, 8, 30, tzinfo=timezone.utc))      # BST: 08:30 UTC is 09:30 UK

    class R:
        def __init__(self): self.patched, self.tables = [], {
            "contacts": [dict(contact_urn=1, ods_code="A1", full_name="Jane Doe", first_name="Jane", last_name="Doe", job_title="Practice Manager", email="jane.doe@nhs.net", phone=None, role_tier="A"),
                         dict(contact_urn=2, ods_code="A1", full_name="Bad One", first_name="Bad", last_name="One", job_title="Practice Manager", email="bad.one@nhs.net", phone=None, role_tier="A"),
                         dict(contact_urn=4, ods_code="A1", full_name="Jane Dup", first_name="Jane", last_name="Dup", job_title="Practice Manager", email="jane.dup@nhs.net", phone=None, role_tier="A"),
                         dict(contact_urn=3, ods_code="A1", full_name="Nurse N", first_name="Nurse", last_name="N", job_title="Nurse", email="nurse.n@nhs.net", phone=None, role_tier="x")],
            "gp_practices": [dict(ods_code="A1", hubspot_company_id="77")], "hubspot_segments": [dict(list_id="4584", processing_type="MANUAL", criteria=dict(neverbounce=["Valid", "Accept All (Unverifiable)"], roles=["Practice Manager"]))]}
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            rows = self.tables[table]
            if table == "contacts" and params and params.get("nb_state") == "eq.approved": return rows[:2]
            if table == "contacts" and params and params.get("hubspot_contact_id") == "not.is.null": return [dict(contact_urn=9, email="Jane.Dup@nhs.net")]      # an address HubSpot already holds
            if table == "contacts" and params and params.get("nb_state") == "is.null": return [r for r in rows]
            return rows
        def patch(self, table, filters, values): self.patched.append((table, filters, values))
    rest = R()
    assert nb.queue_new(rest) == 2 and rest.patched[0][2] == {"nb_state": "pending"} and "1,2" in rest.patched[0][1]["contact_urn"]      # decision-makers only; the nurse is not queued
    rest.patched.clear()

    class H:
        def __init__(self): self.calls = []
        def call(self, method, path, **kw):
            self.calls.append((method, path, kw.get("json")))
            if path.endswith("/contacts/search"): return {"results": []}
            if method == "POST" and path == "/crm/v3/objects/contacts": return {"id": "555"}
            return {}
    hub = H()
    answers = {"jane.doe@nhs.net": "catchall", "bad.one@nhs.net": "invalid"}
    def get(url, params=None, timeout=0):
        class J:
            def json(self_inner):
                if url.endswith("/account/info"): return {"credits_info": {"paid_credits_remaining": 90, "free_credits_remaining": 10}}
                return {"status": "success", "result": answers[params["email"]]}
        return J()
    out = nb.run(rest, hub, "k", datetime(2026, 11, 9, 7, 0, tzinfo=timezone.utc), get=get)
    assert out["checked"] == 2 and out["passed"] == 1 and out["failed"] == 1 and out["created"] == 1 and "enrolled" not in out and out["by_status"] == {"Accept All (Unverifiable)": 1, "Invalid": 1} and out["credits_remaining"] == 100, out
    created = [c for c in hub.calls if c[0] == "POST" and c[1] == "/crm/v3/objects/contacts"][0][2]["properties"]
    assert created["neverbounce_status"] == "Accept All (Unverifiable)" and created["job_role_standardised"] == "Practice Manager" and created["email"] == "jane.doe@nhs.net"
    assert ("PUT", "/crm/v4/objects/contacts/555/associations/default/companies/77", None) in hub.calls and not [c for c in hub.calls if "/lists/" in c[1]]      # on its practice company; never added to a HubSpot list automatically (that waits for review in Atlas)
    ok = [p for p in rest.patched if p[1] == {"contact_urn": "eq.1"}][0][2]
    assert ok["nb_result"] == "Accept All (Unverifiable)" and ok["hubspot_contact_id"] == "555" and [p for p in rest.patched if p[1] == {"contact_urn": "eq.2"}][0][2]["hs_neverbounce"] == "Invalid"
    assert nb.run(rest, hub, "k", datetime(2026, 11, 10, 7, 0, tzinfo=timezone.utc), get=get) == {"skipped": "outside Monday before 09:00 UK"}
    assert "2 checked" in nb.report(out)


def test_segments_sync_tracks_two_campaign_lists_and_reads_their_criteria():
    from src import segments as sg

    branch = {"filterBranchType": "OR", "filters": [], "filterBranches": [{"filterBranchType": "AND", "filterBranches": [], "filters": [
        {"filterType": "PROPERTY", "property": "lifecyclestage", "operation": {"operator": "IS_ANY_OF", "values": ["2207373534", "lead"]}},
        {"filterType": "PROPERTY", "property": "neverbounce_status", "operation": {"operator": "IS_ANY_OF", "values": ["Valid"]}},
        {"filterType": "IN_LIST", "listId": "3428"}]}]}
    text, crit = sg.summarize(branch)
    assert crit == {"lifecycle": ["2207373534", "lead"], "neverbounce": ["Valid"]} and "in_list" in text and "neverbounce_status IS_ANY_OF Valid" in text

    class Hub:
        def call(self, method, path, **kw):
            if path == "/crm/v3/lists/search": return {"lists": [{"listId": 2675, "objectTypeId": "0-1", "name": "UM | Campaign List Template", "processingType": "DYNAMIC", "additionalProperties": {"hs_list_size": "10"}},
                                                               {"listId": 99, "objectTypeId": "0-1", "name": "Other list", "processingType": "MANUAL"}, {"listId": 5, "objectTypeId": "0-2", "name": "company list"}], "hasMore": False}
            if path == "/crm/v3/lists/2675": return {"list": {"filterBranch": branch}}
            if path == "/crm/v3/lists/2675/memberships": return {"results": [{"recordId": "1"}, {"recordId": "2"}]}
            raise AssertionError(path)

    class Rest:
        def __init__(self): self.up, self.deleted = {}, []
        def select_all(self, table, columns="*", order="id", params=None, page=1000): return [{"contact_id": "9"}] if table == "hubspot_segment_members" else []
        def upsert(self, table, rows, on_conflict, batch=500): self.up[table] = rows
        def delete_in(self, table, column, values, chunk=200, extra=None): self.deleted.append((table, values, extra))
    r = Rest()
    out = sg.sync(r, Hub())
    assert out == {"segments": 2, "segments_tracked": 1, "segment_members": 2}      # the company list is ignored; only UM (a default) is tracked
    um = [x for x in r.up["hubspot_segments"] if x["list_id"] == "2675"][0]
    assert um["tracked"] and um["criteria"]["neverbounce"] == ["Valid"] and [m["contact_id"] for m in r.up["hubspot_segment_members"]] == ["1", "2"] and r.deleted == [("hubspot_segment_members", ["9"], {"list_id": "eq.2675"})]


def test_audience_alerts_only_for_audiences_with_the_switch_on(monkeypatch):
    from src import notify, slack

    posted = []
    monkeypatch.setattr(slack, "atlas_configured", lambda: True)
    monkeypatch.setattr(slack, "post_atlas", lambda text, blocks=None: posted.append(text))

    class R:
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            assert params == {"slack_alert": "eq.true", "archived": "eq.false"}
            return [dict(id="a1", name="Job report role", signal_type="JOB_REPORT_ROLE", kind="signal", slack_alert=True, archived=False), dict(id="a2", name="Other", signal_type="NEW_PRACTICE", kind="signal", slack_alert=True, archived=False)]
    sent = [dict(trigger_type="JOB_REPORT_ROLE", gp_practices=dict(ods_code="A1", practice_name="Test Surgery")), dict(trigger_type="CQC_PROVIDER_CHANGE", gp_practices=dict(ods_code="A2", practice_name="Nope"))]
    assert notify.audience_alerts(R(), sent, "https://x") == 1 and len(posted) == 1 and "Job report role" in posted[0] and "Test Surgery" in posted[0] and "Nope" not in posted[0]


def test_pcn_wrong_links_are_removed_only_when_the_one_shot_is_on():
    from src import hubspot_sync as hsy

    def run(unlink):
        calls = []

        class Hub:
            def call(self, method, path, **kw):
                calls.append((method, path, kw.get("json")))
                if path.endswith("/batch/read"): return {"results": [{"from": {"id": "100"}, "to": [{"toObjectId": "1"}, {"toObjectId": "2"}]}]}
                if "labels" in path: return {"results": []}
                return {}

        class Rest:
            def select_all(self, *a, **k): return []
            def upsert(self, *a, **k): pass
        pcns = [{"id": "1", "ods_code": "P1", "name": "Right PCN"}, {"id": "2", "ods_code": "P2", "name": "Wrong PCN"}]
        epcn = {"P1": {"name": "Right PCN"}, "P2": {"name": "Wrong PCN"}}
        conflicts = []
        stats, _, _ = hsy.sync_pcn_records(Rest(), Hub(), epcn, pcns, {"A1": {"pcn_code": "P1", "practice_name": "Practice A"}}, {"A1": "100"}, getj=lambda url, *a, **k: {"Organisations": []}, conflicts=conflicts, unlink_wrong=unlink)
        return stats, conflicts, [c for c in calls if c[1].endswith("/batch/archive")]
    stats, conflicts, archive = run(False)
    assert archive == [] and conflicts and conflicts[0][3] == ["Wrong PCN"]      # add-only by default: the audit lists it
    stats, conflicts, archive = run(True)
    assert stats["pcn_links_removed"] == 1 and conflicts == [] and archive[0][2] == {"inputs": [{"from": {"id": "100"}, "to": [{"id": "2"}]}]}      # only the wrong one goes; the practice's own PCN stays


def test_open_deals_are_linked_for_practices_without_a_link():
    from src import hubspot_sync as hsy

    class R:
        def __init__(self): self.up = []
        def select_all(self, table, columns="*", order="id", params=None, page=1000): return [{"ods_code": "B2"}]
        def upsert(self, table, rows, on_conflict, batch=500): self.up += rows
    by_ods = {"B1": [{"id": "10", "name": "Sherburn Surgery", "createdate": "2020"}], "B2": [{"id": "20", "name": "Linked already"}], "B3": [{"id": "30", "name": "No deal"}]}
    to_deals = {"10": ["d1", "d2"], "20": ["d3"], "30": ["d4"]}
    deals = {"d1": {"pipeline": hsy.PIPELINE_CONVERSION, "hs_is_closed": "false", "dealname": "Sherburn and Rillington Practice", "hs_lastmodifieddate": "2026-11-09"}, "d2": {"pipeline": hsy.PIPELINE_SALES, "hs_is_closed": "false", "dealname": "Older", "hs_lastmodifieddate": "2026-10-01"},
             "d3": {"pipeline": hsy.PIPELINE_SALES, "hs_is_closed": "false"}, "d4": {"pipeline": hsy.PIPELINE_SALES, "hs_is_closed": "true", "dealname": "Closed"}}
    r = R()
    assert hsy.link_open_deals(r, by_ods, to_deals, deals) == 1 and r.up[0]["ods_code"] == "B1" and r.up[0]["deal_id"] == "d1" and r.up[0]["linked_by"] == "daily sync"      # newest open deal; an existing link and a closed deal are left alone


def test_hubspot_contacts_missing_from_atlas_are_stored_with_graded_addresses():
    from src import hubspot_sync as hsy

    class R:
        def __init__(self): self.rows = []
        def insert(self, table, rows, **kw): self.rows += rows
    by_ods = {"A1": [{"id": "10"}], "A2": [{"id": "20"}]}
    to_contacts = {"10": ["1", "2", "3"], "20": ["4"]}
    contacts = {"1": {"email": "Sam.Hoes@nhs.net", "firstname": "Samantha", "lastname": "Hoes-Mole", "jobtitle": "Practice Manager"}, "2": {"email": "info@nhs.net", "firstname": "", "lastname": ""}, "3": {"email": "known@nhs.net", "firstname": "K", "lastname": "N"}, "4": {}}
    r = R()
    assert hsy.import_hubspot_contacts(r, by_ods, to_contacts, contacts, {"3"}) == 2 and {x["hubspot_contact_id"] for x in r.rows} == {"1", "2"}      # known ids and empty records are skipped
    sam = [x for x in r.rows if x["hubspot_contact_id"] == "1"][0]
    assert sam["source"] == "hubspot" and sam["ods_code"] == "A1" and sam["email"] == "sam.hoes@nhs.net" and sam["email_quality"] == "direct" and sam["role_tier"] == "A" and sam["hubspot_status"] == "Imported"


def test_disqualified_leads_give_each_contact_its_latest_reason():
    from src import hubspot_sync as hsy

    class Hub:
        def call(self, method, path, **kw):
            if path.endswith("/contacts/leads/batch/read"): return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": "10"}, {"toObjectId": "11"}]}, {"from": {"id": "2"}, "to": [{"toObjectId": "12"}]}]}
            if path.endswith("/leads/batch/read"):
                return {"results": [{"id": "10", "properties": {"hs_lead_disqualification_reason": "Bad timing", "hs_lastmodifieddate": "2026-10-01T00:00:00Z", "disqualified_lead_reengagement_date": "2027-01-15"}},
                                    {"id": "11", "properties": {"hs_lead_disqualification_reason": "No budget", "hs_lead_disqualification_note": "Next year", "hs_lastmodifieddate": "2026-11-01T00:00:00Z"}},
                                    {"id": "12", "properties": {"hs_lastmodifieddate": "2026-11-02T00:00:00Z"}}]}
            raise AssertionError(path)
    dq = hsy.disqualified_leads(Hub(), ["1", "2"])
    assert dq == {"1": {"reason": "No budget", "note": "Next year", "at": "2026-11-01T00:00:00Z", "reengage": None}}      # the newest disqualified lead wins; a contact whose lead has no reason is left out
    st = hsy.contact_state({"lifecyclestage": "lead"}, 5, "now", dq["1"])
    assert st["hs_dq_reason"] == "No budget" and st["hs_dq_note"] == "Next year" and hsy.contact_state({}, 6, "now")["hs_dq_reason"] is None


def test_hubspot_contacts_stored_only_when_a_person_made_them_and_atlas_lacks_them():
    from src import hubspot_sync as hsy

    class R:
        def __init__(self): self.rows = []
        def insert(self, table, rows): self.rows += rows
    contacts = {"1": {"email": "new@nhs.net", "firstname": "New", "lastname": "Person"},
                "2": {"email": "atlas@nhs.net", "firstname": "By", "lastname": "Atlas", "um_source_detail_1": "Oscar AI"},
                "3": {"email": "held@nhs.net", "firstname": "In", "lastname": "Atlas"},
                "4": {"email": "x@nhs.net", "firstname": "Dated", "lastname": "Atlas", "um_source_detail_2": "Lalu Atlas Import: 2026-11-09"},
                "5": {"email": "", "firstname": "No", "lastname": "Email"}}
    r = R()
    n = hsy.import_hubspot_contacts(r, {"A1": [{"id": 10}]}, {"10": ["1", "2", "3", "4", "5"]}, contacts, set(), known_emails={"held@nhs.net"})
    assert n == 1 and r.rows[0]["hubspot_contact_id"] == "1"      # not Atlas-made contacts, not an address Atlas already holds, nothing without an email


def test_deals_made_in_hubspot_for_a_group_are_recorded_against_the_networks_they_cover():
    from src import hubspot_sync as hsy

    class Hub:
        def call(self, method, path, **kw):
            if "/companies/deals/batch/read" in path: return {"results": [{"from": {"id": "9"}, "to": [{"toObjectId": 1}, {"toObjectId": 2}, {"toObjectId": 3}]}]}
            if "/deals/companies/batch/read" in path: return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": 100}, {"toObjectId": 101}, {"toObjectId": 102}]}, {"from": {"id": "3"}, "to": []}]}
            if "/deals/batch/read" in path:
                return {"results": [{"id": "1", "properties": {"dealname": "Sunderland GP Alliance", "hs_is_closed": "false"}}, {"id": "2", "properties": {"dealname": "Lost", "hs_is_closed_lost": "true"}}, {"id": "3", "properties": {"dealname": "No practices"}}]}
            raise AssertionError(path)

    class R:
        def __init__(self): self.up, self.deleted = [], []
        def select_all(self, table, *a, **k):
            return {"hubspot_org_companies": [{"org_id": "prov", "company_id": "9"}], "hubspot_network_deals": [{"deal_id": "1", "org_id": "stale", "created_by": "HubSpot sync", "covers": []}],
                    "organisations": [{"id": "p1", "ods_code": "A1"}, {"id": "p2", "ods_code": "A2"}, {"id": "p3", "ods_code": "A3"}, {"id": "p4", "ods_code": "A4"}],
                    "org_relationships": [{"from_org": "p1", "to_org": "prov", "rel_type": "OPERATED_BY"}, {"from_org": "p2", "to_org": "prov", "rel_type": "OPERATED_BY"}, {"from_org": "p1", "to_org": "fed", "rel_type": "MEMBER_OF_FEDERATION"},
                                          {"from_org": "p3", "to_org": "fed", "rel_type": "MEMBER_OF_FEDERATION"}, {"from_org": "p4", "to_org": "fed", "rel_type": "MEMBER_OF_FEDERATION"}]}[table]
        def upsert(self, table, rows, key): self.up += rows
        def delete_in(self, table, col, vals, extra=None): self.deleted.append((col, vals, extra))
    r = R()
    n = hsy.link_network_deals(r, Hub(), ["9"], {"100": "A1", "101": "A2", "102": "A3"})
    got = {(x["deal_id"], x["org_id"]): x["covers"] for x in r.up}
    assert got[("1", "prov")] == ["A1", "A2"] and got[("1", "fed")] == ["A1", "A3"]      # one deal covering both networks sits on both, with each network's practices
    assert got[("3", "prov")] == [] and ("2", "prov") not in got and n == 3      # a deal naming no practice stays on the company's own network; a lost deal is dropped
    assert r.deleted == [("deal_id", ["1"], {"org_id": "eq.stale"})]      # a sync-made row for a network the deal no longer covers is removed


def test_contact_links_keep_emailless_contacts_and_duplicates_are_counted():
    from src import hubspot_sync as hsy
    ours = [dict(contact_urn=1, ods_code="A1", email=None, hubspot_status="Imported", hubspot_contact_id="77"),      # a nurse: no email, matched by HubSpot id
            dict(contact_urn=2, ods_code="A1", email="a@nhs.net", hubspot_status="Not imported", hubspot_contact_id=None),
            dict(contact_urn=3, ods_code="A1", email=None, hubspot_status="Imported", hubspot_contact_id="99")]      # gone from HubSpot
    crow = hsy.contact_link_updates(ours, {"A1": []}, {"A1": {"a@nhs.net": ("5", "2026-01-01")}}, {"A1": {"77"}})
    got = {r["contact_urn"]: r for r in crow}
    assert 1 not in got      # the link of a contact with no email is NOT cleared (clearing it made every sync store it again)
    assert got[2]["hubspot_contact_id"] == "5" and got[3]["hubspot_contact_id"] is None
    rows = [dict(ods_code="A1", email="x@nhs.net", hubspot_contact_id="1", source="hubspot"), dict(ods_code="A1", email="x@nhs.net", hubspot_contact_id="2", source="hubspot"), dict(ods_code="A1", email=None, hubspot_contact_id="1", source="oscar"),
            dict(ods_code="A1", email=None, hubspot_contact_id=None, source="hubspot"), dict(ods_code="A2", email="x@nhs.net", hubspot_contact_id="1", source="oscar")]
    assert hsy.duplicate_contact_counts(rows) == {"same_id_same_practice": 1, "same_email_same_practice": 1, "nameless_without_id": 1}      # the same id may appear at different practices; at one practice it is a duplicate


def test_a_customer_with_only_a_signed_deal_is_linked_to_it():
    from src import hubspot_sync as hsy

    class R:
        def __init__(self): self.up = []
        def select_all(self, *a, **k): return []
        def upsert(self, table, rows, key): self.up += rows
    r = R()
    by_ods = {"C1": [{"id": 5, "name": "Lea Vale", "createdate": "2020"}]}
    deals = {"d1": {"hs_is_closed": "true", "hs_is_closed_won": "true", "pipeline": "default", "closedate": "2026-01-01T00:00:00Z", "dealname": "Old"},
             "d2": {"hs_is_closed": "true", "hs_is_closed_won": "true", "pipeline": "default", "closedate": "2026-06-01T00:00:00Z", "dealname": "Lea Vale Medical Group"},
             "d3": {"hs_is_closed": "true", "hs_is_closed_lost": "true", "pipeline": "default", "closedate": "2026-08-01T00:00:00Z", "dealname": "Lost"}}
    assert hsy.link_open_deals(r, by_ods, {"5": ["d1", "d2", "d3"]}, deals) == 1 and r.up[0]["deal_id"] == "d2"      # no open deal: the latest signed one, never a lost one


def test_lifecycle_audit_compares_stage_with_services_and_churn():
    from src import hubspot_sync as hsy
    live = {"s1": {"hs_pipeline_stage": "2551571664", "hs_name": "Svc A"}}
    gone = {"s2": {"hs_pipeline_stage": "999", "hs_name": "Old"}}
    co = lambda stage, **k: [{"id": 1, "name": "P", "lifecyclestage": stage, **k}]
    r = hsy.lifecycle_audit("A1", "P", co("customer"), ["s2"], gone, "2026-05-01", "now")
    assert r["issue"] == "lifecycle_should_be_past" and "2026-05-01" in r["detail"]      # no live Service, churned, still Customer
    assert hsy.lifecycle_audit("A1", "P", co("customer"), ["s1"], live, "2026-05-01", "now") is None      # a live Service: not flagged
    assert hsy.lifecycle_audit("A1", "P", co("customer"), ["s2"], gone, None, "now") is None      # no churn date: not flagged
    assert hsy.lifecycle_audit("A1", "P", co(hsy.PAST_CUSTOMER), ["s2"], gone, "2026-05-01", "now") is None      # already right
    assert hsy.lifecycle_audit("A1", "P", co(hsy.PAST_CUSTOMER), ["s1"], live, None, "now")["issue"] == "lifecycle_past_but_live"
    assert hsy.lifecycle_audit("A1", "P", co(hsy.MERGED_CLOSED), ["s2"], gone, "2026-05-01", "now") is None


def test_lost_deals_give_each_contact_its_latest_closed_lost_reason():
    from src import hubspot_sync as hsy

    class Hub:
        def call(self, method, path, **kw):
            if path.endswith("/contacts/deals/batch/read"): return {"results": [{"from": {"id": "1"}, "to": [{"toObjectId": "50"}, {"toObjectId": "51"}]}, {"from": {"id": "2"}, "to": [{"toObjectId": "52"}, {"toObjectId": "53"}]}, {"from": {"id": "3"}, "to": [{"toObjectId": "54"}]}]}
            if path.endswith("/deals/batch/read"):
                return {"results": [{"id": "50", "properties": {"hs_is_closed": "true", "hs_is_closed_lost": "true", "um_closed_lost_reasons": "Timing / Project Delayed", "closedate": "2026-01-01T00:00:00Z", "pipeline": "default", "dealname": "Old"}},
                                    {"id": "51", "properties": {"hs_is_closed": "true", "hs_is_closed_lost": "true", "um_closed_lost_reasons": "Selected Competitor", "closedate": "2026-06-01T00:00:00Z", "pipeline": "3784347852", "dealname": "Renewal"}},
                                    {"id": "52", "properties": {"hs_is_closed": "true", "hs_is_closed_lost": "true", "um_closed_lost_reasons": "No Budget / Too Expensive", "closedate": "2026-02-01T00:00:00Z", "pipeline": "default"}},
                                    {"id": "53", "properties": {"hs_is_closed": "false", "pipeline": "default"}},
                                    {"id": "54", "properties": {"hs_is_closed": "true", "hs_is_closed_lost": "true", "closedate": "2026-03-01T00:00:00Z", "pipeline": "default"}}]}
            raise AssertionError(path)
    lost = hsy.lost_deals(Hub(), ["1", "2", "3"])
    assert lost["1"]["reason"] == "Selected Competitor" and lost["1"]["kind"] == "customer" and lost["1"]["at"] == "2026-06-01"      # the latest lost deal wins; a renewals deal means they were a customer
    assert "2" not in lost      # a contact with a deal still open is already being worked
    assert lost["3"]["reason"] == "No reason recorded" and lost["3"]["kind"] == "lead"
    assert hsy.contact_state({}, 1, "now", None, lost["1"])["hs_lost_reason"] == "Selected Competitor" and hsy.contact_state({}, 1, "now")["hs_lost_kind"] is None


def test_contacts_atlas_creates_in_hubspot_carry_source_and_legal_basis():
    from datetime import datetime, timezone
    from src import neverbounce as nb
    p = nb.creation_props(today=datetime(2026, 11, 9, tzinfo=timezone.utc))
    assert p["source_category"] == "Import" and p["um_source_detail_1"] == "Oscar AI" and p["um_source_detail_2"] == "Lalu Atlas Import: 2026-11-09" and p["um_lt_source_detail_2"] == p["um_source_detail_2"]
    assert p["hs_marketable_status"] == "false" and p["hs_legal_basis"] == "Legitimate interest \u2013 prospect/lead"      # the exact HubSpot option value (en dash)


def test_slack_channels_are_the_ones_the_bot_is_in_and_follow_changes():
    from src import slack

    pages = [{"ok": True, "channels": [{"id": "C1", "name": "lalu_atlas", "is_member": True}, {"id": "C2", "name": "random", "is_member": False}], "response_metadata": {"next_cursor": "x"}},
             {"ok": True, "channels": [{"id": "C3", "name": "sales", "is_member": True, "is_private": True}], "response_metadata": {"next_cursor": ""}}]
    calls = []

    def get(url, params=None, headers=None, timeout=0):
        calls.append(params)

        class J:
            def json(self): return pages[len(calls) - 1]
        return J()
    assert slack.list_channels(get, "tok") == [{"id": "C1", "name": "lalu_atlas", "is_private": False}, {"id": "C3", "name": "sales", "is_private": True}] and calls[1]["cursor"] == "x"      # only channels it is a member of

    class Rest:
        def __init__(self): self.up, self.deleted = None, None
        def upsert(self, table, rows, on_conflict, batch=500): self.up = rows
        def select_all(self, table, columns="*", order="id", params=None, page=1000): return [{"id": "C1"}, {"id": "C9"}]
        def delete_in(self, table, column, values, chunk=200, extra=None): self.deleted = values
    calls.clear(); r = Rest()
    assert slack.sync_channels(r, get, "tok") == 2 and [x["id"] for x in r.up] == ["C1", "C3"] and r.deleted == ["C9"]      # a channel the bot left disappears from the picker, a new one appears


def test_sequence_exit_reason_is_recorded_from_what_hubspot_holds():
    from src import hubspot_sync as hsy

    base = {"hs_latest_sequence_enrolled_date": "2026-11-01T09:00:00Z", "hs_latest_sequence_ended_date": "2026-11-03T10:00:00Z", "hs_sequences_is_enrolled": "false"}
    assert hsy.sequence_exit({**base, "hs_sequences_is_enrolled": "true"}) is None and hsy.sequence_exit({"hs_sequences_is_enrolled": "false"}) is None      # still in it, or never in one
    assert hsy.sequence_exit({**base, "hs_sales_email_last_replied": "2026-11-02T08:00:00Z"}) == "replied"
    assert hsy.sequence_exit({**base, "engagements_last_meeting_booked": str(int(1793000000000))}) in ("booked a meeting", "completed")
    assert hsy.sequence_exit({**base, "engagements_last_meeting_booked": "2026-11-02T11:00:00Z"}) == "booked a meeting"
    assert hsy.sequence_exit({**base, "hs_sales_email_last_replied": "2026-10-01T00:00:00Z"}) == "completed"      # a reply from before this sequence does not count
    assert hsy.sequence_exit({**base, "hs_email_optout": "true", "hs_sales_email_last_replied": "2026-11-02T08:00:00Z"}) == "unsubscribed" and hsy.sequence_exit({**base, "hs_email_bounce": "1"}) == "bounced"
    st = hsy.contact_state({**base, "hs_latest_sequence_enrolled": "88", "hs_sales_email_last_replied": "2026-11-02T08:00:00Z"}, 1, "now")
    assert st["hs_seq_exit"] == "replied" and st["hs_seq_id"] == "88" and st["hs_seq_ended_at"].startswith("2026-11-03")
