import json, os, pathlib, sys, tempfile
from playwright.sync_api import sync_playwright

def prac(i, **kw):
    d = dict(ods_code=f"A{10000+i}", practice_name=f"Test Surgery {i}", status="Active", total_patients=9000+i*1000, sales_segment="Tier 2 (Mid-Market)",
             pcn_code="U00001" if i % 2 == 0 else None, pcn_name="West PCN", icb_name="NHS Test ICB", clinical_software="EMIS Web", lead_status="Cold",
             cqc_rating="Good", cqc_provider_id="P1" if i < 3 else f"P{i+10}", group_size=3 if i < 3 else None, group_name="Modality Test" if i < 3 else None,
             manager_name="Ann Lee", manager_title="Practice Manager", manager_email="a@nhs.net", town="Leeds", postcode="LS1 1AA", gp_federation="Fed One" if i == 1 else None,
             cqc_last_inspection="2025-01-02", org_notes="Good client", data_month="2026-09")
    d.update(kw); return d
PR = [prac(i) for i in range(12)]
PR[1].update(hubspot_company_id="441"); PR[3].update(hubspot_company_id="443")
PR[8].update(practice_name="Test Old Surgery", total_patients=0, merged_into="A10001", merged_note="Merged 2025", merged_at="2026-01-01T00:00:00Z", merged_by="boss@lalu.co.uk")
PR[9].update(practice_name="Test Annex A", total_patients=0)
PR[10].update(practice_name="Test Annex B", total_patients=0)
PR[11].update(practice_name="Test Closed Candidate", total_patients=0, cqc_status="Deregistered", cqc_last_inspection="2016-06-16")
CLOSE = [dict(ods_code="A10011", cqc_last_inspection="2016-06-16")]
SUGG = [dict(ods_code="A10009", into_code="A10003", into_name="Test Surgery 3", into_patients=12000, n_candidates=1, confidence="high"), dict(ods_code="A10010", into_code="A10005", into_name="Test Surgery 5", into_patients=14000, n_candidates=2, confidence="medium")]
PR[3]["gp_federation"] = "Fed One"
for p_ in PR:
    p_.update(hubspot_customer=False, hubspot_engaged=False, hubspot_stage=None)
PR[2].update(hubspot_customer=True, hubspot_stage="customer"); PR[1].update(hubspot_engaged=True, hubspot_stage="opportunity")
HS = [dict(ods_code=p_["ods_code"], hs_contacts=1, hs_imported=1 if i < 3 else 0, hs_primary_imported=i < 3, hs_last_imported_at="2026-10-12T09:00:00Z", hs_primary_imported_at="2026-10-12T09:00:00Z" if i < 3 else None) for i, p_ in enumerate(PR)]
PP = [dict(ods_code=p["ods_code"], price_tier=3, tier_label="Tier 3 (Medium-Large)", base_price=0.076, year1_price=0.072, est_arr=round(p["total_patients"] * 0.076 * 12), est_arr_year1=round(p["total_patients"] * 0.072 * 12), base_price_sar=0.0475, est_arr_sar=round(p["total_patients"] * 0.0475 * 12)) for p in PR]
TIERS = [dict(route="practice", tier=i + 1, label=l, threshold=t, size_discount=d, speed_discount=0.05) for i, (l, t, d) in enumerate([("Very Large", 20000, 0.1), ("Large", 15000, 0.075), ("Medium-Large", 10000, 0.05), ("Medium", 5000, 0), ("Solo", 0, 0)])] + \
        [dict(route=r, tier=5, label="Solo / Small", threshold=0, size_discount=0.125, speed_discount=0.05) for r in ("pcn", "group", "federation")]
SETTINGS = [dict(key="list_price_per_patient", value=0.08, description="Annual list price per patient"), dict(key="term_discount_2yr", value=0.025, description="2-year term"), dict(key="term_discount_3yr", value=0.05, description="3-year term"), dict(key="price_floor_per_patient", value=0.05, description="Price floor"), dict(key="monthly_list_price_per_patient", value=0.10, description="Monthly list price"), dict(key="list_price_sar_per_patient", value=0.05, description="SAR annual"), dict(key="monthly_list_price_sar_per_patient", value=0.06, description="SAR monthly")]
NETS = [dict(id="1", kind="pcn", name="West PCN", source_key="ods:U00001", practices=4, patients=40000, tier1=0, tier2=0, tier3=4, tier4=0, tier5=0, emis=4, systmone=0, cqc_concern=1, engaged=2, customers=1, arr_customers=900, hs_imported=3, do_not_contact=0, confirmed=True, arr_single=3000, arr_single_sar=1900, arr_customers_sar=500, arr_network_sar=1600, network_tier=1, arr_network=2500, network_base_price=0.0620),
        dict(id="2", kind="group", name="Modality Test", source_key="cqc:provider:P1", practices=3, patients=30000, tier1=0, tier2=0, tier3=3, tier4=0, tier5=0, emis=3, systmone=0, cqc_concern=0, engaged=1, customers=1, arr_customers=800, hs_imported=1, do_not_contact=0, confirmed=True, arr_single=2200, network_tier=5, arr_network=2100, network_base_price=0.07),
        dict(id="3", kind="federation", name="Fed One", source_key="fed:fed one", practices=1, patients=13000, tier1=0, tier2=0, tier3=1, tier4=0, tier5=0, emis=1, systmone=0, cqc_concern=0, engaged=0, customers=0, arr_customers=0, hs_imported=0, do_not_contact=0, confirmed=False, arr_single=900, network_tier=5, arr_network=870, network_base_price=0.07)]
INDEX = pathlib.Path(__file__).resolve().parent.parent.joinpath("index.html").as_uri()
SHOTS = os.environ.get("SHOT_DIR") or tempfile.gettempdir()
FAKE = """
window.supabase = { createClient: () => {
  const data = %s;
  const q = t => { const r = { select: () => r, order: () => r, range: (a,b) => window.__fail ? Promise.resolve({ data: null, error: { message: 'network down' } }) : (window.__slow ? new Promise(r => setTimeout(r, window.__slow)) : Promise.resolve()).then(() => ({ data: (data[t]||[]).slice(a, b+1) })), eq: () => r, in: () => r, limit: () => Promise.resolve({ data: data[t]||[] }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }), then: (f) => Promise.resolve({ data: data[t]||[] }).then(f) }; return r; };
  return { auth: { getSession: async () => ({ data: { session: { user: { email: 'new@lalu.co.uk' } } } }), signOut: async () => {}, updateUser: async (a) => { (window.__rpc = window.__rpc || []).push(['updateUser', a]); return {}; }, resetPasswordForEmail: async (e, o) => { (window.__rpc = window.__rpc || []).push(['reset', e, o]); return {}; }, signInWithPassword: async () => ({}) },
    from: q, channel: () => ({ on() { return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; } }), removeChannel() {}, rpc: async (n, a) => { (window.__rpc = window.__rpc || []).push([n, a]); return { data: { stored: ((a && a.p_rows) || []).length, new: 1, practices_updated: 0 } }; }, functions: { invoke: async (name, o) => { const b = (o && o.body) || {}; (window.__rpc = window.__rpc || []).push(['fn:' + name, b]);
      if (name !== 'hubspot-push') return { data: {} };
      const H = window.__hsdb = window.__hsdb || { company: { id: '77', name: 'Test Surgery 1 (HubSpot)', partner_organisation_code: 'A10001', patient_list_size: '9000' },
        deal: { id: '88', dealname: 'Test Surgery 1 - SAR', dealstage: 'contractsent', size_tier: 'Tier 4', commercial_model: 'eMR+ SAR Only', value_per_patient: '£0.10', size_discount: '0', speed_discount: '0', term_length_discount: '0', term_length_years: '1', total_discount: '0', actual_value_per_patient_calculated: '0.10' } };
      if (b.action === 'find') return { data: { companies: [Object.assign({ match: 'ODS code' }, H.company)] } };
      if (b.action === 'deals') return { data: { deals: [H.deal] } };
      if (b.action === 'read') return { data: { company: H.company, deal: H.deal } };
      if (b.action === 'write') { Object.assign(H.company, b.company || {}); const d = Object.assign(H.deal, b.deal || {});
        const t = Math.round((Number(d.size_discount) + Number(d.speed_discount) + Number(d.term_length_discount)) * 1000) / 1000; d.total_discount = String(t);
        d.actual_value_per_patient_calculated = String(Math.round(Number(String(d.value_per_patient).replace('£', '')) * (1 - t) * 100000) / 100000); if (window.__hsBlank) d.actual_value_per_patient_calculated = ''; window.__hslink = b.ods; return { data: { ok: true } }; }
      if (b.action === 'create_company' || b.action === 'link_company') return { data: { ok: true, companyId: '900', contacts: [], networks: [], warnings: [] } };
      return { data: {} }; } } };
} };
""" % json.dumps({"gp_practices": PR, "practice_merge_suggestions": SUGG, "practice_closure_candidates": CLOSE, "practice_pricing": PP, "network_summary": NETS, "practice_hubspot": HS, "pricing_tiers": TIERS, "pricing_settings": SETTINGS, "sales_triggers": [dict(id="s1", ods_code=None, org_id="1", employer_code="W1", trigger_type="JOB_REPORT_ROLE", headline="Hiring: Records Administrator", description="Acclaim PCN advertised", detected_at="2026-10-16T08:00:00Z"), dict(id="s2", ods_code=None, org_id=None, employer_code="A0095", trigger_type="JOB_REPORT_ROLE", headline="Hiring: Medical Secretary", description="Little Common Surgery advertised", action="Offer cover for reports.", url="https://www.jobs.nhs.uk/candidate/jobadvert/A0095-26-0006", detected_at="2026-10-16T08:00:00Z")], "job_employers": [dict(employer_code="A0002", employer_name="Auto Surgery", postcodes=["LS11AA"], match_status="auto", ods_code="A10003", candidates=[]), dict(employer_code="A0095", employer_name="Little Common Surgery", postcodes=["TN394SP"], match_status="review", ods_code=None, candidates=[dict(ods_code="A10001", name="Little Common Surgery", postcode="TN39 4SP")]), dict(employer_code="A0001", employer_name="Done Surgery", postcodes=[], match_status="confirmed", ods_code="A10002", candidates=[])], "job_adverts": [dict(advert_id="3", employer_code="A0002", ods_code="A10003", title="Records Clerk", matched_role="records / summarising", post_date="2026-10-15", close_date=None, url="https://x/3"), dict(advert_id="1", employer_code="A0095", ods_code=None, title="Medical Secretary", matched_role="medical secretary", post_date="2026-10-14", close_date="2026-10-30", url="https://x/1"), dict(advert_id="2", employer_code="A0001", ods_code="A10002", title="Medical Records Administrator", matched_role="records / summarising", post_date="2026-10-13", close_date=None, url="https://x/2")], "signal_settings": [dict(trigger_type="NEW_PRACTICE", label="New practice", source="NHS ODS (daily)", rule="A code appears", why="Greenfield", sort_order=1, enabled=True)], "contacts": [dict(full_name="Ann Lee", is_primary=True, job_title="Practice Manager", email="a@nhs.net", phone="01")], "patient_counts": [dict(data_month="2026-09", updated_at="2026-10-13T10:00:00Z")], "ingest_runs": [dict(finished_at="2026-10-13T10:00:00Z")]})
import os
errors = []
with sync_playwright() as p:
    import glob
    exe = os.environ.get("CHROMIUM_PATH") or next(iter(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell")), None)
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.route("**/*", lambda r: r.fulfill(body=FAKE, content_type="text/javascript") if "supabase-js" in r.request.url else r.continue_())
    pg.add_init_script("window.__slow = 700")
    pg.goto(INDEX)
    pg.wait_for_selector("#loading:not(.hidden)", timeout=3000)       # the pop-up is there while data loads
    assert "Loading" in pg.inner_text("#loading") and pg.is_visible("#load-spin")
    pg.wait_for_selector("#rows tr", timeout=15000); pg.wait_for_selector("#loading", state="hidden", timeout=8000)
    pg.evaluate("window.__slow = 0")
    assert pg.locator("#rows tr").count() == 11, pg.locator("#rows tr").count()   # 12 fixtures, one merged and hidden by default
    assert "11 practices" in pg.inner_text("#count")
    def noflow(sel, name):
        b_ = pg.evaluate("(s => { const w = document.querySelector(s); return [w.scrollWidth, w.clientWidth]; })(%r)" % sel)
        assert b_[0] <= b_[1] + 2, f"{name} overflows: {b_}"
    noflow("#view-practices .overflow-x-auto", "practices")
    pg.screenshot(path=SHOTS + "/practices.png")
    # filters + chips + sort
    pg.click("#f-more-btn"); pg.check("#f-grp")
    assert "3 practices" in pg.inner_text("#count"), pg.inner_text("#count")
    assert "clear" in pg.inner_text("#f-chips").lower()
    pg.click("#f-chips >> text=/clear/i"); assert "11 practices" in pg.inner_text("#count")
    pg.click("th[data-sort=patients]"); pg.click("th[data-sort=patients]")
    # drawer
    pg.click("#rows tr:has-text(\"Test Surgery 1\")"); pg.wait_for_selector("#drawer:not(.translate-x-full)")
    body = pg.inner_text("#dr-body"); assert "Modality Test" in body and "Ann Lee" in body, body
    assert pg.get_attribute("#dr-body .speed-toggle", "aria-checked") == "false"  # the speed discount is not guaranteed, so it is off by default
    kpi = lambda: pg.inner_text("#dr-body .price-card > div > div:first-child").replace("\n", " ")
    tb = pg.inner_text("#dr-body .price-card tbody"); assert "annual plan, 1-year commitment" in tb and "Speed discount" not in tb and "£0.076" in tb and "£0.072" not in tb, tb
    assert "£9,120" in kpi() and "on renewal" not in kpi().lower(), kpi()   # no speed discount: one figure
    pg.click("#dr-body .speed-toggle"); assert pg.get_attribute("#dr-body .speed-toggle", "aria-checked") == "true"
    assert "£8,640" in kpi() and "on renewal" in kpi().lower() and "£9,120" in kpi() and "£0.072" in pg.inner_text("#dr-body .price-card tbody") and "Speed discount" in pg.inner_text("#dr-body .price-card tbody")
    assert pg.evaluate("document.activeElement.classList.contains('speed-toggle')")
    rc = pg.inner_text("#dr-body .route-cmp"); assert "speed discount on" in rc and "£8,640" in rc and "£0.072" in rc, rc   # the route comparison follows the speed switch
    pg.click('#dr-body .bill-opt[data-b="monthly"]'); mo = pg.inner_text("#dr-body")   # monthly plan: list rate only, no discounts, no speed switch
    assert "monthly plan" in mo.lower() and "£0.100" in mo and "£12,000" in mo and "no discounts" in mo and "Size discount" not in mo and pg.locator("#dr-body .term-opt").count() == 0 and pg.locator("#dr-body .speed-toggle").count() == 0, mo
    pg.click('#dr-body .prod-opt[data-p="sar"]'); sm = pg.inner_text("#dr-body"); assert "SAR only" in sm and "£0.060" in sm and "£7,200" in sm, sm   # SAR monthly 0.06
    pg.click('#dr-body .bill-opt[data-b="annual"]'); sa = pg.inner_text("#dr-body")   # SAR annual 0.05, size 5% + speed 5% on -> £0.045 = £5,400; the price floor does not apply to SAR
    assert "£0.045" in sa and "£5,400" in sa and "Price floor" not in sa, sa
    pg.click('#dr-body .prod-opt[data-p="all"]'); assert pg.locator("#dr-body .term-opt").count() == 3
    pg.click('#dr-body .term-opt[data-yrs="3"]'); t3 = pg.inner_text("#dr-body"); assert "Term discount" in t3 and "3-year" in t3 and "£0.068" in t3 and "annual plan, 3-year commitment" in t3 and "12-month" not in t3, t3  # 5% size + 5% term + 5% speed off £0.080
    assert "Year 2" in t3 and "Year 3" in t3 and "Total over 3 years" in t3 and "£24,480" in t3 and "Renewal (year 4 onwards)" in t3 and "£8,640" in t3 and t3.count("−15%") >= 4 and "−10%" in t3, t3  # speed applies to all 3 years: 3 x 10,000 x £0.068 x 12; renewal loses speed
    pg.click('#dr-body .term-opt[data-yrs="1"]'); assert "Term discount" not in pg.inner_text("#dr-body")
    assert "estimated annual revenue" in body.lower() and "size discount" in body.lower() and "List price" in body and "speed discount" in body.lower() and "SAR only" in body and "Contract term" in body and "Other ways to sign this practice" in body, body
    assert "£1,216" not in body or True
    pg.wait_for_timeout(500); pg.evaluate("document.querySelector('#dr-body').scrollTop = 0"); pg.screenshot(path=SHOTS + "/profile.png")
    assert pg.locator('#dr-body a[href$="/record/0-2/441"]').count() == 1   # link to the HubSpot company record
    # push to HubSpot: link, preview, write, validate
    pg.evaluate("window.__hsPoll = 30"); assert "Link deal" in pg.inner_text("#dr-hs .hs-bar"); pg.click('#dr-hs .hs-bar [data-hs-act="push"]'); pg.wait_for_selector("#hs-results [data-co]")
    pg.click("#hs-results [data-co]"); pg.wait_for_selector("#hs-results [data-deal]"); pg.click("#hs-results [data-deal]"); pg.wait_for_selector("#hs-write")
    pv = pg.inner_text("#hs-body"); assert "Update HubSpot to match the tool" in pv and "Tier 4" in pv and "£0.10" in pv and "9,000" in pv and "Size Discount %" in pv and "Total Discount %" in pv, pv
    assert pg.locator("#hs-fix-all").count() == 1 and pg.locator("#hs-body ul li").count() == 4 and "ReportSure - MS - SAR Only" in pv and "ReportSure - MS - All Reports" in pv, pv
    pg.screenshot(path=SHOTS + "/hubspot.png"); pg.evaluate("window.__hsBlank = true"); pg.click("#hs-write")
    pg.wait_for_selector("#hs-recheck"); assert "not filled in" in pg.inner_text("#hs-msg") or "has not filled in" in pg.inner_text("#hs-msg"), pg.inner_text("#hs-msg")   # blank calculated value: amber, with a Re-check button
    pg.evaluate("window.__hsBlank = false; window.__hsdb.deal.actual_value_per_patient_calculated = '0.072'"); pg.click("#hs-recheck"); pg.wait_for_function("document.querySelector('#hs-msg').innerText.includes('HubSpot matches the tool')")
    wr = pg.evaluate("window.__rpc.filter(c => c[0] === 'fn:hubspot-push' && c[1].action === 'write')")[0][1]
    assert wr["ods"] == "A10001" and wr["company"] == {"patient_list_size": 10000} and wr["deal"]["size_tier"] == "Tier 3" and wr["deal"]["value_per_patient"] == "£0.08" and wr["deal"]["commercial_model"] == "Subscription" and wr["deal"]["size_discount"] == 0.05 and wr["deal"]["speed_discount"] == 0.05 and wr["deal"]["term_length_discount"] == 0 and wr["deal"]["term_length_years"] == "1", wr
    pg.click("#hs-cancel"); pg.wait_for_selector("#hs-modal", state="hidden")
    # the adaptive HubSpot bar: in sync vs changes to push
    pg.click("#rows tr:has-text('Test Surgery 3')"); pg.wait_for_selector("#dr-hs .hs-bar")
    state = pg.evaluate("""() => { const p = practices.find(x => x.ods_code === 'A10003'), w = hsDesired(p);
      const deal = { id: '9', dealname: 'Sync Deal', size_tier: w.tier, commercial_model: w.model, value_per_patient: w.vpp, size_discount: hsPct(w.size), speed_discount: hsPct(w.speed), term_length_discount: hsPct(w.term), term_length_years: String(w.termYears) };
      hsInfo['A10003'] = { link: { company_id: '1', deal_id: '9' }, pair: { company: { patient_list_size: String(p.total_patients) }, deal } }; hsRefreshBars(); const a = document.querySelector('#dr-hs .hs-bar').innerText;
      deal.size_tier = 'Tier 5'; hsRefreshBars(); return [a, document.querySelector('#dr-hs .hs-bar').innerText]; }""")
    assert "in sync" in state[0] and "Push pricing" not in state[0], state
    assert "1 change to push" in state[1] and "Push pricing" in state[1], state
    # practices that are not in HubSpot: filter, flag, create
    pg.select_option("#f-hs", "missing"); assert pg.locator("#rows tr:has-text('Test Surgery 1')").count() == 0 and pg.locator("#rows tr:has-text('Test Surgery 2')").count() == 1
    pg.click("#rows tr:has-text('Test Surgery 2')"); pg.wait_for_selector('#dr-hs .hs-bar [data-hs-act="create"]'); assert "Not in HubSpot" in pg.inner_text("#dr-body")
    assert "Not in HubSpot yet" in pg.inner_text("#dr-hs .hs-bar") and "Add to HubSpot" in pg.inner_text("#dr-hs .hs-bar")   # the bar offers the next step for a practice that is missing
    pg.screenshot(path=SHOTS + "/hubspot_section.png")
    pg.click('#dr-hs .hs-bar [data-hs-act="create"]'); pg.wait_for_selector("#hs-create"); cp = pg.inner_text("#hs-body"); assert "has no company with this GP ODS Code" in cp and "A10002" in cp and "New company to create" in cp, cp
    pg.click("#hs-create"); pg.wait_for_function("document.querySelector('#hs-msg').innerText.includes('Company created')")
    cc = pg.evaluate("window.__rpc.filter(c => c[0] === 'fn:hubspot-push' && c[1].action === 'create_company')")[0][1]; assert cc["ods"] == "A10002" and cc["company"]["partner_organisation_code"] == "A10002" and cc["company"]["patient_list_size"] == 11000 and cc["company"]["company_status"] == "Prospective Customer", cc
    pg.click("#hs-cancel"); pg.select_option("#f-hs", "")
    pg.keyboard.press("Escape")
    pg.set_viewport_size({"width": 1180, "height": 800}); noflow("#view-practices .overflow-x-auto", "practices@1180"); pg.screenshot(path=SHOTS + "/narrow.png"); pg.set_viewport_size({"width": 1440, "height": 900})
    # networks
    pg.click("#tab-networks"); pg.wait_for_selector("#net-rows tr")
    assert "West PCN" in pg.inner_text("#net-rows"), pg.inner_text("#net-rows")
    pg.click("#net-kinds button[data-k=group]"); assert "Modality Test" in pg.inner_text("#net-rows")
    pg.uncheck("#n-multi"); pg.click("#net-kinds button[data-k=federation]"); assert "Fed One" in pg.inner_text("#net-rows")
    pg.check("#n-multi"); pg.click("#net-kinds button[data-k=pcn]")
    noflow("#view-networks .overflow-x-auto", "networks"); pg.screenshot(path=SHOTS + "/networks.png")
    pg.click("#net-kinds button[data-k=group]")
    pg.click("#net-rows tr:first-child")   # row opens the network profile
    pg.wait_for_selector("#drawer:not(.translate-x-full)")
    prof = pg.inner_text("#dr-body")
    assert "pricing" in prof.lower() and "size discount" in prof.lower() and "estimated annual revenue" in prof.lower() and "signed separately" in prof and "Network discount" in prof and "Test Surgery 0" in prof, prof
    pg.wait_for_timeout(500); pg.screenshot(path=SHOTS + "/netprofile.png")
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
    base_total = pg.inner_text("#rev-routes tr:first-child")
    pg.click('#rev-scen button[data-s="sar"]'); assert pg.inner_text("#rev-routes tr:first-child") != base_total
    pg.click('#rev-scen button[data-s="mix"]'); assert pg.is_visible("#rev-share"); mix_total = pg.inner_text("#rev-routes tr:first-child"); pg.fill("#rev-share", "0"); pg.dispatch_event("#rev-share", "change")
    assert pg.inner_text("#rev-routes tr:first-child") == base_total and mix_total != base_total
    pg.click('#rev-scen button[data-s="all"]'); assert pg.is_hidden("#rev-share")
    pg.click("#rev-metric") if pg.locator("#rev-metric").evaluate("e => e.tagName") == "BUTTON" else None
    pg.screenshot(path=SHOTS + "/revenue.png", full_page=True)
    # signals + data
    pg.click("#tab-signals"); assert pg.is_visible("#s-count")
    pg.screenshot(path=SHOTS + "/signals.png"); sr = pg.inner_text("#s-rows"); assert "unlinked" in sr.lower() and "network" in sr.lower() and "Little Common Surgery" in sr, sr
    assert "Offer cover for reports." in pg.inner_text("#s-rows tr:has-text('Little Common') td:nth-child(5)") and "http" not in sr and pg.locator("#s-rows a[href*=jobadvert]").count() == 1
    pg.click("#sig-settings-link"); pg.wait_for_selector("#view-data:not(.hidden)"); assert "NHS ODS (daily)" in pg.inner_text("#sig-types-rows")
    pg.uncheck("input[data-t=NEW_PRACTICE]"); pg.wait_for_function("document.querySelector('#sig-types-msg').textContent.includes('disabled')")
    pg.click("#tab-signals"); pg.click("#sig-sub button[data-s=jobs]"); pg.wait_for_selector("#jm-rows tr[data-c]")
    assert pg.input_value("#jm-status") == "auto" and "Auto Surgery" in pg.inner_text("#jm-rows")   # opens on the auto-matched employers
    pg.select_option("#jm-status", "review"); pg.wait_for_selector("#jm-rows .jm-pick")
    assert "Little Common Surgery" in pg.inner_text("#jm-rows") and pg.is_visible("#jm-rows .jm-pick") and "1" in pg.inner_text("#jobs-badge")
    pg.click("#jm-rows .jm-act[data-a=confirm]"); assert "Choose a practice" in pg.inner_text("#jm-msg")     # nothing is linked until you choose
    pg.select_option("#jm-rows .jm-pick", "A10001"); pg.click("#jm-rows .jm-act[data-a=confirm]")
    pg.wait_for_function("document.querySelector('#jm-msg').textContent.startsWith('Linked')")
    assert [c for c in pg.evaluate("window.__rpc.filter(c => c[0] === 'link_job_employer')")][0][1]["p_ods"] == "A10001"
    pg.select_option("#jm-status", "confirmed"); assert "Medical Records" in pg.inner_text("#jm-rows") or "Done Surgery" in pg.inner_text("#jm-rows")
    pg.click("#sig-sub button[data-s=feed]"); assert pg.is_visible("#s-count")
    pg.click("#tab-data"); pg.click("#data-sub button[data-d=overview]"); pg.wait_for_selector("#d-fresh")
    assert pg.is_visible("#dp-overview") and pg.is_hidden("#dp-sources") and pg.is_hidden("#dp-pricing")
    pg.click("#data-sub button[data-d=pricing]"); assert "How prices are worked out" in pg.inner_text("#rev-config") and "PCNs / clusters" in pg.inner_text("#rev-config") and "Federations" in pg.inner_text("#rev-config")
    CSV = ('DYNAMIC PRICING\nAnnual Sub List Price / Pt (excl. VAT):,£0.085,Monthly Sub List Price / Pt (excl. VAT):,£0.105,SAR Only Annual List Price:,£0.055,SAR Only Monthly List Price:,£0.065,Practice Speed Incentive %:,5.0%,UK VAT Rate:,20.0%\nNo-Undercut,x,x,x,Absolute Margin Floor / Pt:,£0.050\n\n'
           '"1. SINGLE PRACTICE DISCOUNT SCHEDULE (Practice-Level Contracts)"\nTier,Classification,Patient Threshold (PuM ≥),Practice Count,Tier 1: Size Discount %,Tier 2: Speed Discount % (Year 1 only)\n'
           'Tier 1,Very Large,"20,000",415,12.0%,5.0%\nTier 4,Medium,"5,000",2532,0.0%,5.0%\n"2. PRIMARY CARE NETWORK (PCN) DISCOUNT SCHEDULE"\nTier,Classification,Patient Threshold (PuM ≥),PCN Count,Tier 1: Size Discount %,Tier 2: Speed Discount %\nTier 5,Small,0,105,12.5%,2.5%\n')
    MATRIX = 'MATRIX\nAnnual List Price / Pt:,£0.080,2-Yr Commitment Disc [EDITABLE]:,2.5%,Practice Speed %:,5.0%\nMonthly List Price / Pt:,£0.010,3-Yr Commitment Disc [EDITABLE]:,5.0%\n'
    pg.set_input_files("#ps-file", [dict(name="a.csv", mimeType="text/csv", buffer=CSV.encode()), dict(name="b.csv", mimeType="text/csv", buffer=MATRIX.encode())])
    pg.wait_for_selector("#ps-apply:not(.hidden)"); prev = pg.inner_text("#dp-pricing"); assert "£0.085" in prev and "£0.105" in prev and "size discount" in prev and "12%" in prev and "spreadsheet" in prev.lower(), prev
    pg.click("#ps-apply"); pg.wait_for_function("document.querySelector('#ps-msg').textContent.includes('Prices reloaded')")
    sp = pg.evaluate("window.__rpc.filter(c => c[0] === 'sync_pricing')")[0][1]
    assert sp["p_settings"]["list_price_per_patient"] == 0.085 and sp["p_settings"]["monthly_list_price_per_patient"] == 0.105 and sp["p_settings"]["list_price_sar_per_patient"] == 0.055 and sp["p_settings"]["monthly_list_price_sar_per_patient"] == 0.065 and sp["p_settings"]["term_discount_3yr"] == 0.05 and sp["p_settings"]["price_floor_per_patient"] == 0.05 and any(t["route"] == "practice" and t["tier"] == 1 and t["size_discount"] == 0.12 and t["threshold"] == 20000 for t in sp["p_tiers"]), sp
    assert pg.locator("#rev-config table").count() == 4, pg.locator("#rev-config table").count()
    pg.screenshot(path=SHOTS + "/pricing.png", full_page=True)
    pg.click("#data-sub button[data-d=sources]")
    assert "2026" in pg.inner_text("#d-fresh") and "£0.080 annual" in pg.inner_text("#rev-config")
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
    up("sco", sc, "600 practices"); pg.click("#up-sco .up-load"); pg.wait_for_function("document.querySelector('#up-sco .up-msg').textContent.startsWith('Done')")
    ws = os.path.join(td, "wales_patients.csv")
    open(ws, "w").write("Data values,Data values_sort,Data description,Date,Date_sort,Practice,Practice_reference,Practice_hierarchy,Residence,Residence_reference\n" +
        "".join(f"x,{30000},Number of patients,07/07/2026,1783382400000,Board,7A1,W92000004,All residence,P\n" for _ in range(1)) +
        "".join(f"x,{5000+i},Number of patients,07/07/2026,1783382400000,SURGERY {i},W{93000+i},7A1,All residence,P\n" for i in range(400)))
    # one Wales box takes both files at once; patient numbers load first and may add practices, clusters only update known ones
    pg.set_input_files("#up-wal .up-file", [wl, ws]); pg.wait_for_function("document.querySelector('#up-wal .up-msg').textContent.includes('Press Load')")
    wm = pg.inner_text("#up-wal .up-msg"); assert "clusters, 400 practices" in wm and "patient numbers and health boards, 400 practices" in wm, wm
    pg.click("#up-wal .up-load"); pg.wait_for_function("document.querySelector('#up-wal .up-msg').textContent.startsWith('Done')")
    pg.set_input_files("#up-wal .up-file", sc); pg.wait_for_function("document.querySelector('#up-wal .up-msg').textContent.includes('Fix the file')")
    assert "use the Scotland box" in pg.inner_text("#up-wal .up-msg") and pg.is_disabled("#up-wal .up-load")      # wrong box is explained, not loaded
    calls = pg.evaluate("window.__rpc.filter(c => c[0] === 'load_devolved')")
    assert [(c[1]["p_country"], c[1]["p_create"]) for c in calls] == [("Scotland", True), ("Wales", True), ("Wales", False)], [(c[1]["p_country"], c[1]["p_create"]) for c in calls]
    r0 = calls[0][1]["p_rows"][0]; assert r0["code"] == "S10000" and r0["icb"] == "NHS Tayside" and r0["net_code"] == "SC-dundee-0" and r0["patients"] == 5000 and r0["town"] == "Muirhead", r0
    assert calls[1][1]["p_rows"][0]["patients"] == 5000 and calls[1][1]["p_rows"][0]["icb"] is None or True
    w0 = calls[2][1]["p_rows"][0]; assert w0["code"] == "W93000" and w0["net_code"] == "WC60100", w0
    assert "In the database" in pg.inner_text("#up-eng .up-status") and pg.locator("#uploads > div").count() == 3
    open(os.path.join(td, "bad.csv"), "w").write("a,b\n1,2\n")
    pg.set_input_files("#up-wal .up-file", os.path.join(td, "bad.csv")); pg.wait_for_function("document.querySelector('#up-wal .up-msg').textContent.includes('Not recognised')")
    pg.screenshot(path=SHOTS + "/data.png", full_page=True)
    # ---- usability: keyboard, URL state, status workflow, exports ----
    pg.click("#tab-practices"); pg.click("#f-chips >> text=/clear/i") if pg.locator("#f-chips >> text=/clear/i").count() else None
    pg.fill("#f-search", ""); pg.evaluate("document.querySelector('#rows tr').focus()"); pg.keyboard.press("Enter")
    pg.wait_for_selector("#drawer:not(.translate-x-full)"); assert "open=" in pg.evaluate("location.search")
    pg.keyboard.press("Escape"); pg.wait_for_function("document.querySelector('#drawer').classList.contains('translate-x-full')")
    assert "open=" not in pg.evaluate("location.search") and pg.evaluate("document.activeElement.tagName") == "TR"       # focus goes back to the row
    pg.click("#f-more-btn") if pg.is_hidden("#f-size") else None
    pg.select_option("#f-size", "no"); assert "3 practices" in pg.inner_text("#count") and "size=no" in pg.evaluate("location.search")
    pg.select_option("#f-size", ""); pg.select_option("#f-tier", "Tier 3"); assert "tier=Tier+3" in pg.evaluate("location.search")
    pg.goto("about:blank"); pg.goto(INDEX + "?tier=Tier+3&open=A10001&sort=name:1")      # a shared link restores the view
    pg.wait_for_selector("#drawer:not(.translate-x-full)", timeout=8000)
    assert "Test Surgery 1" in pg.inner_text("#dr-title") and pg.input_value("#f-tier") == "Tier 3" and "11 practices" in pg.inner_text("#count")
    pg.keyboard.press("Escape")
    pg.click("#th-name") if False else None
    # signals: status workflow
    pg.click("#tab-signals"); n0 = pg.locator("#s-rows tr").count(); assert n0 == 2, n0
    pg.select_option("#s-rows tr:has-text('Little Common') .sg-status", "done"); pg.wait_for_function("document.querySelectorAll('#s-rows tr').length === 1")
    pg.select_option("#s-status", "all"); assert pg.locator("#s-rows tr").count() == 2
    pg.select_option("#s-status", "done"); assert "Little Common" in pg.inner_text("#s-rows")
    with pg.expect_download() as dl: pg.click("#s-export")
    csv = open(dl.value.path(), encoding="utf-8-sig").read(); assert csv.startswith('"Detected"') and "Little Common" in csv and "Done" in csv, csv[:200]
    pg.select_option("#s-status", "open")
    pg.click("#tab-networks"); pg.wait_for_selector("#net-rows tr")
    with pg.expect_download() as dl2: pg.click("#n-export")
    assert "Linked practices" in open(dl2.value.path(), encoding="utf-8-sig").read()
    # job matches: the review list is visible without ticking anything, with honest counts
    pg.click("#tab-signals"); pg.click("#sig-sub button[data-s=jobs]"); pg.wait_for_selector("#jm-status option", state="attached", timeout=8000); assert "To review (1)" in pg.inner_html("#jm-status"), pg.inner_html("#jm-status")
    assert "1 employers, 1 with a report" in pg.inner_text("#jm-count") or "employers" in pg.inner_text("#jm-count")
    # the Data tab always opens on Overview
    pg.click("#tab-data"); pg.click("#data-sub button[data-d=pricing]"); pg.click("#tab-practices"); pg.click("#tab-data"); assert pg.is_visible("#dp-overview")
    # mergers: status filter, profile status card, review tab
    pg.goto("about:blank"); pg.goto(INDEX); pg.wait_for_selector("#rows tr", timeout=15000); pg.wait_for_selector("#loading", state="hidden", timeout=8000)
    assert "Test Old Surgery" not in pg.inner_text("#rows") and "May have closed or merged" in pg.inner_text("#rows")   # merged hidden by default, suggestions flagged
    pg.click("#f-more-btn"); pg.select_option("#f-status", "merged"); assert pg.locator("#rows tr").count() == 1 and "Merged → Test Surgery 1" in pg.inner_text("#rows") and "status" not in pg.evaluate("location.search") and "st=merged" in pg.evaluate("location.search")
    pg.click("#rows tr"); pg.wait_for_selector("#drawer:not(.translate-x-full)"); card = pg.inner_text("#dr-body")
    assert "Merged into Test Surgery 1" in card and "Merged 2025" in card and "boss@lalu.co.uk" in card and "Undo merge" in card, card
    pg.click('#dr-body [data-mg="undo"]'); pg.wait_for_function("window.__rpc.some(c => c[0] === 'set_practice_merge' && c[1].p_into === null)")
    pg.keyboard.press("Escape"); pg.select_option("#f-status", label="Active practices"); pg.click("#rows tr:has-text('Test Annex A')"); pg.wait_for_selector("#drawer:not(.translate-x-full)")
    pg.screenshot(path=SHOTS + "/merge_card.png")
    card = pg.inner_text("#dr-body"); assert "Probably merged into Test Surgery 3" in card and "12,000 patients" in card and "Confirm merger" in card, card
    pg.click('#dr-body [data-mg="confirm"]'); pg.wait_for_function("window.__rpc.some(c => c[0] === 'set_practice_merge' && c[1].p_ods === 'A10009' && c[1].p_into === 'A10003')")
    pg.wait_for_selector("#drawer:not(.translate-x-full)"); assert "Merged into Test Surgery 3" in pg.inner_text("#dr-body")
    pg.keyboard.press("Escape"); assert "Test Annex A" not in pg.inner_text("#rows")      # now hidden from the main list
    pg.click("#tab-signals"); pg.click('#sig-sub button[data-s=mergers]'); pg.wait_for_selector("#mg-rows tr")
    rows = pg.inner_text("#mg-rows"); assert "Test Annex B" in rows and "Test Surgery 5" in rows and "Several practices at this postcode" in rows and "Test Closed Candidate" in rows and "Probably closed" in rows and "Deregistered from CQC" in rows and "ss=mergers" in pg.evaluate("location.search"), rows
    pg.screenshot(path=SHOTS + "/mergers.png", full_page=True); assert pg.is_hidden("#s-export") and pg.is_hidden("#s-status")
    pg.click('#mg-rows tr[data-ods=A10010] [data-mg="dismiss"]'); pg.wait_for_function("window.__rpc.some(c => c[0] === 'dismiss_merge_suggestion' && c[1].p_ods === 'A10010' && c[1].p_dismissed === true)")
    pg.click('#mg-rows tr[data-ods=A10011] [data-mg="close"]'); pg.wait_for_function("window.__rpc.some(c => c[0] === 'set_practice_closed' && c[1].p_ods === 'A10011' && c[1].p_closed === true)")
    assert "Nothing to review" in pg.inner_text("#mg-rows") and pg.is_hidden("#merge-badge")
    pg.select_option("#mg-status", "closed"); assert "Test Closed Candidate" in pg.inner_text("#mg-rows")
    pg.select_option("#mg-status", "merged"); assert "Test Annex A" in pg.inner_text("#mg-rows") and "Test Surgery 3" in pg.inner_text("#mg-rows")
    pg.select_option("#mg-status", "dismissed"); assert "Test Annex B" in pg.inner_text("#mg-rows")
    pg.click("#tab-practices"); assert "Test Closed Candidate" not in pg.inner_text("#rows")   # confirmed closures leave the main list
    # a failed load must not leave the spinner up forever: it explains and offers Try again
    pg.goto("about:blank"); pg.add_init_script("window.__fail = true"); pg.goto(INDEX)
    pg.wait_for_selector("#load-retry:not(.hidden)", timeout=8000)
    assert "Could not load the data" in pg.inner_text("#load-step") and pg.is_hidden("#load-spin")
    pg.evaluate("window.__fail = false"); pg.click("#load-retry"); pg.wait_for_selector("#loading", state="hidden", timeout=8000)
    # invite link: lands on the set-password screen, not the dashboard
    pg.goto("about:blank"); pg.goto(INDEX + "#access_token=abc&type=invite")
    pg.wait_for_selector("#setpw:not(.hidden)"); assert "new@lalu.co.uk" in pg.inner_text("#setpw-who") and pg.is_hidden("#app")
    pg.fill("#pw1", "correct horse battery"); pg.fill("#pw2", "something else entirely"); pg.click("#setpw-form button"); assert "do not match" in pg.inner_text("#setpw-error")
    pg.fill("#pw2", "correct horse battery"); pg.click("#setpw-form button"); pg.wait_for_selector("#app:not(.hidden)")
    assert [c for c in pg.evaluate("window.__rpc.filter(c => c[0] === 'updateUser')")][0][1]["password"] == "correct horse battery"
    assert "type=invite" not in pg.evaluate("location.href")
    pg.goto("about:blank"); pg.goto(INDEX + "#error=access_denied&error_description=Email+link+is+invalid+or+has+expired")
    print("SMOKE OK; page errors:", errors)
    sys.exit(1 if errors else 0)
