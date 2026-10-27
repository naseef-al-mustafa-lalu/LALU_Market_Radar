// Loading data, the loading pop-up, shareable URL state and tabs.
/* ---------- data ---------- */
/* Reads a whole table or view. PostgREST caps a response at 1,000 rows, so: one request that also returns a row count, then the remaining pages in parallel.
   Exact counts are cheap on a plain table (gp_practices) but make a view run twice, so views use the planner's estimate, which only sizes the first wave;
   any further pages are fetched in waves until a short page says the data has ended. */
const PAGE_N = 1000;
async function fetchAll(table, columns, order, hint = "planned") {
  const page = (from, count) => db.from(table).select(columns, count ? { count } : {}).order(order).range(from, from + PAGE_N - 1);
  const first = await page(0, hint); if (first.error) throw first.error;
  const out = [...(first.data || [])];
  if (out.length < PAGE_N) return out;
  let next = 1, wave = typeof first.count === "number" ? Math.min(6, Math.max(1, Math.ceil(first.count / PAGE_N) - 1)) : 4;
  for (;;) {
    const rs = await Promise.all(Array.from({ length: wave }, (_, i) => page((next + i) * PAGE_N)));
    let ended = false;
    for (const r of rs) { if (r.error) throw r.error; out.push(...r.data); if (r.data.length < PAGE_N) ended = true; }
    if (ended) return out;
    next += wave; wave = 4;
  }
}
// only the columns the screens read (the full table has ~60; fetching all of them for ~8,000 rows was most of the login wait)
const PRACTICE_COLS = "ods_code,hubspot_company_id,hubspot_list_size,hubspot_org_type,hubspot_operating_status,hubspot_website,operational_start_date,operational_end_date,hubspot_commercial_model,hubspot_contracted_arr,hubspot_contract_terms,hubspot_contracted_src,hubspot_contract_start,hubspot_contract_end,hubspot_pipeline,hubspot_conversion_pipeline,hubspot_renewal_pipeline,practice_name,postcode,website,pcn_code,pcn_name,icb_name,total_patients,status,clinical_software,manager_name,manager_title,manager_email,manager_phone,manager_email_opt_out,lead_status,data_month,address,town,county,region,main_phone,main_email,main_email_opt_out,num_employees,annual_spend,org_notes,nhs_num_gp,gp_federation,oscar_categories,cqc_location_id,cqc_provider_id,cqc_status,cqc_rating,cqc_last_inspection,cqc_manager_absent_date,group_name,group_size,hubspot_company_imported_at,hubspot_stage,hubspot_engaged,hubspot_customer,hubspot_synced_at,country,network_locked,merged_into,merged_note,merged_at,merged_by,merge_dismissed,closure_confirmed_at,closure_note,closed_by";
const PRICING_COLS = "ods_code,price_tier,tier_label,base_price,year1_price,est_arr,est_arr_year1,base_price_sar,est_arr_sar";
const HS_COLS = "ods_code,hs_contacts,hs_imported,hs_primary_imported,hs_last_imported_at,hs_primary_imported_at";
const NET_COLS = "id,kind,name,source_key,practices,patients,tier1,tier2,tier3,tier4,tier5,emis,systmone,cqc_concern,engaged,customers,hs_imported,arr_single,arr_customers,arr_single_sar,arr_customers_sar,arr_network_sar,confirmed,network_tier,network_tier_label,network_base_price,arr_network";
const BRANCH_COLS = "branch_code,branch_name,address,town,county,postcode,phone,opened,status,parent_code,parent_name,parent_role_name,kind,practice_code,resolution,matched_branch_code,match_status,match_note";
async function loadPractices() {
  const [base, pp, hs, br] = await Promise.all([fetchAll("gp_practices", PRACTICE_COLS, "ods_code", "exact"), fetchAll("practice_pricing", PRICING_COLS, "ods_code"), fetchAll("practice_hubspot", HS_COLS, "ods_code"), fetchAll("practice_branches", BRANCH_COLS, "branch_code").catch(() => [])]);
  branches = br.filter(b => b.status === "Active"); indexBranches();
  const m = new Map(pp.map(r => [r.ods_code, r])), h = new Map(hs.map(r => [r.ods_code, r]));
  practices = base.map(p => ({ ...p, ...(m.get(p.ods_code) || {}), ...(h.get(p.ods_code) || {}) }));
  byOds = new Map(practices.map(p => [p.ods_code, p]));
}
async function loadConfig() {
  const [t, st] = await Promise.all([db.from("pricing_tiers").select("*").order("tier"), db.from("pricing_settings").select("*").order("key")]);
  cfgTiers = t.data || []; cfgSettings = Object.fromEntries((st.data || []).map(r => [r.key, r]));
  const pt = cfgTiers.filter(x => x.route === "practice").sort((a, b) => a.tier - b.tier);
  $("f-tier").innerHTML = '<option value="">All tiers</option>' + pt.map((x, i) => {
    const hi = i ? pt[i - 1].threshold : null, lo = x.threshold;
    return `<option value="Tier ${x.tier}">Tier ${x.tier} · ${hi ? (lo ? (lo / 1000) + "–" + (hi / 1000) + "k" : "<" + (hi / 1000) + "k") : (lo / 1000) + "k+"}</option>`; }).join("");
}
async function loadSignals() {
  const { data } = await db.from("sales_triggers").select("*").order("detected_at", { ascending: false }).limit(500);
  signals = data || []; indexSignals(); renderSignals(); renderSignalTypes();
}
function indexSignals() {
  signalCodes = new Set(signals.map(s => s.ods_code)); signalCounts = new Map();
  signals.forEach(s => signalCounts.set(s.ods_code, (signalCounts.get(s.ods_code) || 0) + 1));
  const recent = signals.filter(s => (s.status || "new") === "new" && Date.now() - new Date(s.detected_at) < 7 * 864e5).length;
  $("sig-badge").textContent = recent; $("sig-badge").classList.toggle("hidden", !recent);
}
let netPrefetch = null;
async function loadNetworks(prefetched) {
  try { networks = prefetched || await fetchAll("network_summary", NET_COLS, "id"); renderNetworks(); renderRevenue(); fillNetList(); renderSignals(); } catch (e) { $("n-count").textContent = "Networks unavailable: " + (e.message || e); }
}
/* ---------- loading pop-up (so a slow first load never looks like a crash) ---------- */
let slowTimer = null;
function loading(on, step) {
  $("loading").classList.toggle("hidden", !on);
  clearTimeout(slowTimer); $("load-slow").classList.add("hidden");
  if (on) { $("load-spin").classList.remove("hidden"); $("load-retry").classList.add("hidden"); $("load-step").textContent = step || "Starting…"; slowTimer = setTimeout(() => $("load-slow").classList.remove("hidden"), 6000); }
}
const loadStep = t => { $("load-step").textContent = t; };
function loadFailed(err) {
  $("load-spin").classList.add("hidden"); clearTimeout(slowTimer); $("load-slow").classList.add("hidden");
  $("load-step").textContent = "Could not load the data: " + (err && err.message ? err.message : err) + ". Check your connection and try again."; $("load-retry").classList.remove("hidden");
}
$("load-retry").onclick = () => startApp();
async function startApp() {
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  loading(true, "Checking your sign-in and loading the price list…");
  try {
    loadStep("Loading practices, networks and the price list…"); await Promise.all([loadConfig(), loadPractices(), netPrefetch = fetchAll("network_summary", NET_COLS, "id").catch(() => null)]); loadStep("Loading signals…");
    if (!practices.length) $("rows").innerHTML = '<tr><td colspan="8" class="p-6 text-center text-slate-500 italic">No data yet, or your account is not authorised.</td></tr>';
    const icbs = [...new Set(practices.map(p => p.icb_name))].sort();
    $("f-icb").innerHTML = '<option value="">All ICBs</option>' + icbs.map(i => `<option>${esc(i)}</option>`).join("");
    await loadSignals(); await loadSignalSettings(); loadJobs().catch(() => {}); await loadMergeSuggestions(); renderMergers();
    const { data: run } = await db.from("ingest_runs").select("finished_at").eq("status", "success").order("id", { ascending: false }).limit(1);
    lastRunDate = run && run[0] ? fmtDate(run[0].finished_at) : null;
    $("refresh-badge").textContent = "Refreshed " + (lastRunDate || "never");
    await loadNetworks(await netPrefetch); loadStep("Preparing the dashboard…"); const openCode = stateFromUrl(); applyFilters(); showTab(currentTab, true); loading(false);
    if (openCode && byOds.get(openCode)) openDrawer(byOds.get(openCode));
    channel = db.channel("signals").on("postgres_changes", { event: "INSERT", schema: "public", table: "sales_triggers" }, p => { signals.unshift(p.new); indexSignals(); renderSignals(); if (currentTab === "practices") applyFilters(); })
      .subscribe(s => { $("sig-live").textContent = s === "SUBSCRIBED" ? "● live" : "offline"; });
  } catch (err) { $("refresh-badge").textContent = "Failed to load data: " + (err.message || err); $("refresh-badge").classList.remove("hidden"); loadFailed(err); }
}

/* keyboard: Enter or Space activates a focused row or sortable header, exactly like a click */
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr[tabindex], th[data-sort]") && !e.target.closest("#loading")) { e.preventDefault(); e.target.click(); }
});

/* ---------- shareable state: tab, filters, sort, network and open practice live in the web address ---------- */
const STATE_FIELDS = { q: "f-search", tier: "f-tier", hs: "f-hs", sw: "f-sw", cqc: "f-cqc", icb: "f-icb", country: "f-country", size: "f-size", st: "f-status" };
let restoringUrl = false;
function stateToUrl(push) {
  if (restoringUrl || !$("view-practices")) return;
  const u = new URLSearchParams();
  if (currentTab !== "practices") u.set("tab", currentTab);
  for (const [k, id] of Object.entries(STATE_FIELDS)) if ($(id).value) u.set(k, $(id).value);
  if ($("f-sig").checked) u.set("sig", "1"); if ($("f-grp").checked) u.set("grp", "1");
  if (sort.key !== "patients" || sort.dir !== -1) u.set("sort", sort.key + ":" + sort.dir);
  if (netFilter) u.set("net", [netFilter.kind, netFilter.key, netFilter.label].join("|"));
  if (currentTab === "networks" && netKind !== "pcn") u.set("nk", netKind);
  if (currentTab === "data" && dataSub !== "overview") u.set("ds", dataSub);
  if (currentTab === "signals" && sigSub !== "feed") u.set("ss", sigSub);
  if (drawerCode) u.set("open", drawerCode);
  const qs = u.toString(), url = location.pathname + (qs ? "?" + qs : "") + location.hash;
  if (url !== location.pathname + location.search + location.hash) history[push ? "pushState" : "replaceState"](null, "", url);
}
function stateFromUrl() {
  const u = new URLSearchParams(location.search); restoringUrl = true;
  try {
    for (const [k, id] of Object.entries(STATE_FIELDS)) { const el = $(id); el.value = u.get(k) || ""; if (el.value !== (u.get(k) || "")) el.value = ""; }
    $("f-sig").checked = u.get("sig") === "1"; $("f-grp").checked = u.get("grp") === "1";
    const [k, d] = (u.get("sort") || "patients:-1").split(":"); sort = { key: SORTERS[k] ? k : "patients", dir: Number(d) === 1 ? 1 : -1 };
    const nf = (u.get("net") || "").split("|"); netFilter = nf.length === 3 && nf[0] ? { kind: nf[0], key: nf[1], label: nf[2] } : null;
    netKind = ["pcn", "group", "federation", "icb"].includes(u.get("nk")) ? u.get("nk") : "pcn";
    currentTab = TABS.includes(u.get("tab")) ? u.get("tab") : "practices";
    setDataSub(["overview", "sources", "audit", "branches", "signals", "pricing"].includes(u.get("ds")) ? u.get("ds") : "overview");
    setSigSub(["feed", "mergers", "jobs"].includes(u.get("ss")) ? u.get("ss") : "feed");
  } finally { restoringUrl = false; }
  return u.get("open");
}
window.addEventListener("popstate", () => { if (!$("app").classList.contains("hidden")) { const open = stateFromUrl(); applyFilters(); renderNetworks(); showTab(currentTab, true); if (open && byOds.get(open)) openDrawer(byOds.get(open)); else closeDrawer(); } });

/* ---------- tabs ---------- */
const TABS = ["practices", "networks", "revenue", "signals", "audiences", "data"]; let currentTab = "practices";
const SUBNAV = { networks: "net-kinds", signals: "sig-sub", audiences: "aud-sub", data: "data-sub" };   // tab -> its sub-tab strip in the second row (#subnav)
window.addEventListener("resize", () => { if (!$("subnav").classList.contains("hidden")) $("subnav").style.top = document.querySelector("#app > nav").offsetHeight + "px"; });
function showTab(which, fromUrl) {
  if (which === "data" && currentTab !== "data") setDataSub("overview");
  const changed = currentTab !== which; currentTab = which;
  for (const t of TABS) { $("view-" + t).classList.toggle("hidden", t !== which); $("tab-" + t).className = "px-2.5 lg:px-3 py-1 rounded-md whitespace-nowrap " + (t === which ? "bg-white text-lalu-navy shadow-sm" : "text-slate-300 hover:text-white hover:bg-white/10"); }
  const strip = SUBNAV[which]; $("subnav").classList.toggle("hidden", !strip);      // each tab with sub tabs shows its own strip in the second row
  for (const id of Object.values(SUBNAV)) $(id).classList.toggle("hidden", id !== strip);
  if (strip) $("subnav").style.top = document.querySelector("#app > nav").offsetHeight + "px";
  if (which === "revenue") renderRevenue();
  if (which === "audiences") loadAudiences();
  if (which === "data") renderData();
  if (which !== "practices") closeDrawer();
  if (!fromUrl) stateToUrl(changed);
}
for (const t of TABS) $("tab-" + t).onclick = () => { fromNetworks = false; showTab(t); };
