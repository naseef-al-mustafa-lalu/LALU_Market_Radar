/* ---------- push the selected pricing to the practice's HubSpot deal ---------- */
// Flow: find / confirm the company and deal (saved once per practice) -> preview what will be written -> write -> wait for HubSpot to recalculate
// Total Discount % and Actual Value per Patient (Calculated) -> compare both with the tool. The HubSpot token lives only in the hubspot-push edge function.
const HS_PCT = 1;   // HubSpot's % number fields hold fractions (0.05 for 5%): its Actual Value per Patient formula needs Total Discount between 0 and 1
let hs = null;
const hsCall = async body => {
  const { data, error } = await db.functions.invoke("hubspot-push", { body });
  if (error || data?.error) { let m = data?.error || error?.message || "Request failed"; try { const j = await error?.context?.json?.(); if (j?.error) m = j.error; } catch (e) {} throw new Error(m); }
  return data;
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
  const linked = !!p.hubspot_company_id, active = p.status === "Active" && p.total_patients > 0;
  return sec("HubSpot", kv("Status", chip(HS_LABEL[st], HS_CLS[st]) + (!linked && active ? " " + chip("Not in HubSpot", "bg-amber-100 text-amber-800") : "")) +
    kv("Company record", linked ? hsLink("0-2", p.hubspot_company_id, "Open in HubSpot") : "") + '<div id="dr-hsdeal"></div>' + kv("Lifecycle stage", esc(p.hubspot_stage)) +
    kv("Company created", esc(fmtDate(p.hubspot_company_imported_at))) + kv("Contacts in HubSpot", p.hs_contacts ? p.hs_imported + " of " + p.hs_contacts : "") + kv("Last synced", esc(fmtDate(p.hubspot_synced_at))));
}

/* ---------- the adaptive HubSpot bar on the price card: Add to HubSpot / Link deal / Push pricing (n changes) / In sync ---------- */
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
  else if (!i.link) { dot = "bg-amber-400"; text = "Company found, no deal linked yet"; right = act("push", "Link deal"); }
  else if (i.error) { dot = "bg-rose-500"; text = "Could not read the linked deal"; right = act("push", "Retry"); }
  else if (i.pair) {
    const { count } = hsChanges(p, hsDesired(p), i.pair.company, i.pair.deal, i.pair), name = esc(i.pair.deal.dealname || "deal");
    if (count) { dot = "bg-amber-400"; text = `${name}: ${count} change${count > 1 ? "s" : ""} to push`; right = act("push", `Push pricing <span class="ml-1 rounded-full bg-white/25 px-1.5">${count}</span>`); }
    else { dot = "bg-emerald-500"; text = `${name}: in sync`; right = hsLink("0-3", i.pair.deal.id, "Open deal"); }
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
  const p = practices.find(x => x.ods_code === b.dataset.ods); if (p) (b.dataset.hsAct === "create" ? hsCreateOpen : hsOpen)(p);
});
$("hs-close").onclick = hsClose;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("hs-modal").classList.contains("hidden")) hsClose(); });

async function hsOpen(p) {
  if (!p) return;
  hs = { p, want: hsDesired(p), busy: false };
  $("hs-modal").classList.remove("hidden"); $("hs-title").textContent = "Push pricing to HubSpot: " + p.practice_name;
  hsRender('<p class="text-slate-500">Checking for a saved link…</p>');
  try {
    const { data } = await db.from("hubspot_links").select("*").eq("ods_code", p.ods_code).limit(1);
    const link = (data || [])[0];
    if (link) { Object.assign(hs, await hsCall({ action: "read", companyId: link.company_id, dealId: link.deal_id }), { linked: true }); return hsPreview(); }
  } catch (e) { hsRender(`<p class="text-rose-700">Could not load the saved link: ${esc(e.message)}</p>` + hsFind()); return hsBindFind(); }
  hsRender(hsFind()); hsBindFind(true);
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
      box.querySelectorAll("[data-co]").forEach(b => b.onclick = () => hsDeals(b.dataset.co, companies.find(c => c.id === b.dataset.co)));
    } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
  };
  $("hs-search").onclick = run; $("hs-q").onkeydown = e => { if (e.key === "Enter") run(); };
  if (auto) run();
}
async function hsDeals(companyId, company) {
  const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Loading deals…</p>';
  try {
    const { deals } = await hsCall({ action: "deals", companyId });
    box.innerHTML = `<div class="mb-2 text-xs font-semibold text-slate-600">Deals for ${esc(company.name)}</div>` + (deals.length ? deals.map(d => `<button type="button" data-deal="${esc(d.id)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50">
        <div class="flex justify-between gap-3"><b>${esc(d.dealname)}</b><span class="text-xs text-slate-500">${esc(d.dealstage || "")}</span></div>
        <div class="text-xs text-slate-500">${d.amount ? "£" + Number(d.amount).toLocaleString() : "no amount"} · ${esc(d.size_tier || "no size tier")} · ${esc(d.value_per_patient || "no value per patient")}</div></button>`).join("")
      : '<p class="text-slate-500 italic">This company has no deals yet.</p>') +
      `<div class="mt-2 border-t border-slate-100 pt-2"><button id="hs-newdeal" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">+ Create a new deal for ${esc(company.name)}</button>
        <button id="hs-newlead" class="ml-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">+ Create a lead first</button></div>`;
    $("hs-newdeal").onclick = () => hsDealForm(company);
    $("hs-newlead").onclick = () => hsLeadForm(company);
    box.querySelectorAll("[data-deal]").forEach(b => b.onclick = async () => {
      box.innerHTML = '<p class="text-slate-500">Reading the records…</p>';
      try { Object.assign(hs, await hsCall({ action: "read", companyId, dealId: b.dataset.deal }), { linked: false }); hsPreview(); } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
    });
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* create a deal: every field is editable, then the normal push preview follows */
async function hsDealForm(company) {
  const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Reading the company\'s contacts, pipelines and owners…</p>';
  try {
    const pre = await hsCall({ action: "deal_prefill", companyId: company.id }), p = hs.p, want = hs.want || hsDesired(p);
    const lead = pre.contacts[0] ? [pre.contacts[0].firstname, pre.contacts[0].lastname].filter(Boolean).join(" ") : (p.manager_name || "");
    const pipes = pre.pipelines, def = pipes.find(x => x.id === "default") || pipes[0], stageNew = def.stages.find(s => s.id === "appointmentscheduled") || def.stages[0];
    const close = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), amount = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
    const field = (label, inner) => `<label class="block"><span class="mb-0.5 block text-xs font-semibold text-slate-600">${label}</span>${inner}</label>`, inp = "w-full rounded-lg border border-slate-300 px-2 py-1.5";
    const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
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
      ${pre.contacts.length ? `<div class="mt-3"><div class="mb-1 text-xs font-semibold text-slate-600">Associate contacts</div>${pre.contacts.map(c => `<label class="flex items-center gap-2 py-0.5"><input type="checkbox" data-nd-contact="${esc(c.id)}" checked><span>${esc([c.firstname, c.lastname].filter(Boolean).join(" ") || c.email)} <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} ${esc(c.email || "")}</span></span></label>`).join("")}</div>` : '<p class="mt-3 text-xs text-slate-500">This company has no contacts to associate.</p>'}
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <p class="mt-2 text-xs text-slate-500">The Amount starts at the annual revenue above. The discount fields, size tier, value per patient, commercial model and line item are written on the next screen, where you confirm them.</p>
      <div id="nd-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nd-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nd-create" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Create deal</button></div></div>`;
    $("nd-pipe").onchange = e => { const pp = pipes.find(x => x.id === e.target.value); $("nd-stage").innerHTML = opts(pp.stages.map(s => [s.id, s.label]), pp.stages[0].id); };
    $("nd-cancel").onclick = () => hsDeals(company.id, company);
    $("nd-create").onclick = async () => {
      const b = $("nd-create"), msg = $("nd-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const close = $("nd-close").value, r = await hsCall({ action: "create_deal", ods: p.ods_code, companyId: company.id, contactIds: [...document.querySelectorAll("[data-nd-contact]:checked")].map(x => x.dataset.ndContact),
          deal: { dealname: $("nd-name").value.trim(), pipeline: $("nd-pipe").value, dealstage: $("nd-stage").value, dealtype: $("nd-type").value, product___service: $("nd-prod").value,
            hubspot_owner_id: $("nd-owner")?.value || "", closedate: close ? close + "T00:00:00Z" : "", amount: $("nd-amount").value } });
        Object.assign(hs, await hsCall({ action: "read", companyId: company.id, dealId: r.dealId }), { linked: false }); hsPreview();
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create deal"; }
    };
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* create a lead (Prospecting pipeline, New) before there is a deal */
async function hsLeadForm(company) {
  const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Reading the company\'s contacts and owners…</p>';
  try {
    const pre = await hsCall({ action: "deal_prefill", companyId: company.id }), p = hs.p;
    const field = (label, inner) => `<label class="block"><span class="mb-0.5 block text-xs font-semibold text-slate-600">${label}</span>${inner}</label>`, inp = "w-full rounded-lg border border-slate-300 px-2 py-1.5";
    const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
    const cname = c => [c.firstname, c.lastname].filter(Boolean).join(" ") || c.email;
    box.innerHTML = `<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New lead on ${esc(company.name)}</h4>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="sm:col-span-2">${field("Lead name", `<input id="nl-name" class="${inp}" value="${esc(company.name + " | Market Radar")}">`)}</div>
        ${field("Primary contact", pre.contacts.length ? `<select id="nl-contact" class="${inp}">${opts(pre.contacts.map(c => [c.id, cname(c) + (c.jobtitle ? " · " + c.jobtitle : "")]), pre.contacts[0].id)}</select>` : '<div class="rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-800">A lead needs a contact. Add one in HubSpot first.</div>')}
        ${field("Lead owner", pre.owners ? `<select id="nl-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
        ${field("Lead type", `<select id="nl-type" class="${inp}">${opts([["NEW_BUSINESS", "New business"], ["RE_ATTEMPTING", "Re-attempting"]], "NEW_BUSINESS")}</select>`)}
        ${field("Prospecting campaign", `<select id="nl-camp" class="${inp}">${opts([["", "None"], ["Field Based Lead", "Field Based Lead"], ["PCN Prospecting", "PCN Prospecting"], ["ICB Prospecting", "ICB Prospecting"], ["ICB April 26", "ICB April 26"]], "")}</select>`)}</div>
      <p class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Goes into the Prospecting Pipeline at New. HubSpot's lifecycle workflow will then set the contact's lifecycle stage to Prospecting (only when it is New or Engaged). Created by the tool, the lead gets no automatic owner rotation and no sequence.</p>
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <div id="nl-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nl-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nl-create" ${pre.contacts.length ? "" : "disabled"} class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Create lead</button></div></div>`;
    $("nl-cancel").onclick = () => hsDeals(company.id, company);
    const go = async force => {
      const b = $("nl-create"), msg = $("nl-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const r = await hsCall({ action: "create_lead", ods: p.ods_code, companyId: company.id, contactId: $("nl-contact").value, name: $("nl-name").value.trim(), ownerId: $("nl-owner")?.value || "", leadType: $("nl-type").value, campaign: $("nl-camp").value, force });
        if (r.ok === false) {
          msg.innerHTML = `<div class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">This contact already has an open lead: ${r.existing.map(l => esc(l.name)).join(", ")}. Creating another can duplicate work. <button id="nl-force" class="ml-1 font-semibold underline">Create anyway</button></div>`;
          $("nl-force").onclick = () => go(true); b.disabled = false; b.textContent = "Create lead"; return;
        }
        box.innerHTML = `<div class="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"><b>Lead created.</b> ${hsLink("0-136", r.leadId, "Open the lead in HubSpot")}${r.companyLinked ? "" : " It could not be linked to the company; link it in HubSpot."}<div class="mt-2"><button id="nl-deals" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold">Back to deals</button></div></div>`;
        $("nl-deals").onclick = () => hsDeals(company.id, company);
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create lead"; }
    };
    $("nl-create").onclick = () => go(false);
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* step 2: preview exactly what will be written */
const monthlyNote = w => w.frequency === "monthly" ? " per patient per month" : " per patient per year";
function hsPreview() {
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
    <div class="mt-1 flex items-center justify-between text-xs"><span class="font-semibold text-slate-600">Selected in the profile: ${esc(want.label)}</span>${hs.linked ? '<button id="hs-relink" class="text-blue-600 hover:underline">Change link</button>' : '<button id="hs-back" class="text-blue-600 hover:underline">Choose another</button>'}</div>
    ${warn}
    ${sectionCard("Deal pricing fields", badge(nDeal), discRows)}
    ${sectionCard("Line item", badge(nLine), lineCard)}
    ${sectionCard("HubSpot recalculates, then we check", "", `<div class="grid grid-cols-2 gap-2">${tile("Total discount", pctShow(hsNum(deal.total_discount)) + ' <span class="text-slate-400">→</span> ' + pct(want.total), false, "expected after the write")}
      ${tile("Actual value per patient", (deal.actual_value_per_patient_calculated ? "£" + rate3(deal.actual_value_per_patient_calculated) : "not set") + ' <span class="text-slate-400">→</span> £' + rate3(want.rate), false, "per month, expected")}</div>`)}
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-slate-200 bg-white pt-3"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-write" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Write to HubSpot</button></div>`);
  $("hs-cancel").onclick = hsClose;
  const re = $("hs-relink") || $("hs-back"); if (re) re.onclick = () => { hs.linked = false; hsRender(hsFind()); hsBindFind(); };
  $("hs-write").onclick = () => hsWrite(checks);
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
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; $("hs-write").disabled = false; $("hs-write").textContent = "Write to HubSpot"; }
}

// Read the deal back until HubSpot's calculated fields match the tool (or give up after `tries` reads), then show the comparison.
// The Re-check button runs it again, in case HubSpot is slower than usual.
async function hsValidate(tries) {
  if (!hs) return;
  const { want, company, deal } = hs, msg = $("hs-msg"), expectTotal = hsPct(want.total);
  try {
    let last = null;
    for (let i = 0; i < tries; i++) {
      msg.innerHTML = `<p class="text-slate-500">Waiting for HubSpot to recalculate… (${i + 1}/${tries})</p>`;
      last = (await hsCall({ action: "read", companyId: company.id, dealId: deal.id })).deal;
      if (!hs) return;
      if (Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6 && (hsNum(last.actual_value_per_patient_calculated) == null ? i >= 2 : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4)) break;
      if (i < tries - 1) await new Promise(r => setTimeout(r, window.__hsPoll ?? 4000));
    }
    const okT = Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6, blankV = hsNum(last.actual_value_per_patient_calculated) == null;
    const okV = blankV ? null : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4;   // null: HubSpot has not filled it in
    const line = (ok, label, got, exp) => `<div class="flex items-center justify-between rounded-lg border ${ok === null ? "border-amber-300 bg-amber-50 text-amber-900" : ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-rose-300 bg-rose-50 text-rose-900"} px-3 py-2"><span>${ok === null ? "?" : ok ? "✓" : "✗"} ${label}</span><span class="font-mono">HubSpot ${got} · tool ${exp}</span></div>`;
    const lineNow = hsOurLine(await hsCall({ action: "read", companyId: company.id, dealId: deal.id })), lw = want.line;
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
  $("hs-modal").classList.remove("hidden"); $("hs-title").textContent = "Add to HubSpot: " + p.practice_name;
  hsRender('<p class="text-slate-500">Checking HubSpot for an existing company…</p>');
  try {
    const [{ companies }, { data: cs }] = await Promise.all([hsCall({ action: "find", ods: p.ods_code, name: p.practice_name, query: p.practice_name }),
      db.from("contacts").select("full_name,job_title,email,phone,email_opt_out").eq("ods_code", p.ods_code).limit(20)]);
    const nets = [["pcn", p.pcn_code], ["icb", p.icb_name && p.icb_name.toLowerCase()]].map(([k, key]) => key && networks.find(x => x.kind === k && keyOf(x) === key)).filter(Boolean);
    const { data: nl } = nets.length ? await db.from("hubspot_network_links").select("org_id,object_type,object_id").in("org_id", nets.map(x => x.id)) : { data: [] };
    const contacts = (cs || []).filter(c => c.email && !c.email_opt_out).map(c => ({ name: c.full_name, jobtitle: c.job_title, email: c.email, phone: c.phone }));
    if (!contacts.length && p.manager_email && !p.manager_email_opt_out) contacts.push({ name: p.manager_name, jobtitle: p.manager_title, email: p.manager_email, phone: p.manager_phone });
    hs.cdata = { companies, contacts, skipped: (cs || []).length - contacts.length, links: nl || [], nets };
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
    <div class="text-sm">${cdata.contacts.length ? cdata.contacts.map(c => `<div class="border-t border-slate-100 py-1"><b>${esc(c.name || "Unnamed")}</b> <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} · ${esc(c.email)}</span></div>`).join("") : '<span class="text-slate-500 italic">No contacts with an email address.</span>'}
      ${cdata.skipped > 0 ? `<div class="text-xs text-slate-500">${cdata.skipped} contact(s) skipped (no email or email opt-out).</div>` : ""}</div>
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="mt-4 flex justify-end gap-2"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-create" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Create in HubSpot</button></div>`);
  $("hs-cancel").onclick = hsClose;
  $("hs-create").onclick = () => hsCreateRun("create_company", {});
  document.querySelectorAll("[data-hs-adopt]").forEach(b => b.onclick = () => hsCreateRun("link_company", { companyId: b.dataset.hsAdopt }));
}
async function hsCreateRun(action, extra) {
  const { p, cdata } = hs, msg = $("hs-msg"), btn = $("hs-create");
  btn.disabled = true; btn.textContent = "Working…"; msg.innerHTML = "";
  try {
    const r = await hsCall({ action, ods: p.ods_code, ...extra, company: hsCompanyProps(p), contacts: cdata.contacts, networks: cdata.links.map(l => ({ type: l.object_type, id: l.object_id })) });
    p.hubspot_company_id = r.companyId;
    msg.innerHTML = `<div class="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900">${action === "create_company" ? "Company created" : "Company linked"}: ${hsLink("0-2", r.companyId, "open in HubSpot")}
      <div class="text-xs">${r.contacts.length} contact(s) associated · ${r.networks.length} PCN/ICB association(s)</div></div>
      <div class="mt-2 rounded-lg border border-slate-200 p-3 text-sm"><b>Next:</b> create the deal for this company in HubSpot, then come back to push the pricing. <button id="hs-next" class="ml-1 font-semibold text-blue-600 hover:underline">Push pricing now</button></div>${(r.warnings || []).map(w => `<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</div>`).join("")}`;
    btn.classList.add("hidden"); $("hs-cancel").textContent = "Close";
    const nx = $("hs-next"); if (nx) nx.onclick = () => { hs = null; hsOpen(p); };
    if (drawerCode === p.ods_code) openDrawer(p);
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; btn.disabled = false; btn.textContent = "Create in HubSpot"; }
}

/* ---------- Data > Overview: HubSpot integration panel (health, what needs attention, activity log, run sync now) ---------- */
const HS_KINDS = { push: ["Pricing pushed", "bg-blue-100 text-blue-800"], push_check: ["Check", "bg-slate-100 text-slate-700"], create_company: ["Company created", "bg-emerald-100 text-emerald-800"], create_lead: ["Lead created", "bg-emerald-100 text-emerald-800"],
  link_company: ["Company linked", "bg-emerald-100 text-emerald-800"], pcn_created: ["PCN created", "bg-violet-100 text-violet-800"], pcn_repaired: ["PCN corrected", "bg-violet-100 text-violet-800"],
  pcn_inactivated: ["PCN inactive", "bg-amber-100 text-amber-800"], associations: ["Associations", "bg-violet-100 text-violet-800"], sync_run: ["Sync", "bg-slate-100 text-slate-700"] };
let hsLog = [], hsLogFilter = "all", hsLogQuery = "", hsPanelTimer = null;
const hsAgo = iso => { if (!iso) return "never"; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
async function renderHubspotPanel() {
  const box = $("d-hubspot"); if (!box) return;
  if (!box.innerHTML) box.innerHTML = '<p class="text-sm text-slate-500">Loading HubSpot status…</p>';
  const [{ data: act }, { data: links }] = await Promise.all([db.from("hubspot_activity").select("*").order("at", { ascending: false }).limit(300), db.from("hubspot_network_links").select("org_id")]);
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
    <h3 class="mt-4 text-sm font-bold">Needs attention</h3><div id="hsp-attn">${items || '<p class="text-sm text-slate-500">Nothing needs attention.</p>'}</div>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-bold">Activity log <span class="font-normal text-xs text-slate-500">everything the tool has done to HubSpot</span></h3>
      <div class="flex flex-wrap items-center gap-2"><select id="hsp-filter" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Filter activity">${[["all", "All activity"], ["push", "Pricing pushes"], ["create", "Companies created or linked"], ["pcn", "PCN records"], ["sync", "Sync runs"], ["bad", "Needs attention"]].map(([k, l]) => `<option value="${k}" ${hsLogFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <input id="hsp-q" value="${esc(hsLogQuery)}" placeholder="Search practice or text" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Search activity"><button id="hsp-csv" class="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold hover:bg-slate-50">Export CSV</button></div></div>
    <div id="hsp-log" class="mt-2 max-h-96 overflow-y-auto text-sm"></div>`;
  hsLogRender();
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
