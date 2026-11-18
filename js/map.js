/* Practices map: the Practices filters drawn on a map (Table / Map toggle), coloured by HubSpot status, with a postcode + miles search. Coordinates come from postcodes.io via the
   geocode job and live in app_flags.postcode_coords ({ "AB12CD": [lat, lng] }). Leaflet is vendored in assets/vendor/leaflet. */
let mapOn = false, pmap = null, pmapLayer = null, pmapCircle = null, pmapPin = null, mapCoords = null, mapCoordsLoading = null, mapHidden = new Set(), mapCentre = null, mapInside = [];
const MAP_COL = { customer: "#059669", freemium: "#d97706", engaged: "#0d9488", other: "#94a3b8" };
const MAP_LABEL = { customer: "Customer", freemium: "Freemium", engaged: "Engaged", other: "Other" };
const mapKey = p => { const s = hsState(p); return s === "customer" || s === "freemium" || s === "engaged" ? s : "other"; };
const mapNorm = pc => String(pc || "").replace(/\s+/g, "").toUpperCase();
const mapMiles = (a, b) => { const R = 3958.8, r = x => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]), h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
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
  pmap = L.map("pmap", { preferCanvas: true, zoomControl: true }).setView([52.9, -1.6], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(pmap);
  pmapLayer = L.layerGroup().addTo(pmap);
}
async function mapRefresh(fit) {
  if (!mapOn) return;
  await mapLoadCoords(); mapEnsure(); setTimeout(() => pmap.invalidateSize(), 0);
  const placed = [], unplaced = [];
  for (const p of filtered) (mapAt(p) ? placed : unplaced).push(p);
  const counts = { customer: 0, freemium: 0, engaged: 0, other: 0 }; for (const p of placed) counts[mapKey(p)]++;
  $("m-legend").innerHTML = Object.keys(MAP_COL).map(k => `<button type="button" data-k="${k}" class="m-leg inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-1 font-semibold ${mapHidden.has(k) ? "opacity-40" : ""}" title="Click to show or hide"><span class="h-2.5 w-2.5 rounded-full" style="background:${MAP_COL[k]}"></span>${MAP_LABEL[k]} <span class="font-normal text-slate-500">${counts[k].toLocaleString()}</span></button>`).join("");
  pmapLayer.clearLayers();
  const shown = placed.filter(p => !mapHidden.has(mapKey(p))), pts = [];
  for (const p of shown) {
    const at = mapAt(p), k = mapKey(p), m = L.circleMarker(at, { radius: k === "other" ? 4 : 6, color: "#fff", weight: 1, fillColor: MAP_COL[k], fillOpacity: k === "other" ? 0.7 : 0.95 });
    m.on("click", () => mapPopup(p, m)); m.addTo(pmapLayer); pts.push(at);
  }
  if (!mapCentre) $("m-msg").textContent = unplaced.length ? `${placed.length.toLocaleString()} on the map; ${unplaced.length.toLocaleString()} have no location yet` : `${placed.length.toLocaleString()} practices`;
  if (mapCentre) mapRadiusList(shown);
  else if (fit && pts.length) pmap.fitBounds(L.latLngBounds(pts).pad(0.05));
  if (!Object.keys(mapCoords).length) $("m-msg").textContent = "No locations yet: run the Geocode postcodes workflow once.";
}
function mapPopup(p, m) {
  const d = mapCentre && mapAt(p) ? mapMiles(mapCentre.at, mapAt(p)) : null;
  const html = document.createElement("div"); html.className = "text-sm";
  html.innerHTML = `<div class="font-semibold leading-tight">${esc(p.practice_name)}</div><div class="mt-0.5 text-xs text-slate-500">${esc(p.ods_code)}${p.town ? " · " + esc(p.town) : ""}${d != null ? " · " + d.toFixed(1) + " miles" : ""}</div>
    <div class="mt-1 flex flex-wrap gap-1">${p.total_patients > 0 ? chip(tier(p), TIER_CLS[tier(p)] || "") : ""} ${chip(HS_LABEL[hsState(p)], HS_CLS[hsState(p)])}</div>
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
  mapCentre = { at, miles: Number(miles), pc, label: label || pc.toUpperCase() };
  mapEnsure(); if (pmapCircle) pmapCircle.remove(); if (pmapPin) pmapPin.remove();
  pmapCircle = L.circle(at, { radius: mapCentre.miles * 1609.344, color: "#1e3a5f", weight: 2, fillOpacity: 0.05 }).addTo(pmap);
  pmapPin = L.marker(at, { title: mapCentre.label }).addTo(pmap);
  $("m-clear").classList.remove("hidden");
  pmap.fitBounds(pmapCircle.getBounds().pad(0.05));
  mapRefresh();
}
function mapRadiusList(shown) {
  mapInside = shown.map(p => ({ p, d: mapMiles(mapCentre.at, mapAt(p)) })).filter(x => x.d <= mapCentre.miles).sort((a, b) => a.d - b.d);
  const near = mapInside.filter(x => !mapCentre.ods || x.p.ods_code !== mapCentre.ods);
  $("m-msg").textContent = `${near.length.toLocaleString()} practice${near.length === 1 ? "" : "s"} within ${mapCentre.miles} miles of ${mapCentre.label}`;
  const box = $("m-list"); box.classList.remove("hidden");
  box.innerHTML = `<div class="sticky top-0 flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2"><span class="text-xs font-semibold text-slate-600">${near.length.toLocaleString()} nearest first</span><button type="button" id="m-save" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold hover:bg-slate-50">Save as audience</button></div>`
    + near.slice(0, 300).map(x => `<button type="button" class="m-row flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50" data-ods="${esc(x.p.ods_code)}"><span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style="background:${MAP_COL[mapKey(x.p)]}"></span><span class="min-w-0 flex-1"><span class="block truncate text-sm font-semibold">${esc(x.p.practice_name)}</span><span class="block text-xs text-slate-500">${esc(x.p.ods_code)} · ${x.d.toFixed(1)} mi${x.p.total_patients > 0 ? " · " + Number(x.p.total_patients).toLocaleString() : ""}</span></span></button>`).join("")
    + (near.length > 300 ? `<div class="px-3 py-2 text-xs text-slate-500">Showing the nearest 300.</div>` : "");
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
document.addEventListener("click", e => {
  const leg = e.target.closest(".m-leg"); if (leg) { const k = leg.dataset.k; mapHidden.has(k) ? mapHidden.delete(k) : mapHidden.add(k); mapRefresh(); return; }
  const row = e.target.closest(".m-row"); if (row) { const p = byOds.get(row.dataset.ods); if (p) openDrawer(p); return; }
  if (e.target.closest("#m-save")) { mapSaveAudience(); return; }
  const near = e.target.closest("[data-near]"); if (near) { e.preventDefault(); mapNear(near.dataset.near, 10); }
});
function mapSaveAudience() {
  const codes = mapInside.filter(x => !mapCentre.ods || x.p.ods_code !== mapCentre.ods).map(x => x.p.ods_code), name0 = `Within ${mapCentre.miles} miles of ${mapCentre.label}`;
  audModal("Save as audience", `<label class="block text-xs font-semibold text-slate-600">Name<input type="text" id="aud-name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="${esc(name0.slice(0, 80))}" maxlength="80"></label>
    <p class="mt-3 text-sm"><b>${codes.length.toLocaleString()}</b> practice${codes.length === 1 ? "" : "s"} within ${mapCentre.miles} miles, from the practices the filters show.</p><p class="mt-1 text-xs text-slate-500">This saves the practices as they are today; it will not pick up practices that open nearby later.</p>`,
    async () => { const name = $("aud-name").value.trim(); if (!name) throw new Error("Give the audience a name."); if (!codes.length) throw new Error("No practices in range."); const a = await audCreate(name, { criteria: null, pinned: codes, summary: name0 }); audDone(`Saved “${name}” with ${codes.length.toLocaleString()} practices.`, a); $("aud-open-it").onclick = () => audOpenIt(a); });
}
