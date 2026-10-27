// HubSpot, part 3 of 3: PCN / ICB links, creating a company, and the Data > Overview integration panel with its activity log and response times. Loaded after hubspot-company.js.
/* ---------- PCN / ICB: link to HubSpot's custom objects, shown on the network profile ---------- */
const HS_NET = { p145802630_pcns: { id: "2-203659326", label: "PCN" }, p145802630_icbs: { id: "2-203659324", label: "ICB" } };
async function hsNetworkSection(n) {
  const { data } = await db.from("hubspot_network_links").select("*").eq("org_id", n.id).limit(1);
  const box = $("dr-hsnet"); if (!box) return;
  const l = (data || [])[0];
  box.outerHTML = l ? `<div id="dr-hsnet">${kv(HS_NET[l.object_type].label + " record", hsLink(HS_NET[l.object_type].id, l.object_id, "Open in HubSpot"))}${kv("Matched on", esc(l.matched_on))}
      ${kv("Practices in HubSpot record", l.associated_practices != null ? Number(l.associated_practices).toLocaleString() : "")}${kv("Active eMR+ practices", l.active_emr_practices != null ? Number(l.active_emr_practices).toLocaleString() : "")}
      ${kv("Open deals", l.open_deals_amount != null ? gbpFull(l.open_deals_amount) : "")}${kv("Won deals", l.won_deals_amount != null ? gbpFull(l.won_deals_amount) : "")}</div>`
    : `<div id="dr-hsnet" class="text-sm italic text-slate-500">No ${n.kind === "icb" ? "ICB" : "PCN"} record found in HubSpot (matched by ${n.kind === "icb" ? "name" : "ODS code"}). Scottish clusters and Welsh boards are not held there.</div>`;
}

/* ---------- practices that are not in HubSpot: flag, then create (or link an existing company) after a preview ---------- */

async function hsCreateOpen(p) {
  if (!p) return;
  hs = { p, create: true };
  $("hs-modal").classList.remove("hidden"); hsTitle("Add to HubSpot");
  hsRender('<p class="text-slate-500">Checking HubSpot for an existing company…</p>');
  try {
    const { companies } = await hsCall({ action: "find", ods: p.ods_code, name: p.practice_name, query: p.practice_name });
    const nets = [["pcn", p.pcn_code], ["icb", p.icb_name && p.icb_name.toLowerCase()]].map(([k, key]) => key && networks.find(x => x.kind === k && keyOf(x) === key)).filter(Boolean);
    const { data: nl } = nets.length ? await db.from("hubspot_network_links").select("org_id,object_type,object_id").in("org_id", nets.map(x => x.id)) : { data: [] };
    const ac = await hsAtlasContacts(p);
    hs.cdata = { companies, contacts: ac.ok, skippedList: ac.skipped, links: nl || [], nets };
    hsCreatePreview();
  } catch (e) { hsRender(`<p class="text-rose-700">${esc(e.message)}</p>`); }
}
function hsCompanyProps(p) {
  return { name: p.practice_name, partner_organisation_code: p.ods_code, patient_list_size: p.total_patients, address: p.address || undefined, city: p.town || undefined, county: p.county || undefined, zip: p.postcode || undefined,
    phone: p.main_phone || undefined, website: p.website || undefined, country: p.country || "England", company_status: "Prospective Customer" };
}
function hsCreatePreview() {
  const { p, cdata } = hs, props = hsCompanyProps(p), shown = Object.entries(props).filter(([, v]) => v !== undefined && v !== "");
  const label = { name: "Name", partner_organisation_code: "GP ODS Code", patient_list_size: "Patient list size", address: "Street address", city: "City", county: "County", zip: "Postcode", company_status: "Company status", phone: "Phone", website: "Website", country: "Country" };
  const same = cdata.companies.filter(c => !c.partner_organisation_code);   // companies without an ODS code can be adopted; ones with another code are different practices
  const near = c => (c.zip || "").replace(/\s/g, "").toUpperCase() === (p.postcode || "").replace(/\s/g, "").toUpperCase() ? '<span class="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">same postcode</span>' : "";
  const link = o => { const l = cdata.links.find(x => x.org_id === o.id); return l ? `${HS_NET[l.object_type].label} record found` : "no HubSpot record (not associated)"; };
  hsRender(`<p class="text-slate-600">${esc(p.practice_name)} (${esc(p.ods_code)}) has no company with this GP ODS Code in HubSpot.</p>
    ${same.length ? `<div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"><div class="font-semibold text-amber-900">Is it already there under another name?</div><div class="text-xs text-amber-800">These companies have no GP ODS Code. Use one to avoid a duplicate; the tool then sets its GP ODS Code.</div>
      ${same.map(c => `<div class="mt-2 flex items-center justify-between gap-3 rounded-lg bg-white p-2"><div><div class="font-medium">${hsLink("0-2", c.id, c.name)} ${near(c)}</div><div class="text-xs text-slate-500">${esc([c.address, c.city, c.zip].filter(Boolean).join(", "))}</div></div>
        <button data-hs-adopt="${esc(c.id)}" class="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold hover:bg-slate-50">Use this company</button></div>`).join("")}</div>` : ""}
    <div class="mt-3 text-xs font-semibold text-slate-600">New company to create</div>
    <table class="mt-1 w-full text-sm"><tbody>${shown.map(([k, v]) => `<tr class="border-t border-slate-100"><td class="py-1 pr-3 text-slate-500">${label[k]}</td><td class="py-1 text-right font-medium">${esc(k === "patient_list_size" ? Number(v).toLocaleString() : v)}</td></tr>`).join("")}</tbody></table>
    <div class="mt-3 text-xs font-semibold text-slate-600">Linked to</div>
    <div class="text-sm">${cdata.nets.length ? cdata.nets.map(o => `<div class="flex justify-between border-t border-slate-100 py-1"><span>${esc(o.name)}</span><span class="text-xs text-slate-500">${esc(link(o))}</span></div>`).join("") : '<span class="text-slate-500 italic">No PCN or ICB known for this practice.</span>'}</div>
    <div class="mt-3 text-xs font-semibold text-slate-600">Contacts to create and associate</div>
    <div class="text-sm">${cdata.contacts.length || cdata.skippedList.length ? hsPicker(cdata.contacts, "cc-pick", cdata.skippedList) : '<span class="text-slate-500 italic">No contacts held for this practice.</span>'}</div>
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="mt-4 flex justify-end gap-2"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-create" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Create company and contacts</button></div>`);
  $("hs-cancel").onclick = hsClose;
  $("hs-create").onclick = () => hsCreateRun("create_company", {});
  document.querySelectorAll("[data-hs-adopt]").forEach(b => b.onclick = () => hsCreateRun("link_company", { companyId: b.dataset.hsAdopt }));
}
async function hsCreateRun(action, extra) {
  const { p, cdata } = hs, msg = $("hs-msg"), btn = $("hs-create");
  btn.disabled = true; btn.textContent = "Working…"; msg.innerHTML = "";
  try {
    const r = await hsCall({ action, ods: p.ods_code, ...extra, company: hsCompanyProps(p), contacts: hsPicked(cdata.contacts, "cc-pick"), networks: cdata.links.map(l => ({ type: l.object_type, id: l.object_id })) });
    p.hubspot_company_id = r.companyId;
    msg.innerHTML = `<div class="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900">${action === "create_company" ? "Company created" : "Company linked"}: ${hsLink("0-2", r.companyId, "open in HubSpot")}
      <div class="text-xs">${r.contacts.length} contact(s) associated · ${r.networks.length} PCN/ICB association(s)</div></div>
      <div class="mt-2 rounded-lg border border-slate-200 p-3 text-sm"><b>Next:</b> create a lead or a deal. <button id="hs-next" class="ml-1 font-semibold text-lalu-teal-700 hover:underline">Continue</button></div>${(r.warnings || []).map(w => `<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</div>`).join("")}`;
    btn.classList.add("hidden"); $("hs-cancel").textContent = "Close";
    const nx = $("hs-next"); if (nx) nx.onclick = () => { hs = { p, want: hsDesired(p), busy: false }; hsCompanyPage(r.companyId); };
    if (drawerCode === p.ods_code) openDrawer(p);
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; btn.disabled = false; btn.textContent = "Create company and contacts"; }
}

/* ---------- Data > Overview: HubSpot integration panel (health, what needs attention, activity log, run sync now) ---------- */
const HS_KINDS = { push: ["Pricing pushed", "bg-blue-100 text-blue-800"], push_check: ["Check", "bg-slate-100 text-slate-700"], create_company: ["Company created", "bg-emerald-100 text-emerald-800"], create_lead: ["Lead created", "bg-emerald-100 text-emerald-800"], add_contacts: ["Contacts added", "bg-emerald-100 text-emerald-800"],
  link_company: ["Company linked", "bg-emerald-100 text-emerald-800"], pcn_created: ["PCN created", "bg-violet-100 text-violet-800"], pcn_repaired: ["PCN corrected", "bg-violet-100 text-violet-800"],
  pcn_inactivated: ["PCN inactive", "bg-amber-100 text-amber-800"], associations: ["Associations", "bg-violet-100 text-violet-800"], sync_run: ["Sync", "bg-slate-100 text-slate-700"] };
let hsLog = [], hsLogFilter = "all", hsLogQuery = "", hsPanelTimer = null;
const hsAgo = iso => { if (!iso) return "never"; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const HS_CALL_LABEL = { hub: "Company page", deal_prefill: "Form data (owners, pipelines)", read: "Read a deal (profile strip, re-check)", write: "Push pricing", find: "Find company", create_deal: "Create deal", create_lead: "Create lead", create_company: "Create company", add_contacts: "Add contacts", log_check: "Log check", link_company: "Link company" };
function hsTimingHtml() {
  const by = {}; for (const t of hsTimings) (by[t.a] = by[t.a] || []).push(t);
  const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }, sec = ms => (ms / 1000).toFixed(1) + " s";
  const rows = Object.entries(by).sort((x, y) => med(y[1].map(t => t.ms)) - med(x[1].map(t => t.ms))).map(([a, ts]) => { const ms = ts.map(t => t.ms), bad = ts.filter(t => !t.ok).length;
    return `<tr class="border-t border-slate-100"><td class="py-1 pr-3">${esc(HS_CALL_LABEL[a] || a)}</td><td class="py-1 px-2 text-right">${ts.length}</td><td class="py-1 px-2 text-right font-mono ${med(ms) > 2000 ? "text-rose-700" : med(ms) > 1000 ? "text-amber-700" : ""}">${sec(med(ms))}</td><td class="py-1 px-2 text-right font-mono">${sec(Math.max(...ms))}</td><td class="py-1 px-2 text-right font-mono">${sec(ms[ms.length - 1])}</td><td class="py-1 pl-2 text-right">${bad || ""}</td></tr>`; }).join("");
  return `<details class="mt-4"><summary class="cursor-pointer text-sm font-bold">Response times <span class="font-normal text-xs text-slate-500">this browser, last ${hsTimings.length} HubSpot calls, slowest first</span></summary>
    ${rows ? `<table class="mt-2 w-full text-sm"><thead><tr class="text-left text-[11px] uppercase tracking-wider text-slate-500"><th class="pr-3">Action</th><th class="px-2 text-right">Calls</th><th class="px-2 text-right">Median</th><th class="px-2 text-right">Slowest</th><th class="px-2 text-right">Latest</th><th class="pl-2 text-right">Failed</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="mt-1 text-right"><button id="hsp-timclear" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Clear</button></div>` : '<p class="mt-2 text-sm text-slate-500">No calls yet. Use HubSpot from a practice profile, then come back.</p>'}</details>`;
}
async function renderHubspotPanel() {
  const box = $("d-hubspot"); if (!box) return;
  if (!box.innerHTML) box.innerHTML = '<p class="text-sm text-slate-500">Loading HubSpot status…</p>';
  const [{ data: act }, { data: links }] = await Promise.all([db.from("hubspot_activity").select("*").order("at", { ascending: false }).limit(300), fetchAll("hubspot_network_links", "org_id", "org_id").then(data => ({ data }))]);   // all rows: a plain select stops at 1,000
  hsLog = act || [];
  const run = hsLog.find(r => r.kind === "sync_run"), st = (run && run.detail) || {}, ok = run ? run.ok : null;
  const eligible = practices.filter(p => p.status === "Active" && p.total_patients > 0), missing = eligible.filter(p => !p.hubspot_company_id);
  const linkedIds = new Set((links || []).map(l => l.org_id));
  const eng = kind => networks.filter(n => n.kind === kind && n.patients > 0 && (kind === "pcn" ? /^ods:U\d{5}$/.test(n.source_key) : /ICB/i.test(n.name)));
  const pcnMiss = eng("pcn").filter(n => !linkedIds.has(n.id)), icbMiss = eng("icb").filter(n => !linkedIds.has(n.id));
  const latestCheck = new Map(); for (const r of hsLog) if (r.kind === "push_check" && r.ods_code && !latestCheck.has(r.ods_code)) latestCheck.set(r.ods_code, r);
  const badChecks = [...latestCheck.values()].filter(r => !r.ok);
  const tile = (k, v, sub = "") => `<div class="rounded-lg border border-slate-200 p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-xl font-bold leading-tight">${v}</div>${sub ? `<div class="text-xs text-slate-500">${sub}</div>` : ""}</div>`;
  const attn = (n, label, action = "") => n ? `<div class="flex items-center justify-between gap-3 border-t border-slate-100 py-1.5 first:border-0"><span class="text-sm"><b>${n.toLocaleString()}</b> ${label}</span>${action}</div>` : "";
  const items = [attn(ok === false ? 1 : 0, "The last sync failed: " + esc((run?.summary || "").slice(0, 120))),
    attn(missing.length, "active practices with a list size are not in HubSpot", '<button id="hsp-missing" class="text-xs font-semibold text-lalu-teal-700 hover:underline">View them</button>'),
    attn(pcnMiss.length, "PCNs have no HubSpot PCN record yet (the next sync creates English ones)"), attn(icbMiss.length, "ICBs have no HubSpot ICB record"),
    attn(badChecks.length, "recent pricing pushes where HubSpot's calculated values did not match the tool", '<button id="hsp-bad" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Show</button>')].join("");
  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-2"><h2 class="font-bold">HubSpot integration</h2>
      ${chip(ok === null ? "Never synced" : ok ? "Healthy" : "Last sync failed", ok === null ? "bg-slate-100 text-slate-700" : ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800")}</div>
      <div class="flex items-center gap-3"><span id="hsp-msg" class="text-xs text-slate-500" role="status"></span><button id="hsp-sizes" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50" title="A CSV for HubSpot's company import that updates Patient List Size">List-size import file</button><button id="hsp-run" class="rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">Run sync now</button></div></div>
    <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">${tile("Last sync", run ? hsAgo(run.at) : "never", run ? esc(run.actor) : "")}
      ${tile("Practices linked", (eligible.length - missing.length).toLocaleString(), "of " + eligible.length.toLocaleString() + " active with a list size")}${tile("Customers", practices.filter(p => hsState(p) === "customer").length.toLocaleString(), practices.filter(p => hsState(p) === "freemium").length.toLocaleString() + " more are Freemium")}
      ${tile("Engaged", practices.filter(p => p.hubspot_engaged && !p.hubspot_customer).length.toLocaleString())}${tile("PCN / ICB records linked", linkedIds.size.toLocaleString(), (st.pcn_records_created ? st.pcn_records_created + " created last run" : ""))}</div>
    <h3 class="mt-4 text-sm font-bold">Needs attention</h3><div id="hsp-attn">${items || '<p class="text-sm text-slate-500">Nothing needs attention.</p>'}</div>${hsTimingHtml()}
    <div class="mt-4 flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-bold">Activity log <span class="font-normal text-xs text-slate-500">everything the tool has done to HubSpot</span></h3>
      <div class="flex flex-wrap items-center gap-2"><select id="hsp-filter" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Filter activity">${[["all", "All activity"], ["push", "Pricing pushes"], ["create", "Companies created or linked"], ["pcn", "PCN records"], ["sync", "Sync runs"], ["bad", "Needs attention"]].map(([k, l]) => `<option value="${k}" ${hsLogFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <input id="hsp-q" value="${esc(hsLogQuery)}" placeholder="Search practice or text" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Search activity"><button id="hsp-csv" class="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold hover:bg-slate-50">Export CSV</button></div></div>
    <div id="hsp-log" class="mt-2 max-h-96 overflow-y-auto text-sm"></div>`;
  hsLogRender();
  const tc = $("hsp-timclear"); if (tc) tc.onclick = () => { hsTimings = []; try { localStorage.removeItem(HS_TIMING_KEY); } catch (e) {} renderHubspotPanel(); };
  $("hsp-missing").onclick = () => { showTab("practices"); $("f-hs").value = "missing"; applyFilters(); };
  const bad = $("hsp-bad"); if (bad) bad.onclick = () => { hsLogFilter = "bad"; $("hsp-filter").value = "bad"; hsLogRender(); };
  $("hsp-filter").onchange = e => { hsLogFilter = e.target.value; hsLogRender(); };
  $("hsp-q").oninput = e => { hsLogQuery = e.target.value; hsLogRender(); };
  $("hsp-csv").onclick = () => downloadCsv("Lalu_HubSpot_Activity", ["Time", "Who", "Type", "Practice", "Record", "Summary", "OK"], hsLogRows().map(r => [r.at, r.actor, (HS_KINDS[r.kind] || [r.kind])[0], r.ods_code, r.target, r.summary, r.ok ? "yes" : "no"]));
  $("hsp-sizes").onclick = () => {      // active, unmerged practices already in HubSpot: Record ID matches the company, so the import updates it
    const rows = practices.filter(p => p.hubspot_company_id && p.status === "Active" && !p.merged_into && p.total_patients > 0).sort((a, b) => a.ods_code.localeCompare(b.ods_code));
    downloadCsv("Lalu_HubSpot_ListSizes", ["Record ID", "Company name", "GP ODS Code", "Patient List Size"], rows.map(p => [p.hubspot_company_id, p.practice_name, p.ods_code, p.total_patients]));
    $("hsp-msg").textContent = rows.length.toLocaleString() + " companies in the file (list sizes as of " + (rows[0]?.data_month || "the latest load") + ")";
  };
  $("hsp-run").onclick = async () => {
    const b = $("hsp-run"), msg = $("hsp-msg"); b.disabled = true; msg.textContent = "Starting…";
    const { data, error } = await db.functions.invoke("hubspot-sync-trigger");
    if (error || data?.error) { let m = data?.error || error?.message || "Could not start the sync"; try { const j = await error?.context?.json?.(); if (j?.error) m = j.error; } catch (e) {} msg.textContent = m; b.disabled = false; return; }
    msg.textContent = "Sync started. It takes about 3 minutes; this panel refreshes by itself.";
    clearTimeout(hsPanelTimer); hsPanelTimer = setTimeout(() => { renderHubspotPanel(); hsPanelTimer = setTimeout(renderHubspotPanel, 90000); }, 120000);
  };
}
function hsLogRows() {
  const q = hsLogQuery.trim().toLowerCase(), badOds = new Set(), seen = new Set();
  for (const r of hsLog) if (r.kind === "push_check" && r.ods_code && !seen.has(r.ods_code)) { seen.add(r.ods_code); if (!r.ok) badOds.add(r.ods_code); }
  const inF = r => hsLogFilter === "all" || (hsLogFilter === "push" && (r.kind === "push" || r.kind === "push_check")) || (hsLogFilter === "create" && (r.kind === "create_company" || r.kind === "link_company")) ||
    (hsLogFilter === "pcn" && /^pcn_|associations/.test(r.kind)) || (hsLogFilter === "sync" && r.kind === "sync_run") || (hsLogFilter === "bad" && (!r.ok || (r.kind === "push_check" && badOds.has(r.ods_code))));
  return hsLog.filter(r => inF(r) && (!q || `${r.ods_code} ${r.target} ${r.summary} ${r.actor}`.toLowerCase().includes(q)));
}
function hsLogRender() {
  const rows = hsLogRows().slice(0, 150), box = $("hsp-log"); if (!box) return;
  box.innerHTML = rows.length ? `<table class="w-full text-left"><thead class="sticky top-0 bg-white text-[11px] uppercase tracking-wider text-slate-500"><tr><th class="py-1 pr-2 font-medium">When</th><th class="font-medium">Who</th><th class="font-medium">Type</th><th class="font-medium">What</th></tr></thead><tbody>` +
    rows.map(r => { const [lab, cls] = HS_KINDS[r.kind] || [r.kind, "bg-slate-100 text-slate-700"], p = r.ods_code && practices.find(x => x.ods_code === r.ods_code);
      return `<tr class="border-t border-slate-100 align-top"><td class="py-1.5 pr-2 whitespace-nowrap text-xs text-slate-500" title="${esc(r.at)}">${esc(fmtDate(r.at))}<div>${esc(hsAgo(r.at))}</div></td><td class="pr-2 text-xs">${esc(r.actor)}</td><td class="pr-2">${chip(lab, r.ok ? cls : "bg-rose-100 text-rose-800")}</td>
        <td class="py-1.5"><div>${p ? `<a href="#" data-hsp-open="${esc(p.ods_code)}" class="font-medium text-lalu-teal-700 hover:underline">${esc(p.practice_name)}</a> ` : ""}${esc(r.summary)}</div>
        ${r.detail ? `<details class="text-xs text-slate-500"><summary class="cursor-pointer">Details</summary><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">${esc(JSON.stringify(r.detail, null, 1).slice(0, 4000))}</pre></details>` : ""}</td></tr>`; }).join("") + "</tbody></table>"
    : '<p class="py-3 text-sm italic text-slate-500">No activity matches.</p>';
  box.querySelectorAll("[data-hsp-open]").forEach(a => a.onclick = e => { e.preventDefault(); const p = practices.find(x => x.ods_code === a.dataset.hspOpen); if (p) { showTab("practices"); openDrawer(p); } });
}
