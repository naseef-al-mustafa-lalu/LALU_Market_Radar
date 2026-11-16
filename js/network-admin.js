/* Create or extend a provider group / federation from Atlas: pick its practices, and Atlas creates (or reuses) the HubSpot company, gives it the Org Type the sync looks for, and links the practices with the account's
   labels (Operating Provider / Operated Practice, Federation / Member Practice). The daily HubSpot sync, or Run sync now, then brings it into Atlas. Needs hubspot-network.js's helpers and the shared HubSpot modal. */
let nmKind = "group", nmName = "", nmSel = new Map(), nmPasteText = "", nmMatchRes = null;
function hsNewNetwork() {
  hs = { net: true, p: { practice_name: "Networks" } }; nmKind = "group"; nmName = ""; nmSel = new Map(); nmPasteText = ""; nmMatchRes = null;
  $("hs-modal").classList.remove("hidden"); hsTitle("New group or federation"); nmRender();
}
function nmFind(q) {
  const t = q.trim().toLowerCase(); if (t.length < 2) return [];
  return practices.filter(p => p.status === "Active" && p.org_kind !== "non_gp" && !p.merged_into && !nmSel.has(p.ods_code) && [p.practice_name, p.ods_code, p.postcode].some(v => (v || "").toLowerCase().includes(t))).slice(0, 12);
}

// Add many practices from a pasted list (one per line: name, then optionally an ODS code and a postcode area such as "(WF2)"). A line is added straight away only when it is certain: the ODS code is held and the name agrees,
// or the whole name matches one practice (in the right postcode area when one is given). Anything less certain is offered for a person to confirm, and the rest are listed so they can be searched for by hand.
const NM_NOISE = new Set(["surgery", "medical", "centre", "center", "practice", "health", "group", "partners", "partnership", "clinic", "care", "primary", "the", "and", "unindexed", "public", "search"]);
const nmNorm = n => String(n || "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const nmKeys = n => nmNorm(n).split(" ").filter(w => w.length > 2 && !NM_NOISE.has(w));
const nmOutward = pc => { const t = String(pc || "").trim().toUpperCase(); return t.includes(" ") ? t.split(/\s+/)[0] : t.replace(/\d[A-Z]{2}$/, ""); };   // "WF10 1PH" -> "WF10": compared whole, so WF1 never matches WF10
function nmParseLine(line) {
  const clean = String(line).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s*\d+[.)\t ]+/, "");      // links keep their text; a leading row number goes
  const ods = (clean.match(/\b[A-Z]\d{5}\b/) || [])[0] || "", full = clean.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/), paren = clean.match(/\(([A-Z]{1,2}\d{1,2}[A-Z]?)\)/);
  const parts = clean.split(/\t| {2,}|\s\|\s/).map(x => x.trim()).filter(x => x && !/^[A-Z]\d{5}$/.test(x) && !/^[\d,.]+$/.test(x) && !/^[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}$/.test(x));
  if (!parts.length) return null;
  const alt = (parts[0].match(/\(([^)]*)\)/) || [])[1] || "";
  return { name: parts[0].replace(/\([^)]*\)/g, "").replace(/\b[A-Z]\d{5}\b/, "").trim(), alt, ods, area: (full ? full[1] : paren ? paren[1] : "").toUpperCase() };
}
function nmMatchList(text) {
  const pool = practices.filter(p => p.status === "Active" && p.org_kind !== "non_gp" && !p.merged_into), out = { sure: [], maybe: [], none: [], dup: 0 };
  for (const raw of String(text).split(/\r?\n/)) {
    const q = nmParseLine(raw); if (!q || q.name.length < 2) continue;
    const inArea = p => !q.area || nmOutward(p.postcode) === q.area, nn = nmNorm(q.name), keys = [...nmKeys(q.name), ...nmKeys(q.alt)];
    const byCode = q.ods ? pool.find(p => p.ods_code === q.ods) : null;
    const exact = pool.filter(p => nmNorm(p.practice_name) === nn), exactIn = exact.filter(inArea);
    let hit = null, why = "";
    if (byCode && (nmNorm(byCode.practice_name) === nn || nmKeys(byCode.practice_name).some(k => keys.includes(k)))) { hit = byCode; why = "ODS code"; }
    else if (exactIn.length === 1) { hit = exactIn[0]; why = "name" + (q.area ? " and postcode area" : ""); }
    if (hit) { if (out.sure.some(r => r.p.ods_code === hit.ods_code)) out.dup++; else out.sure.push({ q, p: hit, why }); continue; }
    const fuzzy = (exactIn.length ? exactIn : exact.length ? exact : pool.filter(p => keys.length && keys.every(k => nmKeys(p.practice_name).includes(k)) && inArea(p))).slice(0, 4);
    if (byCode) fuzzy.unshift(byCode);
    out[fuzzy.length ? "maybe" : "none"].push({ q, options: [...new Map(fuzzy.map(p => [p.ods_code, p])).values()] });
  }
  return out;
}
function nmMatchHtml() {
  const m = nmMatchRes; if (!m) return "";
  const line = q => `<span class="font-medium">${esc(q.name)}</span>${q.ods ? ` <span class="font-mono text-xs text-slate-500">${esc(q.ods)}</span>` : ""}${q.area ? ` <span class="text-xs text-slate-500">${esc(q.area)}</span>` : ""}`;
  return `<div class="mt-2 space-y-2"><div class="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900" role="status"><b>${m.sure.length}</b> matched and added${m.dup ? ` (${m.dup} repeated)` : ""}. <b>${m.maybe.length}</b> need a look. <b>${m.none.length}</b> not found.</div>
    ${m.maybe.length ? `<div><div class="text-xs font-semibold text-amber-800">Possible matches: choose the right one</div>${m.maybe.map(r => `<div class="mt-1 rounded-lg border border-amber-200 px-3 py-1.5">${line(r.q)}<div class="mt-1 flex flex-wrap gap-1.5">${r.options.map(p => `<button type="button" class="nm-pick rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:border-lalu-teal-700" data-o="${esc(p.ods_code)}">${esc(p.practice_name)} <span class="font-mono text-slate-500">${esc(p.ods_code)}</span> <span class="text-slate-500">${esc(p.postcode || "")}</span></button>`).join("")}</div></div>`).join("")}</div>` : ""}
    ${m.none.length ? `<div><div class="text-xs font-semibold text-slate-600">Not found in Atlas (search for them above, or they may not be GP practices Atlas holds)</div><ul class="mt-1 list-disc pl-5 text-xs text-slate-600">${m.none.map(r => `<li>${line(r.q)}</li>`).join("")}</ul></div>` : ""}</div>`;
}
function nmRender(msg = "") {
  const sel = [...nmSel.values()], unlinked = sel.filter(p => !p.hubspot_company_id);
  hsRender(`<div class="space-y-3 text-sm">
    <div class="flex gap-2" role="group" aria-label="Kind">${[["group", "Provider group"], ["federation", "Federation"]].map(([k, l]) => `<button type="button" class="nm-kind rounded-lg border px-3 py-1.5 text-xs font-semibold ${nmKind === k ? "border-lalu-navy bg-lalu-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}" data-k="${k}" aria-pressed="${nmKind === k}">${l}</button>`).join("")}</div>
    <label class="block text-xs font-semibold text-slate-600">Name<input id="nm-name" value="${esc(nmName)}" placeholder="e.g. Wigan GP Alliance" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></label>
    <div class="relative"><label class="block text-xs font-semibold text-slate-600">Add practices<input id="nm-q" type="search" autocomplete="off" placeholder="Search name, ODS code or postcode…" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></label><div id="nm-res" class="mt-1 space-y-1"></div></div>
    <details class="rounded-lg border border-slate-200 p-3" ${nmMatchRes || nmPasteText ? "open" : ""}><summary class="cursor-pointer text-xs font-semibold text-slate-600">Add many from a list</summary>
      <p class="mt-1 text-xs text-slate-500">Paste one practice per line (name, then an ODS code and postcode area if you have them). Sure matches are added; the rest are shown for you to check.</p>
      <textarea id="nm-paste" rows="6" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" placeholder="Alverthorpe Surgery&#9;Unindexed&#9;Wakefield (WF2)">${esc(nmPasteText)}</textarea>
      <div class="mt-1"><button type="button" id="nm-match" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Match and add</button></div>${nmMatchHtml()}</details>
    <div><div class="mb-1 text-xs font-semibold text-slate-600">${sel.length} practice${sel.length === 1 ? "" : "s"} selected</div>
      <div class="divide-y divide-slate-100 rounded-lg border border-slate-200">${sel.map(p => `<div class="flex items-center justify-between gap-2 px-3 py-1.5"><span class="min-w-0"><span class="font-medium">${esc(p.practice_name)}</span> <span class="font-mono text-xs text-slate-500">${esc(p.ods_code)}</span>${p.hubspot_company_id ? "" : " " + chip("Not in HubSpot", "bg-amber-100 text-amber-800", "Add this practice to HubSpot first (its profile > Add to HubSpot); it is skipped for now")}</span><button type="button" class="nm-rm text-xs font-semibold text-slate-500 hover:text-rose-700" data-o="${esc(p.ods_code)}" aria-label="Remove ${esc(p.practice_name)}">Remove</button></div>`).join("") || '<p class="px-3 py-2 text-xs italic text-slate-500">None yet.</p>'}</div>
      ${unlinked.length ? `<p class="mt-1 text-xs text-amber-800">${unlinked.length} of these ${unlinked.length === 1 ? "is" : "are"} not in HubSpot yet and will be skipped.</p>` : ""}</div>
    <div id="nm-msg" class="min-h-[1rem] text-xs" role="status">${msg}</div>
    <div class="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white pt-3"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Close</button><button id="nm-go" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50" ${nmName.trim() && sel.some(p => p.hubspot_company_id) ? "" : "disabled"}>Create in HubSpot and link</button></div></div>`);
  $("hs-cancel").onclick = hsClose;
  document.querySelectorAll(".nm-kind").forEach(b => b.onclick = () => { nmKind = b.dataset.k; nmRender(); });
  document.querySelectorAll(".nm-rm").forEach(b => b.onclick = () => { nmSel.delete(b.dataset.o); nmRender(); });
  $("nm-name").oninput = e => { nmName = e.target.value; $("nm-go").disabled = !(nmName.trim() && [...nmSel.values()].some(p => p.hubspot_company_id)); };
  $("nm-q").oninput = e => { $("nm-res").innerHTML = nmFind(e.target.value).map(p => `<button type="button" class="nm-add flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-left hover:border-lalu-teal-700" data-o="${esc(p.ods_code)}"><span><span class="font-medium">${esc(p.practice_name)}</span> <span class="font-mono text-xs text-slate-500">${esc(p.ods_code)}</span> <span class="text-xs text-slate-500">${esc(p.postcode || "")}</span></span><span class="text-xs font-semibold text-lalu-teal-700">Add</span></button>`).join(""); document.querySelectorAll(".nm-add").forEach(b => b.onclick = () => { nmSel.set(b.dataset.o, byOds.get(b.dataset.o)); nmRender(); $("nm-q").focus(); }); };
  $("nm-paste").oninput = e => { nmPasteText = e.target.value; };
  $("nm-match").onclick = () => { nmPasteText = $("nm-paste").value; nmMatchRes = nmMatchList(nmPasteText); for (const r of nmMatchRes.sure) nmSel.set(r.p.ods_code, r.p); nmRender(); };
  document.querySelectorAll(".nm-pick").forEach(b => b.onclick = () => { const p = byOds.get(b.dataset.o); if (p) { nmSel.set(p.ods_code, p); nmMatchRes.maybe = nmMatchRes.maybe.filter(r => !r.options.some(o => o.ods_code === p.ods_code)); } nmRender(); });
  $("nm-go").onclick = nmRun;
}
async function nmRun() {
  const go = $("nm-go"), msg = $("nm-msg"), name = nmName.trim(), members = [...nmSel.values()], linkable = members.filter(p => p.hubspot_company_id), skipped = members.filter(p => !p.hubspot_company_id);
  go.disabled = true; go.textContent = "Working…"; msg.textContent = "";
  try {
    let r = await hsCall({ action: "create_company_for_network", name, kind: nmKind }), reused = false;
    if (r.ok === false && r.existing && r.existing.length) { reused = true; r = await hsCall({ action: "create_company_for_network", name, kind: nmKind, companyId: r.existing[0].id }); }   // a company of that name already exists: use it
    const l = await hsCall({ action: "link_network_members", companyId: r.companyId, kind: nmKind, memberCompanyIds: linkable.map(p => p.hubspot_company_id) });
    hsRender(`<div class="space-y-3 text-sm"><div class="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900" role="status"><b>${esc(name)}</b> ${reused ? "already existed in HubSpot and was used" : "was created in HubSpot"}; ${l.linked} practice${l.linked === 1 ? " was" : "s were"} linked ${l.labelled ? "with the " + (nmKind === "federation" ? "Federation / Member Practice" : "Operating Provider / Operated Practice") + " labels" : "without labels"}. ${hsLink("0-2", r.companyId, "Open in HubSpot")}</div>
      ${skipped.length ? `<p class="text-xs text-amber-800">Skipped, not in HubSpot yet: ${skipped.map(p => esc(p.practice_name + " (" + p.ods_code + ")")).join(", ")}.</p>` : ""}
      ${(r.warnings || []).concat(l.warnings || []).map(w => `<p class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <p class="text-xs text-slate-500">It appears in Atlas (Networks) after the next HubSpot sync. Run it now to see it in about three minutes.</p><div id="nm-sync" class="text-xs" role="status"></div>
      <div class="flex justify-end gap-2"><button id="nm-runsync" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold hover:bg-slate-50">Run HubSpot sync now</button><button id="hs-cancel" class="rounded-lg bg-lalu-navy px-4 py-2 font-semibold text-white">Done</button></div></div>`);
    $("hs-cancel").onclick = hsClose;
    $("nm-runsync").onclick = async e => { e.target.disabled = true; const { data, error } = await db.functions.invoke("hubspot-sync-trigger"); $("nm-sync").textContent = error || (data && data.error) ? "Could not start the sync: " + ((data && data.error) || (error && error.message)) : "Sync started. Reload Atlas in about three minutes."; };
  } catch (e) { go.disabled = false; go.textContent = "Create in HubSpot and link"; msg.innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
}
