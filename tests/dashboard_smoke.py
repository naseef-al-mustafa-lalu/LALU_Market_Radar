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
PP = [dict(ods_code=p["ods_code"], price_tier=3, tier_label="Tier 3 (Medium-Large)", base_price=0.076, year1_price=0.072, est_arr=round(p["total_patients"] * 0.076), est_arr_year1=round(p["total_patients"] * 0.072)) for p in PR]
TIERS = [dict(route="practice", tier=i + 1, label=l, threshold=t, size_discount=d, speed_discount=0.05) for i, (l, t, d) in enumerate([("Very Large", 20000, 0.1), ("Large", 15000, 0.075), ("Medium-Large", 10000, 0.05), ("Medium", 5000, 0), ("Solo", 0, 0)])] + \
        [dict(route="pcn", tier=1, label="Very Large", threshold=0, size_discount=0.225, speed_discount=0.05)]
SETTINGS = [dict(key="list_price_per_patient", value=0.08, description="Annual list price per patient")]
NETS = [dict(id="1", kind="pcn", name="West PCN", source_key="ods:U00001", practices=4, patients=40000, tier1=0, tier2=0, tier3=4, tier4=0, tier5=0, emis=4, systmone=0, cqc_concern=1, engaged=1, do_not_contact=0, confirmed=True, arr_single=3000, network_tier=1, arr_network=2500, network_base_price=0.0620),
        dict(id="2", kind="group", name="Modality Test", source_key="cqc:provider:P1", practices=3, patients=30000, tier1=0, tier2=0, tier3=3, tier4=0, tier5=0, emis=3, systmone=0, cqc_concern=0, engaged=0, do_not_contact=0, confirmed=True, arr_single=2200, network_tier=None, arr_network=None)]
FAKE = """
window.supabase = { createClient: () => {
  const data = %s;
  const q = t => { const r = { select: () => r, order: () => r, range: (a,b) => Promise.resolve({ data: (data[t]||[]).slice(a, b+1) }), eq: () => r, limit: () => Promise.resolve({ data: data[t]||[] }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }), then: (f) => Promise.resolve({ data: data[t]||[] }).then(f) }; return r; };
  return { auth: { getSession: async () => ({ data: { session: {} } }), signOut: async () => {}, signInWithPassword: async () => ({}) },
    from: q, channel: () => ({ on() { return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; } }), removeChannel() {}, rpc: async () => ({ data: {} }), functions: { invoke: async () => ({ data: {} }) } };
} };
""" % json.dumps({"gp_practices": PR, "practice_pricing": PP, "org_pricing": NETS, "pricing_tiers": TIERS, "pricing_settings": SETTINGS, "sales_triggers": [], "contacts": [dict(full_name="Ann Lee", is_primary=True, job_title="Practice Manager", email="a@nhs.net", phone="01")], "patient_counts": [dict(data_month="2026-09", updated_at="2026-10-13T10:00:00Z")], "ingest_runs": [dict(finished_at="2026-10-13T10:00:00Z")]})
errors = []
with sync_playwright() as p:
    import glob; b = p.chromium.launch(executable_path=glob.glob("/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell")[0])
    pg = b.new_page(viewport={"width": 1500, "height": 1000})
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.route("**/*", lambda r: r.fulfill(body=FAKE, content_type="text/javascript") if "supabase-js" in r.request.url else
             (r.fulfill(body="", content_type="text/javascript") if "tailwindcss" in r.request.url else r.continue_()))
    pg.goto("file:///home/user/LALU_Market_Radar/index.html")
    pg.wait_for_selector("#rows tr", timeout=8000)
    assert pg.locator("#rows tr").count() == 8, pg.locator("#rows tr").count()
    assert "8 practices" in pg.inner_text("#count")
    pg.click("#rows tr:first-child")
    pg.wait_for_selector("text=Network and ownership")
    assert "Modality Test" in pg.inner_text("#rows")
    pg.click("#tab-networks"); pg.wait_for_selector("#net-rows tr")
    assert "West PCN" in pg.inner_text("#net-rows") and "3 to approach" in pg.inner_text("#net-rows"), pg.inner_text("#net-rows")
    pg.click("#net-kinds button[data-k=group]"); assert "Modality Test" in pg.inner_text("#net-rows")
    pg.click("#tab-practices"); pg.check("#f-grp"); pg.select_option("#f-lead", "Contacted"); pg.click("#tab-networks")   # stale filters must not hide a network's practices
    pg.click("#net-kinds button[data-k=group]")
    pg.click("#net-rows tr:first-child")   # View practices -> filtered
    pg.wait_for_selector("#view-practices:not(.hidden)")
    assert "3 practices" in pg.inner_text("#count"), pg.inner_text("#count")
    assert "Provider groups" in pg.inner_text("#net-chip")
    assert "≈ £" in pg.inner_text("#rows") and "Tier 3" in pg.inner_text("#rows")
    pg.fill("#f-search", "zzz"); assert "0 practices" in pg.inner_text("#count")
    pg.click("#tab-revenue"); pg.wait_for_selector("#rev-cards > div")
    assert "Single practices route" in pg.inner_text("#rev-cards") and "PCNs route" in pg.inner_text("#rev-cards") and "Tier 3" in pg.inner_text("#rev-tiers")
    assert "Pipeline" in pg.inner_text("#view-revenue") and "Annual list price" in pg.text_content("#rev-config")
    pg.screenshot(path="/tmp/claude-0/revenue.png", full_page=True)
    print("SMOKE OK; page errors:", errors)
    sys.exit(1 if errors else 0)
