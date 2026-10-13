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


def test_ods_patients_pcn():
    patients, month = sources.load_patients(make_patients())
    assert len(patients) == 5200 and patients["A10000"] == 5000 and month == "2026-10"  # MALE rows ignored
    ods = sources.load_ods_practices(zipped("epraccur.csv", make_epraccur()), set(patients))
    assert ods["A10000"]["status"] == "Active" and ods["A15199"]["status"] == "Closed"
    with pytest.raises(ValueError):
        sources.load_ods_practices(make_epraccur(100), set())
    members = b"A10000,x,U12345,20200101,\nA10000,x,U99999,20240101,\nA10001,x,U12345,20200101,\n"
    names = b"U12345,PCN ONE\nU99999,PCN TWO\n"
    m = sources.load_pcn_map(members, names)
    assert m["A10000"] == ("U99999", "PCN TWO") and m["A10001"][0] == "U12345"


def test_discover_url():
    pages = {
        sources.GP_REG_PAGE: '<a href="/data/patients-registered-at-a-gp-practice/september-2026">x</a>'
                             '<a href="/data/patients-registered-at-a-gp-practice/october-2026">y</a>'
                             '<a href="/data/patients-registered-at-a-gp-practice/december-2025">z</a>',
        "https://digital.nhs.uk/data/patients-registered-at-a-gp-practice/october-2026":
            '<a href="https://files.digital.nhs.uk/ab/CD/gp-reg-pat-prac-all.csv">csv</a>'}
    assert sources.discover_gp_reg_url(pages.__getitem__).endswith("/ab/CD/gp-reg-pat-prac-all.csv")


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
