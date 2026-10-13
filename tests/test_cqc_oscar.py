from datetime import datetime, timezone

from src import cqc, ingest, oscar
from tests.conftest import OSCAR_HEAD
from tests.test_pipeline import FakeRest, patch_sources

FULL_HEAD = ("ContactURN,OrgURN,SiteURN,KKOrgUrn,Title,FirstName,LastName,Quals,JobTitle,Dept,Add1,Add2,Town,County,Region,"
             "ContactPhone,ContactEmail,ContactEmailOptOut,MainPhone,MainEmail,MainEmailOptOut,Seniority,AllCategories,DataTypes,"
             "OrgTypes,NumEmployees,AnnualSpend,OrgNotes,WebsiteURL,ParentOrg,Suppress,NHSGPFed,NHSNumGP,NHSGPPracticeCode,MainSite")


def test_oscar_enrichment():
    rows = [
        '1,222904,46024,GP5M8,Mr,CASPER,FONS,MBA,Executive Manager,Admin,LOCKING ROAD SURGERY,168 LOCKING ROAD,WESTON-SUPER-MARE,Avon,South West,'
        '0193,c@nhs.net,No,0193 624,Info@NHS.net,Yes,Chief Officer,~8~6~,~NHS~,~GP Surgery~,50 to 99,1 M - 5 M,Good client,https://x.example,ICB,No,Fed One,More than 9 GPs,l81051,Yes',
        '2,222904,46024,GP5M8,Dr,Ann,Lee,,GP Partner,,,,,,,,a@nhs.net,No,,,No,,,,,,,,,ICB,No,,,L81051,No']
    contacts, info, rej, sup = oscar.parse((FULL_HEAD + "\n" + "\n".join(rows)).encode())
    org = info["L81051"]["org"]
    assert org["oscar_org_urn"] == 222904 and org["town"] == "Weston-Super-Mare" and org["address"] == "Locking Road Surgery, 168 Locking Road"
    assert org["main_email"] == "info@nhs.net" and org["main_email_opt_out"] is True and org["gp_federation"] == "Fed One"
    assert org["num_employees"] == "50 to 99" and org["org_notes"] == "Good client" and org["nhs_num_gp"] == "More than 9 GPs"
    c1 = next(c for c in contacts if c["contact_urn"] == 1)
    assert c1["first_name"] == "Casper" and c1["last_name"] == "Fons" and c1["quals"] == "MBA" and c1["main_site"] is True and c1["is_primary"]
    assert not any(k.startswith("_") for c in contacts for k in c)


def detail(i, ods, status="Registered", rating="Good", insp="2024-01-02", absent=None):
    return {"locationId": i, "providerId": "P" + i, "odsCode": ods, "registrationStatus": status,
            "currentRatings": {"overall": {"rating": rating}}, "lastInspection": {"date": insp}, "registeredManagerAbsentDate": absent}


class FakeCqc:
    """Minimal fake of the CQC API: list (paged), details, changes."""
    def __init__(self):
        self.details = {"1-1": detail("1-1", "A10000"), "1-2": detail("1-2", "VNH4N"), "1-3": detail("1-3", "A10001", "Deregistered"),
                        "1-4": detail("1-4", "A10001", "Registered", "Requires improvement")}
        self.pc = {"1-1": "AB1 2CD", "1-2": "ZZ9 9ZZ", "1-3": "ab12cd", "1-4": "AB1 2CD"}
        self.changes = []

    def __call__(self, path, params=None):
        if path == "/locations":
            ids = sorted(self.details)
            return {"totalPages": 1, "locations": [{"locationId": i, "postalCode": self.pc[i]} for i in ids]}
        if path == "/changes/location":
            return {"totalPages": 1, "changes": self.changes}
        if path.startswith("/providers/"):
            return {"name": "Group " + path.rsplit("/", 1)[1]}
        return self.details.get(path.rsplit("/", 1)[1])


def test_cqc_backfill_then_changes():
    rest = FakeRest(); rest.t["kv_state"] = {}
    rest.select_all_orig = rest.select_all
    def sel(table, columns="*", order="id", params=None, page=1000):
        if table == "kv_state":
            k = params["key"].split(".", 1)[1]
            return [{"key": k, "value": rest.t["kv_state"][k]["value"]}] if k in rest.t["kv_state"] else []
        return rest.select_all_orig(table, columns, order, params, page)
    rest.select_all = sel
    practices = {"A10000": {"postcode": "AB1 2CD", "practice_name": "One"}, "A10001": {"postcode": "AB1 2CD", "practice_name": "Two"}}
    api, now = FakeCqc(), datetime(2026, 10, 14, tzinfo=timezone.utc)
    rows, stats = cqc.sync(rest, practices, api, now)
    by = {r["ods_code"]: r for r in rows}
    assert stats["cqc_mode"] == "backfill" and stats["cqc_backfill_complete"] and stats["cqc_candidates"] == 3  # VNH4N postcode excluded
    assert by["A10000"]["cqc_rating"] == "Good" and by["A10001"]["cqc_status"] == "Registered"  # Registered beats Deregistered
    assert by["A10001"]["cqc_rating"] == "Requires improvement" and by["A10001"]["practice_name"] == "Two"
    # next day: only changed locations are fetched; an unchanged value produces no write
    practices["A10000"].update({k: v for k, v in by["A10000"].items() if k.startswith("cqc_")})
    api.details["1-1"] = detail("1-1", "A10000", rating="Inadequate", insp="2026-10-13", absent="2026-10-01T00:00:00Z")
    api.changes = ["1-1"]
    rows2, stats2 = cqc.sync(rest, practices, api, datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert stats2["cqc_mode"] == "changes" and len(rows2) == 1
    assert rows2[0]["cqc_rating"] == "Inadequate" and rows2[0]["cqc_manager_absent_date"] == "2026-10-01" and rows2[0]["cqc_last_inspection"] == "2026-10-13"


def test_cqc_groups_and_takeover_inputs():
    from src.cqc import build_rows
    api = FakeCqc()
    rest = FakeRest(); rest.t["kv_state"] = {}
    practices = {c: {"practice_name": c, "status": "Active", "cqc_provider_id": "PG", "cqc_location_id": f"1-{i}", "cqc_status": "Registered"}
                 for i, c in enumerate(["A10000", "A10001", "A10002"])}
    practices["A10003"] = {"practice_name": "solo", "status": "Active", "cqc_provider_id": "PX", "cqc_location_id": "1-9", "cqc_status": "Registered"}
    rest.select_all = lambda table, columns="*", order="id", params=None, page=1000: (
        [{"key": "cqc_provider_names", "value": rest.t["kv_state"]["cqc_provider_names"]["value"]}] if "cqc_provider_names" in rest.t["kv_state"] else [])
    now = datetime(2026, 10, 14, tzinfo=timezone.utc)
    rows, stats = build_rows(rest, practices, {}, api, now, {})
    by = {r["ods_code"]: r for r in rows}
    assert stats["cqc_groups"] == 1 and stats["cqc_provider_names_fetched"] == 1
    assert by["A10000"]["group_name"] == "Group PG" and by["A10000"]["group_size"] == 3 and "A10003" not in by  # solo practice is not a group
    assert all(set(r) == set(rows[0]) for r in rows)  # uniform keys
    # takeover: A10002 moves to another provider -> remaining group shrinks to 2 and the mover shows its new operator
    practices2 = {**practices, **{c: {**p, **by[c]} for c, p in practices.items() if c in by}}
    rest.t["kv_state"]["cqc_provider_names"] = {"value": {"PG": "Group PG"}}
    rows2, stats2 = build_rows(rest, practices2, {"A10002": {"cqc_provider_id": "PX", "cqc_location_id": "1-2", "cqc_status": "Registered"}}, api, now, {})
    by2 = {r["ods_code"]: r for r in rows2}
    assert by2["A10000"]["group_size"] == 2 and by2["A10002"]["cqc_provider_id"] == "PX" and by2["A10002"]["group_size"] == 2
