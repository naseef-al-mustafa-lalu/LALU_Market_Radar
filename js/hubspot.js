/* ---------- push the selected pricing to the practice's HubSpot deal ---------- */
// Flow: find / confirm the company and deal (saved once per practice) -> preview what will be written -> write -> wait for HubSpot to recalculate
// Total Discount % and Actual Value per Patient (Calculated) -> compare both with the tool. The HubSpot token lives only in the hubspot-push edge function.
const HS_PCT = 1;   // HubSpot's % number fields hold fractions (0.05 for 5%): its Actual Value per Patient formula needs Total Discount between 0 and 1
let hs = null;
// Every call to the edge function is timed (round trip, so cold starts count) and the last 300 are kept in this browser, to show on Data > HubSpot.
const HS_TIMING_KEY = "atlas_hs_timings";
let hsTimings = (() => { try { return JSON.parse(localStorage.getItem(HS_TIMING_KEY)) || []; } catch (e) { return []; } })();
const hsTimed = (action, ms, ok) => {
  hsTimings.push({ a: action, ms: Math.round(ms), ok, t: Date.now() }); if (hsTimings.length > 300) hsTimings.splice(0, hsTimings.length - 300);
  try { localStorage.setItem(HS_TIMING_KEY, JSON.stringify(hsTimings)); } catch (e) {}
};
const hsCall = async body => {
  const t0 = performance.now(); let ok = false;
  try {
    const { data, error } = await db.functions.invoke("hubspot-push", { body });
    if (error || data?.error) { let m = data?.error || error?.message || "Request failed"; try { const j = await error?.context?.json?.(); if (j?.error) m = j.error; } catch (e) {} throw new Error(m); }
    ok = true; return data;
  } finally { hsTimed(body.action, performance.now() - t0, ok); }
};
const hsPct = f => Math.round(f * HS_PCT * 10000) / 10000;      // fraction -> HubSpot number
const HS_MODELS = { "Subscription": "ReportSure - MS - All Reports", "eMR+ SAR Only": "ReportSure - MS - SAR Only", Freemium: "ReportSure Freemium", PAYG: "eMR+ - PAYG", "GP eMR - Subscripton": "ReportSure - Self Service" };
const hsNum = v => (v === "" || v == null ? null : Number(v));
const hsClose = () => { $("hs-modal").classList.add("hidden"); hs = null; };

// The four Lalu Care products in HubSpot (unit price is set on the product: per patient per year for annual, per patient per month for monthly).
const HS_PRODUCTS = { "all|annual": ["440423339237", "ReportSure - All Report - Annual"], "all|monthly": ["440425147578", "ReportSure - All Report - Monthly"],
  "sar|annual": ["440434162881", "ReportSure - SAR Only - Annual"], "sar|monthly": ["440498134244", "ReportSure - SAR Only - Monthly"] };
const HS_PRODUCT_IDS = new Set(Object.values(HS_PRODUCTS).map(x => x[0]));
function hsLineWanted(p, monthly, yrs, rate, list) {
  const [productId, productName] = HS_PRODUCTS[`${product}|${monthly ? "monthly" : "annual"}`], k = monthly ? 1 : 12;
  return { productId, productName, quantity: p.total_patients, listUnit: Math.round(list * k * 10000) / 10000, netUnit: Math.round(rate * k * 10000) / 10000, termMonths: monthly ? 1 : 12 * yrs,
    frequency: monthly ? "monthly" : "annually", terms: monthly ? "AUTOMATICALLY_RENEW" : "FIXED", payments: monthly ? null : yrs };
}
const hsOurLine = pair => (pair?.lineItems || []).find(l => HS_PRODUCT_IDS.has(String(l.hs_product_id)));
// How the deal's current tool line item compares with the wanted one (null when there is none or the token cannot read line items).
function hsLineStatus(want, pair) {
  if (pair?.lineItems == null) return { unreadable: true };
  const cur = hsOurLine(pair), w = want.line;
  if (!cur) return { action: "create", same: false, cur: null };
  const sameProduct = String(cur.hs_product_id) === w.productId, unit = Number(cur.price) || w.listUnit;
  const same = sameProduct && Number(cur.quantity) === w.quantity && Math.abs((Number(cur.discount) || 0) - Math.max(0, unit - w.netUnit)) < 0.0006 && cur.hs_recurring_billing_period === `P${w.termMonths}M`;
  return { action: sameProduct ? "update" : "replace", same, cur, unit };
}

// What the profile currently has selected, as the values HubSpot should hold.
function hsDesired(p) {
  const row = cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier), monthly = billing === "monthly";
  const size = monthly ? 0 : Number(row.size_discount), term = monthly ? 0 : termDiscount(termYrs), speed = monthly || !speedOn ? 0 : Number(row.speed_discount);
  return { size, term, speed, termYears: monthly ? 1 : termYrs, tier: "Tier " + p.price_tier, model: product === "sar" ? "eMR+ SAR Only" : "Subscription", modelLabel: product === "sar" ? "ReportSure - MS - SAR Only" : "ReportSure - MS - All Reports", vpp: "£" + baseRate().toFixed(2), rate: dealRate(size, term, speed), list: baseRate(),
    total: size + term + speed, line: hsLineWanted(p, monthly, termYrs, dealRate(size, term, speed), baseRate()), label: `${product === "sar" ? "SAR only" : "All reports"} · ${monthly ? "monthly plan" : `annual, ${termYrs}-year term`}${speed ? " · speed discount" : ""}` };
}
// The HubSpot section of the profile now holds facts only (status, links, lifecycle); the one action lives beside the price controls (hsBarHtml).
function hsSection(p, st) {
  const linked = !!p.hubspot_company_id, active = p.status === "Active" && p.total_patients > 0, when = [p.hubspot_company_imported_at && "Created from Atlas " + fmtDate(p.hubspot_company_imported_at), p.hubspot_synced_at && "last synced " + fmtDate(p.hubspot_synced_at)].filter(Boolean).join(" · ");
  return sec("HubSpot", kv("Status", chip(HS_LABEL[st], HS_CLS[st]) + (!linked && active && st !== "none" ? " " + chip("No company record", "bg-amber-100 text-amber-800") : "")) + kv("Company record", linked ? hsLink("0-2", p.hubspot_company_id, "Open in HubSpot") : "") + '<div id="dr-hsdeal"></div>' + kv("Lifecycle stage", esc(p.hubspot_stage))
    + kv("Contacts in HubSpot", p.hs_contacts ? p.hs_imported + " of " + p.hs_contacts : "") + (when ? `<div class="mt-1 text-xs text-slate-500">${esc(when)}</div>` : ""));
}

/* ---------- the adaptive HubSpot bar on the price card: Add to HubSpot / Set up in HubSpot / Push pricing (n changes) / Manage in HubSpot ---------- */
const hsInfo = {};   // ods -> { link, pair: {company, deal}, loading, error }
const hsSame = (a, b) => hsNum(a) != null && Math.abs(hsNum(a) - b) < 1e-6;
// Everything that differs between HubSpot and the tool for the current profile selection. `fixes` need approval; `writes` are always sent.
function hsChanges(p, want, company, deal, pair) {
  const fixes = [
    { id: "ls", label: "Company list size", now: company.patient_list_size ? Number(company.patient_list_size).toLocaleString() : "not set", next: p.total_patients.toLocaleString(), same: hsSame(company.patient_list_size, p.total_patients) },
    { id: "tier", label: "Deal size tier", now: deal.size_tier || "not set", next: want.tier, same: deal.size_tier === want.tier },
    { id: "cm", label: "Deal commercial model", now: HS_MODELS[deal.commercial_model] || deal.commercial_model || "not set", next: want.modelLabel, same: deal.commercial_model === want.model },
    { id: "vpp", label: "Deal value per patient", now: deal.value_per_patient || "not set", next: want.vpp, same: deal.value_per_patient === want.vpp }];
  const writes = [hsSame(deal.size_discount, hsPct(want.size)), hsSame(deal.speed_discount, hsPct(want.speed)), hsSame(deal.term_length_discount, hsPct(want.term)), String(deal.term_length_years) === String(want.termYears)];
  const line = hsLineStatus(want, pair);
  return { fixes, writes, line, count: fixes.filter(f => !f.same).length + writes.filter(s => !s).length + (line.unreadable || line.same ? 0 : 1) };
}
function hsBarHtml(p) {
  if (!p || p.status !== "Active" || !(p.total_patients > 0) || !p.price_tier) return "";
  const i = hsInfo[p.ods_code] || { loading: true }, linked = !!p.hubspot_company_id;   // not looked up yet counts as loading
  const act = (kind, label) => `<button type="button" data-hs-act="${kind}" data-ods="${esc(p.ods_code)}" class="shrink-0 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">${label}</button>`;
  let dot = "bg-slate-300", text = "", right = "";
  if (!linked) { dot = "bg-amber-400"; text = "Not in HubSpot yet"; right = act("create", "Add to HubSpot"); }
  else if (i.loading) text = "Checking the linked deal…";
  else if (!i.link) { dot = "bg-amber-400"; text = "Company in HubSpot, no deal linked yet"; right = act("push", "Set up in HubSpot"); }
  else if (i.error) { dot = "bg-rose-500"; text = "Could not read the linked deal"; right = act("push", "Retry"); }
  else if (i.pair) {
    const { count } = hsChanges(p, hsDesired(p), i.pair.company, i.pair.deal, i.pair), name = esc(i.pair.deal.dealname || "deal");
    if (count) { dot = "bg-amber-400"; text = `${name}: ${count} change${count > 1 ? "s" : ""} to push`; right = act("push", `Push pricing <span class="ml-1 rounded-full bg-white/25 px-1.5">${count}</span>`); }
    else { dot = "bg-emerald-500"; text = `${name}: in sync`; right = `<div class="flex shrink-0 items-center gap-3 text-xs">${hsLink("0-3", i.pair.deal.id, "Open deal")}${act("manage", "Manage in HubSpot")}</div>`; }
  }
  return `<div class="hs-bar flex items-center justify-between gap-3" data-ods="${esc(p.ods_code)}">
    <div class="flex min-w-0 items-center gap-2"><span class="h-2 w-2 shrink-0 rounded-full ${dot}"></span><div class="min-w-0"><div class="text-xs font-semibold text-slate-700">HubSpot</div><div class="truncate text-xs text-slate-500">${text}</div></div></div>${right}</div>`;
}
// The bar lives in a slim strip under the drawer title (#dr-hs), so it is visible whatever section you scroll to. Practices only.
function hsRefreshBars() {
  const box = $("dr-hs"), el = box.querySelector(".hs-bar"); if (!el) return;
  const p = practices.find(x => x.ods_code === el.dataset.ods); if (p) box.innerHTML = hsBarHtml(p);
}
function hsShowBar(p) { const html = p ? hsBarHtml(p) : ""; $("dr-hs").innerHTML = html; $("dr-hs").classList.toggle("hidden", !html); }
async function hsSetLink(p, link) {
  const i = hsInfo[p.ods_code] = { link: link || null, pair: null, loading: !!link, error: null }; hsRefreshBars();
  if (!link) return;
  try { i.pair = await hsCall({ action: "read", companyId: link.company_id, dealId: link.deal_id }); } catch (e) { i.error = e.message; }
  i.loading = false; hsRefreshBars();
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-hs-act]"); if (!b) return;
  const p = practices.find(x => x.ods_code === b.dataset.ods); if (p) (b.dataset.hsAct === "create" ? hsCreateOpen : b.dataset.hsAct === "manage" ? hsManage : hsOpen)(p);
});
$("hs-close").onclick = hsClose;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("hs-modal").classList.contains("hidden")) hsClose(); });

async function hsOpen(p) {
  if (!p) return;
  hs = { p, want: hsDesired(p), busy: false };
  $("hs-modal").classList.remove("hidden"); hsTitle();
  hsRender('<p class="text-slate-500">Checking for a saved link…</p>');
  try {
    const { data } = await db.from("hubspot_links").select("*").eq("ods_code", p.ods_code).limit(1);
    const link = (data || [])[0];
    if (link) { Object.assign(hs, await hsCall({ action: "read", companyId: link.company_id, dealId: link.deal_id }), { linked: true }); return hsPreview(); }
  } catch (e) { hsRender(`<p class="text-rose-700">Could not load the saved link: ${esc(e.message)}</p>` + hsFind()); return hsBindFind(); }
  if (p.hubspot_company_id) return hsCompanyPage(p.hubspot_company_id);   // company already known (synced or created here): no search needed
  hsRender(hsFind()); hsBindFind(true);
}
// "Manage in HubSpot": the company page (contacts, leads, deals) for a practice whose deal is already linked and in sync
function hsManage(p) {
  if (!p) return;
  const link = (hsInfo[p.ods_code] || {}).link, id = (link && link.company_id) || p.hubspot_company_id; if (!id) return hsOpen(p);
  hs = { p, want: hsDesired(p), busy: false }; $("hs-modal").classList.remove("hidden"); hsCompanyPage(String(id));
}
const hsRender = html => { $("hs-body").innerHTML = html; };

/* step 1: find the company and deal */
const hsFind = () => `<p class="text-slate-600">Find the HubSpot company for this practice, then choose its deal. This is saved so you only do it once.</p>
  <div class="mt-3 flex gap-2"><input id="hs-q" class="flex-1 rounded-lg border border-slate-300 px-3 py-2" value="${esc(hs.p.practice_name + " " + hs.p.ods_code)}" aria-label="Search HubSpot companies">
  <button id="hs-search" class="rounded-lg bg-slate-800 px-3 py-2 font-semibold text-white">Search</button></div><div id="hs-results" class="mt-3"></div>`;
function hsBindFind(auto) {
  const run = async () => {
    const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Searching HubSpot…</p>';
    try {
      const { companies } = await hsCall({ action: "find", ods: hs.p.ods_code, name: hs.p.practice_name, query: $("hs-q").value });
      box.innerHTML = companies.length ? companies.map(c => `<button type="button" data-co="${esc(c.id)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50">
          <div class="flex justify-between gap-3"><b>${esc(c.name)}</b><span class="text-xs ${c.match === "ODS code" ? "text-emerald-700" : "text-slate-500"}">matched on ${esc(c.match)}</span></div>
          <div class="text-xs text-slate-500">ODS ${esc(c.partner_organisation_code || "not set")} · list size ${c.patient_list_size ? Number(c.patient_list_size).toLocaleString() : "not set"}</div></button>`).join("")
        : '<p class="text-slate-500 italic">No companies found. Try a shorter name.</p>';
      box.insertAdjacentHTML("beforeend", `<div class="mt-1 flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500"><span>${companies.length ? "Not the right one?" : "Nothing matches."}</span><button id="hs-new" class="font-semibold text-blue-600 hover:underline">Create ${esc(hs.p.practice_name)} in HubSpot</button></div>`);
      $("hs-new").onclick = () => hsCreateOpen(hs.p);
      box.querySelectorAll("[data-co]").forEach(b => b.onclick = () => hsCompanyPage(b.dataset.co));
    } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
  };
  $("hs-search").onclick = run; $("hs-q").onkeydown = e => { if (e.key === "Enter") run(); };
  if (auto) run();
}
// shared form pieces for the create-deal and create-lead forms
const hsField = (label, inner) => `<label class="block"><span class="mb-0.5 block text-xs font-semibold text-slate-600">${label}</span>${inner}</label>`, hsInp = "w-full rounded-lg border border-slate-300 px-2 py-1.5";
const hsOpts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
// owners and pipelines are fetched once per modal in the background, so the lead and deal forms open without waiting on HubSpot
let hsPreCache = null;   // owners and pipelines do not depend on the company: reuse them for ten minutes
const hsPrefill = companyId => hs.pre ? Promise.resolve(hs.pre) : (hs.prePromise = hs.prePromise || hsCall({ action: "deal_prefill", companyId, noContacts: true }).then(r => (hsPreCache = { at: Date.now(), pre: r }, hs.pre = r), e => { hs.prePromise = null; throw e; }));
const hsSkeleton = n => '<div class="space-y-3" aria-label="Loading">' + Array.from({ length: n }, () => '<div class="h-16 animate-pulse rounded-xl bg-slate-100"></div>').join("") + '</div>';
const hsHubCache = {};   // companyId -> { at, hub }: reopening a company shows the last read at once, then refreshes it
const hsTitle = (...parts) => { $("hs-title").textContent = ["Atlas", hs.p.practice_name, ...parts].join(" › "); };
/* contacts Atlas holds for a practice: those that can be sent to HubSpot, and those that cannot (with the reason) */
async function hsAtlasContacts(p, have = new Set()) {
  const { data: cs } = await db.from("contacts").select("full_name,job_title,email,phone,email_opt_out").eq("ods_code", p.ods_code).limit(20);
  const rows = (cs || []).map(c => ({ name: c.full_name, jobtitle: c.job_title, email: c.email, phone: c.phone, optout: c.email_opt_out }));
  if (!rows.length && p.manager_email) rows.push({ name: p.manager_name, jobtitle: p.manager_title, email: p.manager_email, phone: p.manager_phone, optout: p.manager_email_opt_out });
  const ok = [], skipped = [];
  for (const c of rows) {
    const why = !c.email ? "no email address" : c.optout ? "email opt-out" : have.has(c.email.toLowerCase()) ? "already in HubSpot" : "";
    if (!why) ok.push(c); else if (why !== "already in HubSpot") skipped.push({ ...c, why });
  }
  return { ok, skipped };
}
/* one contact picker for create-company and add-contacts: ticked list, skipped people greyed with the reason */
const hsPicker = (list, cls, skipped = []) => list.map((c, i) => `<label class="flex cursor-pointer items-start gap-2 border-t border-slate-100 py-1.5 first:border-0"><input type="checkbox" class="${cls} mt-1" data-i="${i}" checked><span class="min-w-0"><b>${esc(c.name || "Unnamed")}</b> <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} · ${esc(c.email)}</span></span></label>`).join("")
  + skipped.map(c => `<div class="flex items-start gap-2 border-t border-slate-100 py-1.5 text-slate-400"><input type="checkbox" disabled class="mt-1"><span><b>${esc(c.name || "Unnamed")}</b> <span class="text-xs">not added: ${esc(c.why)}</span></span></div>`).join("");
const hsPicked = (list, cls) => [...document.querySelectorAll("." + cls + ":checked")].map(x => list[+x.dataset.i]);
const hsNameOf = c => [c.firstname, c.lastname].filter(Boolean).join(" ") || c.email || "Unnamed";

/* the company page: Company > Contacts > Leads > Deals. Loaded once, then updated in place so going back is instant. */
const hsStep = (n, label, done, note) => `<div class="flex min-w-0 flex-1 items-center gap-2"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}">${done ? "✓" : n}</span><div class="min-w-0"><div class="text-xs font-semibold text-slate-700">${label}</div><div class="truncate text-[11px] text-slate-500">${note}</div></div></div>`;
async function hsCompanyPage(companyId, force) {
  if (!hs.pre && hsPreCache && Date.now() - hsPreCache.at < 600000) hs.pre = hsPreCache.pre;
  hsRender('<div id="hs-results"></div>'); hsTitle();
  const load = async () => {
    const h = await hsCall({ action: "hub", companyId }), a = await hsAtlasContacts(hs.p, new Set(h.contacts.map(c => (c.email || "").toLowerCase())));
    return (hsHubCache[companyId] = { at: Date.now(), hub: { ...h, extra: a.ok, skipped: a.skipped } }).hub;
  };
  const cached = hsHubCache[companyId];
  if (!force && hs.hub && hs.hub.company.id === companyId) return hsHubRender();
  if (!force && cached && Date.now() - cached.at < 300000) {
    hs.hub = cached.hub; hsHubRender(); hsPrefill(companyId).catch(() => {});
    load().then(h => { const idle = $("hs-newlead") && $("hs-addpanel")?.classList.contains("hidden") !== false; if (hs && idle && hs.hub === cached.hub) { hs.hub = h; hsHubRender(); } }).catch(() => {});   // refresh quietly unless the user is mid-action
    return;
  }
  $("hs-results").innerHTML = hsSkeleton(3);
  try { hs.hub = await load(); } catch (e) { $("hs-results").innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Retry</button>`; $("hs-retry").onclick = () => hsCompanyPage(companyId, true); return; }
  hsHubRender(); hsPrefill(companyId).catch(() => {});
}
function hsHubRender() {
  const box = $("hs-results"), p = hs.p, h = hs.hub, co = h.company, leads = h.leads, nLeads = leads ? leads.length : 0, next = !h.contacts.length ? 2 : !nLeads && !h.deals.length ? 3 : 4;
  const btn = (id, label, primary) => `<button id="${id}" class="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold ${primary ? "bg-slate-800 text-white hover:bg-slate-700" : "border border-slate-300 hover:bg-slate-50"}">${label}</button>`;
  const card = (n, title, count, action, body) => `<section class="rounded-xl border ${next === n ? "border-slate-400 shadow-sm" : "border-slate-200"} p-3"><div class="mb-2 flex items-center justify-between gap-3"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">${n}. ${title} <span class="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] normal-case text-slate-600">${count}</span></h4>${action}</div>${body}</section>`;
  const row = (l, r, fresh) => `<div class="flex items-center justify-between gap-3 border-t border-slate-100 py-1.5 first:border-0 ${fresh ? "-mx-1 rounded bg-emerald-50 px-1" : ""}"><div class="min-w-0">${l}</div><div class="shrink-0 text-right text-xs text-slate-500">${r}</div></div>`;
  const empty = t => `<p class="text-sm italic text-slate-500">${t}</p>`, flash = hs.flash; hs.flash = null;
  const fresh = new Set(hs.fresh || []); hs.fresh = null;
  box.innerHTML = (flash ? `<div class="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900" role="status">${flash}</div>` : "")
    + `<div class="mb-3 flex gap-3" aria-label="Progress">${hsStep(1, "Company", true, "in HubSpot")}${hsStep(2, "Contacts", h.contacts.length > 0, h.contacts.length + " linked")}${hsStep(3, "Lead", nLeads > 0, leads ? nLeads + " found" : "unknown")}${hsStep(4, "Deal", h.deals.length > 0, h.deals.length + " found")}</div>
    <div class="space-y-3">
    ${card(1, "Company", "✓", hsLink("0-2", co.id, "Open"), `<div class="font-medium">${esc(co.name)}</div><div class="text-xs text-slate-500">ODS ${esc(co.partner_organisation_code || "not set")} · list size ${co.patient_list_size ? Number(co.patient_list_size).toLocaleString() : "not set"}</div>`)}
    ${card(2, "Contacts", h.contacts.length, h.extra.length ? btn("hs-addcontacts", `Add from Atlas (${h.extra.length})`, next === 2) : "",
      (h.contacts.map(c => row(`<b>${esc(hsNameOf(c))}</b> <span class="text-xs text-slate-500">${esc(c.jobtitle || "")}</span>`, hsLink("0-1", c.id, c.email || "open"), fresh.has(c.id))).join("") || empty("No contacts on this company yet."))
      + `<div id="hs-addpanel" class="mt-2 hidden rounded-lg bg-slate-50 p-2"><div class="mb-1 text-xs font-semibold text-slate-600">Choose who to add to ${esc(co.name)}</div>${hsPicker(h.extra, "ac-pick", h.skipped)}<div class="mt-2 flex justify-end gap-2"><button id="hs-addcancel" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Cancel</button><button id="hs-addgo" class="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">Add selected</button></div><div id="hs-addmsg" class="mt-1 text-xs" role="status"></div></div>`
      + (!h.extra.length && h.skipped.length ? `<div class="mt-2 text-xs text-slate-500">Not added: ${h.skipped.map(c => esc((c.name || c.email || "Unnamed") + " (" + c.why + ")")).join(", ")}</div>` : ""))}
    ${card(3, "Leads", leads ? nLeads : "?", btn("hs-newlead", "+ Create lead", next === 3),
      leads ? (leads.map(l => row(`<b>${esc(l.name)}</b>`, `${l.open ? "" : "closed · "}${esc(l.stage)} ${hsLink("0-136", l.id, "open")}`, fresh.has(l.id))).join("") || empty("No leads yet. A lead tracks the practice before there is a deal.")) : '<p class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Leads could not be read: add the crm.objects.leads.read scope to the HubSpot token.</p>')}
    ${card(4, "Deals", h.deals.length, btn("hs-newdeal", "+ Create deal", next === 4),
      h.deals.length ? '<div class="mb-1 text-xs text-slate-500">Choose a deal to push this practice\'s pricing to it.</div>' + h.deals.map(d => `<button type="button" data-deal="${esc(d.id)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50">
        <div class="flex justify-between gap-3"><b>${esc(d.dealname)}</b><span class="text-xs text-slate-500">${esc(d.dealstage || "")}</span></div>
        <div class="text-xs text-slate-500">${d.amount ? "£" + Number(d.amount).toLocaleString() : "no amount"} · ${esc(d.size_tier || "no size tier")} · ${esc(d.value_per_patient || "no value per patient")}</div></button>`).join("") : empty("No deals yet."))}</div>`;
  const company = { id: co.id, name: co.name };
  $("hs-newdeal").onclick = () => hsDealForm(company);
  $("hs-newlead").onclick = () => hsLeadForm(company);
  const ac = $("hs-addcontacts");
  if (ac) {
    ac.onclick = () => { $("hs-addpanel").classList.remove("hidden"); ac.classList.add("hidden"); };
    $("hs-addcancel").onclick = () => { $("hs-addpanel").classList.add("hidden"); ac.classList.remove("hidden"); };
    $("hs-addgo").onclick = async () => {
      const chosen = hsPicked(h.extra, "ac-pick"), go = $("hs-addgo"), msg = $("hs-addmsg"); if (!chosen.length) { msg.innerHTML = '<span class="text-rose-700">Tick at least one person.</span>'; return; }
      go.disabled = true; go.textContent = "Adding…"; msg.innerHTML = "";
      try {
        const r = await hsCall({ action: "add_contacts", ods: p.ods_code, companyId: co.id, contacts: chosen }), added = [];
        for (const d of r.contacts) { const src = chosen.find(c => c.email.toLowerCase() === d.email); const [f, ...l] = String(src?.name || "").split(/\s+/);
          h.contacts.push({ id: d.id, firstname: f || "", lastname: l.join(" "), jobtitle: src?.jobtitle || "", email: d.email }); added.push(d.id); }
        h.extra = h.extra.filter(c => !r.contacts.some(d => d.email === c.email.toLowerCase()));
        hs.fresh = added; hs.flash = `${r.contacts.length} contact${r.contacts.length === 1 ? "" : "s"} added to HubSpot.` + (r.warnings.length ? " " + esc(r.warnings.join("; ")) : "");
        hsHubRender();
      } catch (e) { go.disabled = false; go.textContent = "Retry"; msg.innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
    };
  }
  box.querySelectorAll("[data-deal]").forEach(b => b.onclick = async () => {
    box.innerHTML = '<p class="text-slate-500">Reading the records…</p>';
    try { Object.assign(hs, await hsCall({ action: "read", companyId: co.id, dealId: b.dataset.deal }), { linked: false }); hsPreview(); } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Back</button>`; $("hs-retry").onclick = () => hsHubRender(); }
  });
}

/* create a deal: every field is editable, then the normal push preview follows */
async function hsDealForm(company) {
  const box = $("hs-results");
  try {
    hsTitle("Create deal"); if (!hs.pre) box.innerHTML = hsSkeleton(3); const pre = await hsPrefill(company.id), p = hs.p, want = hs.want || hsDesired(p), contacts = (hs.hub && hs.hub.contacts) || pre.contacts;
    const lead = contacts[0] ? hsNameOf(contacts[0]) : (p.manager_name || "");
    const pipes = pre.pipelines, def = pipes.find(x => x.id === "default") || pipes[0], stageNew = def.stages.find(s => s.id === "appointmentscheduled") || def.stages[0];
    const close = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), amount = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
    const field = hsField, inp = hsInp;
    const opts = hsOpts;
    const w = want.line, mo = w.frequency === "monthly", annual = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
    const pt = (k, v, sub = "") => `<div class="rounded-lg bg-white px-2.5 py-1.5"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="font-mono font-semibold">${v}</div>${sub ? `<div class="text-[11px] text-slate-500">${sub}</div>` : ""}</div>`;
    const pricing = `<div class="mb-3 rounded-xl bg-slate-50 p-3"><div class="mb-2 flex items-center justify-between"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Pricing to be sent with this deal</h4><span class="text-xs text-slate-500">from the price card: ${esc(want.label)}</span></div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${pt("Patients", p.total_patients.toLocaleString(), esc(want.tier))}${pt("List price", "£" + rate3(want.list) + " /mo", "per patient")}
        ${pt("Total discount", pct(want.total), `size ${pct(want.size)} · term ${pct(want.term)} · speed ${pct(want.speed)}`)}${pt("Net price", "£" + rate3(want.rate) + " /mo", "per patient")}</div>
      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">${pt("Annual revenue", gbpFull(annual), "becomes the deal Amount")}${pt("Line item", esc(w.productName), mo ? "billed monthly" : "billed annually")}
        ${pt("Unit discount", "£" + rate3(Math.max(0, w.listUnit - w.netUnit)), "off £" + rate3(w.listUnit) + (mo ? " /mo" : " /yr"))}${pt("Term", w.termMonths + " month" + (w.termMonths > 1 ? "s" : ""), mo ? "auto-renews" : w.payments + " payment" + (w.payments > 1 ? "s" : ""))}</div></div>`;
    box.innerHTML = `${pricing}<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New deal on ${esc(company.name)}</h4>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="sm:col-span-2">${field("Deal name", `<input id="nd-name" class="${inp}" value="${esc(lead ? lead + " - " + company.name : company.name)}">`)}</div>
        ${field("Pipeline", `<select id="nd-pipe" class="${inp}">${opts(pipes.map(x => [x.id, x.label]), def.id)}</select>`)}
        ${field("Stage", `<select id="nd-stage" class="${inp}">${opts(def.stages.map(s => [s.id, s.label]), stageNew.id)}</select>`)}
        ${field("Deal type", `<select id="nd-type" class="${inp}">${opts([["newbusiness", "New Business"], ["New Business GP eMR", "New Business GP eMR"], ["Existing Business - Freemium", "Existing Business - Freemium"], ["Existing Business - PAYG", "Existing Business - PAYG"], ["Existing Business - SAR Only", "Existing Business - SAR Only"], ["Existing Business - GP eMR", "Existing Business - GP eMR"], ["Renewal", "Renewal"]], "newbusiness")}</select>`)}
        ${field("Product / service", `<select id="nd-prod" class="${inp}">${opts([["eMR+", "ReportSure - Managed Service"], ["eMR", "ReportSure - Self Service"]], "eMR+")}</select>`)}
        ${field("Deal owner", pre.owners ? `<select id="nd-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
        ${field("Close date", `<input id="nd-close" type="date" class="${inp}" value="${close}">`)}
        ${field("Amount (£, per year)", `<input id="nd-amount" type="number" min="0" step="0.01" class="${inp}" value="${amount}">`)}</div>
      ${contacts.length ? `<div class="mt-3"><div class="mb-1 text-xs font-semibold text-slate-600">Associate contacts</div>${contacts.map(c => `<label class="flex items-center gap-2 py-0.5"><input type="checkbox" data-nd-contact="${esc(c.id)}" ${!hs.picked || hs.picked.includes(c.id) ? "checked" : ""}><span>${esc([c.firstname, c.lastname].filter(Boolean).join(" ") || c.email)} <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} ${esc(c.email || "")}</span></span></label>`).join("")}</div>` : '<p class="mt-3 text-xs text-slate-500">This company has no contacts to associate.</p>'}
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <p class="mt-2 text-xs text-slate-500">The Amount starts at the annual revenue above. The pricing above (discounts, size tier, value per patient, commercial model and line item) is written to the deal straight after it is created, and checked against HubSpot on the same page.</p>
      <div id="nd-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nd-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nd-create" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Create deal and push pricing</button></div></div>`;
    $("nd-pipe").onchange = e => { const pp = pipes.find(x => x.id === e.target.value); $("nd-stage").innerHTML = opts(pp.stages.map(s => [s.id, s.label]), pp.stages[0].id); };
    $("nd-cancel").onclick = () => hsCompanyPage(company.id);
    $("nd-create").onclick = async () => {
      const b = $("nd-create"), msg = $("nd-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const close = $("nd-close").value, r = await hsCall({ action: "create_deal", ods: p.ods_code, companyId: company.id, contactIds: [...document.querySelectorAll("[data-nd-contact]:checked")].map(x => x.dataset.ndContact),
          deal: { dealname: $("nd-name").value.trim(), pipeline: $("nd-pipe").value, dealstage: $("nd-stage").value, dealtype: $("nd-type").value, product___service: $("nd-prod").value,
            hubspot_owner_id: $("nd-owner")?.value || "", closedate: close ? close + "T00:00:00Z" : "", amount: $("nd-amount").value } });
        hs.hub = null; delete hsHubCache[company.id]; Object.assign(hs, await hsCall({ action: "read", companyId: company.id, dealId: r.dealId }), { linked: false, auto: true }); hsPreview();
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create deal and push pricing"; }
    };
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* create a lead (Prospecting pipeline, New) before there is a deal */
async function hsLeadForm(company) {
  const box = $("hs-results"); hsTitle("Create lead");
  try {
    if (!hs.pre) box.innerHTML = hsSkeleton(2); const pre = await hsPrefill(company.id), p = hs.p, contacts = (hs.hub && hs.hub.contacts) || pre.contacts, openLeads = ((hs.hub && hs.hub.leads) || []).filter(l => l.open);
    const field = hsField, inp = hsInp;
    const opts = hsOpts;
    box.innerHTML = `<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New lead on ${esc(company.name)}</h4>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="sm:col-span-2">${field("Lead name", `<input id="nl-name" class="${inp}" value="${esc(company.name + " | Atlas")}">`)}</div>
        ${field("Primary contact", contacts.length ? `<select id="nl-contact" class="${inp}">${opts(contacts.map(c => [c.id, hsNameOf(c) + (c.jobtitle ? " · " + c.jobtitle : "")]), (hs.picked && hs.picked[0]) || contacts[0].id)}</select>` : '<div class="rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-800">A lead needs a contact. <button id="nl-addfirst" type="button" class="font-semibold underline">Add contacts first</button></div>')}
        ${field("Lead owner", pre.owners ? `<select id="nl-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
        ${field("Lead type", `<select id="nl-type" class="${inp}">${opts([["NEW_BUSINESS", "New business"], ["RE_ATTEMPTING", "Re-attempting"]], "NEW_BUSINESS")}</select>`)}
        ${field("Source campaign", `<select id="nl-camp" class="${inp}">${opts([["Atlas", "Atlas"], ["", "None"], ["Field Based Lead", "Field Based Lead"], ["PCN Prospecting", "PCN Prospecting"], ["ICB Prospecting", "ICB Prospecting"], ["ICB April 26", "ICB April 26"]], "Atlas")}</select>`)}</div>
      ${openLeads.length ? `<p id="nl-dup" class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">This company already has an open lead: ${openLeads.map(l => esc(l.name) + " (" + esc(l.stage) + ")").join(", ")}. Check it is not the same opportunity.</p>` : ""}
      <details class="mt-3 text-xs text-slate-600"><summary class="cursor-pointer font-semibold">What happens in HubSpot next</summary><p class="mt-1">The lead goes into the Prospecting Pipeline at New. HubSpot's lifecycle workflow then sets the contact to the Prospecting lifecycle stage (only when it is New or Engaged). Leads made here get no owner rotation and no sequence.</p></details>
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <div id="nl-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nl-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nl-create" ${contacts.length ? "" : "disabled"} class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Create lead</button></div></div>`;
    $("nl-cancel").onclick = () => hsHubRender();
    const af = $("nl-addfirst"); if (af) af.onclick = () => hsHubRender();
    const go = async force => {
      const b = $("nl-create"), msg = $("nl-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const contactId = $("nl-contact").value, r = await hsCall({ action: "create_lead", ods: p.ods_code, companyId: company.id, contactId, name: $("nl-name").value.trim(), ownerId: $("nl-owner")?.value || "", leadType: $("nl-type").value, campaign: $("nl-camp").value, force });
        if (r.ok === false) {
          msg.innerHTML = `<div class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">This contact already has an open lead: ${r.existing.map(l => esc(l.name)).join(", ")}. Creating another can duplicate work. <button id="nl-force" class="ml-1 font-semibold underline">Create anyway</button></div>`;
          $("nl-force").onclick = () => go(true); b.disabled = false; b.textContent = "Create lead"; return;
        }
        (hs.hub.leads = hs.hub.leads || []).unshift({ id: r.leadId, name: $("nl-name").value.trim(), stage: "New (Prospecting Pipeline)", open: true });
        hs.picked = [contactId]; hs.fresh = [r.leadId];
        hs.flash = `Lead created. ${hsLink("0-136", r.leadId, "Open it in HubSpot")}${r.companyLinked ? "" : " It could not be linked to the company; link it in HubSpot."}`;
        hsHubRender();
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create lead"; }
    };
    $("nl-create").onclick = () => go(false);
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Back</button>`; $("hs-retry").onclick = () => hsHubRender(); }
}

/* step 2: preview exactly what will be written */
const monthlyNote = w => w.frequency === "monthly" ? " per patient per month" : " per patient per year";
function hsPreview() {
  hsTitle(hs.auto ? "Create deal" : "Push pricing");
  const { p, want, company, deal } = hs, pctShow = v => v == null ? "not set" : pct(v / HS_PCT);
  const sameNum = hsSame;
  const row = (label, now, next, same, note = "") => `<tr class="border-t border-slate-100"><td class="py-1.5 pr-2">${label}${note ? `<div class="text-xs text-slate-500">${note}</div>` : ""}</td><td class="py-1.5 px-2 text-right font-mono text-slate-600">${now}</td><td class="py-1.5 pl-2 text-right font-mono font-semibold ${same ? "text-slate-400" : "text-emerald-700"}">${same ? "no change" : next}</td></tr>`;
  const ch = hsChanges(p, want, company, deal, hs), checks = ch.fixes, diffs = checks.filter(c => !c.same), line = ch.line, w = want.line;
  const warn = diffs.length ? `<div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"><label class="flex items-start gap-2"><input id="hs-fix-all" type="checkbox" class="mt-0.5" checked>
        <span class="font-semibold text-amber-900">Update HubSpot to match the tool <span class="font-normal text-xs">(${diffs.length} field${diffs.length > 1 ? "s" : ""})</span></span></label>
      <ul class="mt-2 space-y-1 text-sm">${diffs.map(c => `<li class="flex justify-between gap-3"><span class="text-amber-900">${c.label}</span><span class="font-mono">${esc(c.now)} <span class="text-slate-400">→</span> <b>${esc(c.next)}</b></span></li>`).join("")}</ul>
      <div class="mt-1 text-xs text-amber-800">Check this is the right company and deal before writing. Untick to leave these fields alone.</div></div>`
    : '<div class="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900">List size, size tier, commercial model and value per patient all match the tool.</div>';
  // Sectioned preview: who it goes to, what changes (before -> after), the line item as a card, and what HubSpot will recalculate.
  const sectionCard = (title, badge, inner) => `<section class="mt-3 rounded-xl border border-slate-200 p-3"><div class="mb-1 flex items-center justify-between"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">${title}</h4>${badge}</div>${inner}</section>`;
  const badge = n => n ? `<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">${n} change${n > 1 ? "s" : ""}</span>` : '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">no changes</span>';
  const chg = (label, now, next, same) => `<div class="flex items-baseline justify-between gap-3 border-t border-slate-100 py-1.5 first:border-0"><span class="text-slate-700">${label}</span>${same
    ? `<span class="font-mono text-slate-400">${now} <span class="text-[11px]">unchanged</span></span>` : `<span class="font-mono"><span class="text-slate-500">${now}</span> <span class="text-slate-400">→</span> <b class="text-emerald-700">${next}</b></span>`}</div>`;
  const discRows = [["Size discount", deal.size_discount, hsPct(want.size), want.size], ["Speed discount", deal.speed_discount, hsPct(want.speed), want.speed], ["Term length discount", deal.term_length_discount, hsPct(want.term), want.term]]
    .map(([l, nowV, hv, tv]) => chg(l, pctShow(hsNum(nowV)), pct(tv), sameNum(nowV, hv))).join("") + chg("Term length (years)", esc(deal.term_length_years || "not set"), String(want.termYears), String(deal.term_length_years) === String(want.termYears));
  const nDeal = [sameNum(deal.size_discount, hsPct(want.size)), sameNum(deal.speed_discount, hsPct(want.speed)), sameNum(deal.term_length_discount, hsPct(want.term)), String(deal.term_length_years) === String(want.termYears)].filter(x => !x).length;
  const tile = (k, v, changed, sub = "") => `<div class="rounded-lg ${changed ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-slate-50"} px-3 py-2"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="font-mono font-semibold">${v}</div>${sub ? `<div class="text-[11px] text-slate-500">${sub}</div>` : ""}</div>`;
  const cur = line.cur, unitNow = cur ? line.unit : w.listUnit, discNew = Math.max(0, unitNow - w.netUnit);
  const lineCard = line.unreadable ? '<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Line items cannot be read with the current HubSpot token. Add the <b>crm.objects.line_items.read / write</b> scopes (and e-commerce) to include the line item in this push.</div>'
    : `<div class="mb-2 text-sm font-semibold">${esc(w.productName)} ${line.action === "create" ? '<span class="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">new line</span>' : line.action === "replace" ? '<span class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">replaces ' + esc(cur.name || "existing line") + '</span>' : ""}</div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">${tile("Quantity", w.quantity.toLocaleString() + " patients", !cur || Number(cur.quantity) !== w.quantity, cur ? "now " + Number(cur.quantity).toLocaleString() : "")}
        ${tile("Unit price", "£" + rate3(w.listUnit) + (w.frequency === "monthly" ? " /mo" : " /yr"), false, "set on the HubSpot product")}
        ${tile("Unit discount", "£" + rate3(discNew), !cur || Math.abs((Number(cur.discount) || 0) - discNew) >= 0.0006, cur ? "now £" + rate3(Number(cur.discount) || 0) : "")}
        ${tile("Net unit price", "£" + rate3(w.netUnit) + (w.frequency === "monthly" ? " /mo" : " /yr"), false, "£" + rate3(w.netUnit / (w.frequency === "monthly" ? 1 : 12)) + " per patient per month")}
        ${tile("Term", w.termMonths + " month" + (w.termMonths > 1 ? "s" : ""), !cur || cur.hs_recurring_billing_period !== `P${w.termMonths}M`, cur ? "now " + esc(cur.hs_recurring_billing_period || "not set") : "")}
        ${tile("Billing", w.frequency === "monthly" ? "Monthly" : "Annually", false, w.frequency === "monthly" ? "auto-renews" : w.payments + " payment" + (w.payments > 1 ? "s" : ""))}</div>`;
  const nLine = line.unreadable || line.same ? 0 : 1;
  hsRender(`<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div class="min-w-0"><div class="truncate font-semibold">${hsLink("0-2", company.id, company.name)}</div><div class="text-xs text-slate-500">ODS ${esc(company.partner_organisation_code || "not set")}</div></div>
      <div class="min-w-0 text-right"><div class="truncate font-semibold">${hsLink("0-3", deal.id, deal.dealname)}</div><div class="text-xs text-slate-500">${esc(deal.dealstage || "")} · ${hs.linked ? "saved link" : "link saved after the write"}</div></div></div>
    ${hs.auto ? '<div class="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900">Deal created. Writing the pricing and checking it against HubSpot…</div>' : ""}
    <div class="mt-1 flex items-center justify-between text-xs"><span class="font-semibold text-slate-600">Selected in the profile: ${esc(want.label)}</span>${hs.linked ? '<button id="hs-relink" class="text-blue-600 hover:underline">Choose a different deal</button>' : '<button id="hs-back" class="text-blue-600 hover:underline">Choose a different deal</button>'}</div>
    ${warn}
    ${sectionCard("Deal pricing fields", badge(nDeal), discRows)}
    ${sectionCard("Line item", badge(nLine), lineCard)}
    ${sectionCard("HubSpot recalculates, then we check", "", `<div class="grid grid-cols-2 gap-2">${tile("Total discount", pctShow(hsNum(deal.total_discount)) + ' <span class="text-slate-400">→</span> ' + pct(want.total), false, "expected after the write")}
      ${tile("Actual value per patient", (deal.actual_value_per_patient_calculated ? "£" + rate3(deal.actual_value_per_patient_calculated) : "not set") + ' <span class="text-slate-400">→</span> £' + rate3(want.rate), false, "per month, expected")}</div>`)}
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-slate-200 bg-white pt-3"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-write" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Push pricing</button></div>`);
  $("hs-cancel").onclick = hsClose;
  const re = $("hs-relink") || $("hs-back"); if (re) re.onclick = () => { hs.linked = false; hsRender(hsFind()); hsBindFind(); };
  $("hs-write").onclick = () => hsWrite(checks);
  if (hs.auto) { hs.auto = false; hsWrite(checks); }   // a deal made here already shows its pricing in the form: write it without a second confirmation
}

/* step 3: write, then wait for HubSpot's calculated fields and compare them with the tool */
async function hsWrite(checks) {
  const { p, want, company, deal } = hs, msg = $("hs-msg"), fixIds = new Set(checks.filter(c => !c.same).map(c => c.id)), ticked = id => !!$("hs-fix-all")?.checked && fixIds.has(id);
  const dealProps = { size_discount: hsPct(want.size), speed_discount: hsPct(want.speed), term_length_discount: hsPct(want.term), term_length_years: String(want.termYears) };
  const companyProps = {};
  if (ticked("tier")) dealProps.size_tier = want.tier;
  if (ticked("cm")) dealProps.commercial_model = want.model;
  if (ticked("vpp")) dealProps.value_per_patient = want.vpp;
  if (ticked("ls")) companyProps.patient_list_size = p.total_patients;
  $("hs-write").disabled = true; $("hs-write").textContent = "Writing…"; msg.innerHTML = "";
  try {
    const w = want.line, wr = await hsCall({ action: "write", ods: p.ods_code, companyId: company.id, dealId: deal.id, deal: dealProps, company: companyProps,
      lineItem: hs.lineItems == null ? undefined : { productId: w.productId, quantity: w.quantity, netUnit: w.netUnit, termMonths: w.termMonths, frequency: w.frequency, terms: w.terms, payments: w.payments } });
    hs.lineItems = wr.lineItems ?? hs.lineItems;
    $("hs-write").classList.add("hidden"); $("hs-cancel").textContent = "Close";
    await hsValidate(6);
    hsSetLink(p, { company_id: company.id, deal_id: deal.id });   // the bar on the price card now reflects the saved link and the new values
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; $("hs-write").disabled = false; $("hs-write").textContent = "Push pricing"; }
}

// Read the deal back until HubSpot's calculated fields match the tool (or give up after `tries` reads), then show the comparison.
// The Re-check button runs it again, in case HubSpot is slower than usual.
async function hsValidate(tries) {
  if (!hs) return;
  const { want, company, deal } = hs, msg = $("hs-msg"), expectTotal = hsPct(want.total);
  try {
    let last = null, lastFull = null;
    for (let i = 0; i < tries; i++) {
      msg.innerHTML = `<p class="text-slate-500">Waiting for HubSpot to recalculate… (${i + 1}/${tries})</p>`;
      lastFull = await hsCall({ action: "read", companyId: company.id, dealId: deal.id }); last = lastFull.deal;
      if (!hs) return;
      if (Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6 && (hsNum(last.actual_value_per_patient_calculated) == null ? i >= 2 : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4)) break;
      if (i < tries - 1) await new Promise(r => setTimeout(r, window.__hsPoll ?? 4000));
    }
    const okT = Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6, blankV = hsNum(last.actual_value_per_patient_calculated) == null;
    const okV = blankV ? null : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4;   // null: HubSpot has not filled it in
    const line = (ok, label, got, exp) => `<div class="flex items-center justify-between rounded-lg border ${ok === null ? "border-amber-300 bg-amber-50 text-amber-900" : ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-rose-300 bg-rose-50 text-rose-900"} px-3 py-2"><span>${ok === null ? "?" : ok ? "✓" : "✗"} ${label}</span><span class="font-mono">HubSpot ${got} · tool ${exp}</span></div>`;
    const lineNow = hsOurLine(lastFull), lw = want.line;   // the last poll already read the line items
    const lineNet = lineNow ? (Number(lineNow.price) - (Number(lineNow.discount) || 0)) : null, okL = lineNow == null ? null : Math.abs(lineNet - lw.netUnit) < 0.0006 && Number(lineNow.quantity) === lw.quantity;
    const done = okT && okV && okL !== false;
    hsCall({ action: "log_check", ods: hs.p.ods_code, dealId: deal.id, dealName: deal.dealname, ok: okT && okV !== false && okL !== false,
      note: okT ? "Actual Value per Patient (Calculated) does not match the tool" : "Total Discount % does not match the tool",
      hubspot: { total_discount: last.total_discount, actual_value: last.actual_value_per_patient_calculated }, tool: { total_discount: want.total, actual_value: want.rate } }).catch(() => {});
    msg.innerHTML = `<div class="space-y-2">${line(okT, "Total Discount %", last.total_discount == null ? "not set" : pct(hsNum(last.total_discount) / HS_PCT), pct(want.total))}
      ${line(okV, "Actual Value per Patient (Calculated)", blankV ? "not set" : "£" + rate3(last.actual_value_per_patient_calculated), "£" + rate3(want.rate))}
      ${lineNow || hs.lineItems != null ? line(okL, "Line item net unit price", lineNow ? "£" + rate3(lineNet) + (lw.frequency === "monthly" ? " /mo" : " /yr") : "none", "£" + rate3(lw.netUnit) + (lw.frequency === "monthly" ? " /mo" : " /yr")) : ""}</div>
      <p class="mt-2 text-xs text-slate-500">${done ? "HubSpot matches the tool. The link is saved for next time." : okT && okV === null ? "Total Discount % matches. HubSpot has not filled in Actual Value per Patient (Calculated) yet, so it could not be compared. The link is saved." : "HubSpot's calculated fields do not match the tool yet. Re-check in a moment, or check the deal's workflow and whether the price floor applies in the tool but not in HubSpot."}</p>
      ${done ? "" : '<div class="mt-2 text-right"><button id="hs-recheck" class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Re-check HubSpot</button></div>'}`;
    const rc = $("hs-recheck"); if (rc) rc.onclick = () => { rc.disabled = true; hsValidate(3); };
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><div class="mt-2 text-right"><button id="hs-recheck" class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold">Re-check HubSpot</button></div>`; $("hs-recheck").onclick = () => hsValidate(3); }
}

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
      <div class="mt-2 rounded-lg border border-slate-200 p-3 text-sm"><b>Next:</b> create a lead or a deal. <button id="hs-next" class="ml-1 font-semibold text-blue-600 hover:underline">Continue</button></div>${(r.warnings || []).map(w => `<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</div>`).join("")}`;
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
    <div class="mt-1 text-right"><button id="hsp-timclear" class="text-xs font-semibold text-blue-600 hover:underline">Clear</button></div>` : '<p class="mt-2 text-sm text-slate-500">No calls yet. Use HubSpot from a practice profile, then come back.</p>'}</details>`;
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
    attn(missing.length, "active practices with a list size are not in HubSpot", '<button id="hsp-missing" class="text-xs font-semibold text-blue-600 hover:underline">View them</button>'),
    attn(pcnMiss.length, "PCNs have no HubSpot PCN record yet (the next sync creates English ones)"), attn(icbMiss.length, "ICBs have no HubSpot ICB record"),
    attn(badChecks.length, "recent pricing pushes where HubSpot's calculated values did not match the tool", '<button id="hsp-bad" class="text-xs font-semibold text-blue-600 hover:underline">Show</button>')].join("");
  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-2"><h2 class="font-bold">HubSpot integration</h2>
      ${chip(ok === null ? "Never synced" : ok ? "Healthy" : "Last sync failed", ok === null ? "bg-slate-100 text-slate-700" : ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800")}</div>
      <div class="flex items-center gap-3"><span id="hsp-msg" class="text-xs text-slate-500" role="status"></span><button id="hsp-run" class="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">Run sync now</button></div></div>
    <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">${tile("Last sync", run ? hsAgo(run.at) : "never", run ? esc(run.actor) : "")}
      ${tile("Practices linked", (eligible.length - missing.length).toLocaleString(), "of " + eligible.length.toLocaleString() + " active with a list size")}${tile("Customers", practices.filter(p => p.hubspot_customer).length.toLocaleString())}
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
        <td class="py-1.5"><div>${p ? `<a href="#" data-hsp-open="${esc(p.ods_code)}" class="font-medium text-blue-600 hover:underline">${esc(p.practice_name)}</a> ` : ""}${esc(r.summary)}</div>
        ${r.detail ? `<details class="text-xs text-slate-500"><summary class="cursor-pointer">Details</summary><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">${esc(JSON.stringify(r.detail, null, 1).slice(0, 4000))}</pre></details>` : ""}</td></tr>`; }).join("") + "</tbody></table>"
    : '<p class="py-3 text-sm italic text-slate-500">No activity matches.</p>';
  box.querySelectorAll("[data-hsp-open]").forEach(a => a.onclick = e => { e.preventDefault(); const p = practices.find(x => x.ods_code === a.dataset.hspOpen); if (p) { showTab("practices"); openDrawer(p); } });
}
