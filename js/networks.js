// Networks tab, the network profile panel and the Revenue tab.
/* ---------- networks ---------- */
const keyOf = n => n.kind === "group" ? n.source_key.slice("cqc:provider:".length) : n.source_key.slice(4);
function openNetwork(kind, key, label) {
  const fromTab = currentTab === "networks";
  clearFilters(); closeDrawer();
  netFilter = { kind, key, label }; fromNetworks = fromTab;
  showTab("practices"); applyFilters();
}
/* ---------- network profile (side panel): how the network price is built and what it does to each practice ---------- */
function openNetworkProfile(n) {
  hsShowBar(null);
  drawerCode = null; document.querySelectorAll("#rows tr.bg-lalu-teal-50").forEach(r => r.classList.remove("bg-lalu-teal-50"));
  const KIND = { pcn: "PCN / cluster", icb: "ICB / health board", group: "Provider group", federation: "Federation" }[n.kind] || n.kind, key = keyOf(n);
  const members = practices.filter(p => p.status === "Active" && netMatch(p, { kind: n.kind, key })).sort((a, b) => b.total_patients - a.total_patients);
  const list = Number(cfgSettings.list_price_per_patient?.value || 0);
  const route = cfgTiers.filter(t => t.route === n.kind).sort((a, b) => a.threshold - b.threshold);
  const row = route.find(t => t.tier === n.network_tier), base = n.network_base_price != null ? Number(n.network_base_price) : null;
  const next = route.find(t => t.threshold > n.patients && (!row || t.tier < row.tier));
  $("dr-title").textContent = n.name;
  $("dr-sub").innerHTML = `${chip(KIND, "bg-slate-100 text-slate-700")} ${n.network_tier ? chip("Tier " + n.network_tier + (row ? " · " + row.label : ""), TIER_CLS["Tier " + n.network_tier]) : ""} ${n.customers > 0 ? chip("Has a customer", "bg-emerald-100 text-emerald-800") : ""} ${n.confirmed === false ? chip("inferred: verify", "bg-amber-50 text-amber-700") : ""}`;
  const saving = n.arr_single != null && n.arr_network != null ? n.arr_single - n.arr_network : null;
  const price = !row || base == null ? '<div class="text-sm italic text-slate-500">No price route is configured for this kind of network (edit <code>pricing_tiers</code>).</div>' :
    priceCard({ patients: Number(n.patients), tierRow: row, route: n.kind, arr: n.arr_network, who: "the network" }) +
    `<div class="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm"><div class="flex justify-between"><span class="text-slate-600">The same ${n.practices} practices signed separately</span><span class="font-mono">${gbpFull(n.arr_single)}</span></div>
      <div class="flex justify-between mt-0.5"><span class="text-slate-600">Network price</span><span class="font-mono font-semibold">${gbpFull(n.arr_network)}</span></div>
      <div class="flex justify-between mt-0.5 border-t border-slate-200 pt-1"><span class="font-medium">${saving > 0 ? "Network discount" : "Difference"}</span><span class="font-mono font-semibold ${saving > 0 ? "text-emerald-700" : ""}">${saving == null ? "–" : (saving > 0 ? "−" : "+") + gbpFull(Math.abs(saving))} <span class="text-xs font-normal text-slate-500">${n.arr_single && saving != null ? "(" + pct(Math.abs(saving) / n.arr_single) + ")" : ""}</span></span></div></div>
    ${n.arr_network_sar != null ? `<div class="mt-2 flex justify-between text-sm text-slate-600"><span>SAR only: network price (signed separately ${gbpFull(n.arr_single_sar)})</span><span class="font-mono">${gbpFull(n.arr_network_sar)}</span></div>` : ""}
    <p class="text-xs text-slate-500 mt-1">Routes are alternatives, not additive: the network price applies only if the whole network signs together.</p>`;
  const rows = members.map(p => {
    const net = base != null ? p.total_patients * base * 12 : null;
    return `<tr class="border-t border-slate-100 hover:bg-lalu-teal-50/50 cursor-pointer" tabindex="0" role="button" data-ods="${esc(p.ods_code)}"><td class="py-1 pr-2"><div class="font-medium leading-tight">${esc(p.practice_name)}${p.merged_into ? " " + chip("merged", "bg-indigo-100 text-indigo-800") : isClosed(p) ? " " + chip("closed", "bg-slate-200 text-slate-700") : ""}</div><div class="text-xs text-slate-500 font-mono">${esc(p.ods_code)}</div></td>
      <td class="text-right font-mono">${p.total_patients > 0 ? p.total_patients.toLocaleString() : "–"}</td>
      <td class="px-2">${p.price_tier ? chip("T" + p.price_tier, TIER_CLS["Tier " + p.price_tier] || "") : ""}</td>
      <td class="text-right font-mono">${p.base_price != null ? "£" + rate3(Number(p.base_price)) : "–"}</td>
      <td class="text-right font-mono">${gbpFull(p.est_arr)}</td>
      <td class="text-right font-mono text-slate-500">${gbpFull(p.est_arr_sar)}</td>
      <td class="text-right font-mono text-emerald-700">${net != null && p.total_patients > 0 ? gbpFull(net) : "–"}</td></tr>`; }).join("");
  const hdr = ["Practice", "Patients", "Tier", "£/pt/mo singly", "ARR singly", "SAR-only singly", "ARR in network"].map((h, i) => `<th class="${i === 0 ? "text-left" : i === 2 ? "text-left px-2" : "text-right"} font-medium">${h}</th>`).join("");
  $("dr-body").innerHTML =
    `<div class="grid grid-cols-4 gap-2 text-center">${[["Practices", n.practices], ["Patients", Number(n.patients || 0).toLocaleString()], ["Engaged", n.engaged + " of " + n.practices], ["Customers", n.customers]]
      .map(([k, v]) => `<div class="rounded-lg bg-slate-50 py-2"><div class="text-base font-bold">${v}</div><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div></div>`).join("")}</div>` +
    (n.kind === "pcn" || n.kind === "icb" ? sec("HubSpot", '<div id="dr-hsnet" class="text-sm text-slate-500">Checking HubSpot…</div>') : "") +
    sec("Pricing: " + KIND + " route", price) +
    sec("Linked practices: price singly vs in the network", `<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="text-xs uppercase tracking-wider text-slate-500"><tr>${hdr}</tr></thead><tbody>${rows}</tbody></table></div>`) +
    sec("Recent signals across this network", (() => {
      const codes = new Set(members.map(p => p.ods_code));
      return signals.filter(x => (x.ods_code && codes.has(x.ods_code)) || x.org_id === n.id).slice(0, 8).map(x => `<div class="py-1 border-t border-slate-100 first:border-0 text-sm"><span class="font-mono text-xs text-slate-500">${esc(fmtDate(x.detected_at))}</span> <b class="text-xs">${esc(x.headline)}</b>
        <div class="text-xs text-slate-500">${esc(x.ods_code ? (byOds.get(x.ods_code)?.practice_name || x.ods_code) : "network-level")} · ${esc(x.trigger_type.replaceAll("_", " ").toLowerCase())}</div></div>`).join("");
    })()) +
    `<button id="np-view" class="w-full bg-lalu-teal-700 hover:bg-lalu-teal-800 text-white rounded-lg py-2 text-sm font-semibold">Filter the practice list to this network →</button>`;
  $("dr-body").scrollTop = 0;
  if (n.kind === "pcn" || n.kind === "icb") hsNetworkSection(n);
  $("dr-body").onclick = ev => { const tr = ev.target.closest("tr[data-ods]"); if (tr && byOds.get(tr.dataset.ods)) { openDrawer(byOds.get(tr.dataset.ods)); return; } if (ev.target.closest("#np-view")) openNetwork(n.kind, key, n.name); };
  drawerOpened(); $("drawer").classList.remove("translate-x-full");
}
function renderNetworks() {
  $("net-kinds").innerHTML = Object.entries(NET_KINDS).map(([k, label]) =>
    `<button data-k="${k}" class="px-3 py-1 rounded-md ${k === netKind ? "bg-white shadow-sm" : "text-slate-500"}">${label} <span class="text-xs text-slate-500">${networks.filter(n => n.kind === k).length}</span></button>`).join("");
  $("net-kinds").querySelectorAll("button").forEach(b => b.onclick = () => { netKind = b.dataset.k; renderNetworks(); stateToUrl(); });
  const q = $("n-search").value.trim().toLowerCase(), srt = $("n-sort").value, multi = $("n-multi").checked;
  netList = networks.filter(n => n.kind === netKind && (!multi || n.practices >= 3) && (!q || n.name.toLowerCase().includes(q)))
    .sort((a, b) => srt === "patients" ? b.patients - a.patients : srt === "arr" ? (b.arr_network || b.arr_single) - (a.arr_network || a.arr_single) : srt === "practices" ? b.practices - a.practices
      : ((b.practices - b.engaged) - (a.practices - a.engaged)) || b.patients - a.patients);
  netShown = 0; $("net-rows").innerHTML = ""; renderMoreNetworks();
  const one = { pcn: "PCN", group: "group", federation: "federation", icb: "ICB" }[netKind];
  $("n-count").textContent = `${netList.length.toLocaleString()} ${netList.length === 1 ? one : NET_KINDS[netKind].replace("Provider groups", "groups").replace("Federations", "federations")}`;
}
function renderMoreNetworks() {
  const slice = netList.slice(netShown, netShown + PAGE); netShown += slice.length;
  const frag = document.createDocumentFragment();
  for (const n of slice) {
    const open = n.practices - n.engaged, tot = Math.max(n.practices, 1);
    const bar = (v, cls) => v ? `<div class="${cls}" style="width:${(v / tot) * 100}%" title="${v}"></div>` : "";
    const KIND = { pcn: "PCN", icb: "ICB", group: "group", federation: "federation" }[n.kind] || n.kind;
    const tr = document.createElement("tr"); tr.className = "hover:bg-lalu-teal-50/50 cursor-pointer"; tr.tabIndex = 0; tr.setAttribute("role", "button");
    tr.innerHTML = `<td class="px-3 py-2 align-top"><div class="font-semibold leading-tight">${esc(n.name)}</div>
        <div class="text-xs text-slate-500">EMIS ${n.emis} · SystmOne ${n.systmone}${n.cqc_concern ? " · " + chip(n.cqc_concern + " CQC flagged", "bg-amber-100 text-amber-800") : ""}${n.confirmed === false ? " · " + chip("inferred: verify", "bg-amber-50 text-amber-700") : ""}</div></td>
      <td class="px-3 py-2 text-right font-mono align-top">${n.practices}</td>
      <td class="px-3 py-2 text-right font-mono align-top">${n.patients ? Number(n.patients).toLocaleString() : "–"}</td>
      <td class="px-3 py-2 whitespace-nowrap align-top">${n.network_tier ? chip("Tier " + n.network_tier, TIER_CLS["Tier " + n.network_tier]) : '<span class="text-slate-300">–</span>'}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap align-top">${n.network_tier ? `<div class="font-mono font-semibold text-emerald-700">${gbpFull(n.arr_network)}</div><div class="text-xs text-slate-500">as ${KIND} · ${gbpFull(n.arr_single)} singly</div>`
        : `<div class="font-mono text-slate-500">${gbpFull(n.arr_single)}</div><div class="text-xs text-slate-500">no ${esc(KIND)} price route set</div>`}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap align-top">${n.network_tier ? `<div class="font-mono text-slate-600">${gbpFull(n.arr_network_sar)}</div><div class="text-xs text-slate-500">${gbpFull(n.arr_single_sar)} singly</div>` : `<div class="font-mono text-slate-500">${gbpFull(n.arr_single_sar)}</div>`}</td>
      <td class="px-3 py-2 align-top"><div class="flex h-2 rounded overflow-hidden bg-slate-100">${bar(n.tier1, "bg-purple-700")}${bar(n.tier2, "bg-purple-500")}${bar(n.tier3, "bg-violet-300")}${bar(n.tier4, "bg-slate-300")}${bar(n.tier5, "bg-slate-200")}</div>
        <div class="text-xs text-slate-500 mt-0.5">${[n.tier1, n.tier2, n.tier3, n.tier4, n.tier5].map((v, i) => v ? "T" + (i + 1) + " " + v : "").filter(Boolean).join(" · ")}</div></td>
      <td class="px-3 py-2 text-xs whitespace-nowrap align-top"><div class="font-semibold">${n.engaged} of ${n.practices}</div>${open > 0 ? `<div class="text-xs text-slate-500">${open} to approach</div>` : '<div class="text-xs text-emerald-700">all engaged</div>'}</td>
      <td class="px-3 py-2 whitespace-nowrap align-top">${n.customers > 0 ? chip("Has " + (n.customers === 1 ? "a customer" : n.customers + " customers"), "bg-emerald-100 text-emerald-800") + `<div class="text-xs text-slate-500 mt-0.5">${gbpFull(n.arr_customers)}/yr live</div>` : '<span class="text-xs text-slate-300">no customers</span>'}</td>
      <td class="px-3 py-2 text-right align-top"><button class="text-lalu-teal-700 hover:underline text-xs whitespace-nowrap">View →</button></td>`;
    tr.onclick = () => openNetworkProfile(n);
    tr.querySelector("button").onclick = e => { e.stopPropagation(); openNetwork(n.kind, keyOf(n), n.name); };
    frag.appendChild(tr);
  }
  $("net-rows").appendChild(frag);
  $("n-more").classList.toggle("hidden", netShown >= netList.length);
  if (!netList.length) $("net-rows").innerHTML = '<tr><td colspan="10" class="p-6 text-center text-slate-500 italic">Nothing here yet. Federations appear once a source for them is loaded (currently the Oscar file).</td></tr>';
}
["n-search", "n-sort", "n-multi"].forEach(id => $(id).addEventListener(id === "n-search" ? "input" : "change", renderNetworks));
$("n-more").addEventListener("click", renderMoreNetworks);

/* ---------- revenue ---------- */
const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
// Revenue scenario: all customers on All reports, all on SAR only, or a mix with an editable SAR-only share.
let revScen = "all", sarShare = 30;
const scen = (all, sar) => { all = Number(all) || 0; sar = Number(sar) || 0; return revScen === "sar" ? sar : revScen === "mix" ? all * (1 - sarShare / 100) + sar * sarShare / 100 : all; };
function routeData() {
  const act = practices.filter(p => p.status === "Active" && p.total_patients > 0);
  const net = k => networks.filter(n => n.kind === k && n.patients > 0);
  const netRoute = (key, name, unit) => ({ key, name, unit, list: net(key), tierOf: n => n.network_tier, pat: n => n.patients, val: n => scen(n.arr_network, n.arr_network_sar) });
  return [{ key: "practice", name: "Single practices", unit: ["practice", "practices"], list: act, tierOf: p => p.price_tier, pat: p => p.total_patients, val: p => scen(p.est_arr, p.est_arr_sar) },
    netRoute("pcn", "PCNs", ["PCN", "PCNs"]), netRoute("icb", "ICBs", ["ICB", "ICBs"]), netRoute("group", "Provider groups", ["group", "groups"]), netRoute("federation", "Federations", ["federation", "federations"])]
    .filter(r => r.key === "practice" || (cfgTiers.some(t => t.route === r.key) && r.list.length));
}
function renderRevenue() {
  if (!practices.length || !cfgTiers.length) return;
  const routes = routeData(), act = routes[0].list;
  $("rev-routes").innerHTML = routes.map(r => { const pat = sum(r.list, r.pat), arr = sum(r.list, r.val);
    return `<tr><td class="py-2 font-semibold">${r.name}</td><td class="py-2 text-right font-mono">${r.list.length.toLocaleString()}</td><td class="py-2 text-right font-mono">${(pat / 1e6).toFixed(2)}m</td>
      <td class="py-2 text-right font-mono font-semibold text-emerald-700">${gbp(arr)}</td><td class="py-2 text-right font-mono text-slate-500">£${(arr / 12 / Math.max(pat, 1)).toFixed(4)}</td></tr>`; }).join("");
  const scenBox = $("rev-scen");   // built once: re-creating the buttons would swallow a click that follows editing the share box
  if (!scenBox.children.length) { scenBox.innerHTML = [["all", "All reports"], ["sar", "SAR only"], ["mix", "Mix"]].map(([k, l]) => `<button data-s="${k}" class="px-2.5 py-1 rounded-md">${l}</button>`).join(""); scenBox.onclick = e => { const b = e.target.closest("button"); if (b) { revScen = b.dataset.s; renderRevenue(); } }; }
  scenBox.querySelectorAll("button").forEach(b => { const on = b.dataset.s === revScen; b.setAttribute("aria-pressed", on); b.className = "px-2.5 py-1 rounded-md " + (on ? "bg-white shadow-sm" : "text-slate-500"); });
  $("rev-share-wrap").classList.toggle("hidden", revScen !== "mix"); $("rev-share-wrap").classList.toggle("flex", revScen === "mix");
  $("rev-share").onchange = e => { sarShare = Math.min(100, Math.max(0, Number(e.target.value) || 0)); e.target.value = sarShare; renderRevenue(); };
  $("rev-metric").innerHTML = [["arr", "Est. ARR"], ["patients", "Patients"], ["count", "Count"]].map(([k, l]) => `<button data-m="${k}" class="px-2.5 py-1 rounded-md ${k === revMetric ? "bg-white shadow-sm" : "text-slate-500"}">${l}</button>`).join("");
  $("rev-metric").querySelectorAll("button").forEach(b => b.onclick = () => { revMetric = b.dataset.m; renderRevenue(); });
  const cell = (r, t) => { const m = r.list.filter(x => r.tierOf(x) === t); return revMetric === "arr" ? sum(m, r.val) : revMetric === "patients" ? sum(m, r.pat) : m.length; };
  const fmt = v => revMetric === "arr" ? gbp(v) : revMetric === "patients" ? (v / 1e6).toFixed(2) + "m" : v.toLocaleString();
  $("rev-matrix-head").innerHTML = `<tr><th class="py-1.5 text-left">Tier</th>${routes.map(r => `<th class="py-1.5 text-right">${r.name}</th>`).join("")}</tr>`;
  const labels = cfgTiers.filter(t => t.route === "practice").sort((a, b) => a.tier - b.tier);
  $("rev-matrix").innerHTML = labels.map(t => `<tr><td class="py-1.5">${chip("Tier " + t.tier, TIER_CLS["Tier " + t.tier] || "")} <span class="text-slate-500 text-xs">${esc(t.label)}</span></td>${routes.map(r => `<td class="py-1.5 text-right font-mono">${fmt(cell(r, t.tier))}</td>`).join("")}</tr>`).join("") +
    `<tr class="font-semibold"><td class="py-1.5">Total</td>${routes.map(r => `<td class="py-1.5 text-right font-mono">${fmt(revMetric === "arr" ? sum(r.list, r.val) : revMetric === "patients" ? sum(r.list, r.pat) : r.list.length)}</td>`).join("")}</tr>`;
  $("rev-pipeline").innerHTML = ["customer", "freemium", "engaged", "imported", "company", "none"].map(st => {
    const m = act.filter(p => hsState(p) === st);
    return `<div class="rounded-lg border border-slate-200 p-3"><div>${chip(HS_LABEL[st], HS_CLS[st])}</div><div class="text-xl font-bold mt-1">${gbp(sum(m, p => scen(p.est_arr, p.est_arr_sar)))}</div><div class="text-xs text-slate-500">${m.length.toLocaleString()} practices</div></div>`; }).join("");
}
