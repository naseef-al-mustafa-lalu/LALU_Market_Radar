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


def test_ods_api_pcn_and_icb():
    def page(url, params):
        o = int(params["Offset"])
        return {"Organisations": [{"OrgId": f"A{i + 10000:05d}", "Name": f"S{i}", "PostCode": "X1"} for i in range(o, min(o + 1000, 5300))]}
    act = sources.load_active_gp_practices(page)
    assert len(act) == 5300 and act["A10000"]["name"] == "S0"
    with pytest.raises(ValueError):
        sources.load_active_gp_practices(lambda u, p: {"Organisations": []})
    names = sources.load_pcn_names(b'"U00000","WEST NORWICH PCN","26A","NHS NORFOLK AND SUFFOLK ICB - 26A","20240401"\n"X","bad"\n')
    assert names == {"U00000": ("WEST NORWICH PCN", "NHS NORFOLK AND SUFFOLK ICB")}
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


def test_digest_select_and_escape():
    def trig(i, seg, n, lead="Cold", name="<script>x</script>"):
        return {"id": i, "trigger_type": "NEW_PRACTICE", "headline": "H", "description": "D",
                "gp_practices": {"ods_code": "A10000", "practice_name": name, "pcn_name": "P", "icb_name": "I",
                                 "total_patients": n, "sales_segment": seg, "clinical_software": "Unknown",
                                 "manager_name": None, "manager_title": None, "manager_email": "a@b.c",
                                 "manager_phone": None, "manager_email_opt_out": True, "lead_status": lead, "status": "Active"}}
    ts = [trig("1", "Tier 3 (Small Practice)", 100), trig("2", "Tier 1 (Enterprise / Super-Partnership)", 20000),
          trig("3", "Tier 2 (Mid-Market)", 8000, lead="Do-Not-Contact")]
    send, skip = digest.select(ts, "Tier 2")
    assert [t["id"] for t in send] == ["2"] and {t["id"] for t in skip} == {"1", "3"}
    out = digest.render(send, "https://x")
    assert "<script>" not in out and "&lt;script&gt;" in out and "a@b.c" not in out and "opt-out" in out
