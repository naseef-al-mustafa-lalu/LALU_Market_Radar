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

// What the profile currently has selected, as the values HubSpot should hold.
function hsDesired(p) {
  const row = cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier), monthly = billing === "monthly";
  const size = monthly ? 0 : Number(row.size_discount), term = monthly ? 0 : termDiscount(termYrs), speed = monthly || !speedOn ? 0 : Number(row.speed_discount);
  return { size, term, speed, termYears: monthly ? 1 : termYrs, tier: "Tier " + p.price_tier, model: product === "sar" ? "eMR+ SAR Only" : "Subscription", modelLabel: product === "sar" ? "ReportSure - MS - SAR Only" : "ReportSure - MS - All Reports", vpp: "£" + baseRate().toFixed(2), rate: dealRate(size, term, speed), list: baseRate(),
    total: size + term + speed, label: `${product === "sar" ? "SAR only" : "All reports"} · ${monthly ? "monthly plan" : `annual, ${termYrs}-year term`}${speed ? " · speed discount" : ""}` };
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
function hsChanges(p, want, company, deal) {
  const fixes = [
    { id: "ls", label: "Company list size", now: company.patient_list_size ? Number(company.patient_list_size).toLocaleString() : "not set", next: p.total_patients.toLocaleString(), same: hsSame(company.patient_list_size, p.total_patients) },
    { id: "tier", label: "Deal size tier", now: deal.size_tier || "not set", next: want.tier, same: deal.size_tier === want.tier },
    { id: "cm", label: "Deal commercial model", now: HS_MODELS[deal.commercial_model] || deal.commercial_model || "not set", next: want.modelLabel, same: deal.commercial_model === want.model },
    { id: "vpp", label: "Deal value per patient", now: deal.value_per_patient || "not set", next: want.vpp, same: deal.value_per_patient === want.vpp }];
  const writes = [hsSame(deal.size_discount, hsPct(want.size)), hsSame(deal.speed_discount, hsPct(want.speed)), hsSame(deal.term_length_discount, hsPct(want.term)), String(deal.term_length_years) === String(want.termYears)];
  return { fixes, writes, count: fixes.filter(f => !f.same).length + writes.filter(s => !s).length };
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
    const { count } = hsChanges(p, hsDesired(p), i.pair.company, i.pair.deal), name = esc(i.pair.deal.dealname || "deal");
    if (count) { dot = "bg-amber-400"; text = `${name}: ${count} change${count > 1 ? "s" : ""} to push`; right = act("push", `Push pricing <span class="ml-1 rounded-full bg-white/25 px-1.5">${count}</span>`); }
    else { dot = "bg-emerald-500"; text = `${name}: in sync`; right = hsLink("0-3", i.pair.deal.id, "Open deal"); }
  }
  return `<div class="hs-bar mt-3 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2" data-ods="${esc(p.ods_code)}">
    <div class="flex min-w-0 items-center gap-2"><span class="h-2 w-2 shrink-0 rounded-full ${dot}"></span><div class="min-w-0"><div class="text-xs font-semibold text-slate-700">HubSpot</div><div class="truncate text-xs text-slate-500">${text}</div></div></div>${right}</div>`;
}
function hsRefreshBars() {
  document.querySelectorAll(".hs-bar").forEach(el => { const p = practices.find(x => x.ods_code === el.dataset.ods); if (p) el.outerHTML = hsBarHtml(p); });
}
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
      : '<p class="text-slate-500 italic">This company has no deals.</p>');
    box.querySelectorAll("[data-deal]").forEach(b => b.onclick = async () => {
      box.innerHTML = '<p class="text-slate-500">Reading the records…</p>';
      try { Object.assign(hs, await hsCall({ action: "read", companyId, dealId: b.dataset.deal }), { linked: false }); hsPreview(); } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
    });
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* step 2: preview exactly what will be written */
function hsPreview() {
  const { p, want, company, deal } = hs, pctShow = v => v == null ? "not set" : pct(v / HS_PCT);
  const sameNum = hsSame;
  const row = (label, now, next, same, note = "") => `<tr class="border-t border-slate-100"><td class="py-1.5 pr-2">${label}${note ? `<div class="text-xs text-slate-500">${note}</div>` : ""}</td><td class="py-1.5 px-2 text-right font-mono text-slate-600">${now}</td><td class="py-1.5 pl-2 text-right font-mono font-semibold ${same ? "text-slate-400" : "text-emerald-700"}">${same ? "no change" : next}</td></tr>`;
  const checks = hsChanges(p, want, company, deal).fixes, diffs = checks.filter(c => !c.same);
  const warn = diffs.length ? `<div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"><label class="flex items-start gap-2"><input id="hs-fix-all" type="checkbox" class="mt-0.5" checked>
        <span class="font-semibold text-amber-900">Update HubSpot to match the tool <span class="font-normal text-xs">(${diffs.length} field${diffs.length > 1 ? "s" : ""})</span></span></label>
      <ul class="mt-2 space-y-1 text-sm">${diffs.map(c => `<li class="flex justify-between gap-3"><span class="text-amber-900">${c.label}</span><span class="font-mono">${esc(c.now)} <span class="text-slate-400">→</span> <b>${esc(c.next)}</b></span></li>`).join("")}</ul>
      <div class="mt-1 text-xs text-amber-800">Check this is the right company and deal before writing. Untick to leave these fields alone.</div></div>`
    : '<div class="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900">List size, size tier, commercial model and value per patient all match the tool.</div>';
  hsRender(`<div class="rounded-lg bg-slate-50 p-3"><div class="flex justify-between gap-3"><div><div class="font-semibold">${hsLink("0-2", company.id, company.name)}</div><div class="text-xs text-slate-500">ODS ${esc(company.partner_organisation_code || "not set")}</div></div>
      <div class="text-right"><div class="font-semibold">${hsLink("0-3", deal.id, deal.dealname)}</div><div class="text-xs text-slate-500">${esc(deal.dealstage || "")}</div></div></div>
      <div class="mt-1 flex justify-between text-xs text-slate-500"><span>${hs.linked ? "Saved link" : "New link, saved after the write"}</span>${hs.linked ? '<button id="hs-relink" class="text-blue-600 hover:underline">Change link</button>' : '<button id="hs-back" class="text-blue-600 hover:underline">Choose another</button>'}</div></div>
    <div class="mt-3 text-xs font-semibold text-slate-600">Selected in the profile: ${esc(want.label)}</div>${warn}
    <table class="mt-3 w-full text-sm tabular-nums"><thead class="text-[11px] uppercase tracking-wider text-slate-500"><tr><th class="py-1 text-left font-medium">Will be written</th><th class="py-1 px-2 text-right font-medium">Now in HubSpot</th><th class="py-1 pl-2 text-right font-medium">New value</th></tr></thead><tbody>
      ${row("Size Discount %", pctShow(hsNum(deal.size_discount)), pct(want.size), sameNum(deal.size_discount, hsPct(want.size)))}
      ${row("Speed Discount %", pctShow(hsNum(deal.speed_discount)), pct(want.speed), sameNum(deal.speed_discount, hsPct(want.speed)))}
      ${row("Term Length Discount %", pctShow(hsNum(deal.term_length_discount)), pct(want.term), sameNum(deal.term_length_discount, hsPct(want.term)))}
      ${row("Term Length (Years)", deal.term_length_years || "not set", String(want.termYears), String(deal.term_length_years) === String(want.termYears))}</tbody></table>
    <table class="mt-3 w-full text-sm tabular-nums"><thead class="text-[11px] uppercase tracking-wider text-slate-500"><tr><th class="py-1 text-left font-medium">HubSpot recalculates, then checked</th><th class="py-1 px-2 text-right font-medium">Now</th><th class="py-1 pl-2 text-right font-medium">Tool</th></tr></thead><tbody>
      <tr class="border-t border-slate-100"><td class="py-1.5">Total Discount %</td><td class="py-1.5 px-2 text-right font-mono text-slate-600">${pctShow(hsNum(deal.total_discount))}</td><td class="py-1.5 pl-2 text-right font-mono font-semibold">${pct(want.total)}</td></tr>
      <tr class="border-t border-slate-100"><td class="py-1.5">Actual Value per Patient (Calculated)</td><td class="py-1.5 px-2 text-right font-mono text-slate-600">${deal.actual_value_per_patient_calculated ? "£" + rate3(deal.actual_value_per_patient_calculated) : "not set"}</td><td class="py-1.5 pl-2 text-right font-mono font-semibold">£${rate3(want.rate)}</td></tr></tbody></table>
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="mt-4 flex justify-end gap-2"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-write" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Write to HubSpot</button></div>`);
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
    await hsCall({ action: "write", ods: p.ods_code, companyId: company.id, dealId: deal.id, deal: dealProps, company: companyProps });
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
    const done = okT && okV;
    msg.innerHTML = `<div class="space-y-2">${line(okT, "Total Discount %", last.total_discount == null ? "not set" : pct(hsNum(last.total_discount) / HS_PCT), pct(want.total))}
      ${line(okV, "Actual Value per Patient (Calculated)", blankV ? "not set" : "£" + rate3(last.actual_value_per_patient_calculated), "£" + rate3(want.rate))}</div>
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
  return { name: p.practice_name, partner_organisation_code: p.ods_code, patient_list_size: p.total_patients, address: p.address || undefined, city: p.town || undefined, zip: p.postcode || undefined,
    phone: p.main_phone || undefined, website: p.website || undefined, country: p.country || "England" };
}
function hsCreatePreview() {
  const { p, cdata } = hs, props = hsCompanyProps(p), shown = Object.entries(props).filter(([, v]) => v !== undefined && v !== "");
  const label = { name: "Name", partner_organisation_code: "GP ODS Code", patient_list_size: "Patient list size", address: "Address", city: "Town", zip: "Postcode", phone: "Phone", website: "Website", country: "Country" };
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
