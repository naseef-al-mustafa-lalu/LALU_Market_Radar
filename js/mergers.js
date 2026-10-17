// Practice mergers: a practice that merged stays Active on ODS with no NHS list size (its patients are counted under the practice that absorbed it).
// Suggestions come from the database (same postcode); a person confirms them. Nothing is merged automatically.
let mergeSugg = new Map(), mgShown = 0, mgList = [];
const CONF = { high: ["Only practice at this postcode", "bg-emerald-100 text-emerald-800"], medium: ["Several practices at this postcode", "bg-amber-100 text-amber-800"], low: ["Non-standard site: often a service in a shared building", "bg-slate-100 text-slate-600"] };
const CONF_RANK = { high: 0, medium: 1, low: 2 };
const absorbedBy = code => practices.filter(x => x.merged_into === code);
const lifecycle = p => p.merged_into ? "merged" : p.status === "Closed" ? "closed" : "active";
async function loadMergeSuggestions() {
  try { mergeSugg = new Map((await fetchAll("practice_merge_suggestions", "ods_code,into_code,into_name,into_patients,n_candidates,confidence", "ods_code")).map(r => [r.ods_code, r])); }
  catch { mergeSugg = new Map(); }
  updateMergeBadge();
}
function updateMergeBadge() { const n = mergeSugg.size; const b = $("merge-badge"); if (b) { b.textContent = n; b.classList.toggle("hidden", !n); } }

/* ---------- confirm / undo / dismiss ---------- */
async function setMerge(ods, into, note) {
  const { error } = await db.rpc("set_practice_merge", { p_ods: ods, p_into: into || null, p_note: note || null });
  if (error) return error.message || String(error);
  const p = byOds.get(ods); if (!p) return null;
  Object.assign(p, into ? { merged_into: into, merged_note: note || null, merged_at: new Date().toISOString(), merge_dismissed: false } : { merged_into: null, merged_note: null, merged_at: null });
  if (into) mergeSugg.delete(ods);
  updateMergeBadge(); applyFilters(); renderMergers();
  if (drawerCode === ods) openDrawer(p);
  return null;
}
async function dismissMerge(ods, dismissed) {
  const { error } = await db.rpc("dismiss_merge_suggestion", { p_ods: ods, p_dismissed: dismissed });
  if (error) return error.message || String(error);
  const p = byOds.get(ods); if (p) p.merge_dismissed = dismissed;
  if (dismissed) mergeSugg.delete(ods); else await loadMergeSuggestions();
  updateMergeBadge(); renderMergers(); if (drawerCode === ods && p) openDrawer(p);
  return null;
}

/* ---------- practice profile: status card ---------- */
const mgBtn = (act, ods, label, cls, extra = "") => `<button type="button" data-mg="${act}" data-ods="${esc(ods)}" ${extra} class="${cls} rounded-lg px-3 py-1.5 text-xs font-semibold">${label}</button>`;
const BTN_PRIMARY = "bg-indigo-600 hover:bg-indigo-700 text-white", BTN_GHOST = "border border-slate-300 bg-white hover:bg-slate-50 text-slate-700";
function mergeSection(p) {
  const kids = absorbedBy(p.ods_code);
  let card = "";
  if (p.merged_into) {
    const t = byOds.get(p.merged_into);
    card = `<div class="rounded-xl border border-indigo-200 bg-indigo-50 p-3"><div class="font-semibold text-indigo-900">Merged into <a href="#" data-open="${esc(p.merged_into)}" class="underline">${esc(t ? t.practice_name : p.merged_into)}</a></div>
      <p class="text-xs text-indigo-900/80 mt-0.5">Its patients are counted in that practice's list${t && t.total_patients ? " (" + t.total_patients.toLocaleString() + " patients)" : ""}, so this one has no list size of its own and is hidden from the main list.</p>
      ${p.merged_note ? `<p class="text-xs text-indigo-900/80 mt-1 italic">${esc(p.merged_note)}</p>` : ""}
      <p class="text-xs text-indigo-900/60 mt-1">${p.merged_at ? "Recorded " + esc(fmtDate(p.merged_at)) : ""}${p.merged_by ? " by " + esc(p.merged_by) : ""}</p>
      <div class="mt-2">${mgBtn("undo", p.ods_code, "Undo merge", BTN_GHOST)}</div></div>`;
  } else if (p.status === "Active" && !(p.total_patients > 0) && (p.country || "England") === "England") {
    const s = mergeSugg.get(p.ods_code);
    card = s ? `<div class="rounded-xl border border-amber-200 bg-amber-50 p-3"><div class="font-semibold text-amber-900">Probably merged into <a href="#" data-open="${esc(s.into_code)}" class="underline">${esc(s.into_name)}</a></div>
        <p class="text-xs text-amber-900/80 mt-0.5">Same postcode, ${Number(s.into_patients).toLocaleString()} patients. ${chip(CONF[s.confidence][0], CONF[s.confidence][1])}</p>
        <div class="mt-2 flex flex-wrap gap-2">${mgBtn("confirm", p.ods_code, "Confirm merger", BTN_PRIMARY, `data-into="${esc(s.into_code)}"`)}${mgBtn("dismiss", p.ods_code, "Not a merger", BTN_GHOST)}</div></div>`
      : `<div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">${esc(noSizeReason(p))}${p.merge_dismissed ? `<div class="mt-1 text-xs text-slate-500">You marked this "not a merger". ${mgBtn("restore", p.ods_code, "Show suggestion again", "text-blue-600 hover:underline px-0")}</div>` : ""}</div>`;
    if (!p.merged_into) card += mergePicker(p);
  }
  const absorbed = kids.length ? `<div class="${card ? "mt-3" : ""} rounded-xl border border-slate-200 p-3"><div class="text-xs font-semibold text-slate-600 mb-1">Practices merged into this one</div>${kids.map(k =>
    `<div class="flex justify-between gap-2 py-0.5 text-sm"><a href="#" data-open="${esc(k.ods_code)}" class="text-blue-600 hover:underline">${esc(k.practice_name)}</a><span class="font-mono text-xs text-slate-500">${esc(k.ods_code)}</span></div>`).join("")}
    <p class="text-xs text-slate-500 mt-1">Their patients are included in this practice's list size.</p></div>` : "";
  return card || absorbed ? sec("Status", card + absorbed + '<p id="mg-msg" class="text-xs text-rose-600 mt-1 min-h-[1rem]" role="status"></p>') : "";
}
function mergePicker(p) {
  return `<details class="mt-2 text-sm"><summary class="cursor-pointer text-blue-600 hover:underline">Mark as merged into another practice…</summary>
    <div class="mt-2 space-y-2"><input data-mg-search type="text" autocomplete="off" placeholder="Search the practice it merged into…" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm" aria-label="Practice it merged into">
      <div data-mg-results class="space-y-1"></div>
      <input data-mg-note type="text" maxlength="300" placeholder="Note (optional)" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm" aria-label="Note">
      <div class="flex items-center gap-2"><span data-mg-picked class="text-xs text-slate-500 flex-1">No practice chosen.</span>${mgBtn("pick-save", p.ods_code, "Save", BTN_PRIMARY, "disabled")}</div></div></details>`;
}
const pickable = (q, self) => { q = q.trim().toLowerCase(); return q.length < 2 ? [] : practices.filter(x => x.ods_code !== self && x.status === "Active" && !x.merged_into && x.total_patients > 0 &&
  [x.practice_name, x.ods_code, x.postcode].some(v => (v || "").toLowerCase().includes(q))).sort((a, b) => b.total_patients - a.total_patients).slice(0, 6); };
$("dr-body").addEventListener("input", e => {
  const inp = e.target.closest("[data-mg-search]"); if (!inp) return;
  const box = inp.closest("details"), res = box.querySelector("[data-mg-results]"), ods = drawerCode;
  res.innerHTML = pickable(inp.value, ods).map(x => `<button type="button" data-mg="choose" data-into="${esc(x.ods_code)}" class="w-full text-left rounded-lg border border-slate-200 hover:bg-blue-50 px-2 py-1 text-xs"><b>${esc(x.practice_name)}</b> <span class="font-mono text-slate-500">${esc(x.ods_code)}</span> · ${esc(x.postcode || "")} · ${x.total_patients.toLocaleString()} patients</button>`).join("") || (inp.value.trim().length > 1 ? '<div class="text-xs text-slate-500">No match.</div>' : "");
});
$("dr-body").addEventListener("click", async e => {
  const open = e.target.closest("a[data-open]");
  if (open) { e.preventDefault(); const t = byOds.get(open.dataset.open); if (t) { if (!filtered.includes(t)) { /* hidden by the status filter: still open it */ } openDrawer(t); } return; }
  const b = e.target.closest("button[data-mg]"); if (!b) return;
  const act = b.dataset.mg, ods = b.dataset.ods || drawerCode, msg = () => $("mg-msg");
  if (act === "choose") { const det = b.closest("details"), x = byOds.get(b.dataset.into); det.dataset.into = x.ods_code; det.querySelector("[data-mg-picked]").textContent = "Merged into: " + x.practice_name + " (" + x.ods_code + ")"; det.querySelector('[data-mg="pick-save"]').disabled = false; det.querySelector("[data-mg-results]").innerHTML = ""; return; }
  b.disabled = true; let err = null;
  if (act === "confirm") err = await setMerge(ods, b.dataset.into, null);
  else if (act === "pick-save") { const det = b.closest("details"); err = await setMerge(ods, det.dataset.into, det.querySelector("[data-mg-note]").value); }
  else if (act === "undo") err = await setMerge(ods, null, null);
  else if (act === "dismiss") err = await dismissMerge(ods, true);
  else if (act === "restore") err = await dismissMerge(ods, false);
  if (err && msg()) { msg().textContent = "Could not save: " + err; b.disabled = false; }
});

/* ---------- Signals > Mergers: review list ---------- */
function renderMergers() {
  const box = $("mg-rows"); if (!box) return;
  const merged = practices.filter(p => p.merged_into), dismissed = practices.filter(p => p.merge_dismissed && !p.merged_into && p.status === "Active" && !(p.total_patients > 0));
  const cur = $("mg-status").value || "review";
  $("mg-status").innerHTML = [["review", "To review", mergeSugg.size], ["merged", "Confirmed mergers", merged.length], ["dismissed", "Not a merger", dismissed.length]].map(([k, l, n]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${l} (${n.toLocaleString()})</option>`).join("");
  const st = $("mg-status").value, q = $("mg-search").value.trim().toLowerCase(), cf = $("mg-conf").value;
  $("mg-conf").classList.toggle("hidden", st !== "review");
  const rows = st === "review" ? [...mergeSugg.values()].map(s => ({ p: byOds.get(s.ods_code), s })).filter(r => r.p && (!cf || r.s.confidence === cf)).sort((a, b) => CONF_RANK[a.s.confidence] - CONF_RANK[b.s.confidence] || a.p.practice_name.localeCompare(b.p.practice_name))
    : st === "merged" ? merged.map(p => ({ p, s: null })) : dismissed.map(p => ({ p, s: null }));
  mgList = rows.filter(r => !q || [r.p.practice_name, r.p.ods_code, r.p.postcode, r.p.pcn_name].some(v => (v || "").toLowerCase().includes(q)));
  mgShown = 0; box.innerHTML = ""; renderMoreMergers();
  $("mg-count").textContent = `${mgList.length.toLocaleString()} ${st === "review" ? "suggestion" : "practice"}${mgList.length === 1 ? "" : "s"}`;
}
function renderMoreMergers() {
  const st = $("mg-status").value, slice = mgList.slice(mgShown, mgShown + 50); mgShown += slice.length;
  $("mg-rows").insertAdjacentHTML("beforeend", slice.map(({ p, s }) => {
    const into = s ? { code: s.into_code, name: s.into_name, n: s.into_patients } : p.merged_into ? (t => ({ code: p.merged_into, name: t ? t.practice_name : p.merged_into, n: t ? t.total_patients : 0 }))(byOds.get(p.merged_into)) : null;
    const act = st === "review" ? mgBtn("confirm", p.ods_code, "Confirm", BTN_PRIMARY, `data-into="${esc(s.into_code)}"`) + " " + mgBtn("dismiss", p.ods_code, "Not a merger", BTN_GHOST)
      : st === "merged" ? mgBtn("undo", p.ods_code, "Undo", BTN_GHOST) : mgBtn("restore", p.ods_code, "Show again", BTN_GHOST);
    return `<tr class="align-top" data-ods="${esc(p.ods_code)}"><td class="py-2 pr-3"><a href="#" data-mgopen="${esc(p.ods_code)}" class="font-semibold leading-tight text-slate-900 hover:underline">${esc(p.practice_name)}</a><div class="font-mono text-xs text-slate-500">${esc(p.ods_code)} · ${esc(p.postcode || "")}</div></td>
      <td class="pr-3">${into ? `<a href="#" data-mgopen="${esc(into.code)}" class="font-medium text-slate-900 hover:underline">${esc(into.name)}</a><div class="text-xs text-slate-500"><span class="font-mono">${esc(into.code)}</span>${into.n ? " · " + Number(into.n).toLocaleString() + " patients" : ""}</div>` : '<span class="text-slate-300">–</span>'}</td>
      <td class="pr-3">${s ? chip(CONF[s.confidence][0], CONF[s.confidence][1]) : p.merged_note ? `<span class="text-xs text-slate-600">${esc(p.merged_note)}</span>` : ""}</td>
      <td class="whitespace-nowrap space-x-1">${act}</td></tr>`; }).join(""));
  $("mg-more").classList.toggle("hidden", mgShown >= mgList.length);
  if (!mgList.length) $("mg-rows").innerHTML = `<tr><td colspan="4" class="py-6 text-slate-500 italic">${st === "review" ? "Nothing to review: every practice with no list size has been dealt with." : "Nothing here."}</td></tr>`;
}
$("mg-rows").addEventListener("click", async e => {
  const o = e.target.closest("a[data-mgopen]"); if (o) { e.preventDefault(); const t = byOds.get(o.dataset.mgopen); if (t) { clearFilters(); $("f-status").value = "all"; $("f-search").value = t.ods_code; showTab("practices"); applyFilters(); openDrawer(t); } return; }
  const b = e.target.closest("button[data-mg]"); if (!b) return; b.disabled = true;
  const ods = b.dataset.ods, a = b.dataset.mg; let err = null;
  if (a === "confirm") err = await setMerge(ods, b.dataset.into, null); else if (a === "undo") err = await setMerge(ods, null, null);
  else if (a === "dismiss") err = await dismissMerge(ods, true); else if (a === "restore") err = await dismissMerge(ods, false);
  $("mg-msg").textContent = err ? "Could not save: " + err : a === "confirm" ? "Merger recorded." : a === "undo" ? "Merger undone." : a === "dismiss" ? "Marked as not a merger." : "Suggestion restored.";
  if (err) b.disabled = false;
});
["mg-status", "mg-conf"].forEach(id => $(id).addEventListener("change", renderMergers)); $("mg-search").addEventListener("input", renderMergers); $("mg-more").addEventListener("click", renderMoreMergers);
