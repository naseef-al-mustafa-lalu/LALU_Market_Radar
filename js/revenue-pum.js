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
    const n = Number(p.hubspot_signed_size), to = pumChurn === "active" && p.hubspot_churned_date ? -2 : gone >= 0 ? gone : months.length;      // churned in the month it is dated: gone from that month's end
    if (to === -2) continue;
    for (let i = from; i < to; i++) series[k][i] += n;
    if (gone >= 0) for (let i = gone; i < months.length; i++) churned[i] += n;
  }
  return { months, series, churned, undated: rows.length - dated.length };
}
function pumChart(d, labels) {
  if (!d.months.length) return '<p class="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">No customers match these filters, or none has a start date yet. Run the HubSpot sync once so the Service dates are read.</p>';
  const W = 1000, H = 300, L = 44, R = 30, T = 12, B = 28, keys = Object.keys(d.series), totals = d.months.map((_, i) => keys.reduce((a, k) => a + d.series[k][i], 0)), max = Math.max(1, ...totals) * 1.08;
  const x = i => L + (d.months.length === 1 ? 0 : i * (W - L - R) / (d.months.length - 1)), y = v => T + (H - T - B) * (1 - v / max), colour = k => (labels[k] || [])[1];
  let base = d.months.map(() => 0), areas = "";
  for (const k of keys) {
    const top = d.months.map((_, i) => base[i] + d.series[k][i]), pts = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).concat(base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse()).join(" ");
    areas += `<polygon points="${pts}" fill="${colour(k)}" fill-opacity="0.85" stroke="${colour(k)}" stroke-width="1"/>`; base = top;
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => { const v = max / 1.08 * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e2e8f0"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#64748b">${pumShort(v)}</text>`; }).join("");
  const step = Math.ceil(d.months.length / 8), xl = d.months.map((m, i) => i % step === 0 || i === d.months.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="8.5" fill="#64748b">${m}</text>` : "").join("");
  const hover = d.months.map((m, i) => `<rect x="${(x(i) - (W - L - R) / Math.max(1, d.months.length - 1) / 2).toFixed(1)}" y="${T}" width="${((W - L - R) / Math.max(1, d.months.length - 1)).toFixed(1)}" height="${H - T - B}" fill="transparent"><title>${m}: ${totals[i].toLocaleString()} patients${keys.map(k => `\n${(labels[k] || [k])[0]}: ${d.series[k][i].toLocaleString()}`).join("")}${d.churned[i] ? `\nChurned to date: ${d.churned[i].toLocaleString()}` : ""}</title></rect>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="Patients under management by month">${ticks}${areas}${xl}${hover}</svg>`;
}
function renderPum() {
  const box = $("rev-pum"); if (!box || !practices.length) return;
  const rows = pumRows(), d = pumSeries(rows, pumSplit), labels = pumSplit === "service" ? { "eMR+": ["Managed service (eMR+)", "#0d9488"], eMR: ["Self service (eMR)", "#a855f7"] } : PUM_PRODUCTS, last = d.months.length - 1;
  const now = last >= 0 ? Object.keys(d.series).reduce((a, k) => a + d.series[k][last], 0) : 0, yearAgo = last >= 12 ? Object.keys(d.series).reduce((a, k) => a + d.series[k][last - 12], 0) : null;
  const churnedPts = rows.filter(p => p.hubspot_churned_date).reduce((a, p) => a + Number(p.hubspot_signed_size), 0), live = rows.filter(p => !p.hubspot_churned_date);
  const tile = (k, v, sub = "") => `<div class="rounded-lg border border-slate-200 p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-xl font-bold leading-tight">${v}</div>${sub ? `<div class="text-xs text-slate-500">${sub}</div>` : ""}</div>`;
  const chk = (k, l, c) => `<label class="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><input type="checkbox" class="pum-prod h-4 w-4" value="${k}" ${pumProducts.has(k) ? "checked" : ""}><span class="inline-block h-2.5 w-2.5 rounded-sm" style="background:${c}"></span>${l}</label>`;
  const seg = (id, cur, opts) => `<span class="inline-flex gap-1 rounded-lg bg-slate-100 p-1 text-xs font-semibold" id="${id}">${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="rounded-md px-2.5 py-1 ${cur === k ? "bg-white text-lalu-navy shadow-sm" : "text-slate-500"}">${l}</button>`).join("")}</span>`;
  box.innerHTML = `<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><h2 class="font-bold">Patients under management <span class="info-slot align-middle" data-text="Each customer counts at the size they signed for (the won deal's line item quantity, else the company's list size) from their first Service start until the date the Service churned. Only practices HubSpot still knows about are counted, and Freemium and PAYG are off by default."></span></h2>
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">${Object.entries(PUM_PRODUCTS).map(([k, [l, c]]) => chk(k, l, c)).join("")}</div>
    <div class="mt-2 flex flex-wrap items-center gap-3 text-xs"><label class="font-semibold text-slate-600" for="pum-service">Service</label><select id="pum-service" class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"><option value="">Managed and self service</option>${Object.entries(PUM_SERVICES).map(([k, l]) => `<option value="${esc(k)}" ${pumService === k ? "selected" : ""}>${l} (${esc(k)})</option>`).join("")}</select>
      ${seg("pum-churn", pumChurn, [["offset", "Take churn off"], ["active", "Current customers only"]])}${seg("pum-split", pumSplit, [["product", "By product"], ["service", "By service type"]])}</div>
    <div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">${tile("Patients today", now.toLocaleString(), `${live.length.toLocaleString()} practice${live.length === 1 ? "" : "s"}`)}${tile("Last 12 months", yearAgo == null ? "–" : (now - yearAgo >= 0 ? "+" : "−") + Math.abs(now - yearAgo).toLocaleString(), yearAgo == null ? "less than a year of history" : `from ${yearAgo.toLocaleString()}`)}
      ${tile("Churned patients", churnedPts.toLocaleString(), `${rows.filter(p => p.hubspot_churned_date).length.toLocaleString()} practice${rows.filter(p => p.hubspot_churned_date).length === 1 ? "" : "s"}, taken off from their churn date`)}${tile("No start date", d.undated.toLocaleString(), "customers left off the chart")}</div>
    <div class="mt-3">${pumChart(d, labels)}</div>
    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">${Object.keys(d.series).map(k => `<span class="inline-flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-sm" style="background:${(labels[k] || [])[1]}"></span>${(labels[k] || [k])[0]}</span>`).join("")}</div></div>`;
  box.querySelectorAll(".pum-prod").forEach(c => c.onchange = () => { c.checked ? pumProducts.add(c.value) : pumProducts.delete(c.value); renderPum(); });
  $("pum-service").onchange = e => { pumService = e.target.value; renderPum(); };
  $("pum-churn").querySelectorAll("button").forEach(b => b.onclick = () => { pumChurn = b.dataset.v; renderPum(); });
  $("pum-split").querySelectorAll("button").forEach(b => b.onclick = () => { pumSplit = b.dataset.v; renderPum(); });
}
function setRevSub(which) {
  revSub = which; $("rev-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.r === which ? "bg-white shadow-sm" : "text-slate-500"));
  $("rev-est").classList.toggle("hidden", which !== "est"); $("rev-pum").classList.toggle("hidden", which !== "pum"); if (which === "pum") renderPum();
}
$("rev-sub").querySelectorAll("button").forEach(b => b.onclick = () => setRevSub(b.dataset.r));
