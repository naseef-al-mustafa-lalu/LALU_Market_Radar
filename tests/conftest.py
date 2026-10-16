import io
import zipfile

import pytest


def make_epraccur(n=5200, closed=("A15199",)):
    rows = []
    for i in range(n):
        code = f"A{i + 10000:05d}"
        status = "C" if code in closed else "A"
        cols = [code, f"TEST SURGERY {i}", "", "", "1 High St", "", "", "", "", "AB1 2CD", "", "", status] + [""] * 12 + ["4"]
        rows.append(",".join(f'"{c}"' for c in cols))
    return "\n".join(rows).encode()


def make_patients(n=5200, boost=None):
    boost = boost or {}
    lines = ["PUBLICATION,EXTRACT_DATE,TYPE,SUB_ICB_LOCATION_CODE,ONS_SUB_ICB_LOCATION_CODE,CODE,POSTCODE,SEX,AGE,NUMBER_OF_PATIENTS"]
    for i in range(n):
        code = f"A{i + 10000:05d}"
        lines.append(f"GP_PRAC_PAT_LIST,01Oct2026,GP,X,Y,{code},AB1 2CD,ALL,ALL,{boost.get(code, 5000 + i)}")
        lines.append(f"GP_PRAC_PAT_LIST,01Oct2026,GP,X,Y,{code},AB1 2CD,MALE,ALL,100")  # must be ignored
    return "\n".join(lines).encode()


OSCAR_HEAD = ("ContactURN,FirstName,LastName,Salutation,JobTitle,Seniority,ContactPhone,MainPhone,ContactEmail,"
              "ContactEmailOptOut,MainEmailOptOut,WebsiteURL,ParentOrg,Suppress,NHSGPPracticeCode")


def make_oscar(rows):
    return (OSCAR_HEAD + "\n" + "\n".join(rows)).encode()


def zipped(name, data):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr(name, data)
    return b.getvalue()


@pytest.fixture
def oscar_rows():
    return [
        "1,Casper,FONS,,Executive Manager,Chief Officer,01934 1,,Casper@NHS.net ,No,No,https://a.example,ICB One,No,a10000",
        "2,Pat,Lee,,Receptionist,,,,pat@nhs.net,No,No,,ICB One,No,A10000",
        "3,Ann,Boe,,Practice Manager,Manager,,0200,ann@nhs.net,Yes,No,,ICB One,No,A10001",
        "4,Sup,Pressed,,Practice Manager,,,,s@nhs.net,No,No,,ICB One,Yes,A10002",
        "5,Bad,Code,,Practice Manager,,,,b@nhs.net,No,No,,ICB One,No,ZZZ",
        "x,Bad,Urn,,Practice Manager,,,,b@nhs.net,No,No,,ICB One,No,A10003",
    ]


@pytest.fixture(autouse=True)
def _no_jobs_scan(monkeypatch):
    monkeypatch.setenv("NHS_JOBS", "0")   # tests never touch the live NHS Jobs feed
