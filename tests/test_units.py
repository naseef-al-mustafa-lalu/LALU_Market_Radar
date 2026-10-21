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
    assert prim["contact_urn"] == 1 and prim["email"] == "casper@nhs.net" and prim["full_name"] == "Casper Fons"
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
    assert f == {"hubspot_contracted_arr": 4000.0, "hubspot_contracted_src": "service", "hubspot_pipeline": 500.0, "hubspot_renewal_pipeline": 700.0}
    g = hsy.revenue_fields(["w"], deals, [], {}, True, "eMR Plus")                  # no Service: fall back to the won deal, flagged
    assert g["hubspot_contracted_arr"] == 900.0 and g["hubspot_contracted_src"] == "deal"
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
