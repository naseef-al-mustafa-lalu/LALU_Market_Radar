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
function hsLineWanted(p, monthly, yrs, rate, list) {      // Annual / Monthly name the contract TERM (and the product); everyone is billed monthly, so prices are always per patient per month
  const [productId, productName] = HS_PRODUCTS[`${product}|${monthly ? "monthly" : "annual"}`];
  return { productId, productName, quantity: p.total_patients, listUnit: Math.round(list * 10000) / 10000, netUnit: Math.round(rate * 10000) / 10000, term: monthly ? 1 : 12 * yrs, termMonths: null,
    frequency: "monthly", terms: "AUTOMATICALLY_RENEW", payments: null };
}
const hsOurLine = pair => (pair?.lineItems || []).find(l => HS_PRODUCT_IDS.has(String(l.hs_product_id)));
// How the deal's current tool line item compares with the wanted one (null when there is none or the token cannot read line items).
function hsLineStatus(want, pair) {
  if (pair?.lineItems == null) return { unreadable: true };
  const cur = hsOurLine(pair), w = want.line;
  if (!cur) return { action: "create", same: false, cur: null };
  const sameProduct = String(cur.hs_product_id) === w.productId, unit = Number(cur.price) || w.listUnit;
  const same = sameProduct && Number(cur.quantity) === w.quantity && Math.abs(unit - w.listUnit) < 0.0006 && Math.abs((Number(cur.discount) || 0) - Math.max(0, w.listUnit - w.netUnit)) < 0.0006 && cur.recurringbillingfrequency === "monthly";
  return { action: sameProduct ? "update" : "replace", same, cur, unit };
}

// What the profile currently has selected, as the values HubSpot should hold.
function hsDesired(p, ov) {   // ov: { referral, member } prices another practice of a saved group without touching the profile's own referral state
  const row = cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier), monthly = billing === "monthly";
  const size = monthly ? 0 : Number(row.size_discount), term = monthly ? 0 : termDiscount(termYrs), speed = monthly || !speedOn ? 0 : Number(row.speed_discount);
  const referral = ov ? ov.referral : HS_REFERRAL_WRITES ? referralExtraFor(p) : 0;   // the conditional referral-group discount
  return { size, term, speed, referral, group: !ov && referral > 0 ? referralPayload(p) : null, member: ov ? ov.member : refMembership(p), termYears: monthly ? 1 : termYrs, tier: "Tier " + p.price_tier, model: product === "sar" ? "eMR+ SAR Only" : "Subscription", modelLabel: product === "sar" ? "ReportSure - MS - SAR Only" : "ReportSure - MS - All Reports", vpp: "£" + baseRate().toFixed(2), rate: dealRate(size + referral, term, speed), list: baseRate(),
    total: size + referral + term + speed, line: hsLineWanted(p, monthly, termYrs, dealRate(size + referral, term, speed), baseRate()), label: `${product === "sar" ? "SAR only" : "All reports"} · ${monthly ? "monthly plan" : `annual, ${termYrs}-year term`}${speed ? " · speed discount" : ""}` };
}
// The HubSpot section of the profile now holds facts only (status, links, lifecycle); the one action lives beside the price controls (hsBarHtml).
function hsSection(p, st) {
  const linked = !!p.hubspot_company_id, active = p.status === "Active" && p.total_patients > 0, when = [p.hubspot_company_imported_at && "Created from Atlas " + fmtDate(p.hubspot_company_imported_at), p.hubspot_synced_at && "last synced " + fmtDate(p.hubspot_synced_at)].filter(Boolean).join(" · ");
  return sec("HubSpot", kv("Status", chip(HS_LABEL[st], HS_CLS[st]) + (!linked && active && st !== "none" ? " " + chip("No company record", "bg-amber-100 text-amber-800") : "")) + kv("Company record", linked ? hsLink("0-2", p.hubspot_company_id, "Open in HubSpot") : "") + alignHsRows(p) + '<div id="dr-hsdeal"></div>' + kv("Open pipeline", Number(p.hubspot_pipeline) > 0 ? gbpFull(Number(p.hubspot_pipeline)) : "") + kv("Freemium conversion", p.hubspot_commercial_model === "Freemium" && p.hubspot_customer ? (Number(p.hubspot_conversion_pipeline) > 0 ? "Open conversion deal " + gbpFull(Number(p.hubspot_conversion_pipeline)) : '<span class="text-amber-700">No open conversion deal</span>') : (Number(p.hubspot_conversion_pipeline) > 0 ? "Open conversion deal " + gbpFull(Number(p.hubspot_conversion_pipeline)) : "")) + kv("Open renewal", Number(p.hubspot_renewal_pipeline) > 0 ? gbpFull(Number(p.hubspot_renewal_pipeline)) : "") + kv("Commercial model", p.hubspot_commercial_model ? esc(HS_COMPANY_MODEL[p.hubspot_commercial_model] || p.hubspot_commercial_model) : "") + kv("Lifecycle stage", esc(p.hubspot_stage))
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
  const writes = [hsSame(deal.size_discount, hsPct(want.size)), hsSame(deal.speed_discount, hsPct(want.speed)), hsSame(deal.term_length_discount, hsPct(want.term)), String(deal.term_length_years) === String(want.termYears), hsSame(deal.referral_discount || 0, hsPct(want.referral))];
  const line = hsLineStatus(want, pair);
  return { fixes, writes, line, count: fixes.filter(f => !f.same).length + writes.filter(s => !s).length + (line.unreadable || line.same ? 0 : 1) };
}
function hsBarHtml(p) {
  if (!p || p.status !== "Active" || !(p.total_patients > 0) || !p.price_tier) return "";
  const i = hsInfo[p.ods_code] || { loading: true }, linked = !!p.hubspot_company_id;   // not looked up yet counts as loading
  const act = (kind, label) => `<button type="button" data-hs-act="${kind}" data-ods="${esc(p.ods_code)}" class="shrink-0 rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">${label}</button>`;
  let dot = "bg-slate-300", text = "", right = "";
  if (!linked) { dot = "bg-amber-400"; text = "Not in HubSpot yet"; right = act("create", "Add to HubSpot"); }
  else if (i.loading) text = "Checking the linked deal…";
  else if (!i.link && p.hubspot_commercial_model === "Freemium") { dot = "bg-teal-500"; text = "Freemium customer: no deal needed"; right = act("push", "Manage in HubSpot"); }
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
// A line item the tool already put on this deal says how the contract is billed (SAR or all reports, monthly or annual): start the profile's plan from it, unless the user has already chosen one,
// so a monthly contract is not pushed as annual just because the profile defaults to annual.
function hsAdoptLine(p, pair) {
  const cur = hsOurLine(pair); if (!cur || pricingTouched || !document.querySelector(".price-card")) return;
  const hit = Object.entries(HS_PRODUCTS).find(([, v]) => v[0] === String(cur.hs_product_id)); if (!hit) return;
  const [prod, bill] = hit[0].split("|");      // the product names the term (annual or monthly plan); billing is monthly either way
  if (prod === product && bill === billing) return;
  product = prod; billing = bill; repaintPriceCards();
}
async function hsSetLink(p, link) {
  const i = hsInfo[p.ods_code] = { link: link || null, pair: null, loading: !!link, error: null }; hsRefreshBars();
  if (!link) return;
  try { i.pair = await hsCall({ action: "read", companyId: link.company_id, dealId: link.deal_id }); } catch (e) { i.error = e.message; }
  i.loading = false; hsRefreshBars(); if (i.pair && $("drawer") && !$("drawer").classList.contains("translate-x-full")) hsAdoptLine(p, i.pair);
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
