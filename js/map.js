/* Practices map: the Practices filters drawn on a map (Table / Map toggle), coloured by HubSpot status, with a postcode + miles search. Coordinates come from postcodes.io via the
   geocode job and live in app_flags.postcode_coords ({ "AB12CD": [lat, lng] }). Leaflet is vendored in assets/vendor/leaflet. */
let mapOn = false, pmap = null, pmapLayer = null, pmapCircle = null, pmapPin = null, mapCoords = null, mapCoordsLoading = null, mapHidden = new Set(), mapCentre = null, mapInside = [], mapBranches = false;
const MAP_UK = [[49.8, -8.9], [60.9, 2.0]];      // Great Britain and Northern Ireland
const mapRadius = k => { const z = pmap ? pmap.getZoom() : 6, r = Math.min(13, 3.5 + Math.max(0, z - 5) * 1.1); return k === "other" ? r * 0.8 : r; };      // dots grow as you zoom in, so they stay easy to click
function mapSizeMarkers() { if (pmapLayer) pmapLayer.eachLayer(m => m.setRadius(mapRadius(m._k) * (m._ring ? 0.85 : 1))); }
const MAP_COL = { customer: "#059669", nomodel: "#7c3aed", freemium: "#d97706", engaged: "#2563eb", other: "#94a3b8" };
const MAP_LABEL = { customer: "Customer", nomodel: "Customer, no Commercial Model", freemium: "Freemium", engaged: "Engaged", other: "Other" };
const MAP_TIP = { customer: "Customers (HubSpot lifecycle stage Customer) with a Commercial Model: All Reports, SAR Only, PAYG or Self Service", nomodel: "HubSpot lifecycle stage is Customer but no Commercial Model is set: fix in HubSpot (the Revenue page counts these separately)", freemium: "Freemium customers", engaged: "Not a customer; engaged in HubSpot", other: "Everything else" };
const mapKey = p => { const s = hsState(p); return s === "customer" ? (p.hubspot_commercial_model ? "customer" : "nomodel") : s === "freemium" || s === "engaged" ? s : "other"; };      // the same split as the Revenue page
const mapNorm = pc => String(pc || "").replace(/\s+/g, "").toUpperCase();
const mapMiles = (a, b) => { const R = 3958.8, r = x => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]), h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const mapBranchAt = b => mapCoords && mapCoords[mapNorm(b.postcode)] || null;
function mapBranchSites(list) {      // the branch sites of the practices shown that have a location of their own (a branch at the practice's own postcode adds nothing to the map)
  const out = [];
  for (const p of list) for (const b of branchesByParent.get(p.ods_code) || []) { const at = mapBranchAt(b); if (at && mapNorm(b.postcode) !== mapNorm(p.postcode)) out.push({ p, b, at }); }
  return out;
}
const mapAt = p => mapCoords && mapCoords[mapNorm(p.postcode)] || null;
async function mapLoadCoords() {
  if (mapCoords) return mapCoords;
  if (!mapCoordsLoading) mapCoordsLoading = (async () => {
    try { const { data } = await db.from("app_flags").select("value").eq("key", "postcode_coords").maybeSingle(); mapCoords = data && data.value || {}; } catch (e) { mapCoords = {}; }
    return mapCoords;
  })();
  return mapCoordsLoading;
}
function mapSetView(on) {
  mapOn = on;
  $("map-panel").classList.toggle("hidden", !on); $("tbl-wrap").classList.toggle("hidden", on); $("tbl-more").classList.toggle("hidden", on);
  $("v-map").className = "rounded-md px-3 py-1.5 " + (on ? "bg-white shadow-sm" : "text-slate-500"); $("v-table").className = "rounded-md px-3 py-1.5 " + (on ? "text-slate-500" : "bg-white shadow-sm");
  $("v-map").setAttribute("aria-pressed", String(on)); $("v-table").setAttribute("aria-pressed", String(!on));
  if (on) mapRefresh(true);
}
function mapEnsure() {
  if (pmap) return;
  pmap = L.map("pmap", { preferCanvas: true, zoomControl: true, maxZoom: 18, maxBounds: MAP_UK, maxBoundsViscosity: 1, renderer: L.canvas({ tolerance: 10 }) });      // the UK only: no panning or zooming out to the rest of the world
  pmap.fitBounds(MAP_UK); pmap.setMinZoom(pmap.getZoom());
  pmap.on("zoomend", mapSizeMarkers);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(pmap);
  pmapLayer = L.layerGroup().addTo(pmap);
}
async function mapRefresh(fit) {
  if (!mapOn) return;
  await mapLoadCoords(); mapEnsure(); pmap.invalidateSize(); if (!pmap.getSize().x) return;      // the Practices tab is not showing
  const placed = [], unplaced = [];
  for (const p of filtered) (mapAt(p) ? placed : unplaced).push(p);
  const counts = { customer: 0, nomodel: 0, freemium: 0, engaged: 0, other: 0 }; for (const p of placed) counts[mapKey(p)]++;
  $("m-legend").innerHTML = Object.keys(MAP_COL).map(k => `<button type="button" data-k="${k}" class="m-leg inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-1 font-semibold ${mapHidden.has(k) ? "opacity-40" : ""}" title="${esc(MAP_TIP[k])}. Click to show or hide."><span class="h-2.5 w-2.5 rounded-full" style="background:${MAP_COL[k]}"></span>${MAP_LABEL[k]} <span class="font-normal text-slate-500">${counts[k].toLocaleString()}</span></button>`).join("");
  pmapLayer.clearLayers();
  const shown = placed.filter(p => !mapHidden.has(mapKey(p))), pts = [];
  for (const p of shown) {
    const at = mapAt(p), k = mapKey(p), m = L.circleMarker(at, { radius: mapRadius(k), color: "#fff", weight: 1, fillColor: MAP_COL[k], fillOpacity: k === "other" ? 0.7 : 0.95 });
    m._k = k; m.on("click", () => mapPopup(p, m)); m.addTo(pmapLayer); pts.push(at);
  }
  const sites = mapBranches ? mapBranchSites(filtered.filter(p => !mapHidden.has(mapKey(p)))) : [];
  for (const x of sites) { const k = mapKey(x.p), m = L.circleMarker(x.at, { radius: mapRadius(k) * 0.85, color: MAP_COL[k], weight: 2, fillColor: "#fff", fillOpacity: 1 }); m._k = k; m._ring = true; m.on("click", () => mapBranchPopup(x, m)); m.addTo(pmapLayer); pts.push(x.at); }
  if (mapBranches) $("m-legend").insertAdjacentHTML("beforeend", `<span class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-1 font-semibold" title="Branch sites are drawn as rings in their practice's colour"><span class="h-2.5 w-2.5 rounded-full border-2 border-slate-500 bg-white"></span>Branches <span class="font-normal text-slate-500">${sites.length.toLocaleString()}</span></span>`);
  if (!mapCentre) $("m-msg").textContent = unplaced.length ? `${placed.length.toLocaleString()} on the map; ${unplaced.length.toLocaleString()} have no location yet` : `${placed.length.toLocaleString()} practices`;
  if (mapCentre) mapRadiusList(shown, sites);
  else if (fit && pts.length) pmap.fitBounds(L.latLngBounds(pts).pad(0.05), { maxZoom: 12 });
  if (!Object.keys(mapCoords).length) $("m-msg").textContent = "No locations yet: run the Geocode postcodes workflow once.";
}
function mapBranchPopup(x, m) {
  const d = mapCentre ? mapMiles(mapCentre.at, x.at) : null, html = document.createElement("div"); html.className = "text-sm";
  html.innerHTML = `<div class="font-semibold leading-tight">${esc(x.b.branch_name)}</div><div class="mt-0.5 text-xs text-slate-500">Branch of ${esc(x.p.practice_name)}${d != null ? " · " + d.toFixed(1) + " miles" : ""}</div>
    <div class="mt-1 flex flex-wrap gap-1">${chip(HS_LABEL[hsState(x.p)], HS_CLS[hsState(x.p)])}</div><button type="button" class="mt-2 rounded-md bg-lalu-navy px-2.5 py-1 text-xs font-semibold text-white">Open practice profile</button>`;
  html.querySelector("button").onclick = () => openDrawer(x.p);
  m.bindPopup(html).openPopup();
}
function mapPopup(p, m) {
  const d = mapCentre && mapAt(p) ? mapMiles(mapCentre.at, mapAt(p)) : null;
  const html = document.createElement("div"); html.className = "text-sm";
  html.innerHTML = `<div class="font-semibold leading-tight">${esc(p.practice_name)}</div><div class="mt-0.5 text-xs text-slate-500">${esc(p.ods_code)}${p.town ? " · " + esc(p.town) : ""}${d != null ? " · " + d.toFixed(1) + " miles" : ""}</div>
    <div class="mt-1 flex flex-wrap gap-1">${p.total_patients > 0 ? chip(tier(p), TIER_CLS[tier(p)] || "") : ""} ${chip(HS_LABEL[hsState(p)], HS_CLS[hsState(p)])}${p.hubspot_commercial_model ? " " + chip(MODEL_KEY[p.hubspot_commercial_model] || p.hubspot_commercial_model, "bg-slate-100 text-slate-700") : ""}</div>
    <div class="mt-1 text-xs text-slate-600">${p.total_patients > 0 ? Number(p.total_patients).toLocaleString() + " patients" : "No list size"}</div>
    <button type="button" class="mt-2 rounded-md bg-lalu-navy px-2.5 py-1 text-xs font-semibold text-white">Open profile</button>`;
  html.querySelector("button").onclick = () => openDrawer(p);
  m.bindPopup(html).openPopup();
}
async function mapGeocode(pc) {
  await mapLoadCoords();
  const key = mapNorm(pc); if (!key) return null;
  if (mapCoords[key]) return mapCoords[key];
  try {
    const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(key)); if (r.ok) { const j = await r.json(); if (j.result) return [j.result.latitude, j.result.longitude]; }
    const o = await fetch("https://api.postcodes.io/outcodes/" + encodeURIComponent(pc.trim().split(/\s+/)[0])); if (o.ok) { const j = await o.json(); if (j.result) return [j.result.latitude, j.result.longitude]; }   // only the first part given, e.g. LS1
  } catch (e) { /* offline: handled below */ }
  return null;
}
async function mapSearch(pc, miles, label) {
  if (!mapOn) mapSetView(true);
  $("m-pc").value = pc; $("m-mi").value = String(miles);
  $("m-msg").textContent = "Looking up…";
  const at = await mapGeocode(pc);
  if (!at) { $("m-msg").textContent = "Postcode not found."; return; }
  mapCentre = { at, miles: Number(miles), pc, label: label || pc.toUpperCase() }; mapRows = 100;
  mapEnsure(); pmap.invalidateSize(); if (!pmap.getSize().x) { $("m-msg").textContent = "Open the Practices tab to see the map."; return; }
  if (pmapCircle) pmapCircle.remove(); if (pmapPin) pmapPin.remove();
  pmapCircle = L.circle(at, { radius: mapCentre.miles * 1609.344, color: "#1e3a5f", weight: 2, fillOpacity: 0.05 }).addTo(pmap);
  pmapPin = L.circleMarker(at, { radius: 7, color: "#fff", weight: 2, fillColor: "#1e3a5f", fillOpacity: 1 }).bindTooltip(mapCentre.label).addTo(pmap);
  $("m-clear").classList.remove("hidden");
  pmap.fitBounds(pmapCircle.getBounds().pad(0.05));
  mapRefresh();
}
let mapRowsShown = null, mapSort = { key: "d", dir: 1 }, mapRows = 100;
const MAP_SORT = { d: x => x.d, name: x => x.p.practice_name.toLowerCase(), patients: x => x.p.total_patients || 0, tier: x => x.p.price_tier || 9, status: x => ["customer", "nomodel", "freemium", "engaged", "other"].indexOf(mapKey(x.p)) };
function mapRadiusList(shown, sites = []) {
  const keep = x => x.d <= mapCentre.miles && (!mapCentre.ods || x.p.ods_code !== mapCentre.ods);
  mapInside = shown.map(p => ({ p, d: mapMiles(mapCentre.at, mapAt(p)) })).filter(keep).sort((a, b) => a.d - b.d);
  const brIn = sites.map(x => ({ p: x.p, b: x.b, d: mapMiles(mapCentre.at, x.at) })).filter(keep);
  const near = [...mapInside, ...brIn], f = MAP_SORT[mapSort.key]; near.sort((a, b) => { const x = f(a), y = f(b); return ((x < y ? -1 : x > y ? 1 : 0) * mapSort.dir) || a.d - b.d; });
  mapRowsShown = near; $("m-msg").textContent = `${near.length.toLocaleString()} ${brIn.length ? "location" : "practice"}${near.length === 1 ? "" : "s"} within ${mapCentre.miles} miles of ${mapCentre.label}`;
  const th = (k, label, cls = "") => `<th data-k="${k}" class="m-th cursor-pointer select-none px-3 py-2 ${cls} hover:text-slate-800">${label}${mapSort.key === k ? ` <span>${mapSort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
  const box = $("m-list"); box.classList.remove("hidden");
  box.innerHTML = `<div class="flex items-center justify-between gap-2 px-4 py-2"><span class="text-sm font-semibold text-slate-700">${near.length.toLocaleString()} practice${near.length === 1 ? "" : "s"} in range</span><button type="button" id="m-save" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Save as audience</button></div>
    <div class="max-h-[50vh] overflow-auto"><table class="w-full text-left text-sm"><thead class="sticky top-0 bg-slate-50 text-xs uppercase tracking-wider text-slate-500 shadow-[0_1px_0_#e2e8f0]"><tr>${th("name", "Practice")}${th("d", "Distance", "text-right")}<th class="px-3 py-2">Town</th>${th("patients", "List size", "text-right")}${th("tier", "Tier")}${th("status", "HubSpot")}</tr></thead>
    <tbody class="divide-y divide-slate-100">${near.slice(0, mapRows).map(x => `<tr class="m-row cursor-pointer hover:bg-lalu-teal-50/50" data-ods="${esc(x.p.ods_code)}" tabindex="0"><td class="px-3 py-2"><div class="font-semibold leading-tight">${esc(x.b ? x.b.branch_name : x.p.practice_name)}${x.b ? " " + chip("Branch", "bg-slate-100 text-slate-600") : ""}</div><div class="text-xs text-slate-500">${x.b ? "of " + esc(x.p.practice_name) : esc(x.p.ods_code)}</div></td><td class="px-3 py-2 text-right font-mono">${x.d.toFixed(1)} mi</td><td class="px-3 py-2">${esc(x.b ? x.b.town || "" : x.p.town || "")}</td><td class="px-3 py-2 text-right font-mono">${x.b ? "" : x.p.total_patients > 0 ? Number(x.p.total_patients).toLocaleString() : "–"}</td><td class="px-3 py-2">${!x.b && x.p.total_patients > 0 ? chip(tier(x.p), TIER_CLS[tier(x.p)] || "") : ""}</td><td class="px-3 py-2">${chip(HS_LABEL[hsState(x.p)], HS_CLS[hsState(x.p)])}${x.p.hubspot_commercial_model ? `<div class="mt-0.5 text-xs text-slate-500">${esc(MODEL_KEY[x.p.hubspot_commercial_model] || x.p.hubspot_commercial_model)}</div>` : ""}</td></tr>`).join("")}</tbody></table>
    ${near.length > mapRows ? `<div class="p-3 text-center"><button type="button" id="m-more" class="text-sm text-lalu-teal-700 hover:underline">Show more (${(near.length - mapRows).toLocaleString()} left)</button></div>` : ""}</div>`;
}
function mapClear() {
  mapCentre = null; mapInside = []; if (pmapCircle) pmapCircle.remove(); if (pmapPin) pmapPin.remove(); pmapCircle = pmapPin = null;
  $("m-clear").classList.add("hidden"); $("m-list").classList.add("hidden"); $("m-list").innerHTML = ""; mapRefresh(true);
}
// From a profile: the practices near this one.
function mapNear(ods, miles) { const p = byOds.get(ods); if (!p) return; closeDrawer(); showTab("practices"); mapSearch(p.postcode || "", miles || 10, p.practice_name).then(() => { if (mapCentre) mapCentre.ods = ods; mapRefresh(); }); }
$("v-table").onclick = () => mapSetView(false);
$("v-map").onclick = () => mapSetView(true);
$("m-go").onclick = () => mapSearch($("m-pc").value, $("m-mi").value);
$("m-pc").addEventListener("keydown", e => { if (e.key === "Enter") mapSearch($("m-pc").value, $("m-mi").value); });
$("m-mi").addEventListener("change", () => { if (mapCentre) mapSearch(mapCentre.pc, $("m-mi").value, mapCentre.label); });
$("m-clear").onclick = mapClear;
$("m-br").addEventListener("change", e => { mapBranches = e.target.checked; mapRefresh(); });
document.addEventListener("click", e => {
  const leg = e.target.closest(".m-leg"); if (leg) { const k = leg.dataset.k; mapHidden.has(k) ? mapHidden.delete(k) : mapHidden.add(k); mapRefresh(); return; }
  const mth = e.target.closest(".m-th"); if (mth) { const k = mth.dataset.k; mapSort = { key: k, dir: mapSort.key === k ? -mapSort.dir : (k === "patients" ? -1 : 1) }; mapRefresh(); return; }
  if (e.target.closest("#m-more")) { mapRows += 100; mapRefresh(); return; }
  const row = e.target.closest(".m-row"); if (row) { const p = byOds.get(row.dataset.ods); if (p) openDrawer(p); return; }
  if (e.target.closest("#m-save")) { mapSaveAudience(); return; }
  const near = e.target.closest("[data-near]"); if (near) { e.preventDefault(); mapNear(near.dataset.near, 10); }
});
function mapSaveAudience() {
  const codes = [...new Set((mapRowsShown || mapInside).map(x => x.p.ods_code))], name0 = `Within ${mapCentre.miles} miles of ${mapCentre.label}`;
  audModal("Save as audience", `<label class="block text-xs font-semibold text-slate-600">Name<input type="text" id="aud-name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="${esc(name0.slice(0, 80))}" maxlength="80"></label>
    <p class="mt-3 text-sm"><b>${codes.length.toLocaleString()}</b> practice${codes.length === 1 ? "" : "s"} within ${mapCentre.miles} miles, from the practices the filters show.</p><p class="mt-1 text-xs text-slate-500">This saves the practices as they are today; it will not pick up practices that open nearby later.</p>`,
    async () => { const name = $("aud-name").value.trim(); if (!name) throw new Error("Give the audience a name."); if (!codes.length) throw new Error("No practices in range."); const a = await audCreate(name, { criteria: null, pinned: codes, summary: name0 }); audDone(`Saved “${name}” with ${codes.length.toLocaleString()} practices.`, a); $("aud-open-it").onclick = () => audOpenIt(a); });
}
