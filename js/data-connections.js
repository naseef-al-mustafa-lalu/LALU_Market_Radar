// Data > Data sources: the Connections list (what feeds Atlas, what it needs, health, Test connection). Loaded after data-tab.js.
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
      <button id="conn-toggle" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Expand all</button></div>
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
          ${c.id === "hsactions" ? `<div class="md:col-span-2"><button id="conn-test" class="rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">Test connection</button><div id="conn-test-out" class="mt-2 text-sm" role="status"></div></div>` : ""}
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
