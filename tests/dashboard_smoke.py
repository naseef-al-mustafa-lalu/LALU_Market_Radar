import json, sys
from playwright.sync_api import sync_playwright

def prac(i, **kw):
    d = dict(ods_code=f"A{10000+i}", practice_name=f"Test Surgery {i}", status="Active", total_patients=9000+i*1000, sales_segment="Tier 2 (Mid-Market)",
             pcn_code="U00001" if i % 2 == 0 else None, pcn_name="West PCN", icb_name="NHS Test ICB", clinical_software="EMIS Web", lead_status="Cold",
             cqc_rating="Good", cqc_provider_id="P1" if i < 3 else f"P{i+10}", group_size=3 if i < 3 else None, group_name="Modality Test" if i < 3 else None,
             manager_name="Ann Lee", manager_title="Practice Manager", manager_email="a@nhs.net", town="Leeds", postcode="LS1 1AA", gp_federation="Fed One" if i == 1 else None,
             cqc_last_inspection="2025-01-02", org_notes="Good client", data_month="2026-09")
    d.update(kw); return d
PR = [prac(i) for i in range(8)]
PR[3]["gp_federation"] = "Fed One"
for p_ in PR:
    p_.update(hubspot_customer=False, hubspot_engaged=False, hubspot_stage=None)
PR[2].update(hubspot_customer=True, hubspot_stage="customer"); PR[1].update(hubspot_engaged=True, hubspot_stage="opportunity")
HS = [dict(ods_code=p_["ods_code"], hs_contacts=1, hs_imported=1 if i < 3 else 0, hs_primary_imported=i < 3, hs_last_imported_at="2026-10-12T09:00:00Z", hs_primary_imported_at="2026-10-12T09:00:00Z" if i < 3 else None) for i, p_ in enumerate(PR)]
PP = [dict(ods_code=p["ods_code"], price_tier=3, tier_label="Tier 3 (Medium-Large)", base_price=0.076, year1_price=0.072, est_arr=round(p["total_patients"] * 0.076), est_arr_year1=round(p["total_patients"] * 0.072)) for p in PR]
TIERS = [dict(route="practice", tier=i + 1, label=l, threshold=t, size_discount=d, speed_discount=0.05) for i, (l, t, d) in enumerate([("Very Large", 20000, 0.1), ("Large", 15000, 0.075), ("Medium-Large", 10000, 0.05), ("Medium", 5000, 0), ("Solo", 0, 0)])] + \
        [dict(route=r, tier=5, label="Solo / Small", threshold=0, size_discount=0.125, speed_discount=0.05) for r in ("pcn", "group", "federation")]
SETTINGS = [dict(key="list_price_per_patient", value=0.08, description="Annual list price per patient")]
NETS = [dict(id="1", kind="pcn", name="West PCN", source_key="ods:U00001", practices=4, patients=40000, tier1=0, tier2=0, tier3=4, tier4=0, tier5=0, emis=4, systmone=0, cqc_concern=1, engaged=2, customers=1, arr_customers=900, hs_imported=3, do_not_contact=0, confirmed=True, arr_single=3000, network_tier=1, arr_network=2500, network_base_price=0.0620),
        dict(id="2", kind="group", name="Modality Test", source_key="cqc:provider:P1", practices=3, patients=30000, tier1=0, tier2=0, tier3=3, tier4=0, tier5=0, emis=3, systmone=0, cqc_concern=0, engaged=1, customers=1, arr_customers=800, hs_imported=1, do_not_contact=0, confirmed=True, arr_single=2200, network_tier=5, arr_network=2100, network_base_price=0.07),
        dict(id="3", kind="federation", name="Fed One", source_key="fed:fed one", practices=1, patients=13000, tier1=0, tier2=0, tier3=1, tier4=0, tier5=0, emis=1, systmone=0, cqc_concern=0, engaged=0, customers=0, arr_customers=0, hs_imported=0, do_not_contact=0, confirmed=False, arr_single=900, network_tier=5, arr_network=870, network_base_price=0.07)]
FAKE = """
window.supabase = { createClient: () => {
  const data = %s;
  const q = t => { const r = { select: () => r, order: () => r, range: (a,b) => Promise.resolve({ data: (data[t]||[]).slice(a, b+1) }), eq: () => r, limit: () => Promise.resolve({ data: data[t]||[] }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }), then: (f) => Promise.resolve({ data: data[t]||[] }).then(f) }; return r; };
  return { auth: { getSession: async () => ({ data: { session: {} } }), signOut: async () => {}, signInWithPassword: async () => ({}) },
    from: q, channel: () => ({ on() { return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; } }), removeChannel() {}, rpc: async (n, a) => { (window.__rpc = window.__rpc || []).push([n, a]); return { data: { stored: ((a && a.p_rows) || []).length, new: 1, practices_updated: 0 } }; }, functions: { invoke: async () => ({ data: {} }) } };
} };
""" % json.dumps({"gp_practices": PR, "practice_pricing": PP, "network_summary": NETS, "practice_hubspot": HS, "pricing_tiers": TIERS, "pricing_settings": SETTINGS, "sales_triggers": [dict(id="s1", ods_code=None, org_id="1", employer_code="W1", trigger_type="JOB_REPORT_ROLE", headline="Hiring: Records Administrator", description="Acclaim PCN advertised", detected_at="2026-10-16T08:00:00Z"), dict(id="s2", ods_code=None, org_id=None, employer_code="A0095", trigger_type="JOB_REPORT_ROLE", headline="Hiring: Medical Secretary", description="Little Common Surgery advertised", detected_at="2026-10-16T08:00:00Z")], "job_employers": [dict(employer_code="A0095", employer_name="Little Common Surgery", postcodes=["TN394SP"], match_status="review", ods_code=None, candidates=[dict(ods_code="A10001", name="Little Common Surgery", postcode="TN39 4SP")]), dict(employer_code="A0001", employer_name="Done Surgery", postcodes=[], match_status="confirmed", ods_code="A10002", candidates=[])], "job_adverts": [dict(advert_id="1", employer_code="A0095", ods_code=None, title="Medical Secretary", matched_role="medical secretary", post_date="2026-10-14", close_date="2026-10-30", url="https://x/1"), dict(advert_id="2", employer_code="A0001", ods_code="A10002", title="Medical Records Administrator", matched_role="records / summarising", post_date="2026-10-13", close_date=None, url="https://x/2")], "signal_settings": [dict(trigger_type="NEW_PRACTICE", label="New practice", source="NHS ODS (daily)", rule="A code appears", why="Greenfield", sort_order=1, enabled=True)], "contacts": [dict(full_name="Ann Lee", is_primary=True, job_title="Practice Manager", email="a@nhs.net", phone="01")], "patient_counts": [dict(data_month="2026-09", updated_at="2026-10-13T10:00:00Z")], "ingest_runs": [dict(finished_at="2026-10-13T10:00:00Z")]})
import os
CSS = os.environ.get("TAILWIND_CSS", "")
errors = []
with sync_playwright() as p:
    import glob; b = p.chromium.launch(executable_path=glob.glob("/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell")[0])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.route("**/*", lambda r: r.fulfill(body=FAKE, content_type="text/javascript") if "supabase-js" in r.request.url else
             (r.fulfill(body="document.head.insertAdjacentHTML('beforeend', '<style>' + %s + '</style>')" % json.dumps(open(CSS).read() if CSS and __import__("os").path.exists(CSS) else ""), content_type="text/javascript") if "tailwindcss" in r.request.url else r.continue_()))
    pg.goto("file:///home/user/LALU_Market_Radar/index.html")
    pg.wait_for_selector("#rows tr", timeout=8000)
    assert pg.locator("#rows tr").count() == 8, pg.locator("#rows tr").count()
    assert "8 practices" in pg.inner_text("#count")
    def noflow(sel, name):
        b_ = pg.evaluate("(s => { const w = document.querySelector(s); return [w.scrollWidth, w.clientWidth]; })(%r)" % sel)
        assert b_[0] <= b_[1] + 2, f"{name} overflows: {b_}"
    noflow("#view-practices .overflow-x-auto", "practices")
    pg.screenshot(path="/tmp/claude-0/practices.png")
    # filters + chips + sort
    pg.click("#f-more-btn"); pg.check("#f-grp")
    assert "3 practices" in pg.inner_text("#count"), pg.inner_text("#count")
    assert "clear" in pg.inner_text("#f-chips").lower()
    pg.click("#f-chips >> text=/clear/i"); assert "8 practices" in pg.inner_text("#count")
    pg.click("th[data-sort=patients]"); pg.click("th[data-sort=patients]")
    # drawer
    pg.click("#rows tr:has-text(\"Test Surgery 1\")"); pg.wait_for_selector("#drawer:not(.translate-x-full)")
    body = pg.inner_text("#dr-body"); assert "Modality Test" in body and "Ann Lee" in body, body
    pg.screenshot(path="/tmp/claude-0/profile.png")
    pg.keyboard.press("Escape")
    pg.set_viewport_size({"width": 1180, "height": 800}); noflow("#view-practices .overflow-x-auto", "practices@1180"); pg.screenshot(path="/tmp/claude-0/narrow.png"); pg.set_viewport_size({"width": 1440, "height": 900})
    # networks
    pg.click("#tab-networks"); pg.wait_for_selector("#net-rows tr")
    assert "West PCN" in pg.inner_text("#net-rows"), pg.inner_text("#net-rows")
    pg.click("#net-kinds button[data-k=group]"); assert "Modality Test" in pg.inner_text("#net-rows")
    pg.uncheck("#n-multi"); pg.click("#net-kinds button[data-k=federation]"); assert "Fed One" in pg.inner_text("#net-rows")
    pg.check("#n-multi"); pg.click("#net-kinds button[data-k=pcn]")
    noflow("#view-networks .overflow-x-auto", "networks"); pg.screenshot(path="/tmp/claude-0/networks.png")
    pg.click("#net-kinds button[data-k=group]")
    pg.click("#net-rows tr:first-child")   # row opens the network profile
    pg.wait_for_selector("#drawer:not(.translate-x-full)")
    prof = pg.inner_text("#dr-body")
    assert "pricing" in prof.lower() and "Size discount" in prof and "Price per patient" in prof and "Network discount vs singly" in prof and "Test Surgery 0" in prof, prof
    pg.screenshot(path="/tmp/claude-0/netprofile.png")
    pg.click("#dr-body tr[data-ods=A10001]"); pg.wait_for_function("document.querySelector('#dr-title').textContent === 'Test Surgery 1'")
    pg.click("#tab-networks"); pg.click("#net-kinds button[data-k=group]"); pg.click("#net-rows tr:first-child"); pg.click("#np-view")
    pg.wait_for_selector("#view-practices:not(.hidden)")
    assert "3 practices" in pg.inner_text("#count"), pg.inner_text("#count")
    assert "back to networks" in pg.inner_text("#view-practices").lower()
    assert "£" in pg.inner_text("#rows")
    pg.fill("#f-search", "zzz"); assert "0 practices" in pg.inner_text("#count")
    # revenue
    pg.click("#tab-revenue"); pg.wait_for_selector("#rev-routes tr, #rev-routes > div")
    assert "£" in pg.inner_text("#rev-routes") and "£" in pg.inner_text("#rev-matrix")
    pg.click("#rev-metric") if pg.locator("#rev-metric").evaluate("e => e.tagName") == "BUTTON" else None
    pg.screenshot(path="/tmp/claude-0/revenue.png", full_page=True)
    # signals + data
    pg.click("#tab-signals"); assert pg.is_visible("#s-count")
    sr = pg.inner_text("#s-rows"); assert "unlinked" in sr.lower() and "network" in sr.lower() and "Little Common Surgery" in sr, sr
    pg.click("#sig-sub button[data-s=types]"); assert "NHS ODS (daily)" in pg.inner_text("#sig-types-rows") and pg.is_hidden("#s-count")
    pg.uncheck("input[data-t=NEW_PRACTICE]"); pg.wait_for_function("document.querySelector('#sig-types-msg').textContent.includes('disabled')")
    pg.click("#sig-sub button[data-s=jobs]"); pg.wait_for_selector("#jm-rows tr[data-c]")
    assert "Little Common Surgery" in pg.inner_text("#jm-rows") and pg.is_visible("#jm-rows .jm-pick") and "1" in pg.inner_text("#jobs-badge")
    pg.click("#jm-rows .jm-act[data-a=confirm]"); assert "Choose a practice" in pg.inner_text("#jm-msg")     # nothing is linked until you choose
    pg.select_option("#jm-rows .jm-pick", "A10001"); pg.click("#jm-rows .jm-act[data-a=confirm]")
    pg.wait_for_function("document.querySelector('#jm-msg').textContent.startsWith('Linked')")
    assert [c for c in pg.evaluate("window.__rpc.filter(c => c[0] === 'link_job_employer')")][0][1]["p_ods"] == "A10001"
    pg.select_option("#jm-status", "confirmed"); assert "Medical Records" in pg.inner_text("#jm-rows") or "Done Surgery" in pg.inner_text("#jm-rows")
    pg.click("#sig-sub button[data-s=feed]"); assert pg.is_visible("#s-count")
    pg.click("#tab-data"); pg.wait_for_selector("#d-fresh")
    assert "2026" in pg.inner_text("#d-fresh") and "Annual list price" in pg.inner_text("#rev-config")
    import tempfile, os
    td = tempfile.mkdtemp()
    sc = os.path.join(td, "scotland_20260701_opendata.csv"); wl = os.path.join(td, "wales.csv")
    open(sc, "w").write("PracticeCode,GPPracticeName,PracticeListSize,AddressLine1,AddressLine2,AddressLine3,AddressLine4,Postcode,TelephoneNumber,PracticeType,HB,HSCP,DataZone,GPCluster\n" +
        "".join(f'{10000+i},Practice {i},{5000+i},x,Liff Road,MUIRHEAD,,DD2 5NH,01,GMS,S08000030,s,d,Dundee {i%4}\n' for i in range(600)))
    open(wl, "w").write("Period,PsuPracticeCode,PracticeId,Locality,Street,Area,Posttown,County,Postcode,ClusterID\n" +
        "".join(f"202607,6{i},W{93000+i},,ST. LUKE'S SURGERY {i},a,CARDIFF,GWENT,NP11 5GX,601{i%5:02d}\n" for i in range(400)) + "202607,,7A3,HB,1 Talbot Gateway,a,Baglan,,SA12 7BR,\n")
    def up(box, path, expect):
        pg.set_input_files(f"#up-{box} .up-file", path)
        pg.wait_for_function("(b) => document.querySelector('#up-' + b + ' .up-msg').textContent.length > 0", arg=box)
        msg = pg.inner_text(f"#up-{box} .up-msg"); assert expect in msg, msg
        return msg
    up("sco", sc, "Read 600"); pg.click("#up-sco .up-load"); pg.wait_for_function("document.querySelector('#up-sco .up-msg').textContent.startsWith('Done')")
    up("walc", wl, "Read 400"); pg.click("#up-walc .up-load"); pg.wait_for_function("document.querySelector('#up-walc .up-msg').textContent.startsWith('Done')")
    up("walc", sc, "use that box instead")           # wrong box is explained, not loaded
    assert pg.is_disabled("#up-walc .up-load")
    calls = pg.evaluate("window.__rpc.filter(c => c[0] === 'load_devolved')")
    assert [c[1]["p_country"] for c in calls] == ["Scotland", "Wales"], calls
    r0 = calls[0][1]["p_rows"][0]; assert r0["code"] == "S10000" and r0["icb"] == "NHS Tayside" and r0["net_code"] == "SC-dundee-0" and r0["patients"] == 5000 and r0["town"] == "Muirhead", r0
    w0 = calls[1][1]["p_rows"][0]; assert w0["code"] == "W93000" and w0["net_code"] == "WC60100", w0
    assert "In the database" in pg.inner_text("#up-eng .up-status")
    open(os.path.join(td, "bad.csv"), "w").write("a,b\n1,2\n")
    up("walp", os.path.join(td, "bad.csv"), "Not recognised")
    pg.screenshot(path="/tmp/claude-0/data.png", full_page=True)
    print("SMOKE OK; page errors:", errors)
    sys.exit(1 if errors else 0)
