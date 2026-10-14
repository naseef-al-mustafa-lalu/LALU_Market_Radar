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
    from: q, channel: () => ({ on() { return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; } }), removeChannel() {}, rpc: async () => ({ data: {} }), functions: { invoke: async () => ({ data: {} }) } };
} };
""" % json.dumps({"gp_practices": PR, "practice_pricing": PP, "network_summary": NETS, "practice_hubspot": HS, "pricing_tiers": TIERS, "pricing_settings": SETTINGS, "sales_triggers": [], "contacts": [dict(full_name="Ann Lee", is_primary=True, job_title="Practice Manager", email="a@nhs.net", phone="01")], "patient_counts": [dict(data_month="2026-09", updated_at="2026-10-13T10:00:00Z")], "ingest_runs": [dict(finished_at="2026-10-13T10:00:00Z")]})
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
    pg.click("#net-rows tr:first-child")
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
    pg.click("#tab-data"); pg.wait_for_selector("#d-fresh")
    assert "2026" in pg.inner_text("#d-fresh") and "Annual list price" in pg.inner_text("#rev-config")
    pg.screenshot(path="/tmp/claude-0/data.png", full_page=True)
    print("SMOKE OK; page errors:", errors)
    sys.exit(1 if errors else 0)
