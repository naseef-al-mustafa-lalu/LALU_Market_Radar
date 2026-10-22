// Practices tab: filters, rows, pricing breakdown and the practice profile panel.
/* ---------- practices: filters, chips, sorting ---------- */
const netMatch = (p, nf) => !nf || (nf.kind === "pcn" ? p.pcn_code === nf.key : nf.kind === "group" ? p.cqc_provider_id === nf.key
  : nf.kind === "federation" ? (p.gp_federation || "").toLowerCase() === nf.key : (p.icb_name || "").toLowerCase() === nf.key);
const SORTERS = {
  name: p => (p.practice_name || "").toLowerCase(), patients: p => p.total_patients || 0, arr: p => p.est_arr || 0, arr_sar: p => p.est_arr_sar || 0, contracted: p => p.hubspot_contracted_arr || 0,
  cqc: p => CQC_RANK[p.cqc_rating] || 9, hubspot: p => HS_RANK[hsState(p)] };
function applyFilters() {
  const q = $("f-search").value.trim().toLowerCase(), t = $("f-tier").value, sw = $("f-sw").value, hs = $("f-hs").value,
        cqcf = $("f-cqc").value, icb = $("f-icb").value, ctry = $("f-country").value, sz = $("f-size").value, stf = $("f-status").value, sig = $("f-sig").checked, grp = $("f-grp").checked;
  const bHits = q.length >= 3 ? branches.filter(b => [b.branch_name, b.branch_code, b.postcode, b.town].some(v => (v || "").toLowerCase().includes(q))) : [];
  branchHit = new Map();
  for (const b of bHits) if (b.kind === "gp_practice") branchHit.set(b.parent_code, [...(branchHit.get(b.parent_code) || []), b.branch_name]);
  renderBranchHits(bHits.filter(b => b.kind !== "gp_practice"));
  filtered = practices.filter(p =>
    (stf === "all" || (stf === "merged" ? !!p.merged_into : stf === "closed" ? isClosed(p) && !p.merged_into : p.status === "Active" && !p.merged_into && !isClosed(p))) && netMatch(p, netFilter) && (!t || tier(p) === t) && (!sw || p.clinical_software === sw) && (!hs || (hs === "missing" ? !p.hubspot_company_id && p.status === "Active" && p.total_patients > 0 : hsState(p) === hs)) &&
    (!cqcf || (cqcf === "None" ? !p.cqc_rating : p.cqc_rating === cqcf)) && (!icb || p.icb_name === icb) && (!ctry || (p.country || "England") === ctry) && (!sz || (sz === "yes") === (p.total_patients > 0)) &&
    (!sig || signalCodes.has(p.ods_code)) && (!grp || p.group_size > 1) &&
    (!q || [p.practice_name, p.ods_code, p.pcn_name, p.manager_name, p.postcode, p.group_name, p.gp_federation, p.town].some(v => (v || "").toLowerCase().includes(q)) || branchHit.has(p.ods_code)));
  const f = SORTERS[sort.key], by = (a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.total_patients - a.total_patients; };
  filtered.sort(by);
  renderChips(); renderSortHeaders();
  shown = 0; $("rows").innerHTML = ""; renderMore();
  $("count").textContent = `${filtered.length.toLocaleString()} practices`;
  stateToUrl();
}
// Branch surgeries whose parent is not a practice in Atlas (closed, or not a GP practice): shown above the table so they can still be found
function renderBranchHits(list) {
  const box = $("branch-hits"), show = list.slice(0, 8);
  box.classList.toggle("hidden", !show.length);
  box.innerHTML = show.length ? `<div class="font-semibold mb-1">Branch sites with no practice in Atlas${list.length > show.length ? " (first " + show.length + " of " + list.length + ")" : ""}</div>` +
    show.map(b => `<div>${esc(b.branch_name)} <span class="font-mono text-xs">${esc(b.branch_code)}</span> · ${esc(b.postcode || "")} · belongs to ${esc(b.parent_name || b.parent_code || "an unknown organisation")} <span class="font-mono text-xs">${esc(b.parent_code || "")}</span> ${chip(b.kind === "non_gp" ? "Non-GP: " + (b.parent_role_name || "organisation") : "GP practice not in Atlas", "bg-slate-200 text-slate-700")}</div>`).join("") : "";
}
// A practice's branch sites (ODS role Branch Surgery): list size, price and HubSpot all stay on the practice
function branchSection(p) {
  const list = branchesByParent.get(p.ods_code);
  return list ? sec("Branch sites", list.map(b => `<div class="text-sm py-1"><div class="font-semibold">${esc(b.branch_name)} <span class="font-mono text-xs text-slate-500">${esc(b.branch_code)}</span></div>
    <div class="text-xs text-slate-500">${[b.address, b.town, b.postcode].filter(Boolean).map(esc).join(", ")}${b.opened ? " · opened " + esc(fmtDate(b.opened)) : ""}${b.phone ? " · " + esc(b.phone) : ""}</div></div>`).join("")) : "";
}
function renderChips() {
  const box = $("f-chips"); box.innerHTML = "";
  const add = (label, clear) => { const c = document.createElement("span"); c.className = "chip bg-indigo-50 text-indigo-800 border border-indigo-100"; c.innerHTML = `${esc(label)} <button class="ml-0.5 font-bold" aria-label="Remove filter">✕</button>`; c.querySelector("button").onclick = clear; box.appendChild(c); };
  const sel = (id, label) => { const el = $(id); if (el.value) add(label + ": " + el.options[el.selectedIndex].text, () => { el.value = ""; applyFilters(); }); };
  if (netFilter) {
    if (fromNetworks) { const b = document.createElement("button"); b.className = "text-sm text-lalu-teal-700 hover:underline mr-1"; b.textContent = "← Back to networks"; b.onclick = () => { netFilter = null; fromNetworks = false; showTab("networks"); applyFilters(); }; box.appendChild(b); }
    add((NET_KINDS[netFilter.kind] || "").replace(/s$/, "") + ": " + netFilter.label, () => { netFilter = null; fromNetworks = false; applyFilters(); });
  }
  if ($("f-search").value.trim()) add("Search: " + $("f-search").value.trim(), () => { $("f-search").value = ""; applyFilters(); });
  sel("f-tier", "Tier"); sel("f-hs", "HubSpot"); sel("f-sw", "System"); sel("f-cqc", "CQC"); sel("f-icb", "ICB"); sel("f-country", "Country"); sel("f-size", "List size"); sel("f-status", "Status");
  if ($("f-sig").checked) add("Has recent signals", () => { $("f-sig").checked = false; applyFilters(); });
  if ($("f-grp").checked) add("Group-run only", () => { $("f-grp").checked = false; applyFilters(); });
  if (box.children.length > 1 || (box.children.length === 1 && !netFilter)) {
    const x = document.createElement("button"); x.className = "text-xs text-slate-500 hover:text-slate-800 underline"; x.textContent = "Clear all";
    x.onclick = clearFilters; box.appendChild(x);
  }
}
function clearFilters() {
  for (const id of ["f-search", "f-tier", "f-sw", "f-hs", "f-cqc", "f-icb", "f-country", "f-size", "f-status"]) $(id).value = "";
  $("f-sig").checked = false; $("f-grp").checked = false; netFilter = null; fromNetworks = false; applyFilters();
}
function renderSortHeaders() {
  document.querySelectorAll("#view-practices th[data-sort]").forEach(th => {
    th.tabIndex = 0; th.setAttribute("role", "button"); th.setAttribute("aria-sort", th.dataset.sort === sort.key ? (sort.dir === 1 ? "ascending" : "descending") : "none");
    th.querySelector(".arrow")?.remove();
    if (th.dataset.sort === sort.key) th.insertAdjacentHTML("beforeend", `<span class="arrow ml-1 text-slate-700">${sort.dir === 1 ? "▲" : "▼"}</span>`);
  });
}
document.querySelectorAll("#view-practices th[data-sort]").forEach(th => th.onclick = () => {
  const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === "name" || k === "cqc" || k === "hubspot" ? 1 : -1) }; applyFilters(); });
$("f-more-btn").onclick = () => { const m = $("f-more"); m.classList.toggle("hidden"); $("f-more-btn").textContent = m.classList.contains("hidden") ? "More filters ▾" : "Fewer filters ▴"; };
["f-search", "f-tier", "f-sw", "f-hs", "f-cqc", "f-icb", "f-country", "f-size", "f-status", "f-sig", "f-grp"].forEach(id => $(id).addEventListener(id === "f-search" ? "input" : "change", applyFilters));

/* ---------- practices: compact rows ---------- */
function networkCell(p) {
  const bits = [];
  if (p.pcn_code) bits.push(`<span class="text-xs text-slate-700" title="${esc(p.pcn_name)}">${esc(p.pcn_name)}</span>`);
  if (p.group_size > 1) bits.push(chip((p.group_name || "Group") + " · " + p.group_size, "bg-indigo-100 text-indigo-800"));
  if (p.gp_federation) bits.push(chip(p.gp_federation, "bg-teal-100 text-teal-800"));
  return bits.length ? `<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 max-w-[16rem]">${bits.join("")}</div>` : '<span class="text-slate-300">–</span>';
}
function cqcCell(p) {
  if (!p.cqc_rating) return '<span class="text-slate-300">–</span>';
  return CQC_CHIP[p.cqc_rating] ? chip(p.cqc_rating, CQC_CHIP[p.cqc_rating], p.cqc_last_inspection ? "Inspected " + p.cqc_last_inspection : "") : `<span class="text-xs text-slate-500" title="${p.cqc_last_inspection ? "Inspected " + esc(p.cqc_last_inspection) : ""}">${esc(p.cqc_rating)}</span>`;
}
// A paying customer with a real contract value: the profile leads with the contract, not the list-price estimate. Freemium and customers with no value yet keep the pricing section.
const isPaying = p => p.hubspot_customer && p.hubspot_commercial_model !== "Freemium" && Number(p.hubspot_contracted_arr) > 0;
function contractSection(p) {
  const c = Number(p.hubspot_contracted_arr), est = Number(p.est_arr), end = p.hubspot_contract_end, days = end ? Math.round((new Date(end) - Date.now()) / 864e5) : null;
  const renew = end ? esc(fmtDate(end)) + " " + (days < 0 ? chip("Past renewal date", "bg-red-100 text-red-800") : days <= 90 ? chip("Renews in " + days + " days", "bg-amber-100 text-amber-800") : "") : "";
  return sec("Contract", kv("Contracted ARR", `<span class="font-mono font-semibold text-teal-700">${gbpFull(c)}</span> <span class="text-xs text-slate-500">${p.hubspot_contracted_src === "deal" ? "from closed-won deals, unverified" : "Service ACV"}</span>`) +
    kv("Contract start", p.hubspot_contract_start ? esc(fmtDate(p.hubspot_contract_start)) : "") + kv("Renewal date", renew) +
    (est > 0 ? `<div class="text-xs text-slate-500 mt-1">List-price estimate ${gbpFull(est)}; the contract is ${c >= est ? "+" : "−"}${gbpFull(Math.abs(c - est))} against it.</div>` : ""));
}
// Operational period from the ODS API: opened date, and the closed date once it has one
const opPeriod = p => p.operational_start_date || p.operational_end_date ? esc((p.operational_start_date ? "Opened " + fmtDate(p.operational_start_date) : "") + (p.operational_end_date ? (p.operational_start_date ? " · " : "") + "Closed " + fmtDate(p.operational_end_date) : "")) : "";
function hsCell(p) {
  const st = hsState(p), stage = p.hubspot_stage;
  const tip = p.hs_contacts === 0 ? "No contact yet" : p.hs_primary_imported ? "Key contact imported " + fmtDate(p.hs_primary_imported_at) : p.hs_imported > 0 ? p.hs_imported + " of " + p.hs_contacts + " contacts imported" : "Contact not imported";
  const main = st === "customer" || st === "freemium" || st === "engaged" ? chip(HS_LABEL[st], HS_CLS[st], tip) : `<span class="text-xs ${st === "imported" || st === "company" ? "text-slate-600" : "text-slate-300"}" title="${esc(tip)}">${st === "imported" || st === "company" ? "In HubSpot" : "–"}</span>`;
  // the HubSpot lifecycle stage sits under the status (hidden when it only repeats the chip)
  return `<div class="leading-tight">${main}</div>${stage && stage !== "Customer" ? `<div class="mt-0.5 text-[11px] text-slate-500" title="HubSpot lifecycle stage">${esc(stage)}</div>` : ""}`;
}
function renderMore() {
  const slice = filtered.slice(shown, shown + PAGE); shown += slice.length;
  const frag = document.createDocumentFragment();
  for (const p of slice) {
    const tr = document.createElement("tr"); tr.dataset.ods = p.ods_code; tr.tabIndex = 0; tr.setAttribute("role", "button");
    tr.className = "hover:bg-lalu-teal-50/50 cursor-pointer" + (p.ods_code === drawerCode ? " bg-lalu-teal-50" : "");
    const sig = signalCounts.get(p.ods_code), hasN = p.total_patients > 0;
    tr.innerHTML = `
      <td class="px-3 py-2"><div class="font-semibold text-slate-900 leading-tight">${esc(p.practice_name)}${branchHit.has(p.ods_code) ? " " + chip("Branch: " + branchHit.get(p.ods_code)[0] + (branchHit.get(p.ods_code).length > 1 ? " +" + (branchHit.get(p.ods_code).length - 1) : ""), "bg-sky-100 text-sky-800", "A branch surgery of this practice matched your search") : ""}${sig ? " " + chip(sig + " signal" + (sig > 1 ? "s" : ""), "bg-purple-100 text-purple-800") : ""}${p.merged_into ? " " + chip("Merged → " + ((byOds.get(p.merged_into) || {}).practice_name || p.merged_into), "bg-indigo-100 text-indigo-800") : isClosed(p) ? " " + chip("Closed", "bg-slate-200 text-slate-700") : mergeSugg.has(p.ods_code) || closureCands.has(p.ods_code) ? " " + chip("May have closed or merged", "bg-amber-100 text-amber-800", "Review in Signals > Closures and mergers") : ""}</div>
        <div class="text-xs text-slate-500 font-mono">${esc(p.ods_code)} · ${esc(p.town || p.postcode || "")}</div></td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${hasN ? `<span class="font-mono font-semibold">${p.total_patients.toLocaleString()}</span> ${chip(tier(p).replace("Tier ", "T"), TIER_CLS[tier(p)] || "", p.tier_label || "")}` : `<span class="text-xs text-slate-500 underline decoration-dotted cursor-help" title="${esc(noSizeReason(p))}">${p.merged_into ? "Merged" : isClosed(p) ? "Closed" : "No list size"}</span>`}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${hasN ? `<span class="font-mono font-semibold text-emerald-700" title="£${rate3(Number(p.base_price))} per patient per month">${gbpFull(p.est_arr)}</span>` : '<span class="text-slate-300">–</span>'}</td>
      <td class="hidden xl:table-cell px-3 py-2 text-right whitespace-nowrap">${hasN && p.est_arr_sar != null ? `<span class="font-mono text-slate-600" title="£${rate3(Number(p.base_price_sar))} per patient per month, SAR only">${gbpFull(p.est_arr_sar)}</span>` : '<span class="text-slate-300">–</span>'}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${contractedCell(p)}</td>
      <td class="px-3 py-2">${networkCell(p)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${cqcCell(p)}</td>
      <td class="px-3 py-2">${p.manager_name ? `<div class="font-medium leading-tight">${esc(p.manager_name)}</div><div class="text-xs text-slate-500">${esc(p.manager_title)}</div>` : '<span class="text-xs text-slate-300">no contact yet</span>'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${hsCell(p)}</td>`;
    tr.onclick = () => openDrawer(p);
    frag.appendChild(tr);
  }
  $("rows").appendChild(frag);
  $("more").classList.toggle("hidden", shown >= filtered.length);
  if (!filtered.length) $("rows").innerHTML = '<tr><td colspan="9" class="p-6 text-center text-slate-500 italic">No practices match these filters.</td></tr>';
}
$("more").addEventListener("click", renderMore);

/* ---------- price breakdown: headline figure, then the working in plain steps ---------- */
// Price = list price less the SUM of the selected discounts (size + term + speed), never below the price floor.
// Term and speed are choices, not guarantees, so they are switches shared by every price card on the page.
let speedOn = false, termYrs = 1, billing = "annual", product = "all";   // billing: "annual" or "monthly" (rolling, no discounts); product: "all" reports or "sar" only
const priceCards = new Map();
const setting = k => Number(cfgSettings[k]?.value || 0);
const termDiscount = yrs => yrs >= 3 ? setting("term_discount_3yr") : yrs === 2 ? setting("term_discount_2yr") : 0;
// Rates are quoted per patient per MONTH (as in the pricing sheet); annual revenue = patients x rate x 12.
const baseRate = () => setting(`${billing === "monthly" ? "monthly_" : ""}list_price_${product === "sar" ? "sar_" : ""}per_patient`);
const yearly = (patients, rate) => patients * rate * 12;
// Discounts (size + term + speed) apply to annual plans only; monthly plans pay the list rate. The price floor protects All reports only.
const dealRate = (size, term, speed) => billing === "monthly" ? baseRate()
  : product === "sar" ? baseRate() * (1 - size - term - speed) : Math.max(setting("price_floor_per_patient"), baseRate() * (1 - size - term - speed));
function priceCard(args) {
  const id = "pc" + priceCards.size; priceCards.set(id, args);
  return `<div class="price-card" data-pc="${id}">${priceCardBody(args, id)}</div>`;
}
function repaintPriceCards() { const live = new Set([...document.querySelectorAll(".price-card")].map(el => el.dataset.pc)); for (const k of priceCards.keys()) if (!live.has(k)) priceCards.delete(k); document.querySelectorAll(".price-card").forEach(el => { el.innerHTML = priceCardBody(priceCards.get(el.dataset.pc), el.dataset.pc); }); document.querySelectorAll(".route-cmp").forEach(el => { el.innerHTML = routeCmpPractice ? routeComparisonBody(routeCmpPractice) : ""; }); if (typeof hsRefreshBars === "function") hsRefreshBars(); }
document.addEventListener("click", e => {
  const sw = e.target.closest(".speed-toggle"), bl = e.target.closest(".bill-opt"), pr = e.target.closest(".prod-opt");
  if (sw) { speedOn = !speedOn; repaintPriceCards(); document.querySelector(".speed-toggle")?.focus({ preventScroll: true }); }
  else if (bl) { billing = bl.dataset.b; repaintPriceCards(); document.querySelector(`.bill-opt[data-b="${billing}"]`)?.focus({ preventScroll: true }); }
  else if (pr) { product = pr.dataset.p; repaintPriceCards(); document.querySelector(`.prod-opt[data-p="${product}"]`)?.focus({ preventScroll: true }); }
});
document.addEventListener("click", e => { const b = e.target.closest(".term-opt"); if (b) { termYrs = Number(b.dataset.yrs); repaintPriceCards(); document.querySelector(`.term-opt[data-yrs="${termYrs}"]`)?.focus({ preventScroll: true }); } });
function priceCardBody({ patients, tierRow, route, who }, id) {
  const monthly = billing === "monthly", sar = product === "sar", list = baseRate(), prodName = sar ? "SAR only" : "All reports";
  if (!tierRow || !patients) return '<p class="text-sm italic text-slate-500">No price yet: this needs a list size and a price tier for this route.</p>';
  const size = monthly ? 0 : Number(tierRow.size_discount), speed = monthly ? 0 : Number(tierRow.speed_discount), term = monthly ? 0 : termDiscount(termYrs), floor = setting("price_floor_per_patient");
  const useSpeed = speedOn && speed > 0;
  // The speed discount applies to every year of the term and ends at renewal.
  const termRate = dealRate(size, term, useSpeed ? speed : 0), renewal = dealRate(size, term, 0);
  const sum = size + term + (useSpeed ? speed : 0), floored = !sar && !monthly && list * (1 - sum) < floor - 1e-9;
  const sub = t => `<div class="text-xs text-slate-500 font-normal leading-snug">${t}</div>`, amt = x => "−£" + rate3(x);
  const line = (label, detail, pctText, value, cls = "") => `<tr class="border-t border-emerald-100 ${cls}"><td class="py-1.5 pr-3 align-top"><div class="font-medium leading-snug">${label}</div>${detail ? sub(detail) : ""}</td><td class="py-1.5 px-2 text-right align-top whitespace-nowrap text-slate-600">${pctText}</td><td class="py-1.5 pl-2 text-right align-top whitespace-nowrap font-mono">${value}</td></tr>`;
  const adj = termRate - list * (1 - sum);
  const rowsHtml = [
    line("List price", `${prodName} · ` + (monthly ? "monthly plan, rolling, no discounts" : `annual plan, ${termYrs}-year commitment`), "", `£${rate3(list)} <span class="text-xs font-normal text-slate-500">/ month</span>`, "border-t-0"),
    monthly ? "" : line("Size discount", `${chip("Tier " + tierRow.tier, TIER_CLS["Tier " + tierRow.tier] || "")} ${esc(tierRow.label)}${who ? ", " + esc(who) : ""}`, "−" + pct(size), amt(list * size)),
    term ? line("Term discount", `${termYrs}-year commitment`, "−" + pct(term), amt(list * term)) : "",
    useSpeed ? line("Speed discount", termYrs > 1 ? "Every year of the term, not guaranteed" : "Term year, not guaranteed", "−" + pct(speed), amt(list * speed)) : "",
    adj > 1e-9 ? line("Price floor", `Never below £${rate3(floor)} per month`, "", "+£" + rate3(adj)) : "",
    line("Price per patient per month", "", monthly ? "" : `${pct(1 - termRate / list)} off`, `£${rate3(termRate)} <span class="text-xs font-normal text-slate-500">/ month</span>`, "font-semibold border-t-2 border-emerald-200"),
    line(`× ${patients.toLocaleString()} patients × 12 months`, "Per year", "", gbpFull(yearly(patients, termRate)), "font-semibold")
  ].join("");
  // Price by year: every term year pays the same rate; the speed discount ends at renewal.
  const yrRows = [], N = monthly ? 1 : termYrs, tT = yearly(patients, termRate), rT = yearly(patients, renewal);
  const yr = (label, rate, total, bold) => `<tr class="border-t border-emerald-100 ${bold ? "font-semibold" : ""}"><td class="py-1 pr-3">${label}</td><td class="py-1 px-2 text-right whitespace-nowrap">${rate == null ? "" : "−" + pct(1 - rate / list)}</td><td class="py-1 px-2 text-right whitespace-nowrap font-mono">${rate == null ? "" : `£${rate3(rate)} /mo`}</td><td class="py-1 pl-2 text-right whitespace-nowrap font-mono">${total}</td></tr>`;
  if (N > 1) for (let y = 1; y <= N; y++) yrRows.push(yr("Year " + y, termRate, gbpFull(tT)));
  if (N > 1) yrRows.push(yr(`Total over ${N} years`, null, gbpFull(tT * N), true));
  if (useSpeed) yrRows.push(yr(N > 1 ? `Renewal (year ${N + 1} onwards)` : "Renewal (year 2 onwards)", renewal, gbpFull(rT) + " /yr"));
  const th = (t, c = "") => `<th class="py-1 ${c} font-medium whitespace-nowrap">${t}</th>`;
  const yearTable = yrRows.length ? `<div class="mt-3"><div class="text-xs font-semibold text-slate-600 mb-0.5">Price by year</div><table class="w-full text-sm tabular-nums"><caption class="sr-only">Discount, price per patient and total for each year of the contract</caption><thead class="text-[11px] uppercase tracking-wider text-slate-500"><tr>${th("Period", "text-left pr-3")}${th("Discount", "text-right px-2")}${th("Per patient", "text-right px-2")}${th("Total", "text-right pl-2")}</tr></thead><tbody>${yrRows.join("")}</tbody></table>${useSpeed ? '<p class="mt-0.5 text-xs text-slate-500">The speed discount applies for the whole term and ends at renewal.</p>' : ""}</div>` : "";
  const steps = `<table class="mt-3 w-full text-sm tabular-nums"><caption class="sr-only">How the price is built</caption><thead class="sr-only"><tr><th>Step</th><th>Discount</th><th>Per patient</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  const opts = [1, 2, 3].map(y => `<button type="button" class="term-opt flex-1 rounded-md border px-2 py-1.5 text-left ${y === termYrs ? "border-emerald-600 bg-white ring-1 ring-emerald-600" : "border-slate-300 bg-white/60 hover:bg-white"}" data-yrs="${y}" aria-pressed="${y === termYrs}">
      <div class="text-xs font-semibold">${y} year${y > 1 ? "s" : ""}${y > 1 ? ` <span class="font-normal text-slate-500">−${pct(termDiscount(y))}</span>` : ""}</div><div class="font-mono text-sm">${gbpFull(yearly(patients, dealRate(size, termDiscount(y), useSpeed ? speed : 0)))}<span class="text-xs text-slate-500"> /yr</span></div></button>`).join("");
  const seg = (label, cls, key, cur, items) => `<div class="inline-flex rounded-lg bg-white/70 border border-slate-300 p-0.5 text-xs font-semibold" role="group" aria-label="${label}">${items.map(([k, l]) => `<button type="button" class="${cls} rounded-md px-3 py-1 ${cur === k ? "bg-emerald-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"}" data-${key}="${k}" aria-pressed="${cur === k}">${l}</button>`).join("")}</div>`;
  return `<div class="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
    <div class="flex items-end justify-between gap-3">
      <div><div class="text-xs uppercase tracking-wider text-slate-500">Estimated annual revenue · ${prodName}${monthly ? " · monthly plan" : termYrs > 1 ? ` · ${termYrs}-year term` : ""}</div><div class="text-2xl font-bold text-emerald-700 leading-tight">${gbpFull(tT)}<span class="text-sm font-normal text-slate-500"> / year</span></div></div>
      ${useSpeed ? `<div class="text-right"><div class="text-xs uppercase tracking-wider text-slate-500">On renewal</div><div class="text-lg font-semibold leading-tight">${gbpFull(rT)}</div><div class="text-xs text-slate-500">speed discount ends</div></div>` : ""}</div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div class="flex flex-wrap items-center gap-2">${seg("Product", "prod-opt", "p", product, [["all", "All reports"], ["sar", "SAR only"]])}${seg("Billing", "bill-opt", "b", billing, [["annual", "Annual"], ["monthly", "Monthly"]])}</div>
      ${!monthly && Number(tierRow.speed_discount) > 0 ? `<div class="flex items-center gap-2 text-xs text-slate-600"><span id="spd-l-${id}">${pct(Number(tierRow.speed_discount))} speed discount <span class="text-slate-400">(not guaranteed)</span></span><button type="button" role="switch" aria-checked="${speedOn}" aria-labelledby="spd-l-${id}" class="speed-toggle relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${speedOn ? "bg-emerald-600" : "bg-slate-300"}"><span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${speedOn ? "translate-x-4" : "translate-x-0.5"}"></span></button></div>` : ""}</div>
    ${monthly ? `<p class="mt-2 text-xs text-slate-500">Monthly plans are rolling with no commitment, so no discounts apply. Switch to Annual for size, term and speed discounts.</p>` :
      `<div class="mt-3"><div class="text-xs font-semibold text-slate-600 mb-1">Contract term <span class="font-normal text-slate-500">(longer commitments earn a discount)</span></div><div class="flex gap-2" role="group" aria-label="Contract term">${opts}</div></div>`}
    ${steps}${yearTable}
    </div>`;
}
// "Other ways to sign": follows the product, billing, term and speed choices on the price card, so every number on the profile agrees.
let routeCmpPractice = null;
function routeComparison(p) {
  routeCmpPractice = p;
  const inner = routeComparisonBody(p);
  return inner ? `<div class="route-cmp mt-3">${inner}</div>` : "";
}
function routeComparisonBody(p) {
  if (!(p.total_patients > 0) || p.est_arr == null) return "";
  const monthly = billing === "monthly", list = baseRate(), term = monthly ? 0 : termDiscount(termYrs), rows = [];
  const rateFor = row => { if (!row) return null; const sp = speedOn && !monthly ? Number(row.speed_discount) : 0; return dealRate(monthly ? 0 : Number(row.size_discount), term, sp); };
  const add = (kind, key, label) => {
    const n = networks.find(x => x.kind === kind && keyOf(x) === key);
    const price = n && n.network_tier ? rateFor(cfgTiers.find(t => t.route === kind && t.tier === n.network_tier)) : null;
    if (price == null) return;
    rows.push({ name: n.name, net: `${kind}|${esc(key)}|${esc(n.name)}`, sub: `${label} · Tier ${n.network_tier}`, sub2: `${Number(n.patients).toLocaleString()} patients across ${n.practices} practices`, price });
  };
  if (p.pcn_code) add("pcn", p.pcn_code, "PCN / cluster");
  if (p.group_size > 1) add("group", p.cqc_provider_id, "Provider group");
  if (p.gp_federation) add("federation", p.gp_federation.toLowerCase(), "Federation");
  const ownRate = rateFor(cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier));
  if (!rows.length || ownRate == null) return "";
  const alone = { name: "On its own", sub: `Single practice · Tier ${p.price_tier}`, sub2: `${p.total_patients.toLocaleString()} patients`, price: ownRate };
  const all = [alone, ...rows].map(r => ({ ...r, arr: yearly(p.total_patients, r.price) }));
  const best = Math.min(...all.map(r => r.price)), worst = Math.max(...all.map(r => r.price));
  const ctx = [product === "sar" ? "SAR only" : "All reports", monthly ? "monthly plan" : `annual, ${termYrs}-year term`, !monthly && speedOn ? "speed discount on" : null].filter(Boolean).join(" · ");
  const card = r => { const d = r.arr - all[0].arr, base = r === all[0];
    return `<div class="flex items-start justify-between gap-4 rounded-lg border ${base ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"} px-3 py-2.5">
      <div class="min-w-0"><div class="font-medium leading-tight">${base ? "On its own" : `<a href="#" class="text-lalu-teal-700 hover:underline" data-net="${r.net}">${esc(r.name)}</a>`}${r.price === best && best < worst ? ' <span class="ml-1 align-middle rounded-full bg-emerald-100 text-emerald-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Lowest</span>' : ""}</div>
        <div class="mt-0.5 text-xs text-slate-500">${esc(r.sub)}</div><div class="text-xs text-slate-400">${esc(r.sub2)}</div></div>
      <div class="shrink-0 text-right tabular-nums"><div class="font-mono font-semibold">${gbpFull(r.arr)}<span class="text-xs font-normal text-slate-500"> /yr</span></div>
        <div class="text-xs text-slate-600">${list > 0 && r.price < list - 1e-9 ? "−" + pct(1 - r.price / list) + " off · " : ""}£${rate3(r.price)} /mo</div>
        <div class="text-xs">${base ? '<span class="text-slate-400">baseline</span>' : Math.abs(d) < 1 ? '<span class="text-slate-500">same as alone</span>' : `<span class="font-medium ${d < 0 ? "text-emerald-700" : "text-amber-700"}">${d < 0 ? "−" : "+"}${gbpFull(Math.abs(d))} vs alone</span>`}</div></div></div>`; };
  return `<div class="text-xs font-semibold text-slate-600">Other ways to sign this practice</div><div class="text-xs text-slate-500 mb-1.5">${esc(ctx)}</div>
    <div class="space-y-2">${all.map(card).join("")}</div>
    <p class="mt-1.5 text-xs text-slate-500">Alternatives, not additive. A network price needs the whole network to sign.</p>`;
}

/* ---------- practice profile (side panel) ---------- */
const kv = (k, v) => v ? `<div class="flex justify-between gap-3 py-0.5 text-sm"><span class="text-slate-500 shrink-0">${k}</span><span class="text-right text-slate-800 break-words">${v}</span></div>` : "";
const sec = (title, body) => body && body.trim() ? `<section class="border-t border-slate-100 pt-3"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">${title}</h4>${body}</section>` : "";
let drawerOpener = null;
function drawerOpened() { if (!drawerOpener || !document.body.contains(drawerOpener)) drawerOpener = document.activeElement; $("dr-close").focus({ preventScroll: true }); }
function closeDrawer() { const was = !$("drawer").classList.contains("translate-x-full"); drawerCode = null; $("drawer").classList.add("translate-x-full");
  if (was && drawerOpener && document.body.contains(drawerOpener)) drawerOpener.focus({ preventScroll: true }); drawerOpener = null; stateToUrl(); document.querySelectorAll("#rows tr.bg-lalu-teal-50").forEach(r => r.classList.remove("bg-lalu-teal-50")); }
$("dr-close").onclick = closeDrawer;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
async function openDrawer(p) {
  drawerCode = p.ods_code;
  document.querySelectorAll("#rows tr").forEach(r => r.classList.toggle("bg-lalu-teal-50", r.dataset.ods === p.ods_code));
  drawerOpened(); $("drawer").classList.remove("translate-x-full");
  $("dr-title").textContent = p.practice_name; stateToUrl(); hsShowBar(p);
  const st = hsState(p);
  $("dr-sub").innerHTML = `<span class="font-mono">${esc(p.ods_code)}</span>${p.merged_into ? " " + chip("Merged", "bg-indigo-100 text-indigo-800") : isClosed(p) ? " " + chip("Closed", "bg-slate-200 text-slate-700") : ""}${p.town ? " · " + esc(p.town) : ""} ${p.total_patients > 0 ? chip(tier(p), TIER_CLS[tier(p)] || "") : ""} ${p.cqc_rating && CQC_CHIP[p.cqc_rating] ? chip(p.cqc_rating, CQC_CHIP[p.cqc_rating]) : ""}${p.cqc_status === "Deregistered" ? " " + chip("CQC deregistered", "bg-amber-100 text-amber-800", "CQC lists this location as deregistered; check whether the practice still operates") : ""} ${st === "customer" || st === "engaged" ? chip(HS_LABEL[st], HS_CLS[st]) : ""}`;
  const link = (label, kind, key) => `<a href="#" class="text-lalu-teal-700 hover:underline" data-net="${kind}|${esc(key)}|${esc(label)}">${esc(label)}</a>`;
  const web = p.website ? `<a class="text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="${esc(/^https?:/.test(p.website) ? p.website : "https://" + p.website)}">${esc(p.website)}</a>` : "";
  const addr = [p.address, p.town, p.county, p.postcode].filter(Boolean).map(esc).join(", ");
  const body = $("dr-body");
  body.innerHTML = mergeSection(p) + `<div id="dr-contacts" class="text-sm text-slate-500">Loading contacts…</div><div id="dr-signals"></div>` +
    sec("Practice details", kv("Address", addr) + kv("Country", p.country && p.country !== "England" ? esc(p.country) : "") + kv("Region", esc(p.region)) + kv("Clinical system", p.clinical_software !== "Unknown" ? esc(p.clinical_software) : '<span class="text-slate-500">Not identified</span>') +
      kv("Operational", opPeriod(p)) + kv("Website", web) + kv("Main phone", esc(p.main_phone)) +
      kv("Main email", p.main_email ? (p.main_email_opt_out ? "opt-out" : esc(p.main_email)) : "") + kv("GPs", esc(p.nhs_num_gp)) + kv("Employees", esc(p.num_employees)) + kv("Annual spend", esc(p.annual_spend)) + kv("Categories", esc(p.oscar_categories))) +
    branchSection(p) +
    sec("Network and ownership", kv("PCN", p.pcn_code ? link(p.pcn_name, "pcn", p.pcn_code) : "") + kv("Provider group", p.group_size > 1 ? link((p.group_name || "Group") + " (" + p.group_size + " practices)", "group", p.cqc_provider_id) : "") +
      kv("Federation", p.gp_federation ? link(p.gp_federation, "federation", p.gp_federation.toLowerCase()) : "") + kv("ICB", p.icb_name && p.icb_name !== "Unallocated ICB" ? link(p.icb_name, "icb", p.icb_name.toLowerCase()) : "")) +
    (isPaying(p) ? contractSection(p) : "") +
    (isPaying(p) ? "" : sec("Pricing", p.total_patients > 0 ? priceCard({ patients: p.total_patients, tierRow: cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier), route: "practice", arr: p.est_arr }) +
      `<div class="text-xs text-slate-500 mt-1">List size ${p.data_month ? "from " + esc(p.data_month) : ""}.</div>` + routeComparison(p) : `<p class="text-sm text-slate-600">No list size, so no price. ${esc(p.merged_into ? "Its patients are counted under the practice it merged into." : isClosed(p) ? "This practice has closed." : noSizeReason(p))}</p>`)) +
    sec("Quality and system", kv("CQC rating", p.cqc_rating ? (CQC_CHIP[p.cqc_rating] ? chip(p.cqc_rating, CQC_CHIP[p.cqc_rating]) : esc(p.cqc_rating)) : p.cqc_location_id ? '<span class="text-slate-500">Not rated yet</span>' : '<span class="text-slate-500" title="No CQC location could be matched to this practice by postcode and ODS code, so there is no rating, registration status or inspection date.">Not matched to a CQC location</span>') + kv("Registration", esc(p.cqc_status)) + kv("Last inspection", esc(p.cqc_last_inspection)) +
      kv("Manager absent since", esc(p.cqc_manager_absent_date)))  +
    hsSection(p, st) +
    sec("Notes (Oscar)", p.org_notes ? `<div class="text-sm text-slate-700 whitespace-pre-wrap">${esc(p.org_notes)}</div>` : "");
  body.scrollTop = 0;
  body.onclick = ev => { const a = ev.target.closest("a[data-net]"); if (a) { ev.preventDefault(); const [kind, key, label] = a.dataset.net.split("|"); openNetwork(kind, key, label); } };
  const jobs = jobAdverts.filter(j => j.ods_code === p.ods_code).sort((a, b) => (b.post_date || "").localeCompare(a.post_date || "")).slice(0, 8);
  const [{ data: cs }, { data: sg }, { data: hl }] = await Promise.all([
    db.from("contacts").select("*").eq("ods_code", p.ods_code).order("is_primary", { ascending: false }),
    db.from("sales_triggers").select("*").eq("ods_code", p.ods_code).order("detected_at", { ascending: false }).limit(10),
    db.from("hubspot_links").select("deal_id,deal_name").eq("ods_code", p.ods_code).limit(1)]);
  if (drawerCode !== p.ods_code) return;   // user moved on
  hsSetLink(p, hl && hl[0]);
  const dealBox = $("dr-hsdeal"); if (dealBox && hl && hl[0]) dealBox.outerHTML = kv("Linked deal", hsLink("0-3", hl[0].deal_id, hl[0].deal_name || "Open deal"));
  $("dr-contacts").outerHTML = `<section><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Contacts</h4>` + ((cs || []).map(c => `<div class="py-1.5 border-t border-slate-100 first:border-0"><b>${esc(c.full_name)}</b>${c.is_primary ? ' <span class="text-amber-500" title="Primary contact">★</span>' : ""}
      <span class="text-slate-500 text-sm"> · ${esc(c.job_title)}${c.dept ? " · " + esc(c.dept) : ""}</span>
      <div class="text-xs text-slate-600">${c.email ? (c.email_opt_out ? '<span class="text-rose-600">email opt-out</span>' : `<a class="text-lalu-teal-700 hover:underline" href="mailto:${esc(c.email)}">${esc(c.email)}</a>`) : ""} ${esc(c.phone)}</div>
      <div class="mt-0.5">${c.hubspot_status === "Imported" ? (c.hubspot_contact_id ? hsLink("0-1", c.hubspot_contact_id, "In HubSpot · " + fmtDate(c.hubspot_imported_at)) : chip("In HubSpot · " + fmtDate(c.hubspot_imported_at), "bg-emerald-100 text-emerald-800")) : chip("Not imported to HubSpot", "bg-slate-100 text-slate-500")}</div></div>`).join("") || '<p class="text-sm italic text-slate-500">No contacts yet (added when the Oscar file is loaded).</p>') + `</section>`;
  $("dr-signals").outerHTML = sec("Signals and hiring", sigTiles(sg || [], jobs));
}

/* signals and hiring in the profile: one collapsible tile each, newest unactioned signal open */
const SIG_DOT = { new: "bg-amber-400", in_progress: "bg-blue-500", done: "bg-emerald-500", dismissed: "bg-slate-300" };
const SIG_CHIP = { new: "bg-amber-100 text-amber-800", in_progress: "bg-blue-100 text-blue-800", done: "bg-emerald-100 text-emerald-800", dismissed: "bg-slate-100 text-slate-500" };
const tileChev = '<svg class="dchev h-4 w-4 shrink-0 text-slate-400 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>';
function sigTiles(sg, jobs) {
  const open = sg.findIndex(s => ["new", "in_progress"].includes(s.status || "new"));
  const sigTile = (s, i) => { const st = s.status || "new", type = String(s.trigger_type || "").replaceAll("_", " ").toLowerCase();
    return `<details class="dtile rounded-xl border border-slate-200 bg-white" ${i === open ? "open" : ""}>
      <summary class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50"><span class="h-2.5 w-2.5 shrink-0 rounded-full ${SIG_DOT[st]}"></span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-semibold">${esc(s.headline)}</span><span class="block truncate text-xs text-slate-500">${esc(fmtDate(s.detected_at))} · ${esc(type)}</span></span>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${SIG_CHIP[st]}">${esc(SIG_STATUS[st])}</span>${tileChev}</summary>
      <div class="space-y-2 border-t border-slate-100 px-3 py-2.5 text-sm">${s.description ? `<p class="text-slate-700">${esc(s.description)}</p>` : ""}
        ${s.action ? `<div class="rounded-lg bg-lalu-teal-50 p-2 text-blue-900"><div class="text-[11px] font-semibold uppercase tracking-wider text-lalu-teal-800">Next step</div><div class="mt-0.5">${esc(s.action)}</div></div>` : ""}
        ${s.url && /^https?:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="inline-block text-xs font-semibold text-lalu-teal-700 hover:underline">Open source ↗</a>` : ""}</div></details>`; };
  const jobTile = j => `<details class="dtile rounded-xl border border-slate-200 bg-white"><summary class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50"><span class="h-2.5 w-2.5 shrink-0 rounded-full bg-violet-400"></span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-semibold">${esc(j.title)}</span><span class="block truncate text-xs text-slate-500">${esc(j.matched_role)} · posted ${esc(fmtDate(j.post_date))}</span></span>
      ${j.close_date ? `<span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">closes ${esc(fmtDate(j.close_date))}</span>` : ""}${tileChev}</summary>
      <div class="border-t border-slate-100 px-3 py-2.5 text-sm"><a href="${esc(j.url)}" target="_blank" rel="noopener" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Open the advert on NHS Jobs ↗</a></div></details>`;
  const head = (t, n) => `<div class="mb-1 mt-1 flex items-center gap-2 text-xs font-semibold text-slate-600">${t}<span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">${n}</span></div>`;
  if (!sg.length && !jobs.length) return "";   // nothing to show: the whole section hides
  return (sg.length ? head("Signals", sg.length) + `<div class="space-y-1.5">${sg.map(sigTile).join("")}</div>` : "") + (jobs.length ? `<div class="${sg.length ? "mt-3" : ""}">${head("Hiring: report / records roles (NHS Jobs)", jobs.length)}<div class="space-y-1.5">${jobs.map(jobTile).join("")}</div></div>` : "");
}
