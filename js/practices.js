// Practices tab: filters, rows, pricing breakdown and the practice profile panel.
/* ---------- practices: filters, chips, sorting ---------- */
const netMatch = (p, nf) => !nf || (nf.kind === "pcn" ? p.pcn_code === nf.key : nf.kind === "group" ? p.cqc_provider_id === nf.key
  : nf.kind === "federation" ? (p.gp_federation || "").toLowerCase() === nf.key : (p.icb_name || "").toLowerCase() === nf.key);
const SORTERS = {
  name: p => (p.practice_name || "").toLowerCase(), patients: p => p.total_patients || 0, arr: p => p.est_arr || 0,
  cqc: p => CQC_RANK[p.cqc_rating] || 9, hubspot: p => HS_RANK[hsState(p)] };
function applyFilters() {
  const q = $("f-search").value.trim().toLowerCase(), t = $("f-tier").value, sw = $("f-sw").value, hs = $("f-hs").value,
        cqcf = $("f-cqc").value, icb = $("f-icb").value, ctry = $("f-country").value, sz = $("f-size").value, sig = $("f-sig").checked, grp = $("f-grp").checked;
  filtered = practices.filter(p =>
    p.status === "Active" && netMatch(p, netFilter) && (!t || tier(p) === t) && (!sw || p.clinical_software === sw) && (!hs || hsState(p) === hs) &&
    (!cqcf || (cqcf === "None" ? !p.cqc_rating : p.cqc_rating === cqcf)) && (!icb || p.icb_name === icb) && (!ctry || (p.country || "England") === ctry) && (!sz || (sz === "yes") === (p.total_patients > 0)) &&
    (!sig || signalCodes.has(p.ods_code)) && (!grp || p.group_size > 1) &&
    (!q || [p.practice_name, p.ods_code, p.pcn_name, p.manager_name, p.postcode, p.group_name, p.gp_federation, p.town].some(v => (v || "").toLowerCase().includes(q))));
  const f = SORTERS[sort.key], by = (a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.total_patients - a.total_patients; };
  filtered.sort(by);
  renderChips(); renderSortHeaders();
  shown = 0; $("rows").innerHTML = ""; renderMore();
  $("count").textContent = `${filtered.length.toLocaleString()} practices`;
  stateToUrl();
}
function renderChips() {
  const box = $("f-chips"); box.innerHTML = "";
  const add = (label, clear) => { const c = document.createElement("span"); c.className = "chip bg-indigo-50 text-indigo-800 border border-indigo-100"; c.innerHTML = `${esc(label)} <button class="ml-0.5 font-bold" aria-label="Remove filter">✕</button>`; c.querySelector("button").onclick = clear; box.appendChild(c); };
  const sel = (id, label) => { const el = $(id); if (el.value) add(label + ": " + el.options[el.selectedIndex].text, () => { el.value = ""; applyFilters(); }); };
  if (netFilter) {
    if (fromNetworks) { const b = document.createElement("button"); b.className = "text-sm text-blue-600 hover:underline mr-1"; b.textContent = "← Back to networks"; b.onclick = () => { netFilter = null; fromNetworks = false; showTab("networks"); applyFilters(); }; box.appendChild(b); }
    add((NET_KINDS[netFilter.kind] || "").replace(/s$/, "") + ": " + netFilter.label, () => { netFilter = null; fromNetworks = false; applyFilters(); });
  }
  if ($("f-search").value.trim()) add("Search: " + $("f-search").value.trim(), () => { $("f-search").value = ""; applyFilters(); });
  sel("f-tier", "Tier"); sel("f-hs", "HubSpot"); sel("f-sw", "System"); sel("f-cqc", "CQC"); sel("f-icb", "ICB"); sel("f-country", "Country"); sel("f-size", "List size");
  if ($("f-sig").checked) add("Has recent signals", () => { $("f-sig").checked = false; applyFilters(); });
  if ($("f-grp").checked) add("Group-run only", () => { $("f-grp").checked = false; applyFilters(); });
  if (box.children.length > 1 || (box.children.length === 1 && !netFilter)) {
    const x = document.createElement("button"); x.className = "text-xs text-slate-500 hover:text-slate-800 underline"; x.textContent = "Clear all";
    x.onclick = clearFilters; box.appendChild(x);
  }
}
function clearFilters() {
  for (const id of ["f-search", "f-tier", "f-sw", "f-hs", "f-cqc", "f-icb", "f-country", "f-size"]) $(id).value = "";
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
["f-search", "f-tier", "f-sw", "f-hs", "f-cqc", "f-icb", "f-country", "f-size", "f-sig", "f-grp"].forEach(id => $(id).addEventListener(id === "f-search" ? "input" : "change", applyFilters));

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
function hsCell(p) {
  const st = hsState(p);
  const tip = p.hs_contacts === 0 ? "No contact yet" : p.hs_primary_imported ? "Key contact imported " + fmtDate(p.hs_primary_imported_at) : p.hs_imported > 0 ? p.hs_imported + " of " + p.hs_contacts + " contacts imported" : "Contact not imported";
  return st === "customer" || st === "engaged" ? chip(HS_LABEL[st], HS_CLS[st], tip) : `<span class="text-xs ${st === "imported" ? "text-slate-600" : "text-slate-300"}" title="${esc(tip)}">${st === "imported" ? "In HubSpot" : "–"}</span>`;
}
function renderMore() {
  const slice = filtered.slice(shown, shown + PAGE); shown += slice.length;
  const frag = document.createDocumentFragment();
  for (const p of slice) {
    const tr = document.createElement("tr"); tr.dataset.ods = p.ods_code; tr.tabIndex = 0; tr.setAttribute("role", "button");
    tr.className = "hover:bg-blue-50/50 cursor-pointer" + (p.ods_code === drawerCode ? " bg-blue-50" : "");
    const sig = signalCounts.get(p.ods_code), hasN = p.total_patients > 0;
    tr.innerHTML = `
      <td class="px-3 py-2"><div class="font-semibold text-slate-900 leading-tight">${esc(p.practice_name)}${sig ? " " + chip(sig + " signal" + (sig > 1 ? "s" : ""), "bg-purple-100 text-purple-800") : ""}</div>
        <div class="text-xs text-slate-500 font-mono">${esc(p.ods_code)} · ${esc(p.town || p.postcode || "")}</div></td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${hasN ? `<span class="font-mono font-semibold">${p.total_patients.toLocaleString()}</span> ${chip(tier(p).replace("Tier ", "T"), TIER_CLS[tier(p)] || "", p.tier_label || "")}` : `<span class="text-xs text-slate-500 underline decoration-dotted cursor-help" title="${esc(noSizeReason(p))}">No list size</span>`}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${hasN ? `<span class="font-mono font-semibold text-emerald-700" title="£${Number(p.base_price).toFixed(3)} per patient per month">${gbpFull(p.est_arr)}</span>` : '<span class="text-slate-300">–</span>'}</td>
      <td class="px-3 py-2">${networkCell(p)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${cqcCell(p)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-xs text-slate-600">${SYS[p.clinical_software] || '<span class="text-slate-300">–</span>'}</td>
      <td class="px-3 py-2">${p.manager_name ? `<div class="font-medium leading-tight">${esc(p.manager_name)}</div><div class="text-xs text-slate-500">${esc(p.manager_title)}</div>` : '<span class="text-xs text-slate-300">no contact yet</span>'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${hsCell(p)}</td>`;
    tr.onclick = () => openDrawer(p);
    frag.appendChild(tr);
  }
  $("rows").appendChild(frag);
  $("more").classList.toggle("hidden", shown >= filtered.length);
  if (!filtered.length) $("rows").innerHTML = '<tr><td colspan="8" class="p-6 text-center text-slate-500 italic">No practices match these filters.</td></tr>';
}
$("more").addEventListener("click", renderMore);

/* ---------- price breakdown: headline figure, then the working in plain steps ---------- */
// Price = list price less the SUM of the selected discounts (size + term + speed), never below the price floor.
// Term and speed are choices, not guarantees, so they are switches shared by every price card on the page.
let speedOn = true, termYrs = 1, billing = "annual";   // billing: "annual" (paid yearly) or "monthly" (rolling, no term)
const priceCards = new Map();
const setting = k => Number(cfgSettings[k]?.value || 0);
const termDiscount = yrs => yrs >= 3 ? setting("term_discount_3yr") : yrs === 2 ? setting("term_discount_2yr") : 0;
// Rates are quoted per patient per MONTH (as in the pricing sheet); annual revenue = patients x rate x 12.
const baseRate = () => billing === "monthly" ? setting("monthly_list_price_per_patient") : setting("list_price_per_patient");
const yearly = (patients, rate) => patients * rate * 12;
const dealRate = (size, term, speed) => Math.max(setting("price_floor_per_patient"), baseRate() * (1 - size - term - speed));
function priceCard(args) {
  const id = "pc" + priceCards.size; priceCards.set(id, args);
  return `<div class="price-card" data-pc="${id}">${priceCardBody(args, id)}</div>`;
}
function repaintPriceCards() { const live = new Set([...document.querySelectorAll(".price-card")].map(el => el.dataset.pc)); for (const k of priceCards.keys()) if (!live.has(k)) priceCards.delete(k); document.querySelectorAll(".price-card").forEach(el => { el.innerHTML = priceCardBody(priceCards.get(el.dataset.pc), el.dataset.pc); }); }
document.addEventListener("click", e => {
  const sw = e.target.closest(".speed-toggle"), bl = e.target.closest(".bill-opt");
  if (sw) { speedOn = !speedOn; repaintPriceCards(); document.querySelector(".speed-toggle")?.focus({ preventScroll: true }); }
  else if (bl) { billing = bl.dataset.b; repaintPriceCards(); document.querySelector(`.bill-opt[data-b="${billing}"]`)?.focus({ preventScroll: true }); }
});
document.addEventListener("click", e => { const b = e.target.closest(".term-opt"); if (b) { termYrs = Number(b.dataset.yrs); repaintPriceCards(); document.querySelector(`.term-opt[data-yrs="${termYrs}"]`)?.focus({ preventScroll: true }); } });
function priceCardBody({ patients, tierRow, route, who }, id) {
  const monthly = billing === "monthly", list = baseRate();
  if (!tierRow || !patients) return '<p class="text-sm italic text-slate-500">No price yet: this needs a list size and a price tier for this route.</p>';
  const size = Number(tierRow.size_discount), speed = Number(tierRow.speed_discount), term = monthly ? 0 : termDiscount(termYrs), floor = setting("price_floor_per_patient");
  const useSpeed = speedOn && speed > 0, recurring = dealRate(size, term, 0), year1 = dealRate(size, term, useSpeed ? speed : 0);
  const sum = size + term + (useSpeed ? speed : 0), floored = list * (1 - sum) < floor - 1e-9;
  const tiersAsc = cfgTiers.filter(t => t.route === route).sort((a, b) => a.threshold - b.threshold);
  const next = tiersAsc.find(t => Number(t.threshold) > patients && t.tier < tierRow.tier);
  const sub = t => `<div class="text-xs text-slate-500 font-normal leading-snug">${t}</div>`, amt = x => "−£" + x.toFixed(3);
  const line = (label, detail, pctText, value, cls = "") => `<tr class="border-t border-emerald-100 ${cls}"><td class="py-1.5 pr-3 align-top"><div class="font-medium leading-snug">${label}</div>${detail ? sub(detail) : ""}</td><td class="py-1.5 px-2 text-right align-top whitespace-nowrap text-slate-600">${pctText}</td><td class="py-1.5 pl-2 text-right align-top whitespace-nowrap font-mono">${value}</td></tr>`;
  const adj = year1 - list * (1 - sum);
  const rowsHtml = [
    line("List price", monthly ? "Monthly plan: rolling, billed monthly" : "Annual plan: 12-month commitment", "", `£${list.toFixed(3)} <span class="text-xs font-normal text-slate-500">/ month</span>`, "border-t-0"),
    line("Size discount", `${chip("Tier " + tierRow.tier, TIER_CLS["Tier " + tierRow.tier] || "")} ${esc(tierRow.label)}${who ? ", " + esc(who) : ""}`, "−" + pct(size), amt(list * size)),
    term ? line("Term discount", `${termYrs}-year commitment`, "−" + pct(term), amt(list * term)) : "",
    useSpeed ? line("Speed discount", "Year 1 only, not guaranteed", "−" + pct(speed), amt(list * speed)) : "",
    adj > 1e-9 ? line("Price floor", `Never below £${floor.toFixed(3)} per month`, "", "+£" + adj.toFixed(3)) : "",
    line(`Price per patient per month${useSpeed ? " (year 1)" : ""}`, "", `${pct(1 - year1 / list)} off`, `£${year1.toFixed(3)} <span class="text-xs font-normal text-slate-500">/ month</span>`, "font-semibold border-t-2 border-emerald-200"),
    line(`× ${patients.toLocaleString()} patients × 12 months`, useSpeed ? "Year 1 total" : "Per year", "", gbpFull(yearly(patients, year1)), "font-semibold")
  ].join("");
  // Price by year across the contract: the speed discount only applies in year 1, the term discount for every year of the term.
  const yrRows = [], recT = yearly(patients, recurring), y1T = yearly(patients, year1), N = monthly ? 1 : termYrs;
  const yr = (label, price, total, bold) => `<tr class="border-t border-emerald-100 ${bold ? "font-semibold" : ""}"><td class="py-1 pr-3">${label}</td><td class="py-1 px-2 text-right whitespace-nowrap font-mono">${price}</td><td class="py-1 pl-2 text-right whitespace-nowrap font-mono">${total}</td></tr>`;
  // One row per year of the term (a 1-year term also shows the renewal year when speed makes year 1 differ).
  if (N > 1 || useSpeed) for (let y = 1; y <= Math.max(N, 2); y++) {
    const first = y === 1 && useSpeed, label = y > N ? "Year 2 onwards (renewal)" : "Year " + y;
    yrRows.push(yr(label, `£${(first ? year1 : recurring).toFixed(3)} /mo`, gbpFull(first ? y1T : recT) + (y === 1 ? "" : N === 1 ? " /yr" : "")));
  }
  if (N > 1) yrRows.push(yr(`Total over ${N} years`, "", gbpFull(y1T + (N - 1) * recT), true));
  const yearTable = yrRows.length ? `<div class="mt-3"><div class="text-xs font-semibold text-slate-600 mb-0.5">Price by year</div><table class="w-full text-sm tabular-nums"><caption class="sr-only">Price per patient and total for each year of the contract</caption><thead class="sr-only"><tr><th>Period</th><th>Per patient</th><th>Total</th></tr></thead><tbody>${yrRows.join("")}</tbody></table>${useSpeed ? '<p class="mt-0.5 text-xs text-slate-500">The speed discount applies in year 1 only.</p>' : ""}</div>` : "";
  const steps = `<table class="mt-3 w-full text-sm tabular-nums"><caption class="sr-only">How the price is built</caption><thead class="sr-only"><tr><th>Step</th><th>Discount</th><th>Per patient</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  const opts = [1, 2, 3].map(y => `<button type="button" class="term-opt flex-1 rounded-md border px-2 py-1.5 text-left ${y === termYrs ? "border-emerald-600 bg-white ring-1 ring-emerald-600" : "border-slate-300 bg-white/60 hover:bg-white"}" data-yrs="${y}" aria-pressed="${y === termYrs}">
      <div class="text-xs font-semibold">${y} year${y > 1 ? "s" : ""}${y > 1 ? ` <span class="font-normal text-slate-500">−${pct(termDiscount(y))}</span>` : ""}</div><div class="font-mono text-sm">${gbpFull(yearly(patients, dealRate(size, termDiscount(y), 0)))}<span class="text-xs text-slate-500"> /yr</span></div></button>`).join("");
  return `<div class="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
    <div class="flex items-end justify-between gap-3">
      <div><div class="text-xs uppercase tracking-wider text-slate-500">Estimated annual revenue${monthly ? " · monthly plan" : termYrs > 1 ? ` · ${termYrs}-year term` : ""}</div><div class="text-2xl font-bold text-emerald-700 leading-tight">${gbpFull(yearly(patients, recurring))}<span class="text-sm font-normal text-slate-500"> / year</span></div></div>
      ${speed > 0 ? `<div class="text-right"><div class="text-xs uppercase tracking-wider text-slate-500">First year</div><div class="text-lg font-semibold leading-tight">${gbpFull(yearly(patients, year1))}</div><div class="text-xs text-slate-500">${useSpeed ? pct(speed) + " speed discount" : "no speed discount"}</div></div>` : ""}</div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div class="inline-flex rounded-lg bg-white/70 border border-slate-300 p-0.5 text-xs font-semibold" role="group" aria-label="Billing">${[["annual", "Annual"], ["monthly", "Monthly"]].map(([k, l]) => `<button type="button" class="bill-opt rounded-md px-3 py-1 ${billing === k ? "bg-emerald-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"}" data-b="${k}" aria-pressed="${billing === k}">${l}</button>`).join("")}</div>
      ${speed > 0 ? `<div class="flex items-center gap-2 text-xs text-slate-600"><span id="spd-l-${id}">${pct(speed)} speed discount <span class="text-slate-400">(not guaranteed)</span></span><button type="button" role="switch" aria-checked="${speedOn}" aria-labelledby="spd-l-${id}" class="speed-toggle relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${speedOn ? "bg-emerald-600" : "bg-slate-300"}"><span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${speedOn ? "translate-x-4" : "translate-x-0.5"}"></span></button></div>` : ""}</div>
    ${monthly ? `<p class="mt-2 text-xs text-slate-500">Monthly plans are rolling with no commitment, so there is no term discount. Switch to Annual to choose a 1, 2 or 3-year term.</p>` :
      `<div class="mt-3"><div class="text-xs font-semibold text-slate-600 mb-1">Contract term <span class="font-normal text-slate-500">(longer commitments earn a discount)</span></div><div class="flex gap-2" role="group" aria-label="Contract term">${opts}</div></div>`}
    ${steps}${yearTable}
    ${next ? `<p class="mt-3 text-xs text-slate-600 border-t border-emerald-100 pt-2">${(Number(next.threshold) - patients).toLocaleString()} more patients would reach <b>Tier ${next.tier}</b> (${pct(next.size_discount)} size discount, £${(list * (1 - Number(next.size_discount))).toFixed(3)} per patient per month).</p>` : ""}</div>`;
}
function routeComparison(p) {
  if (!(p.total_patients > 0) || p.est_arr == null) return "";
  const rows = [];
  const add = (kind, key, label) => {
    const n = networks.find(x => x.kind === kind && keyOf(x) === key);
    if (!n || !n.network_tier || n.network_base_price == null) return;
    const arr = yearly(p.total_patients, Number(n.network_base_price));
    rows.push(`<tr class="border-t border-slate-100 align-top"><td class="py-1.5 pr-2"><a href="#" class="text-blue-600 hover:underline font-medium" data-net="${kind}|${esc(key)}|${esc(n.name)}">${esc(n.name)}</a><div class="text-xs text-slate-500">${label} · Tier ${n.network_tier} · ${Number(n.patients).toLocaleString()} patients across ${n.practices} practices</div></td>
      <td class="text-right font-mono">£${Number(n.network_base_price).toFixed(3)}</td><td class="text-right font-mono font-semibold">${gbpFull(arr)}</td><td class="text-right text-xs ${arr < p.est_arr ? "text-emerald-700" : "text-slate-500"}">${arr === Math.round(p.est_arr) ? "same" : (arr < p.est_arr ? "−" : "+") + gbpFull(Math.abs(arr - p.est_arr))}</td></tr>`);
  };
  if (p.pcn_code) add("pcn", p.pcn_code, "PCN / cluster");
  if (p.group_size > 1) add("group", p.cqc_provider_id, "Provider group");
  if (p.gp_federation) add("federation", p.gp_federation.toLowerCase(), "Federation");
  if (!rows.length) return "";
  return `<div class="mt-3"><div class="text-xs font-semibold text-slate-600 mb-1">Other ways to sign this practice</div>
    <table class="w-full text-sm"><thead class="text-xs uppercase tracking-wider text-slate-500"><tr><th class="text-left font-medium">Route</th><th class="text-right font-medium whitespace-nowrap">£ / patient / mo</th><th class="text-right font-medium whitespace-nowrap pl-2">£ / year</th><th class="text-right font-medium whitespace-nowrap pl-2">vs alone</th></tr></thead><tbody>
    <tr><td class="py-1.5 pr-2"><div class="font-medium">On its own</div><div class="text-xs text-slate-500">Single practice · Tier ${p.price_tier}</div></td><td class="text-right font-mono">£${Number(p.base_price).toFixed(3)}</td><td class="text-right font-mono font-semibold">${gbpFull(p.est_arr)}</td><td class="text-right text-xs text-slate-500">–</td></tr>${rows.join("")}</tbody></table>
    <p class="mt-1 text-xs text-slate-500">Routes are alternatives: a network price applies only if the whole network signs together.</p></div>`;
}

/* ---------- practice profile (side panel) ---------- */
const kv = (k, v) => v ? `<div class="flex justify-between gap-3 py-0.5 text-sm"><span class="text-slate-500 shrink-0">${k}</span><span class="text-right text-slate-800 break-words">${v}</span></div>` : "";
const sec = (title, body) => body && body.trim() ? `<section class="border-t border-slate-100 pt-3"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">${title}</h4>${body}</section>` : "";
let drawerOpener = null;
function drawerOpened() { if (!drawerOpener || !document.body.contains(drawerOpener)) drawerOpener = document.activeElement; $("dr-close").focus({ preventScroll: true }); }
function closeDrawer() { const was = !$("drawer").classList.contains("translate-x-full"); drawerCode = null; $("drawer").classList.add("translate-x-full");
  if (was && drawerOpener && document.body.contains(drawerOpener)) drawerOpener.focus({ preventScroll: true }); drawerOpener = null; stateToUrl(); document.querySelectorAll("#rows tr.bg-blue-50").forEach(r => r.classList.remove("bg-blue-50")); }
$("dr-close").onclick = closeDrawer;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
async function openDrawer(p) {
  drawerCode = p.ods_code;
  document.querySelectorAll("#rows tr").forEach(r => r.classList.toggle("bg-blue-50", r.dataset.ods === p.ods_code));
  drawerOpened(); $("drawer").classList.remove("translate-x-full");
  $("dr-title").textContent = p.practice_name; stateToUrl();
  const st = hsState(p);
  $("dr-sub").innerHTML = `<span class="font-mono">${esc(p.ods_code)}</span>${p.town ? " · " + esc(p.town) : ""} ${p.total_patients > 0 ? chip(tier(p), TIER_CLS[tier(p)] || "") : ""} ${p.cqc_rating && CQC_CHIP[p.cqc_rating] ? chip(p.cqc_rating, CQC_CHIP[p.cqc_rating]) : ""} ${st === "customer" || st === "engaged" ? chip(HS_LABEL[st], HS_CLS[st]) : ""}`;
  const link = (label, kind, key) => `<a href="#" class="text-blue-600 hover:underline" data-net="${kind}|${esc(key)}|${esc(label)}">${esc(label)}</a>`;
  const web = p.website ? `<a class="text-blue-600 hover:underline" target="_blank" rel="noopener" href="${esc(/^https?:/.test(p.website) ? p.website : "https://" + p.website)}">${esc(p.website)}</a>` : "";
  const addr = [p.address, p.town, p.county, p.postcode].filter(Boolean).map(esc).join(", ");
  const body = $("dr-body");
  body.innerHTML = `<div id="dr-contacts" class="text-sm text-slate-500">Loading contacts…</div>` +
    sec("Network and ownership", kv("PCN", p.pcn_code ? link(p.pcn_name, "pcn", p.pcn_code) : "") + kv("Provider group", p.group_size > 1 ? link((p.group_name || "Group") + " (" + p.group_size + " practices)", "group", p.cqc_provider_id) : "") +
      kv("Federation", p.gp_federation ? link(p.gp_federation, "federation", p.gp_federation.toLowerCase()) : "") + kv("ICB", p.icb_name && p.icb_name !== "Unallocated ICB" ? link(p.icb_name, "icb", p.icb_name.toLowerCase()) : "")) +
    sec("Pricing", p.total_patients > 0 ? priceCard({ patients: p.total_patients, tierRow: cfgTiers.find(t => t.route === "practice" && t.tier === p.price_tier), route: "practice", arr: p.est_arr }) +
      `<div class="text-xs text-slate-500 mt-1">List size ${p.data_month ? "from " + esc(p.data_month) : ""}.</div>` + routeComparison(p) : `<p class="text-sm text-slate-600">No list size, so no price. ${esc(noSizeReason(p))}</p>`) +
    sec("Quality and system", kv("CQC rating", p.cqc_rating ? (CQC_CHIP[p.cqc_rating] ? chip(p.cqc_rating, CQC_CHIP[p.cqc_rating]) : esc(p.cqc_rating)) : "") + kv("Registration", esc(p.cqc_status)) + kv("Last inspection", esc(p.cqc_last_inspection)) +
      kv("Manager absent since", esc(p.cqc_manager_absent_date)) + kv("Clinical system", p.clinical_software !== "Unknown" ? esc(p.clinical_software) : "")) +
    sec("HubSpot", kv("Status", chip(HS_LABEL[st], HS_CLS[st])) + kv("Lifecycle stage", esc(p.hubspot_stage)) + kv("Company imported", esc(fmtDate(p.hubspot_company_imported_at))) +
      kv("Contacts imported", p.hs_contacts ? p.hs_imported + " of " + p.hs_contacts : "") + kv("Last contact import", esc(fmtDate(p.hs_last_imported_at))) + kv("Last synced", esc(fmtDate(p.hubspot_synced_at))) +
      (!p.hubspot_synced_at && !p.hs_imported ? '<div class="text-xs text-slate-500 italic py-0.5">Not synced yet: filled in by the HubSpot integration.</div>' : "")) +
    sec("Practice details", kv("Address", addr) + kv("Country", p.country && p.country !== "England" ? esc(p.country) : "") + kv("Region", esc(p.region)) + kv("Website", web) + kv("Main phone", esc(p.main_phone)) +
      kv("Main email", p.main_email ? (p.main_email_opt_out ? "opt-out" : esc(p.main_email)) : "") + kv("GPs", esc(p.nhs_num_gp)) + kv("Employees", esc(p.num_employees)) + kv("Annual spend", esc(p.annual_spend)) + kv("Categories", esc(p.oscar_categories))) +
    sec("Notes (Oscar)", p.org_notes ? `<div class="text-sm text-slate-700 whitespace-pre-wrap">${esc(p.org_notes)}</div>` : "") +
    sec("Hiring: report / records roles (NHS Jobs)", jobAdverts.filter(j => j.ods_code === p.ods_code).sort((a, b) => (b.post_date || "").localeCompare(a.post_date || "")).slice(0, 8).map(j =>
      `<div class="py-1 border-t border-slate-100 first:border-0 text-sm"><a class="text-blue-600 hover:underline" target="_blank" rel="noopener" href="${esc(j.url)}">${esc(j.title)}</a>
       <div class="text-xs text-slate-500">${esc(j.matched_role)} · posted ${esc(fmtDate(j.post_date))}${j.close_date ? " · closes " + esc(fmtDate(j.close_date)) : ""}</div></div>`).join("")) +
    `<div id="dr-signals"></div>`;
  body.scrollTop = 0;
  body.onclick = ev => { const a = ev.target.closest("a[data-net]"); if (a) { ev.preventDefault(); const [kind, key, label] = a.dataset.net.split("|"); openNetwork(kind, key, label); } };
  const [{ data: cs }, { data: sg }] = await Promise.all([
    db.from("contacts").select("*").eq("ods_code", p.ods_code).order("is_primary", { ascending: false }),
    db.from("sales_triggers").select("*").eq("ods_code", p.ods_code).order("detected_at", { ascending: false }).limit(10)]);
  if (drawerCode !== p.ods_code) return;   // user moved on
  $("dr-contacts").outerHTML = `<section><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Contacts</h4>` + ((cs || []).map(c => `<div class="py-1.5 border-t border-slate-100 first:border-0"><b>${esc(c.full_name)}</b>${c.is_primary ? ' <span class="text-amber-500" title="Primary contact">★</span>' : ""}
      <span class="text-slate-500 text-sm"> · ${esc(c.job_title)}${c.dept ? " · " + esc(c.dept) : ""}</span>
      <div class="text-xs text-slate-600">${c.email ? (c.email_opt_out ? '<span class="text-rose-600">email opt-out</span>' : `<a class="text-blue-600 hover:underline" href="mailto:${esc(c.email)}">${esc(c.email)}</a>`) : ""} ${esc(c.phone)}</div>
      <div class="mt-0.5">${c.hubspot_status === "Imported" ? chip("In HubSpot · " + fmtDate(c.hubspot_imported_at), "bg-emerald-100 text-emerald-800") : chip("Not imported to HubSpot", "bg-slate-100 text-slate-500")}</div></div>`).join("") || '<p class="text-sm italic text-slate-500">No contacts yet (added when the Oscar file is loaded).</p>') + `</section>`;
  $("dr-signals").outerHTML = sec("Signals", (sg || []).map(s => `<div class="py-1 border-t border-slate-100 first:border-0"><span class="font-mono text-xs text-slate-500">${esc(fmtDate(s.detected_at))}</span> <b class="text-xs">${esc(s.headline)}</b> ${chip(SIG_STATUS[s.status || "new"], s.status === "done" ? "bg-emerald-100 text-emerald-800" : s.status === "in_progress" ? "bg-blue-100 text-blue-800" : s.status === "dismissed" ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-800")} ${sigLink(s)}<div class="text-xs text-slate-500">${esc(s.description)}</div>${s.action ? `<div class="text-xs text-blue-700 mt-0.5"><b>Next step:</b> ${esc(s.action)}</div>` : ""}</div>`).join("") || '<p class="text-sm italic text-slate-500">No signals for this practice yet.</p>');
}
