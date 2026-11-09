/* Create or extend a provider group / federation from Atlas: pick its practices, and Atlas creates (or reuses) the HubSpot company, gives it the Org Type the sync looks for, and links the practices with the account's
   labels (Operating Provider / Operated Practice, Federation / Member Practice). The daily HubSpot sync, or Run sync now, then brings it into Atlas. Needs hubspot-network.js's helpers and the shared HubSpot modal. */
let nmKind = "group", nmName = "", nmSel = new Map();
function hsNewNetwork() {
  hs = { net: true, p: { practice_name: "Networks" } }; nmKind = "group"; nmName = ""; nmSel = new Map();
  $("hs-modal").classList.remove("hidden"); hsTitle("New group or federation"); nmRender();
}
function nmFind(q) {
  const t = q.trim().toLowerCase(); if (t.length < 2) return [];
  return practices.filter(p => p.status === "Active" && p.org_kind !== "non_gp" && !p.merged_into && !nmSel.has(p.ods_code) && [p.practice_name, p.ods_code, p.postcode].some(v => (v || "").toLowerCase().includes(t))).slice(0, 12);
}
function nmRender(msg = "") {
  const sel = [...nmSel.values()], unlinked = sel.filter(p => !p.hubspot_company_id);
  hsRender(`<div class="space-y-3 text-sm">
    <div class="flex gap-2" role="group" aria-label="Kind">${[["group", "Provider group"], ["federation", "Federation"]].map(([k, l]) => `<button type="button" class="nm-kind rounded-lg border px-3 py-1.5 text-xs font-semibold ${nmKind === k ? "border-lalu-navy bg-lalu-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}" data-k="${k}" aria-pressed="${nmKind === k}">${l}</button>`).join("")}</div>
    <label class="block text-xs font-semibold text-slate-600">Name<input id="nm-name" value="${esc(nmName)}" placeholder="e.g. Wigan GP Alliance" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></label>
    <div class="relative"><label class="block text-xs font-semibold text-slate-600">Add practices<input id="nm-q" type="search" autocomplete="off" placeholder="Search name, ODS code or postcode…" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></label><div id="nm-res" class="mt-1 space-y-1"></div></div>
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
