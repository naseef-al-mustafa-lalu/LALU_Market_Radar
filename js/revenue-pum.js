/* Revenue > Patients under management: how many patients customers cover over time, split by product, with churn taken off when a Service churned.
   Each customer counts at the size they signed for (hubspot_signed_size) from their first Service start (else the won deal's close date) until the date the Service churned. Loaded after networks.js. */
const PUM_PRODUCTS = { all: ["All reports", "#0d9488"], sar: ["SAR only", "#1e3a8a"], self: ["Self service (GP eMR)", "#a855f7"], payg: ["PAYG", "#f59e0b"], freemium: ["Freemium", "#94a3b8"] };
const PUM_SERVICES = { "eMR+": "Managed service", eMR: "Self service" };      // HubSpot deal property Product / Service
let pumProducts = new Set(["all", "sar"]), pumService = "", pumChurn = "offset", pumSplit = "product", revSub = "est";
const pumMonth = d => d.slice(0, 7), pumNext = m => { const [y, n] = m.split("-").map(Number); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, "0")}`; };
const pumShort = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "m" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));
// The rows the chart uses: customers (and churned ones) with a product, a start and a signed size, after the filters.
function pumRows() {
  return practices.filter(p => p.hubspot_product && Number(p.hubspot_signed_size) > 0 && pumProducts.has(p.hubspot_product) && (!pumService || p.hubspot_product_service === pumService)
    && (p.hubspot_customer || p.hubspot_churned_date || p.hubspot_company_status === "Ex-Customer"));
}
// Patients under management at the end of each month: { months: [..], series: { key: [..] }, churned: [cumulative churned patients] }.
function pumSeries(rows, splitKey) {
  const dated = rows.filter(p => p.hubspot_first_start), start = dated.map(p => pumMonth(p.hubspot_first_start)).sort()[0], now = new Date().toISOString().slice(0, 7);
  if (!start) return { months: [], series: {}, churned: [], undated: rows.length };
  const months = []; for (let m = start; m <= now; m = pumNext(m)) months.push(m);
  const keys = splitKey === "service" ? ["eMR+", "eMR"] : Object.keys(PUM_PRODUCTS).filter(k => pumProducts.has(k)), series = Object.fromEntries(keys.map(k => [k, months.map(() => 0)])), churned = months.map(() => 0);
  for (const p of dated) {
    const k = splitKey === "service" ? (p.hubspot_product_service === "eMR" ? "eMR" : "eMR+") : p.hubspot_product, from = months.indexOf(pumMonth(p.hubspot_first_start)), gone = p.hubspot_churned_date ? months.indexOf(pumMonth(p.hubspot_churned_date)) : -1;
    if (!series[k] || from < 0) continue;
    const hist = (p.hubspot_size_history || []).map(([d, n]) => [pumMonth(d), Number(n)]), at = i => { let n = hist.length ? hist[0][1] : Number(p.hubspot_signed_size); for (const [m, v] of hist) if (m <= months[i]) n = v; return n; };      // the size in the contract in force that month
    const to = pumChurn === "active" && p.hubspot_churned_date ? -2 : gone >= 0 ? gone : months.length;      // churned in the month it is dated: gone from that month's end
    if (to === -2) continue;
    for (let i = from; i < to; i++) series[k][i] += at(i);
    if (gone >= 0) for (let i = gone; i < months.length; i++) churned[i] += at(gone - 1 >= 0 ? gone - 1 : gone);
  }
  return { months, series, churned, undated: rows.length - dated.length };
}
// Small inline icons (outline, 16px) so the filters and tiles read at a glance
const PUM_ICON = {
  users: '<path d="M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM22 19v-1a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>', down: '<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>', userMinus: '<path d="M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM17 8h6"/>',
  calendar: '<path d="M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z"/>', layers: '<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>', filter: '<path d="M3 5h18l-7 8v6l-4-2v-4L3 5z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>', check: '<path d="M5 12l5 5 9-10"/>', clock: '<path d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>', info: '<path d="M12 8h.01M11 12h1v5h1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
};
const pumIcon = (k, cls = "h-4 w-4") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls} shrink-0" aria-hidden="true">${PUM_ICON[k]}</svg>`;
let pumRange = "all", pumHidden = new Set();
const pumLabel = m => { const [y, n] = m.split("-"); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(n) - 1] + " " + y.slice(2); };
// A line chart: one line per product (or service type) plus a dashed total, a crosshair with a tooltip, soft gridlines.
function pumChart(d, labels) {
  if (!d.months.length) return '<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">' + pumIcon("filter", "h-6 w-6 text-slate-400") + '<div>No customers match these filters, or none has a start date yet.</div><div class="text-xs text-slate-500">Run the HubSpot sync once so the Service dates are read.</div></div>';
  const n = pumRange === "all" ? d.months.length : Math.min(d.months.length, Number(pumRange)), cut = d.months.length - n, months = d.months.slice(cut), churned = d.churned.slice(cut);
  const keys = Object.keys(d.series).filter(k => !pumHidden.has(k)), all = Object.keys(d.series), series = Object.fromEntries(all.map(k => [k, d.series[k].slice(cut)]));
  const totals = months.map((_, i) => keys.reduce((a, k) => a + series[k][i], 0)), W = 1000, H = 320, L = 46, R = 22, T = 16, B = 30, max = Math.max(1, ...totals, ...keys.flatMap(k => series[k])) * 1.1;
  const x = i => L + (months.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (months.length - 1)), y = v => T + (H - T - B) * (1 - v / max), colour = k => (labels[k] || [])[1];
  const path = arr => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => { const v = max / 1.1 * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e2e8f0" stroke-dasharray="${f ? "3 4" : "0"}"/><text x="${L - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#94a3b8">${pumShort(v)}</text>`; }).join("");
  const step = Math.max(1, Math.ceil(months.length / 9)), xl = months.map((m, i) => (months.length - 1 - i) % step === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="9.5" fill="#94a3b8">${pumLabel(m)}</text>` : "").join("");
  const lines = keys.map(k => `<path d="${path(series[k])}" fill="none" stroke="${colour(k)}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(months.length - 1).toFixed(1)}" cy="${y(series[k][months.length - 1]).toFixed(1)}" r="3.5" fill="#fff" stroke="${colour(k)}" stroke-width="2"/>`).join("");
  const total = keys.length > 1 ? `<path d="${path(totals)}" fill="none" stroke="#0f172a" stroke-width="1.6" stroke-dasharray="5 4" stroke-linejoin="round"/>` : "";
  const data = JSON.stringify({ m: months.map(pumLabel), k: keys.map(k => [(labels[k] || [k])[0], colour(k), series[k]]), t: totals, c: churned, x: months.map((_, i) => +(x(i) / W).toFixed(4)) }).replaceAll("'", "&#39;");
  return `<div class="relative" id="pum-wrap" data-chart='${data}'><svg viewBox="0 0 ${W} ${H}" class="w-full select-none" role="img" aria-label="Patients under management by month" id="pum-svg">${grid}${xl}${total}${lines}<line id="pum-cross" y1="${T}" y2="${H - B}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3" class="hidden"/><g id="pum-dots"></g><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="pum-hit"/></svg><div id="pum-tip" class="pointer-events-none absolute z-10 hidden min-w-[11rem] rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur"></div></div>`;
}
function pumHover() {
  const wrap = $("pum-wrap"), svg = $("pum-svg"); if (!wrap || !svg) return;
  const d = JSON.parse(wrap.dataset.chart), W = 1000, tip = $("pum-tip"), cross = $("pum-cross"), dots = $("pum-dots"), max = Math.max(1, ...d.t, ...d.k.flatMap(k => k[2])) * 1.1, H = 320, T = 16, B = 30;
  const y = v => T + (H - T - B) * (1 - v / max), show = e => {
    const r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width; let best = 0;
    d.x.forEach((v, i) => { if (Math.abs(v - fx) < Math.abs(d.x[best] - fx)) best = i; });
    const cx = d.x[best] * W; cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.classList.remove("hidden");
    dots.innerHTML = d.k.map(k => `<circle cx="${cx}" cy="${y(k[2][best]).toFixed(1)}" r="4.5" fill="${k[1]}" stroke="#fff" stroke-width="2"/>`).join("");
    tip.innerHTML = `<div class="mb-1 font-semibold text-slate-900">${esc(d.m[best])}</div>${d.k.map(k => `<div class="flex items-center justify-between gap-4"><span class="inline-flex items-center gap-1.5 text-slate-600"><span class="inline-block h-2 w-2 rounded-full" style="background:${k[1]}"></span>${esc(k[0])}</span><span class="font-mono font-semibold">${k[2][best].toLocaleString()}</span></div>`).join("")}`
      + (d.k.length > 1 ? `<div class="mt-1 flex justify-between gap-4 border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span class="font-mono">${d.t[best].toLocaleString()}</span></div>` : "") + (d.c[best] ? `<div class="mt-1 text-rose-600">Churned to date: ${d.c[best].toLocaleString()}</div>` : "");
    tip.classList.remove("hidden"); const w = tip.offsetWidth, px = d.x[best] * r.width, left = px + 14 + w > r.width ? px - w - 14 : px + 14; tip.style.left = Math.max(0, left) + "px"; tip.style.top = "8px";
  };
  svg.addEventListener("mousemove", show); svg.addEventListener("mouseleave", () => { tip.classList.add("hidden"); cross.classList.add("hidden"); dots.innerHTML = ""; });
}
function renderPum() {
  const box = $("rev-pum"); if (!box || !practices.length) return;
  const rows = pumRows(), d = pumSeries(rows, pumSplit), labels = pumSplit === "service" ? { "eMR+": ["Managed service (eMR+)", "#0d9488"], eMR: ["Self service (eMR)", "#a855f7"] } : PUM_PRODUCTS, last = d.months.length - 1;
  const sumAt = i => Object.keys(d.series).reduce((a, k) => a + d.series[k][i], 0), now = last >= 0 ? sumAt(last) : 0, yearAgo = last >= 12 ? sumAt(last - 12) : null;
  const churnedRows = rows.filter(p => p.hubspot_churned_date), churnedPts = churnedRows.reduce((a, p) => a + Number(((p.hubspot_size_history || []).slice(-1)[0] || [])[1] || p.hubspot_signed_size), 0), live = rows.filter(p => !p.hubspot_churned_date), diff = yearAgo == null ? null : now - yearAgo;
  const tile = (icon, tone, k, v, sub = "") => `<div class="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3"><span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}">${pumIcon(icon, "h-5 w-5")}</span><div class="min-w-0"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="text-xl font-bold leading-tight">${v}</div>${sub ? `<div class="truncate text-xs text-slate-500" title="${esc(sub)}">${sub}</div>` : ""}</div></div>`;
  const chip = (k, [l, c]) => `<label class="group relative cursor-pointer select-none"><input type="checkbox" class="pum-prod peer sr-only" value="${k}" ${pumProducts.has(k) ? "checked" : ""}><span class="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 transition peer-checked:border-transparent peer-checked:text-slate-900 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-lalu-teal-600 hover:bg-slate-50" style="--c:${c}"><span class="flex h-4 w-4 items-center justify-center rounded-full border-2 ${pumProducts.has(k) ? "text-white" : "text-transparent"}" style="border-color:${c};${pumProducts.has(k) ? `background:${c}` : ""}">${pumIcon("check", "h-2.5 w-2.5")}</span>${l}</span></label>`;
  const seg = (id, icon, cur, opts) => `<span class="inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-xs font-semibold" id="${id}"><span class="px-1.5 text-slate-400">${pumIcon(icon)}</span>${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="rounded-lg px-2.5 py-1 transition ${cur === k ? "bg-white text-lalu-navy shadow-sm" : "text-slate-500 hover:text-slate-800"}">${l}</button>`).join("")}</span>`;
  box.innerHTML = `<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="flex items-center gap-2 text-lg font-bold">${pumIcon("users", "h-5 w-5 text-lalu-teal-700")}Patients under management <span class="info-slot align-middle" data-text="Each customer counts at the patient size in their contract (the won deal's line item quantity, else the Amount over twelve months of the price per patient), updated at each renewal, from their first Service start until the date the Service churned. The company's list size is only used where no contract size can be worked out."></span></h2>
      ${seg("pum-range", "calendar", pumRange, [["12", "12m"], ["24", "24m"], ["all", "All time"]])}</div>
    <div class="mt-4 flex flex-wrap items-center gap-2">${Object.entries(PUM_PRODUCTS).map(([k, v]) => chip(k, v)).join("")}</div>
    <div class="mt-3 flex flex-wrap items-center gap-3"><label class="relative inline-flex items-center"><span class="pointer-events-none absolute left-2.5 text-slate-400">${pumIcon("filter")}</span><select id="pum-service" class="appearance-none rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-8 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-lalu-teal-600" aria-label="Service"><option value="">Managed and self service</option>${Object.entries(PUM_SERVICES).map(([k, l]) => `<option value="${esc(k)}" ${pumService === k ? "selected" : ""}>${l} (${esc(k)})</option>`).join("")}</select><span class="pointer-events-none absolute right-2.5 text-slate-400">${pumIcon("chevron")}</span></label>
      ${seg("pum-churn", "userMinus", pumChurn, [["offset", "Net of churn"], ["active", "Current only"]])}${seg("pum-split", "layers", pumSplit, [["product", "By product"], ["service", "By service type"]])}</div>
    <div class="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">${tile("users", "bg-teal-50 text-teal-700", "Patients today", now.toLocaleString(), `${live.length.toLocaleString()} practice${live.length === 1 ? "" : "s"}`)}
      ${tile(diff != null && diff < 0 ? "down" : "trend", diff != null && diff < 0 ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700", "Last 12 months", diff == null ? "–" : diff === 0 ? "No change" : (diff > 0 ? "+" : "−") + Math.abs(diff).toLocaleString(), diff == null ? "less than a year of history" : `from ${yearAgo.toLocaleString()}`)}
      ${tile("userMinus", "bg-rose-50 text-rose-700", "Churned patients", churnedPts.toLocaleString(), `${churnedRows.length.toLocaleString()} practice${churnedRows.length === 1 ? "" : "s"}, off from their churn date`)}${tile("clock", "bg-slate-100 text-slate-600", "No start date", d.undated.toLocaleString(), "customers left off the chart")}</div>
    <div class="mt-4 rounded-xl border border-slate-100 bg-slate-50/50 p-2 md:p-3">${pumChart(d, labels)}</div>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-xs"><span class="text-slate-500">Lines</span>${Object.keys(d.series).map(k => `<button type="button" data-k="${esc(k)}" class="pum-line inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold transition ${pumHidden.has(k) ? "border-slate-200 text-slate-400 line-through" : "border-slate-200 bg-white text-slate-700"}"><span class="inline-block h-0.5 w-4 rounded" style="background:${(labels[k] || [])[1]}"></span>${(labels[k] || [k])[0]}</button>`).join("")}${Object.keys(d.series).length > 1 ? '<span class="inline-flex items-center gap-1.5 text-slate-500"><span class="inline-block w-4 border-t-2 border-dashed border-slate-800"></span>Total</span>' : ""}</div></div>`;
  box.querySelectorAll(".pum-prod").forEach(c => c.onchange = () => { c.checked ? pumProducts.add(c.value) : pumProducts.delete(c.value); renderPum(); });
  $("pum-service").onchange = e => { pumService = e.target.value; renderPum(); };
  $("pum-churn").querySelectorAll("button").forEach(b => b.onclick = () => { pumChurn = b.dataset.v; renderPum(); });
  $("pum-split").querySelectorAll("button").forEach(b => b.onclick = () => { pumSplit = b.dataset.v; pumHidden.clear(); renderPum(); });
  $("pum-range").querySelectorAll("button").forEach(b => b.onclick = () => { pumRange = b.dataset.v; renderPum(); });
  box.querySelectorAll(".pum-line").forEach(b => b.onclick = () => { pumHidden.has(b.dataset.k) ? pumHidden.delete(b.dataset.k) : pumHidden.add(b.dataset.k); renderPum(); });
  pumHover();
}
function setRevSub(which) {
  revSub = which; $("rev-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.r === which ? "bg-white shadow-sm" : "text-slate-500"));
  $("rev-est").classList.toggle("hidden", which !== "est"); $("rev-pum").classList.toggle("hidden", which !== "pum"); if (which === "pum") renderPum();
}
$("rev-sub").querySelectorAll("button").forEach(b => b.onclick = () => setRevSub(b.dataset.r));
