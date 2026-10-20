// Data tab: overview, rate card and file uploads.
/* ---------- data tab ---------- */
async function renderData() {
  renderHubspotPanel();
  const row = await latestCountRow(), withCounts = practices.filter(p => p.total_patients > 0).length, withCqc = practices.filter(p => p.cqc_location_id).length;
  renderUploads();
  $("pc-status").textContent = row ? `Data for ${row.data_month || "?"}, loaded ${fmtDate(row.updated_at)}. ${withCounts.toLocaleString()} of ${practices.length.toLocaleString()} practices have counts.` : "No patient counts loaded yet: practices show no list size or ARR until you load the NHS file.";
  $("d-fresh").innerHTML = [["Practices last refreshed", lastRunDate || "never"], ["Patient counts", row ? "NHS " + (row.data_month || "?") + ", loaded " + fmtDate(row.updated_at) : "not loaded"],
    ["Practices with a CQC match", withCqc.toLocaleString() + " of " + practices.length.toLocaleString()], ["Practices with a contact", practices.filter(p => p.manager_name).length.toLocaleString()],
    ["Merged practices", practices.filter(p => p.merged_into).length.toLocaleString()], ["Confirmed closures", practices.filter(p => p.closure_confirmed_at).length.toLocaleString()], ["Closures and mergers to review", (mergeSugg.size + closureCands.size).toLocaleString()], ["Provider groups", new Set(practices.filter(p => p.group_size > 1).map(p => p.cqc_provider_id)).size.toLocaleString()]].map(([k, v]) => `<div class="flex justify-between py-0.5 border-b border-slate-50"><span class="text-slate-500">${k}</span><span class="font-medium">${esc(v)}</span></div>`).join("");
  const { data: runs } = await db.from("ingest_runs").select("id,started_at,finished_at,status,error,stats").order("id", { ascending: false }).limit(6);
  $("d-runs").innerHTML = `<table class="w-full"><thead class="text-slate-500"><tr><th class="text-left font-medium py-1">Started</th><th class="text-left font-medium">Status</th><th class="text-left font-medium">Notes</th></tr></thead><tbody>` +
    (runs || []).map(r => { const st = r.stats || {}, notes = r.error ? r.error.split("\n")[0].slice(0, 90) : [st.practices_changed != null ? st.practices_changed + " practices changed" : "", st.cqc_error ? "CQC error" : "", st.oscar_error ? "Oscar not loaded" : "", st.patients_missing ? "no patient counts" : ""].filter(Boolean).join(" · ");
      return `<tr class="border-t border-slate-100"><td class="py-1 whitespace-nowrap">${esc(fmtDate(r.started_at))}</td><td>${chip(r.status, r.status === "success" ? "bg-emerald-100 text-emerald-800" : r.status === "failed" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600")}</td><td class="text-slate-500">${esc(notes)}</td></tr>`; }).join("") + `</tbody></table>`;
  renderRateCard();
  window.__lastRuns = runs; window.__lastCount = row; renderConnections(runs, row);
}

/* ---------- Data > Data sources: every connection, what it is for, what it needs and what breaks if it fails ---------- */
// Maintain this list when an integration is added or changed. It only describes; secrets are never shown or stored here.
const CONNECTIONS = [
  { id: "radar", name: "Daily market radar (the job)", short: "The job that runs the four feeds below, plus practice websites", forWhat: "Runs the NHS ODS, CQC, Oscar and NHS Jobs feeds, detects changes, raises the signals and posts them to Slack.", runs: "GitHub Action “Daily market radar”, 07:30 UTC",
    secrets: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], where: "GitHub secrets. The feed keys are listed on each feed below.", fails: "Every feed below goes stale and no signals are raised. A failed run is posted to Slack and shown in the runs table on Overview." },
  { id: "ods", name: "NHS ODS directory", short: "Active GP practices, names, postcodes, closures, PCNs and ICBs", forWhat: "The master list of English GP practices and which PCN and ICB each belongs to; closures and new practices become signals.", runs: "Part of the daily market radar (public NHS ODS API and export, no key)",
    secrets: [], where: "Public NHS Digital service, nothing to configure.", fails: "The practice list and PCN links stop updating.", errKey: "pcn_error" },
  { id: "cqc", name: "CQC public API", short: "Registration, ratings, inspections, registered manager, providers", forWhat: "Registration status, overall rating, last inspection, registered-manager absence, and provider groups (such as Modality) for practices run by a group.", runs: "Part of the daily market radar, through CQC's daily changes feed",
    secrets: ["CQC_API_KEY"], where: "GitHub secret. A free key from the CQC API portal.", fails: "Ratings, inspections and CQC signals go stale. Practices show as not matched to a CQC location.", errKey: "cqc_error" },
  { id: "oscar", name: "Oscar research file", short: "Contacts and practice details", forWhat: "Contacts (name, title, email and phone, opt-outs) and practice details (address, federation, GP numbers, employees, spend, notes).", runs: "Part of the daily market radar, when the URL is set",
    secrets: ["OSCAR_API_URL"], where: "GitHub secret. The URL carries the API key, so keep it private. It is held by Unmatched until handover.", fails: "Contacts and Oscar details stop updating; existing ones stay.", errKey: "oscar_error" },
  { id: "jobs", name: "NHS Jobs", short: "Report and records roles advertised by practices", forWhat: "Hiring adverts for report, records and secretary roles, matched to practices. They feed the hiring signals and each practice's hiring section.", runs: "Part of the daily market radar (public NHS Jobs XML feed, no key)",
    secrets: [], where: "Public feed. Employers that cannot be matched to a practice wait for review under Signals.", fails: "Hiring signals and adverts stop updating.", errKey: "jobs_error" },
  { id: "patients", name: "NHS patient numbers", short: "List sizes behind tiers, prices and revenue", forWhat: "List sizes, which drive tiers, prices and estimated revenue.", runs: "GitHub Action “Patient numbers”, Mondays 09:00 UTC (safe to repeat), or upload a file below",
    secrets: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], where: "GitHub secrets. “Update from NHS now” also uses the trigger-patient-load function and its GITHUB_TOKEN (Supabase secret).", fails: "Prices and revenue use the last month loaded." },
  { id: "hssync", name: "HubSpot sync", short: "HubSpot to Atlas, daily", forWhat: "Customer and engaged flags, lifecycle stage, which contacts exist in HubSpot, PCN and ICB links, and keeping HubSpot PCN records in step with NHS ODS.", runs: "GitHub Action “HubSpot sync”, 08:30 UTC, or Run sync now (Data > Overview)",
    secrets: ["HUBSPOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_TOKEN"], where: "HUBSPOT_TOKEN in GitHub secrets (read companies, contacts, deals and the PCN/ICB objects; write PCN records). Run sync now uses the hubspot-sync-trigger function and its GITHUB_TOKEN (Supabase secret).", fails: "HubSpot columns go stale. The Slack summary and the activity log show failures." },
  { id: "hsactions", name: "HubSpot actions", short: "Atlas to HubSpot: companies, contacts, leads, deals, pricing", forWhat: "Creating companies, contacts, leads and deals, and pushing pricing and line items from a practice profile.", runs: "On demand, through the hubspot-push function",
    secrets: ["HUBSPOT_TOKEN"], where: "Supabase function secret, a separate copy from the GitHub one. Scopes: companies, contacts, deals, leads, line items, products, owners (read).", fails: "Create and push buttons show the HubSpot error. Use Test connection to see which scope is missing." },
  { id: "slack", name: "Slack", short: "Signals, failed runs and summaries", forWhat: "New signals, failed runs, patient-number and HubSpot sync summaries.", runs: "Sent by the three workflows above",
    secrets: ["SLACK_WEBHOOK_URL", "SLACK_BOT_TOKEN", "SLACK_CHANNEL", "SLACK_MODE"], where: "GitHub secrets and variables. SLACK_MODE is ON or DISABLED.", fails: "Nothing is posted. The data still updates." },
  { id: "supabase", name: "Supabase", short: "Database, sign-in and functions", forWhat: "Stores everything, signs people in, and runs the HubSpot and patient-number trigger functions.", runs: "Always on",
    secrets: ["SUPABASE_SERVICE_ROLE_KEY"], where: "Only in GitHub and function secrets, never in the page. Invited emails sit on the allowlist.", fails: "The dashboard cannot load or sign in." },
  { id: "github", name: "GitHub", short: "Hosting and every scheduled job", forWhat: "Hosts this dashboard (Pages) and runs every scheduled job and the Tests workflow.", runs: "Every push to main redeploys the page",
    secrets: ["GITHUB_TOKEN"], where: "A personal token held by the two trigger functions (Supabase secrets). Actions must stay enabled.", fails: "Scheduled jobs stop and the page stops updating." },
];
const CONN_TO_DO = ["Rotate the HubSpot token in both places together: the GitHub secret (sync) and the Supabase function secret (actions).", "When a HubSpot scope is added, run Test connection.", "If a feed shows an error, its last error is in the row. Check the matching GitHub secret and the latest run on Overview.", "Add any new integration to CONNECTIONS in js/data-tab.js so this list stays true."];
const connOpen = new Set();   // which connections the user has expanded (kept across re-renders); ones needing attention open themselves
async function renderConnections(runs, countRow) {
  const box = $("d-connections"); if (!box) return;
  const hrs = iso => iso ? (Date.now() - new Date(iso)) / 36e5 : Infinity, ago = iso => iso ? hsAgo(iso) : "never";
  const { data: sy } = await db.from("hubspot_activity").select("at,ok,summary").eq("kind", "sync_run").order("at", { ascending: false }).limit(1);
  const run = (runs || [])[0], sync = (sy || [])[0], st = run?.stats || {};
  const H = (tone, text) => ({ tone, text });
  const feed = (errKey, okText) => !run ? H("grey", "No runs yet") : st[errKey] ? H("red", "Error on the last run") : run.status === "failed" ? H("red", "Run failed") : hrs(run.finished_at || run.started_at) > 36 ? H("amber", "Last run " + ago(run.finished_at || run.started_at)) : H("green", okText);   // each feed reports its own error in the run stats
  const health = {
    radar: !run ? H("grey", "No runs yet") : run.status === "failed" ? H("red", "Last run failed " + ago(run.finished_at || run.started_at)) : hrs(run.finished_at || run.started_at) > 36 ? H("amber", "Last run " + ago(run.finished_at || run.started_at)) : H("green", "Ran " + ago(run.finished_at || run.started_at)),
    ods: feed("pcn_error", "OK on the last run"), cqc: feed("cqc_error", "OK on the last run"), jobs: feed("jobs_error", "OK on the last run"),
    oscar: feed("oscar_error", st.oscar_contacts != null ? Number(st.oscar_contacts).toLocaleString() + " contacts read" : "OK on the last run"),
    patients: countRow ? (hrs(countRow.updated_at) > 24 * 45 ? H("amber", "Loaded " + ago(countRow.updated_at)) : H("green", "NHS " + (countRow.data_month || "?") + ", loaded " + ago(countRow.updated_at))) : H("red", "Not loaded"),
    hssync: !sync ? H("grey", "Never synced") : !sync.ok ? H("red", "Last sync failed " + ago(sync.at)) : hrs(sync.at) > 36 ? H("amber", "Last sync " + ago(sync.at)) : H("green", "Synced " + ago(sync.at)),
    hsactions: connTestResult ? H(connTestResult.every(c => c.ok !== false) ? "green" : "amber", connTestResult.every(c => c.ok !== false) ? "Read access OK" : connTestResult.filter(c => c.ok === false).length + " read check(s) failed") : H("grey", "Not tested this session"),
  };
  const TONE = { green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", red: "bg-rose-100 text-rose-800", grey: "bg-slate-100 text-slate-600" };
  const DOT = { green: "bg-emerald-500", amber: "bg-amber-400", red: "bg-rose-500", grey: "bg-slate-300" };
  const field = (k, inner) => `<div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">${k}</div><div class="mt-0.5 text-sm text-slate-700">${inner}</div></div>`;
  box.innerHTML = `<style>#d-connections details>summary{list-style:none}#d-connections details>summary::-webkit-details-marker{display:none}#d-connections details[open] .conn-chev{transform:rotate(180deg)}</style>
    <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-bold">Connections <span class="text-xs font-normal text-slate-500">what feeds Atlas, and what to look after</span></h2>
      <button id="conn-toggle" class="text-xs font-semibold text-blue-600 hover:underline">Expand all</button></div>
    <div class="mt-3 space-y-2">${CONNECTIONS.map(c => { const h = health[c.id] || H("grey", "No automatic check"), open = connOpen.has(c.id) || h.tone === "red" || h.tone === "amber";
      return `<details data-conn="${c.id}" class="rounded-xl border ${h.tone === "red" ? "border-rose-300" : h.tone === "amber" ? "border-amber-300" : "border-slate-200"} bg-white" ${open ? "open" : ""}>
        <summary class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50"><span class="h-2.5 w-2.5 shrink-0 rounded-full ${DOT[h.tone]}"></span>
          <span class="min-w-0 flex-1"><span class="block truncate font-semibold">${esc(c.name)}</span><span class="block truncate text-xs text-slate-500">${esc(c.short)}</span></span>
          <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[h.tone]}">${esc(h.text)}</span>
          <svg class="conn-chev h-4 w-4 shrink-0 text-slate-400 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg></summary>
        <div class="grid gap-3 border-t border-slate-100 px-3 py-3 md:grid-cols-2">
          ${field("What it is for", esc(c.forWhat))}${field("Runs", esc(c.runs))}
          ${field("Needs", `${c.secrets.length ? `<div class="flex flex-wrap gap-1">${c.secrets.map(s => `<code class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">${esc(s)}</code>`).join("")}</div>` : '<div class="text-slate-600">No secret needed</div>'}<div class="mt-1 text-xs text-slate-500">${esc(c.where)}</div>`)}
          <div class="rounded-lg bg-amber-50 p-2 text-sm text-amber-900"><div class="text-[11px] font-semibold uppercase tracking-wider text-amber-700">If it fails</div><div class="mt-0.5">${esc(c.fails)}</div></div>
          ${c.errKey && st[c.errKey] ? `<div class="rounded-lg bg-rose-50 p-2 text-sm text-rose-900 md:col-span-2"><div class="text-[11px] font-semibold uppercase tracking-wider text-rose-700">Last error</div><div class="mt-0.5 break-words font-mono text-xs">${esc(String(st[c.errKey]).slice(0, 300))}</div></div>` : ""}
          ${c.id === "hsactions" ? `<div class="md:col-span-2"><button id="conn-test" class="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">Test connection</button><div id="conn-test-out" class="mt-2 text-sm" role="status"></div></div>` : ""}
        </div></details>`; }).join("")}</div>
    <details class="mt-3 rounded-xl border border-slate-200"><summary class="flex cursor-pointer items-center justify-between px-3 py-2.5 text-sm font-semibold hover:bg-slate-50">Looking after the connections<svg class="conn-chev h-4 w-4 text-slate-400 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg></summary>
      <ul class="list-disc space-y-0.5 border-t border-slate-100 px-8 py-3 text-sm text-slate-700">${CONN_TO_DO.map(t => `<li>${esc(t)}</li>`).join("")}</ul></details>`;
  box.querySelectorAll("details[data-conn]").forEach(el => el.addEventListener("toggle", () => { el.open ? connOpen.add(el.dataset.conn) : connOpen.delete(el.dataset.conn); }));
  const tg = $("conn-toggle"); tg.onclick = () => { const all = [...box.querySelectorAll("details[data-conn]")], open = all.some(e => !e.open); all.forEach(e => { e.open = open; }); tg.textContent = open ? "Collapse all" : "Expand all"; };
  $("conn-test").onclick = connTestHubspot;
  if (connTestResult) connTestShow();
}
let connTestResult = null;
function connTestShow() { const o = $("conn-test-out"); if (o) o.innerHTML = connTestResult.map(c => `<div class="flex gap-2 py-0.5"><span class="${c.ok === null ? "text-slate-400" : c.ok ? "text-emerald-700" : "text-rose-700"}">${c.ok === null ? "–" : c.ok ? "✓" : "✗"}</span><span>${esc(c.label)}${c.ok === true || !c.note ? "" : `<span class="block text-xs text-slate-500">${esc(c.note)}</span>`}</span></div>`).join("") + '<p class="mt-1 text-xs text-slate-500">Reads are tested here. Write permissions (create and push) are only proven by doing the action; check them under Private apps in HubSpot.</p>'; }
// Read-only checks through the same function the buttons use, so a failure here is what a button would hit.
async function connTestHubspot() {
  const btn = $("conn-test"), out = $("conn-test-out"); btn.disabled = true; btn.textContent = "Testing…"; out.textContent = "";
  const res = [], add = (label, ok, note = "") => res.push({ label, ok, note });
  const linkP = practices.find(p => p.hubspot_company_id && p.status === "Active");
  const { data: lk } = await db.from("hubspot_links").select("company_id,deal_id").limit(1);
  try {
    if (!linkP) add("Companies (read)", false, "No practice is linked to a HubSpot company yet. Run the sync first.");
    else {
      try { await hsCall({ action: "find", ods: linkP.ods_code, name: linkP.practice_name }); add("Companies (read)", true); } catch (e) { add("Companies (read)", false, e.message); }
      try { const h = await hsCall({ action: "hub", companyId: linkP.hubspot_company_id }); add("Contacts and deals (read)", true); add("Leads (read)", h.leads !== null, "Add the crm.objects.leads.read scope to the HubSpot token."); } catch (e) { add("Contacts and deals (read)", false, e.message); }
      try { const pre = await hsCall({ action: "deal_prefill", companyId: linkP.hubspot_company_id, noContacts: true }); add("Deal pipelines (read)", pre.pipelines.length > 0); add("Owners (read)", !!pre.owners, "Add the crm.objects.owners.read scope."); } catch (e) { add("Deal pipelines and owners (read)", false, e.message); }
    }
    if (lk && lk[0]) { try { const r = await hsCall({ action: "read", companyId: lk[0].company_id, dealId: lk[0].deal_id }); add("Line items (read)", r.lineItems !== null, "Add the crm.objects.line_items.read scope (and e-commerce)."); } catch (e) { add("Line items (read)", false, e.message); } }
    else add("Line items (read)", null, "Not tested: no practice has a linked deal yet.");
  } finally { connTestResult = res; btn.disabled = false; btn.textContent = "Test connection"; connTestShow(); renderConnections(window.__lastRuns, window.__lastCount); }
}

/* ---------- Data tab: sub-tabs ---------- */
let dataSub = "overview";
function setDataSub(which) {
  dataSub = which;
  for (const k of ["overview", "sources", "audit", "signals", "pricing"]) $("dp-" + k).classList.toggle("hidden", k !== which);
  if (which === "audit") renderAudit();
  $("data-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.d === which ? "bg-white shadow-sm" : "text-slate-500"));
  stateToUrl();
}
$("data-sub").querySelectorAll("button").forEach(b => b.onclick = () => setDataSub(b.dataset.d));

/* ---------- pricing sync: read rates from CSV exports of the pricing spreadsheet ---------- */
const num = t => { const n = parseFloat(String(t || "").replace(/[£,%\s]/g, "")); return Number.isFinite(n) ? n : null; };
const frac = t => { const n = num(t); return n == null ? null : /%/.test(t) ? n / 100 : n; };
const SHEET_SETTINGS = [["list_price_per_patient", /^(?!.*\bsar\b).*annual (sub )?list price/i, num], ["monthly_list_price_per_patient", /^(?!.*\bsar\b).*monthly (sub )?list price/i, num],
  ["list_price_sar_per_patient", /\bsar\b.*annual (sub )?list price/i, num], ["monthly_list_price_sar_per_patient", /\bsar\b.*monthly (sub )?list price/i, num], ["vat_rate", /vat rate/i, frac],
  ["price_floor_per_patient", /margin floor/i, num], ["term_discount_2yr", /2-yr commitment disc/i, frac], ["term_discount_3yr", /3-yr commitment disc/i, frac]];
const SHEET_ROUTES = [["practice", /single practice/i], ["pcn", /primary care network|\bpcn\b/i], ["icb", /integrated care board|\bicb\b/i]];
// Takes the parsed rows of one or more tabs (the Pricing-Discount-Model tab and/or the Multi-Year-Matrix tab) and returns the values it can find.
function readPricingSheet(tabs) {
  const settings = {}, tiers = {};
  for (const rows of tabs) {
    let route = null, cols = null;
    for (const r of rows) {
      const cells = r.map(c => (c || "").trim());
      cells.forEach((c, i) => {
        for (const [key, re, conv] of SHEET_SETTINGS) if (re.test(c) && !(key in settings)) { const v = conv(cells.slice(i + 1).find(x => x !== "")); if (v != null) settings[key] = v; }
      });
      const head = cells[0] || "";
      if (/^\d\.\s/.test(head) && /schedule/i.test(head)) { route = (SHEET_ROUTES.find(([, re]) => re.test(head)) || [])[0] || null; cols = null; continue; }
      const low = cells.map(c => c.toLowerCase());
      if (low.includes("tier") && low.some(c => c.includes("patient threshold"))) { cols = { th: low.findIndex(c => c.includes("patient threshold")), size: low.findIndex(c => c.includes("size discount")), speed: low.findIndex(c => c.includes("speed discount")) }; continue; }
      const m = /^Tier (\d)$/.exec(head);
      if (route && cols && m) {
        const size = frac(cells[cols.size]), speed = frac(cells[cols.speed]), th = num(cells[cols.th]);
        if (size != null && speed != null && th != null) tiers[route + m[1]] = { route, tier: Number(m[1]), threshold: th, size_discount: size, speed_discount: speed };
      }
    }
  }
  return { settings, tiers: Object.values(tiers) };
}
function pricingChanges(found) {
  const out = [];
  for (const [k, v] of Object.entries(found.settings)) { const cur = cfgSettings[k] ? Number(cfgSettings[k].value) : null; if (cur != null && Math.abs(cur - v) > 1e-9) out.push({ what: cfgSettings[k]?.description || k, from: cur, to: v, kind: /price/.test(k) ? "gbp" : "pct" }); }
  for (const t of found.tiers) {
    const cur = cfgTiers.find(x => x.route === t.route && x.tier === t.tier); if (!cur) continue;
    for (const [f, label] of [["threshold", "from (patients)"], ["size_discount", "size discount"], ["speed_discount", "speed discount"]])
      if (Math.abs(Number(cur[f]) - t[f]) > 1e-9) out.push({ what: `${t.route} tier ${t.tier}: ${label}`, from: Number(cur[f]), to: t[f], kind: f === "threshold" ? "n" : "pct" });
  }
  return out;
}
let pricingFound = null;
async function readPricingFiles(files) {
  const msg = $("ps-msg"), box = $("ps-preview"); pricingFound = null; box.innerHTML = ""; $("ps-apply").classList.add("hidden");
  try {
    const tabs = []; for (const f of files) tabs.push(parseCsv((await f.text()).replace(/^\uFEFF/, "")));
    const found = readPricingSheet(tabs);
    if (!Object.keys(found.settings).length && !found.tiers.length) throw new Error("No pricing values found. Export the Pricing-Discount-Model tab (and Multi-Year-Matrix for term discounts) as CSV.");
    const ch = pricingChanges(found), fmt = (v, k) => v == null ? "none" : k === "gbp" ? "£" + rate3(v) : k === "pct" ? pct(v) : v.toLocaleString();
    msg.textContent = `Read ${Object.keys(found.settings).length} settings and ${found.tiers.length} tier rows. ${ch.length ? ch.length + " differ from what the dashboard holds." : "Everything already matches."}`;
    box.innerHTML = ch.length ? `<table class="mt-2 w-full text-sm"><thead class="text-xs uppercase tracking-wider text-slate-500"><tr><th class="text-left font-medium py-1">Value</th><th class="text-right font-medium">Now</th><th class="text-right font-medium">Spreadsheet</th></tr></thead><tbody>${ch.map(c => `<tr class="border-t border-slate-100"><td class="py-1">${esc(c.what)}</td><td class="text-right font-mono text-slate-500">${esc(fmt(c.from, c.kind))}</td><td class="text-right font-mono font-semibold">${esc(fmt(c.to, c.kind))}</td></tr>`).join("")}</tbody></table>` : "";
    if (ch.length) { pricingFound = found; $("ps-apply").classList.remove("hidden"); $("ps-apply").textContent = `Apply ${ch.length} change${ch.length > 1 ? "s" : ""}`; }
  } catch (e) { msg.textContent = e.message || String(e); }
}
$("ps-file").addEventListener("change", e => { if (e.target.files.length) readPricingFiles([...e.target.files]); e.target.value = ""; });
$("ps-apply").addEventListener("click", async () => {
  if (!pricingFound) return; const btn = $("ps-apply"); btn.disabled = true; $("ps-msg").textContent = "Applying…";
  const { data, error } = await db.rpc("sync_pricing", { p_settings: pricingFound.settings, p_tiers: pricingFound.tiers });
  btn.disabled = false;
  if (error) { $("ps-msg").textContent = "Could not apply: " + (error.message || error); return; }
  pricingFound = null; btn.classList.add("hidden"); $("ps-preview").innerHTML = "";
  $("ps-msg").textContent = `Updated ${data?.settings_changed ?? 0} settings and ${data?.tiers_changed ?? 0} tier rows. Reloading prices…`;
  await loadConfig(); await loadPractices(); applyFilters(); loadNetworks(); renderRateCard(); $("ps-msg").textContent = $("ps-msg").textContent.replace("Reloading prices…", "Prices reloaded.");
});

/* ---------- rate card: one table per price route ---------- */
const ROUTES = [
  ["practice", "Single practices", "One practice signs on its own."],
  ["pcn", "PCNs / clusters", "Every practice in a PCN (or Scottish / Welsh cluster) signs together; tier is set by the combined list size."],
  ["group", "Provider groups", "All practices run by one CQC provider sign together (for example Modality). Starts from the PCN schedule; edit to differ."],
  ["federation", "Federations", "All practices in a federation sign together. Starts from the PCN schedule; edit to differ."]];
function renderRateCard() {
  const list = Number(cfgSettings.list_price_per_patient?.value || 0);
  const sarList = Number(cfgSettings.list_price_sar_per_patient?.value || 0), mList = Number(cfgSettings.monthly_list_price_per_patient?.value || 0), mSar = Number(cfgSettings.monthly_list_price_sar_per_patient?.value || 0);
  const settings = Object.values(cfgSettings).filter(x => !/^(monthly_)?list_price_(sar_)?per_patient$/.test(x.key));
  const table = r => {
    const rows = cfgTiers.filter(t => t.route === r).sort((a, b) => a.tier - b.tier);
    if (!rows.length) return '<p class="text-sm italic text-slate-500">No tiers configured for this route.</p>';
    return `<table class="w-full text-sm"><thead class="text-xs uppercase tracking-wider text-slate-500"><tr><th class="text-left py-1.5 font-medium">Tier</th><th class="text-right font-medium">From (patients)</th><th class="text-right font-medium">Size discount</th><th class="text-right font-medium">All reports</th><th class="text-right font-medium">SAR only</th><th class="text-right font-medium">All reports + ${pct(rows[0].speed_discount)} speed</th></tr></thead><tbody>` +
      rows.map(t => { const p = list * (1 - Number(t.size_discount)), floor = Number(cfgSettings.price_floor_per_patient?.value || 0), y1 = Math.max(floor, list * (1 - Number(t.size_discount) - Number(t.speed_discount))); return `<tr class="border-t border-slate-100"><td class="py-1.5">${chip("T" + t.tier, TIER_CLS["Tier " + t.tier] || "")} ${esc(t.label)}</td><td class="text-right font-mono">${Number(t.threshold) ? Number(t.threshold).toLocaleString() + "+" : "any size"}</td>
        <td class="text-right">${pct(t.size_discount)}</td><td class="text-right font-mono font-semibold">£${rate3(p)}</td><td class="text-right font-mono">£${(sarList * (1 - Number(t.size_discount))).toFixed(4)}</td><td class="text-right font-mono text-slate-600">£${rate3(y1)}</td></tr>`; }).join("") + "</tbody></table>";
  };
  $("rev-config").innerHTML = `<div class="bg-white rounded-xl border border-slate-200 p-4">
      <h2 class="font-bold">How prices are worked out</h2>
      <div class="mt-2 grid gap-3 md:grid-cols-4 text-sm">
        ${[["1", "List price", `Per patient per month. All reports: £${rate3(list)} annual, £${rate3(mList)} monthly. SAR only: £${rate3(sarList)} annual, £${rate3(mSar)} monthly.`], ["2", "Discounts add together", "Annual plans only; monthly plans pay the list price. Size discount (by tier), plus a term discount for 2 or 3-year commitments, plus an optional speed discount that applies to every year of the term and ends at renewal. The percentages are summed and taken off the list price."], ["3", "Price floor", "On All reports annual plans the price never drops below the floor price per patient, whatever the discounts add up to. The floor does not apply to SAR only."], ["4", "× patients × 12", "Annual revenue = price per patient per month × registered patients × 12. Switch product and billing on any profile's price card."]]
          .map(([n, h, t]) => `<div class="flex gap-2"><span class="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-800 text-xs font-bold flex items-center justify-center">${n}</span><div><div class="font-semibold">${h}</div><div class="text-xs text-slate-500">${t}</div></div></div>`).join("")}
      </div>
      <p class="mt-3 text-xs text-slate-500">The routes below are alternatives, not additive. Rates live in the <code>pricing_tiers</code> and <code>pricing_settings</code> tables (Supabase > Table Editor); changes show here and in every profile straight away.</p>
    </div>` + `<div class="grid gap-4 lg:grid-cols-2">` + ROUTES.map(([r, name, blurb]) => `<div class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-bold">${name}</h3><p class="text-xs text-slate-500 mb-2">${blurb}</p>${table(r)}</div>`).join("") + `</div>` +
    (settings.length ? `<div class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-bold mb-1">Other settings</h3>${settings.map(x => `<div class="flex justify-between border-t border-slate-100 py-1 text-sm first:border-0"><span class="text-slate-500">${esc(x.description || x.key)}</span><span class="font-mono">${esc(x.value)}</span></div>`).join("")}</div>` : "");
}

/* ---------- patient counts (upload / runner) ---------- */
/* parser:start */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function monthFromText(t) {
  const m = /(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\s*(\d{4})/.exec(t || "");
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}`;
  const iso = /(\d{4})-(\d{2})-\d{2}/.exec(t || "");
  return iso ? `${iso[1]}-${iso[2]}` : null;
}
function readPatientFile(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows[0] || []).map(h => h.trim().toUpperCase());
  const col = n => head.indexOf(n);
  const iCode = col("CODE"), iN = col("NUMBER_OF_PATIENTS"), iType = col("TYPE"), iSex = col("SEX"), iAge = col("AGE"), iDate = col("EXTRACT_DATE");
  if (iCode < 0 || iN < 0) throw new Error("This does not look like gp-reg-pat-prac-all.csv (no CODE / NUMBER_OF_PATIENTS columns).");
  const totals = new Map(); let month = null;
  for (let r = 1; r < rows.length; r++) {
    const x = rows[r];
    if (x.length <= Math.max(iCode, iN)) continue;
    if (iType >= 0 && x[iType].trim().toUpperCase() !== "GP") continue;
    if (iSex >= 0 && x[iSex].trim().toUpperCase() !== "ALL") continue;
    if (iAge >= 0 && x[iAge].trim().toUpperCase() !== "ALL") continue;
    const code = x[iCode].trim().toUpperCase(), n = parseInt(x[iN], 10);
    if (!/^[A-Z][0-9]{5}$/.test(code) || !Number.isFinite(n) || n < 0) continue;
    totals.set(code, (totals.get(code) || 0) + n);
    if (!month && iDate >= 0) month = monthFromText(x[iDate]);
  }
  if (totals.size < 5000) throw new Error(`Only ${totals.size} practices found: wrong file? Use the practice totals file, gp-reg-pat-prac-all.csv.`);
  return { totals, month };
}
/* parser:end */

let pcTimer = null;
async function latestCountRow() {
  const { data } = await db.from("patient_counts").select("data_month,updated_at").order("updated_at", { ascending: false }).limit(1);
  return data && data[0];
}
async function reloadAfterCounts() { await loadPractices(); applyFilters(); loadNetworks(); renderData(); }
/* devolved nations */
const SCOT_HB = { S08000015: "NHS Ayrshire and Arran", S08000016: "NHS Borders", S08000017: "NHS Dumfries and Galloway", S08000019: "NHS Forth Valley", S08000020: "NHS Grampian",
  S08000022: "NHS Highland", S08000024: "NHS Lothian", S08000025: "NHS Orkney", S08000026: "NHS Shetland", S08000028: "NHS Western Isles", S08000029: "NHS Fife",
  S08000030: "NHS Tayside", S08000031: "NHS Greater Glasgow and Clyde", S08000032: "NHS Lanarkshire" };
const titleCase = t => (t || "").trim().toLowerCase().replace(/(^|[\s(\-/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const slug = t => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function readDevolvedFile(text, fileName) {
  const rows = parseCsv(text.replace(/^\uFEFF/, "")), head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const ix = n => head.indexOf(n.toLowerCase()), out = [], seen = new Set();
  const cell = (x, i) => i >= 0 && x[i] != null ? x[i].trim() : "";
  if (ix("PracticeCode") >= 0 && ix("GPPracticeName") >= 0) {
    const [c, nm, ls, pc, hb, cl] = ["PracticeCode", "GPPracticeName", "PracticeListSize", "Postcode", "HB", "GPCluster"].map(ix), addr = ["AddressLine2", "AddressLine3", "AddressLine4"].map(ix);
    for (const x of rows.slice(1)) {
      const raw = cell(x, c).replace(/\D/g, ""); if (!raw || raw.length > 5) continue;
      const code = "S" + raw.padStart(5, "0"); if (seen.has(code)) continue; seen.add(code);
      const cluster = cell(x, cl), town = addr.map(i => cell(x, i)).filter(Boolean).pop() || "";
      out.push({ code, name: cell(x, nm), postcode: cell(x, pc), town: titleCase(town), patients: parseInt(cell(x, ls), 10) || null,
        net_code: cluster ? "SC-" + slug(cluster) : null, net_name: cluster || null, icb: SCOT_HB[cell(x, hb)] || null });
    }
    const m = /(20\d{2})(\d{2})\d{2}/.exec(fileName || "");
    if (out.length < 500) throw new Error(`Only ${out.length} Scottish practices found: wrong file?`);
    return { kind: "scotland", country: "Scotland", rows: out, month: m ? `${m[1]}-${m[2]}` : null };
  }
  if (ix("Practice_reference") >= 0 && ix("Data values_sort") >= 0 && ix("Residence_reference") >= 0) {   // StatsWales: patients by practice (rows for totals, nations and health boards are skipped)
    const [pr, pn, ph, rr, v, dt, ds] = ["Practice_reference", "Practice", "Practice_hierarchy", "Residence_reference", "Data values_sort", "Date", "Date_sort"].map(ix);
    const boards = new Map(), per = new Map(); let latest = -1;
    for (const x of rows.slice(1)) {
      const ref = cell(x, pr).toUpperCase();
      if (/^7A\d$/.test(ref)) boards.set(ref, cell(x, pn));
      if (cell(x, rr) !== "P" || !/^W[0-9]{5}$/.test(ref)) continue;   // "All residence" only; real practice codes only
      const t = Number(cell(x, ds)), n = parseInt(cell(x, v), 10); if (!Number.isFinite(t) || !Number.isFinite(n)) continue;
      latest = Math.max(latest, t); (per.get(t) || per.set(t, []).get(t)).push({ code: ref, name: cell(x, pn), hb: cell(x, ph), n, date: cell(x, dt) });
    }
    const q = per.get(latest) || [], m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(q[0] ? q[0].date : "");
    for (const r of q) if (!seen.has(r.code)) { seen.add(r.code); out.push({ code: r.code, name: titleCase(r.name), postcode: "", town: "", patients: r.n, net_code: null, net_name: null, icb: boards.get(r.hb) || null }); }
    if (out.length < 300) throw new Error(`Only ${out.length} Welsh practices found in the latest quarter: wrong file?`);
    return { kind: "wales-sizes", country: "Wales", rows: out, month: m ? `${m[3]}-${m[2]}` : null };
  }
  if (ix("PracticeId") >= 0 && ix("ClusterID") >= 0) {
    const [id, st, tn, pc, cl, per] = ["PracticeId", "Street", "Posttown", "Postcode", "ClusterID", "Period"].map(ix); let month = null;
    for (const x of rows.slice(1)) {
      const code = cell(x, id).toUpperCase(); if (!/^W[0-9]{5}$/.test(code) || seen.has(code)) continue; seen.add(code);
      const cluster = cell(x, cl);
      out.push({ code, name: titleCase(cell(x, st)), postcode: cell(x, pc), town: titleCase(cell(x, tn)), patients: null,
        net_code: cluster ? "WC" + cluster : null, net_name: cluster ? "Wales cluster " + cluster : null, icb: null });
      if (!month && /^\d{6}$/.test(cell(x, per))) month = cell(x, per).slice(0, 4) + "-" + cell(x, per).slice(4);
    }
    if (out.length < 300) throw new Error(`Only ${out.length} Welsh practices found: wrong file?`);
    return { kind: "wales-clusters", country: "Wales", rows: out, month };
  }
  throw new Error("Not recognised. Expected the Scotland practice contact details CSV (PracticeCode, GPPracticeName…) , the Wales practice data CSV (PracticeId, ClusterID…) or the StatsWales patients-by-practice CSV.");
}
function readDevolved(text, name, expect) {
  const r = readDevolvedFile(text, name);
  if (r.kind !== expect) throw new Error(`This is the ${UPLOAD_KIND[r.kind]} file: use that box instead.`);
  return r;
}

/* ---------- data file uploads ----------
   One entry per source file. To support a new file: add an entry here (and, if needed, a parser above and a database load function).
   parse(text, fileName) -> { count, month, payload }   throws a readable Error if the file is the wrong one
   load(payload, month, say) -> summary text            say(text) shows progress
   status() -> text shown under the box (what is currently in the database) */
const UPLOAD_KIND = { scotland: "Scotland practices", "wales-clusters": "Wales practices and clusters", "wales-sizes": "Wales patient numbers (StatsWales)" };
const latestMonth = list => list.map(p => p.data_month).filter(Boolean).sort().pop() || "?";
async function loadDevolvedRows(country, rows, month, say, create = true) {
  let stored = 0, added = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    say(`Loading ${Math.min(i + 1000, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`);
    const { data, error } = await db.rpc("load_devolved", { p_country: country, p_month: month, p_create: create, p_rows: rows.slice(i, i + 1000) });
    if (error) throw error; stored += data.stored; added += data.new;
  }
  return `${stored.toLocaleString()} practices processed (${added.toLocaleString()} new)`;
}
const UPLOADS = [
  { id: "eng", title: "England: patient counts", gives: "List size for every English practice, which drives tiers and ARR", file: "gp-reg-pat-prac-all.csv", cadence: "monthly",
    links: [["https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice", "NHS Digital: Patients registered at a GP practice (latest month)"]],
    parse: t => { const r = readPatientFile(t); return { count: r.totals.size, month: r.month, payload: r }; },
    load: async (r, month, say) => {
      const rows = [...r.totals].map(([code, n]) => ({ code, n })); let stored = 0, updated = 0;
      for (let i = 0; i < rows.length; i += 1000) {
        say(`Loading ${Math.min(i + 1000, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`);
        const { data, error } = await db.rpc("load_patient_counts", { p_month: month, p_rows: rows.slice(i, i + 1000) });
        if (error) throw error; stored += data.stored; updated += data.practices_updated;
      }
      return `${stored.toLocaleString()} counts stored, ${updated.toLocaleString()} practices updated`;
    },
    status: () => { const l = practices.filter(p => (p.country || "England") === "England" && p.total_patients > 0); return `${l.length.toLocaleString()} English practices have list sizes (data month ${latestMonth(l)})`; } },
  { id: "sco", title: "Scotland: practices, list sizes, GP clusters", gives: "Practices, list sizes, GP clusters (PCN equivalent) and health boards (ICB equivalent)", file: "…practice_contact_details_YYYYMMDD_opendata.csv", cadence: "quarterly",
    links: [["https://www.opendata.nhs.scot/dataset/gp-practice-contact-details-and-list-sizes", "Public Health Scotland open data: GP practice contact details and list sizes"]],
    parse: (t, n) => { const r = readDevolved(t, n, "scotland"); return { count: r.rows.length, month: r.month, payload: r }; },
    load: (r, month, say) => loadDevolvedRows("Scotland", r.rows, month, say),
    status: () => { const l = practices.filter(p => p.country === "Scotland"); return l.length ? `${l.length.toLocaleString()} Scottish practices loaded (data month ${latestMonth(l)})` : "Nothing loaded yet"; } },
  { id: "wal", title: "Wales: practices, clusters, list sizes", multiple: true, gives: "Two files, loaded together or separately: the cluster file gives each practice's cluster (PCN equivalent); the StatsWales patients file gives list sizes and health boards",
    file: "Wales_practice_data_….csv (PracticeId, ClusterID)  +  patients-registered-to-general-practices-in-wales-…-by-practice-and-country-of-residence-….csv", cadence: "quarterly",
    links: [["https://nwssp.nhs.wales/ourservices/primary-care-services/general-information/data-and-publications/gp-practice-analysis/", "NWSSP: GP practice analysis (clusters)"],
            ["https://stats.gov.wales/en-GB/75dcbf1e-9b43-4d9a-90b1-f02affe80bc2", "StatsWales: patients registered by practice (download as CSV)"]],
    parse: (t, n) => { const r = readDevolvedFile(t, n); if (r.country !== "Wales") throw new Error(`${n}: this is the ${r.country} file: use the ${r.country} box instead.`);
      return { count: r.rows.length, month: r.month, label: r.kind === "wales-sizes" ? "patient numbers and health boards" : "clusters", payload: r }; },
    load: async (r, month, say) => loadDevolvedRows("Wales", r.rows, month, say, r.kind === "wales-sizes"),   // the cluster file lists branch sites, so it may only update practices we already hold
    status: () => { const w = practices.filter(p => p.country === "Wales"); return w.length ? `${w.filter(p => p.status === "Active").length.toLocaleString()} Welsh practices: ${w.filter(p => p.network_locked).length.toLocaleString()} with a cluster, ${w.filter(p => p.total_patients > 0).length.toLocaleString()} with list sizes (data month ${latestMonth(w.filter(p => p.total_patients > 0))})` : "Nothing loaded yet"; } },
];
function renderUploads() {
  const box = $("uploads");
  if (!box.children.length) {
    box.innerHTML = UPLOADS.map(u => `<details id="up-${u.id}" class="dtile rounded-xl border border-slate-200 bg-white">
      <summary class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50"><span class="up-dot h-2.5 w-2.5 shrink-0 rounded-full bg-slate-300"></span>
        <span class="min-w-0 flex-1"><span class="block truncate font-semibold">${esc(u.title)}</span><span class="up-status block truncate text-xs text-slate-500"></span></span>
        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">${esc(u.cadence)}</span>
        <svg class="dchev h-4 w-4 shrink-0 text-slate-400 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg></summary>
      <div class="grid gap-3 border-t border-slate-100 px-3 py-3 md:grid-cols-2">
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">What it gives</div><p class="mt-0.5 text-sm text-slate-700">${esc(u.gives)}</p></div>
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Download</div><p class="mt-0.5 text-sm">${u.links.map(([h, l]) => `<a class="text-blue-600 hover:underline" target="_blank" rel="noopener" href="${esc(h)}">${esc(l)}</a>`).join("<br>")}<span class="mt-0.5 block text-xs text-slate-500">File${u.multiple ? "s" : ""}: ${esc(u.file)}</span></p></div>
        <div class="md:col-span-2 rounded-lg bg-slate-50 p-2"><div class="flex flex-wrap items-center gap-2"><input type="file" accept=".csv,text/csv" ${u.multiple ? "multiple" : ""} class="up-file max-w-[22rem] text-xs"><input type="month" class="up-month rounded border border-slate-300 bg-white px-2 py-1 text-xs"><button disabled class="up-load rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40">Load</button></div>
          <p class="up-msg mt-1 min-h-[1rem] whitespace-pre-line text-xs text-slate-600"></p></div>
      </div></details>`).join("");
    for (const u of UPLOADS) {
      const el = $("up-" + u.id), q = c => el.querySelector(c), say = t => { q(".up-msg").textContent = t; }; let parsed = [];
      q(".up-file").addEventListener("change", async e => {
        const files = [...e.target.files]; parsed = []; q(".up-load").disabled = true; if (!files.length) return; el.open = true;
        const lines = []; let ok = true;
        for (const f of files) {
          if (f.size > 60 * 1024 * 1024) { lines.push(`${f.name}: too large, check you have the right file.`); ok = false; continue; }
          try { const p = u.parse(await f.text(), f.name); parsed.push(p); lines.push(`${f.name}: ${p.label ? p.label + ", " : ""}${p.count.toLocaleString()} practices${p.month ? " (" + p.month + ")" : " (month not found: check the month box)"}`); }
          catch (err) { lines.push(err.message); ok = false; }
        }
        if (parsed.length) q(".up-month").value = parsed.find(p => p.month)?.month || new Date().toISOString().slice(0, 7);
        say(lines.join("\n") + (ok ? "\nPress Load." : "\nFix the file(s) above, then choose again."));
        q(".up-load").disabled = !ok;
      });
      q(".up-load").addEventListener("click", async () => {
        const month = q(".up-month").value;
        if (!parsed.length || !/^\d{4}-\d{2}$/.test(month)) { say("Choose a file and a month first."); return; }
        q(".up-load").disabled = true; const done = [];
        try {
          for (const p of [...parsed].sort((a, b) => (b.payload.kind === "wales-sizes") - (a.payload.kind === "wales-sizes"))) done.push(await u.load(p.payload, p.month || month, t => say(t)));
          parsed = []; q(".up-file").value = ""; await reloadAfterCounts(); say("Done: " + done.join("; ") + ".");
        } catch (err) { say("Load failed: " + (err.message || err)); q(".up-load").disabled = false; }
      });
    }
  }
  for (const u of UPLOADS) { const el = $("up-" + u.id), s = u.status(); el.querySelector(".up-status").textContent = "In the database: " + s; el.querySelector(".up-dot").className = "up-dot h-2.5 w-2.5 shrink-0 rounded-full " + (/nothing loaded/i.test(s) ? "bg-slate-300" : "bg-emerald-500"); }
}
$("pc-run").addEventListener("click", async () => {
  const btn = $("pc-run"), msg = $("pc-run-msg");
  btn.disabled = true; msg.textContent = "Sending request…";
  const before = await latestCountRow();
  const { data, error } = await db.functions.invoke("trigger-patient-load");
  if (error || (data && data.error)) {
    let detail = (data && data.error) || error.message;
    try { const body = await error.context.json(); detail = body.error || detail; } catch (_) {}
    msg.textContent = "Could not start: " + detail + " (use the England upload box instead)"; btn.disabled = false; return;
  }
  msg.textContent = "Started. Waiting for the office PC runner… this updates when it finishes.";
  const t0 = Date.now(); clearInterval(pcTimer);
  pcTimer = setInterval(async () => {
    const row = await latestCountRow();
    if (row && (!before || row.updated_at !== before.updated_at)) { clearInterval(pcTimer); await reloadAfterCounts(); msg.textContent = "Done: patient counts updated."; btn.disabled = false; }
    else if (Date.now() - t0 > 10 * 60 * 1000) { clearInterval(pcTimer); msg.textContent = "Still waiting after 10 minutes: is the runner on? The request stays queued. Or use the England upload box."; btn.disabled = false; }
  }, 10000);
});


/* ---------- Data > HubSpot audit: HubSpot companies that do not match the NHS practice list (rebuilt by every HubSpot sync) ---------- */
const AUDIT_ISSUES = {
  closed_practice: { label: "Closed or merged practice", tone: "bg-rose-100 text-rose-800", help: "The NHS shows this practice as closed or merged, but HubSpot still has a company for it." },
  name_mismatch: { label: "Name differs", tone: "bg-amber-100 text-amber-800", help: "Same ODS code, but the HubSpot company name and the NHS practice name look like different places. One of them is probably on the wrong code." },
  duplicate_code: { label: "Code on several companies", tone: "bg-violet-100 text-violet-800", help: "More than one HubSpot company carries the same GP ODS Code. Merge or correct them." },
  unknown_code: { label: "Not a GP practice code", tone: "bg-slate-200 text-slate-700", help: "The code is not a GP practice in the NHS list (a typo, a PCN or hospital code, or a practice that no longer exists)." },
  pcn_no_code: { label: "PCN record has no code", group: "net", tone: "bg-amber-100 text-amber-800", help: "A HubSpot PCN record with no ODS code cannot be linked to the NHS PCN. Where one NHS PCN has the same name the suggested code is shown. Until it has a code, the sync will not create a second record for that PCN." },
  pcn_duplicate: { label: "PCN code on several records", group: "net", tone: "bg-violet-100 text-violet-800", help: "More than one HubSpot PCN record carries the same code. Merge them." },
  pcn_unknown_code: { label: "PCN code not in NHS list", group: "net", tone: "bg-slate-200 text-slate-700", help: "The code is not in the NHS PCN list: a typo, or a PCN that no longer exists." },
  pcn_name_mismatch: { label: "PCN name differs", group: "net", tone: "bg-amber-100 text-amber-800", help: "Same code, but the HubSpot PCN name and the NHS name look different." },
  pcn_association: { label: "Practice on another PCN too", group: "net", tone: "bg-rose-100 text-rose-800", help: "This practice's company is associated with a PCN record other than its own NHS PCN. The sync only adds associations, so the wrong one stays until someone removes it in HubSpot." },
  icb_issue: { label: "ICB records", group: "net", tone: "bg-sky-100 text-sky-800", help: "An ICB record with no ODS code, or two records sharing the same code or name. Atlas matches ICBs by name, so duplicates make the match unreliable." },
};
const AUDIT_OBJECT = { company: "0-2", pcn: "2-203659326", icb: "2-203659324" };
let auditRows = [], auditIssue = "all", auditQuery = "", auditShown = 100;
async function renderAudit() {
  const box = $("d-audit"); if (!box.innerHTML) box.innerHTML = '<p class="text-sm text-slate-500">Loading…</p>';
  try { auditRows = await fetchAll("hubspot_audit", "*", "id"); } catch (e) { box.innerHTML = `<p class="text-sm text-rose-700">${esc(e.message || e)}</p>`; return; }
  const when = auditRows.reduce((m, r) => (r.found_at > m ? r.found_at : m), "");
  const count = k => auditRows.filter(r => r.issue === k).length;
  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-bold">HubSpot audit <span class="text-xs font-normal text-slate-500">HubSpot companies that do not match the NHS practice list${when ? ", as of the sync " + hsAgo(when) : ""}</span></h2>
      <div class="flex items-center gap-2"><input id="au-q" value="${esc(auditQuery)}" placeholder="Search name or code" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Search the audit"><button id="au-csv" class="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold hover:bg-slate-50">Download CSV</button></div></div>
    <div class="mt-3"><button data-au="all" class="rounded-xl border px-3 py-2 text-left ${auditIssue === "all" ? "border-slate-500 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}"><span class="text-xs uppercase tracking-wider text-slate-500">All issues</span> <span class="ml-2 text-lg font-bold">${auditRows.length.toLocaleString()}</span></button></div>
    ${[["Practice companies", null], ["PCN, ICB and association records", "net"]].map(([title, grp]) => `<div class="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">${title}</div>
      <div class="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">${Object.entries(AUDIT_ISSUES).filter(([, v]) => (v.group || null) === grp).map(([k, v]) => `<button data-au="${k}" class="rounded-xl border p-3 text-left ${auditIssue === k ? "border-slate-500 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}"><div class="text-xs leading-tight text-slate-500">${esc(v.label)}</div><div class="text-xl font-bold">${count(k).toLocaleString()}</div></button>`).join("")}</div>`).join("")}
    <p id="au-help" class="mt-2 text-xs text-slate-500">${auditIssue === "all" ? "Pick a tile to see what each issue means." : esc(AUDIT_ISSUES[auditIssue].help)}</p>
    <div id="au-list" class="mt-2"></div>`;
  box.querySelectorAll("[data-au]").forEach(b => b.onclick = () => { auditIssue = b.dataset.au; auditShown = 100; renderAudit(); });
  $("au-q").oninput = e => { auditQuery = e.target.value; auditShown = 100; auditList(); };
  $("au-csv").onclick = () => downloadCsv("Lalu_HubSpot_audit", ["Issue", "HubSpot company", "HubSpot company id", "ODS code", "NHS name", "NHS status", "Detail", "HubSpot object"], auditFiltered().map(r => [AUDIT_ISSUES[r.issue]?.label || r.issue, r.company_name, r.company_id, r.ods_code, r.nhs_name, r.nhs_status, r.detail, r.object_type || "company"]));
  auditList();
}
function auditFiltered() {
  const q = auditQuery.trim().toLowerCase();
  return auditRows.filter(r => (auditIssue === "all" || r.issue === auditIssue) && (!q || [r.company_name, r.ods_code, r.nhs_name].some(v => (v || "").toLowerCase().includes(q))))
    .sort((a, b) => Object.keys(AUDIT_ISSUES).indexOf(a.issue) - Object.keys(AUDIT_ISSUES).indexOf(b.issue) || (a.company_name || "").localeCompare(b.company_name || ""));
}
function auditList() {
  const box = $("au-list"); if (!box) return;
  if (!auditRows.length) { box.innerHTML = '<p class="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No mismatches recorded. The list is rebuilt by each HubSpot sync (daily 08:30 UTC, or Run sync now on Overview). If it has never run since this tab was added, run it once.</p>'; return; }
  const rows = auditFiltered();
  box.innerHTML = rows.slice(0, auditShown).map(r => { const iss = AUDIT_ISSUES[r.issue] || { label: r.issue, tone: "bg-slate-100 text-slate-700" }, p = practices.find(x => x.ods_code === r.ods_code);
    return `<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2 first:border-0"><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${iss.tone}">${esc(iss.label)}</span>${p && p.hubspot_customer ? chip("Customer", "bg-emerald-100 text-emerald-800") : ""}
        <span class="font-mono text-xs text-slate-500">${esc(r.ods_code || "")}</span></div>
      <div class="mt-0.5 text-sm"><span class="text-xs text-slate-500">HubSpot${r.object_type === "pcn" ? " PCN" : r.object_type === "icb" ? " ICB" : ""}</span> <b>${esc(r.company_name || "(no name)")}</b>${r.nhs_name ? ` <span class="ml-2 text-xs text-slate-500">NHS</span> <b>${esc(r.nhs_name)}</b>` : ""}</div><div class="text-xs text-slate-500">${esc(r.detail || "")}</div></div>
      <div class="flex shrink-0 items-center gap-3 text-xs">${hsLink(AUDIT_OBJECT[r.object_type] || "0-2", r.company_id, r.object_type === "pcn" ? "PCN record" : r.object_type === "icb" ? "ICB record" : "Company")}${p && (r.object_type || "company") === "company" ? `<button data-au-open="${esc(p.ods_code)}" class="font-semibold text-blue-600 hover:underline">Open practice</button>` : ""}</div></div>`; }).join("")
    || '<p class="text-sm text-slate-500">Nothing matches.</p>';
  if (rows.length > auditShown) box.insertAdjacentHTML("beforeend", `<div class="pt-2 text-center"><button id="au-more" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(rows.length - auditShown).toLocaleString()} left)</button></div>`);
  const more = $("au-more"); if (more) more.onclick = () => { auditShown += 200; auditList(); };
  box.querySelectorAll("[data-au-open]").forEach(b => b.onclick = () => { const p = practices.find(x => x.ods_code === b.dataset.auOpen); if (p) { showTab("practices"); openDrawer(p); } });
}
