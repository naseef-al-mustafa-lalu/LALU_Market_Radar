import pytest

from src import digest, oscar, software, sources
from src.common import esc, norm_ods, title_case
from tests.conftest import make_epraccur, make_oscar, make_patients, zipped


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


def test_digest_select_and_escape():
    def trig(i, seg, n, lead="Cold", name="<script>x</script>"):
        return {"id": i, "trigger_type": "NEW_PRACTICE", "headline": "H", "description": "D",
                "gp_practices": {"ods_code": "A10000", "practice_name": name, "pcn_name": "P", "icb_name": "I",
                                 "total_patients": n, "sales_segment": seg, "clinical_software": "Unknown",
                                 "manager_name": None, "manager_title": None, "manager_email": "a@b.c",
                                 "manager_phone": None, "manager_email_opt_out": True, "lead_status": lead, "status": "Active"}}
    ts = [trig("1", "", 100), trig("2", "", 21000), trig("3", "", 16000, lead="Do-Not-Contact")]
    send, skip = digest.select(ts, "Tier 2", TIERS)
    assert [t["id"] for t in send] == ["2"] and {t["id"] for t in skip} == {"1", "3"}
    out = digest.render(send, "https://x", TIERS)
    assert "<script>" not in out and "&lt;script&gt;" in out and "a@b.c" not in out and "opt-out" in out


def test_uploaded_network_is_not_overwritten_by_ods_sync():
    from src import ingest
    old = {"ods_code": "W93001", "practice_name": "St Lukes", "postcode": "NP11 5GX", "status": "Active", "pcn_code": "WC60103",
           "pcn_name": "Wales cluster 60103", "icb_name": "Aneurin Bevan", "network_locked": True, "country": "Wales",
           "total_patients": 0, "clinical_software": "Unknown", "software_checked_at": None, "website": None}
    ods = {"W93001": {"name": "ST LUKES", "postcode": "NP11 5GX", "status": "Active"}}
    recs, _ = ingest.build_records(ods, {}, "2026-09", {"W93001": old}, {}, None, None, pcn_checked=frozenset({"W93001"}))
    assert not recs or (recs[0]["pcn_code"], recs[0]["pcn_name"], recs[0]["icb_name"]) == ("WC60103", "Wales cluster 60103", "Aneurin Bevan")
    assert ingest.pcn_due({"W93001"}, {"W93001": old}, __import__("datetime").datetime.now(__import__("datetime").timezone.utc)) == []


def test_provider_change_signal_text_uses_names_not_ids():
    from src import cqc

    class R:
        def __init__(self):
            self.kv = {}; self.patched = []
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            if table == "kv_state":
                return [{"key": k, "value": v} for k, v in self.kv.items() if params and k == params["key"].split(".", 1)[1]]
            return [{"id": "t1", "headline": "x", "ods_code": "A1", "description":
                     "Bartley Green Medical Practice is now registered with 1-13654215274 (previously 1-199796905). Group takeovers often bring system consolidation."}]
        def upsert(self, table, rows, key, batch=500):
            for r in rows: self.kv[r["key"]] = r["value"]
        def patch(self, table, params, body):
            self.patched.append(body)
    r = R()
    names = {"1-13654215274": "Lakeside Healthcare Group", "1-199796905": "Dr A Partners"}
    assert cqc.repair_provider_signals(r, lambda path, params=None: {"name": names[path.rsplit("/", 1)[1]]}) == 1
    assert r.patched[0]["description"] == "Bartley Green Medical Practice is now run by Lakeside Healthcare Group (previously Dr A Partners)."
    assert r.patched[0]["headline"] == "Bartley Green Medical Practice changed owner to Lakeside Healthcare Group"


def test_same_name_provider_change_is_not_called_a_takeover():
    from src import cqc

    class R:
        def __init__(self): self.patched = []; self.kv = {}
        def select_all(self, table, columns="*", order="id", params=None, page=1000):
            if table == "kv_state": return []
            return [{"id": "t9", "headline": "Bartley Green Medical Practice changed owner to Bartley Green Medical Practice", "ods_code": "A1",
                     "description": "Bartley Green Medical Practice is now run by Bartley Green Medical Practice (previously Bartley Green Medical Practice)."}]
        def upsert(self, *a, **k): pass
        def patch(self, table, params, body): self.patched.append(body)
    r = R()
    assert cqc.repair_provider_signals(r, lambda *a, **k: {}) == 1
    assert r.patched[0]["headline"] == "Bartley Green Medical Practice: new CQC provider record" and "not a takeover" in r.patched[0]["action"]
