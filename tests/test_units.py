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
    import shutil, subprocess, pathlib
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    out = subprocess.run([node, str(pathlib.Path(__file__).parent / "pricing_audit.js")], capture_output=True, text=True, timeout=60)
    assert "mismatches: 0" in out.stdout and "sheet 1-year base mismatches: 0" in out.stdout and "matrix mismatches: 0" in out.stdout, out.stdout + out.stderr


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


def test_n8n_line_item_discount():
    import json, pathlib, shutil, subprocess
    wf = json.loads(pathlib.Path("n8n/line-item-sync.workflow.json").read_text())
    code = next(n for n in wf["nodes"] if n["name"] == "Work out discount")["parameters"]["jsCode"]
    assert pathlib.Path("n8n/line-item-discount.js").read_text().replace("module.exports = { expectedDiscount };\n", "") in code
    if not shutil.which("node"):
        return
    js = "const {expectedDiscount:e}=require('./n8n/line-item-discount.js');const d={size_discount:'0.05',speed_discount:'0.05',term_length_discount:'0.025',referral_discount:'0.02'};" \
         "console.log(JSON.stringify([e(d,{hs_product_id:'440423339237',price:'0.96'}),e({...d,referral_discount:'0'},{hs_product_id:'440423339237',price:'0.96'}),e(d,{hs_product_id:'440425147578',price:'0.1'}),e({size_discount:'0.5',speed_discount:'0.5'},{hs_product_id:'440423339237',price:'0.96'}),e({size_discount:'0.5',speed_discount:'0.5'},{hs_product_id:'440434162881',price:'0.6'}),e(d,{hs_product_id:'1',price:'1'})]))"
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert out == [0.1392, 0.12, 0, 0.336, 0.6, None], out


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


def test_list_size_plan_holds_big_jumps_and_leaves_paying_customers_without_a_line_item():
    from src import hubspot_sync as hsy
    pr = {c: dict(ods_code=c, practice_name=c, status="Active", merged_into=None, total_patients=n) for c, n in [("A", 10500), ("B", 10000), ("C", 20000), ("D", 9000), ("E", 8000), ("F", 0)]}
    pr["E"]["merged_into"] = "A"
    pr["E"]["total_patients"] = 0      # NHS counts a merged practice at 0
    rows = [dict(ods_code="A", hubspot_company_id="1", hubspot_customer=False, hubspot_list_size=10000), dict(ods_code="B", hubspot_company_id="2", hubspot_customer=False, hubspot_list_size=10000),
            dict(ods_code="C", hubspot_company_id="3", hubspot_customer=False, hubspot_list_size=10000), dict(ods_code="D", hubspot_company_id="4", hubspot_customer=True, hubspot_contracted_arr=5000, hubspot_contract_terms=None, hubspot_list_size=5000),
            dict(ods_code="E", hubspot_company_id="5", hubspot_customer=False, hubspot_list_size=7000), dict(ods_code="F", hubspot_company_id="6", hubspot_customer=False, hubspot_list_size=7000)]
    auto, held = hsy.plan_list_sizes(pr, rows)
    assert [c["ods"] for c in auto] == ["A", "E"] and auto[0]["to"] == 10500 and auto[1]["to"] == 0 and auto[1]["gone"] == "merged" and [c["ods"] for c in held] == ["C"]      # B unchanged, D a paying customer with no line item, F has no size; the merged E (NHS 0, HubSpot 7,000) is zeroed, never held


def test_list_size_push_batches_and_stops_on_error():
    from src import hubspot_sync as hsy
    class R:
        def __init__(self): self.up = []
        def upsert(self, table, rows, on_conflict, batch=500): self.up += rows
    class H:
        def __init__(self, fail_at=None): self.calls, self.fail_at = [], fail_at
        def call(self, method, path, **kw):
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
    pr = {"A": dict(ods_code="A", practice_name="Alpha Surgery", **base), "B": dict(ods_code="B", practice_name="Beta Medical Centre", **{**base, "status": "Closed"}),
          "C": dict(ods_code="C", practice_name="Gamma Practice", **{**base, "merged_into": "A"}), "D": dict(ods_code="D", practice_name="Delta Medical Centre", **{**base, "status": "Closed", "postcode": "ZZ9 9ZZ"}),
          "E": dict(ods_code="E", practice_name="Echo Surgery", **base), "F": dict(ods_code="F", practice_name="Foxtrot Surgery", **{**base, "closure_confirmed_at": "2026-01-01"})}
    rows = [dict(ods_code=c, hubspot_company_id=str(i), hubspot_org_type=o, hubspot_operating_status=s) for i, (c, o, s) in enumerate([("A", None, None), ("B", "practice", "active"), ("C", None, None), ("D", "group", "active"), ("E", "practice", "active"), ("F", "practice", "closed")], 1)]
    branches = [dict(branch_code="T1", branch_name="Delta Medical Centre", postcode="ZZ9 9ZZ", resolution="branch", match_status="auto", practice_code="A", status="Active")]
    auto, cases = hsy.plan_alignment(pr, rows, branches)
    got = {c["ods"]: c["props"] for c in auto}
    assert got == {"A": {"org_type": "practice", "operating_status": "active"}, "B": {"operating_status": "closed"}}, got      # E and F already match; D (a moved site) and C (merged) wait for a person
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
    auto, held = hsy.plan_list_sizes(pr, rows)
    assert [(c["ods"], c["to"], c.get("successor")) for c in auto] == [("M", 0, "Parent Practice"), ("K", 0, "Parent Practice")] and not held      # a practice with no NHS data is not zeroed, and a freemium customer without a contract follows NHS and is zeroed like a non-customer

    rows[2].update(hubspot_contracted_arr=4227, hubspot_contract_terms={"line_qty": 7045})      # with a line item the customer follows NHS (up to a point), but a paying customer is never zeroed
    assert [c["ods"] for c in hsy.plan_list_sizes(pr, rows)[0]] == ["M"]
    rows[2].update(hubspot_contract_terms=None)
    assert [c["ods"] for c in hsy.plan_list_sizes(pr, rows)[0]] == ["M"]      # no line item and a contract: left alone
    pr["P"]["total_patients"] = 9500
    rows.append(dict(ods_code="P", hubspot_company_id="9", hubspot_customer=True, hubspot_contracted_arr=4227, hubspot_contract_terms={"line_qty": 9000}, hubspot_list_size=9000))
    assert [(c["ods"], c["to"]) for c in hsy.plan_list_sizes(pr, rows)[0]] == [("M", 0), ("P", 9500)]      # a customer with a line item follows NHS
    rows.pop(); rows[2].update(hubspot_customer=False, hubspot_contracted_arr=None)
    auto = hsy.plan_list_sizes(pr, rows)[0]
    class H:
        def __init__(self): self.calls = []
        def call(self, method, path, **kw): self.calls.append((path, kw.get("json")))
    class R:
        def upsert(self, *a, **k): pass
    h = H(); done, err = hsy.push_list_sizes(R(), h, auto)
    note = [c for c in h.calls if c[0] == "/crm/v3/objects/notes"][0][1]
    assert err is None and "was 3,717" in note["properties"]["hs_note_body"] and "Parent Practice" in note["properties"]["hs_note_body"] and note["associations"][0]["to"]["id"] == "1"


def test_contact_email_quality_and_role():
    from src import contact_quality as cq
    assert cq.email_quality("alex.sample@nhs.net", "Alex", "Sample")[0] == "direct" and cq.email_quality("s.example2@nhs.net", "Samuel", "Example")[0] == "direct"
    assert cq.email_quality("enquiries@nhs.net", "Anne", "Lee")[0] == "shared" and cq.email_quality("practicemanager.z00001@nhs.net", "Pat", "Example")[0] == "shared"
    assert cq.email_quality("examplemedicalcentre@nhs.net", "Kim", "Example")[0] == "shared" and cq.email_quality("test@x.nhs.uk")[0] == "reject"
    assert cq.email_quality("pat.example@nhs.net", "", "")[0] == "likely_direct" and cq.email_quality("charlotte.other@nhs.net", "Charlotte", "Sample")[0] == "likely_direct"
    assert cq.email_quality("", "A", "B")[0] == "no_email" and cq.email_quality("not-an-email")[0] == "invalid"
    assert [cq.role_tier(*a)[0] for a in [("Practice Manager", ""), ("Senior Partner", ""), ("Deputy Practice Manager", ""), ("Practice Nurse", ""), ("Advanced Nurse Practitioner", ""), ("", "Practice Manager"),
            ("Receptionist", ""), ("dropped on 2019-06-11", ""), ("", ""), ("Salaried GP", "")]] == ["A", "A", "B", "x", "x", "A", "x", "x", "?", "x"]


def test_contact_status_suggestion():
    from src import contact_quality as cq
    s = cq.suggest
    assert s("direct", "A")[0] == "approved" and s("direct", "?")[0] == "review" and s("direct", "x")[0] == "rejected" and s("shared", "A")[0] == "generic" and s("likely_direct", "A")[0] == "review"
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
    assert set(up) == {10, 11} and up[10]["hubspot_contact_id"] == "777" and up[10]["hubspot_status"] == "Imported" and up[10]["job_title"] == "Business Manager"      # Oscar's details win; the HubSpot id is kept
    assert rest.deleted == [("contacts", -1)] and stats["contacts_adopted"] == 1      # the adopted HubSpot row goes; the other HubSpot-sourced contact is never touched, never deleted as "stale"
    assert [g["email"] for g in rest.up["practice_generic_emails"]] == ["enquiries@nhs.net"] and stats["generic_emails_added"] == 1      # one generic address per practice
    assert stats["contacts_held"] == 2 and sorted(r[1] for r in rejects if "held back" in r[2]) == ["13", "14"], rejects      # the second shared mailbox and the unclear address are held back
    rest2 = R(db, [dict(ods_code="A1", email="old@nhs.net", source="oscar")]); ingest.contacts_step(rest2, [oc(12, "A", "B", "enquiries@nhs.net")], {"A1": {}}, [], {}, [])
    assert "practice_generic_emails" not in rest2.up      # the practice already has an Oscar generic address: nothing more is ingested
