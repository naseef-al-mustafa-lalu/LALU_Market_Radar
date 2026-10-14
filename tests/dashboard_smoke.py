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
NETS = [dict(id="1", kind="pcn", name="West PCN", source_key="ods:U00001", practices=4, patients=40000, tier1=0, tier2=4, tier3=0, emis=4, systmone=0, cqc_concern=1, engaged=1, do_not_contact=0, confirmed=True),
        dict(id="2", kind="group", name="Modality Test", source_key="cqc:provider:P1", practices=3, patients=30000, tier1=0, tier2=3, tier3=0, emis=3, systmone=0, cqc_concern=0, engaged=0, do_not_contact=0, confirmed=True)]
FAKE = """
window.supabase = { createClient: () => {
  const data = %s;
  const q = t => { const r = { select: () => r, order: () => r, range: (a,b) => Promise.resolve({ data: (data[t]||[]).slice(a, b+1) }), eq: () => r, limit: () => Promise.resolve({ data: data[t]||[] }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }), then: (f) => Promise.resolve({ data: data[t]||[] }).then(f) }; return r; };
  return { auth: { getSession: async () => ({ data: { session: {} } }), signOut: async () => {}, signInWithPassword: async () => ({}) },
    from: q, channel: () => ({ on() { return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; } }), removeChannel() {}, rpc: async () => ({ data: {} }), functions: { invoke: async () => ({ data: {} }) } };
} };
""" % json.dumps({"gp_practices": PR, "org_summary": NETS, "sales_triggers": [], "contacts": [dict(full_name="Ann Lee", is_primary=True, job_title="Practice Manager", email="a@nhs.net", phone="01")], "patient_counts": [dict(data_month="2026-09", updated_at="2026-10-13T10:00:00Z")], "ingest_runs": [dict(finished_at="2026-10-13T10:00:00Z")]})
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
    pg.click("#net-rows tr:first-child")   # View practices -> filtered
    pg.wait_for_selector("#view-practices:not(.hidden)")
    assert "3 practices" in pg.inner_text("#count"), pg.inner_text("#count")
    assert "Provider groups" in pg.inner_text("#net-chip")
    pg.fill("#f-search", "zzz"); assert "0 practices" in pg.inner_text("#count")
    print("SMOKE OK; page errors:", errors)
    sys.exit(1 if errors else 0)
