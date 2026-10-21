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
  $("rev-config").innerHTML = `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <h2 class="font-bold">How prices are worked out</h2>
      <div class="mt-2 grid gap-3 md:grid-cols-4 text-sm">
        ${[["1", "List price", `Per patient per month. All reports: £${rate3(list)} annual, £${rate3(mList)} monthly. SAR only: £${rate3(sarList)} annual, £${rate3(mSar)} monthly.`], ["2", "Discounts add together", "Annual plans only; monthly plans pay the list price. Size discount (by tier), plus a term discount for 2 or 3-year commitments, plus an optional speed discount that applies to every year of the term and ends at renewal. The percentages are summed and taken off the list price."], ["3", "Price floor", "On All reports annual plans the price never drops below the floor price per patient, whatever the discounts add up to. The floor does not apply to SAR only."], ["4", "× patients × 12", "Annual revenue = price per patient per month × registered patients × 12. Switch product and billing on any profile's price card."]]
          .map(([n, h, t]) => `<div class="flex gap-2"><span class="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-800 text-xs font-bold flex items-center justify-center">${n}</span><div><div class="font-semibold">${h}</div><div class="text-xs text-slate-500">${t}</div></div></div>`).join("")}
      </div>
      <p class="mt-3 text-xs text-slate-500">The routes below are alternatives, not additive. Rates live in the <code>pricing_tiers</code> and <code>pricing_settings</code> tables (Supabase > Table Editor); changes show here and in every profile straight away.</p>
    </div>` + `<div class="grid gap-4 lg:grid-cols-2">` + ROUTES.map(([r, name, blurb]) => `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4"><h3 class="font-bold">${name}</h3><p class="text-xs text-slate-500 mb-2">${blurb}</p>${table(r)}</div>`).join("") + `</div>` +
    (settings.length ? `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4"><h3 class="font-bold mb-1">Other settings</h3>${settings.map(x => `<div class="flex justify-between border-t border-slate-100 py-1 text-sm first:border-0"><span class="text-slate-500">${esc(x.description || x.key)}</span><span class="font-mono">${esc(x.value)}</span></div>`).join("")}</div>` : "");
}
