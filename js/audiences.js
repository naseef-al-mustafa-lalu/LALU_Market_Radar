// Audiences: signal audiences (one per signal type, automatic) and custom audiences (a saved Practices filter, hand-picked practices, or both).
// A practice appears in an audience; the salesperson expands it, ticks the contacts worth messaging and approves them. Suggested contacts are read live from HubSpot
// (Atlas holds none); only decisions (approved, skipped) are stored. A contact approved for one audience is locked in every other. Loaded after mergers.js.
let audiences = [], audMembers = [], audOpen = null, audRole = "all", audShown = 100;
const audExpanded = new Set(), audContacts = new Map(), audTicked = new Set();   // ODS -> { loading, list, error }; contact ids ticked for the next approve or skip
const AUD_LOCKS = ["approved", "enrolled"], AUD_PAGE = 100, AUD_EXPAND_ALL = 25;
const AUD_ROLES = [["all", "All roles"], ["manager", "Practice managers"], ["clinical", "GPs and clinicians"], ["other", "Other"]];
const audRoleOf = t => /manager|practice lead|administrator|business partner/i.test(t || "") ? "manager" : /\b(gp|general practitioner|doctor|dr\.?|partner|nurse|clinical|pharmacist|paramedic)\b/i.test(t || "") ? "clinical" : "other";
const audCriteria = a => (a.filters && a.filters.criteria) || null, audPinned = a => (a.filters && a.filters.pinned) || [];
function audPractices(a) {
  if (a.kind === "signal") {
    const m = new Map();
    for (const s of signals.filter(s => s.trigger_type === a.signal_type && s.ods_code && ["new", "in_progress"].includes(s.status || "new"))) (m.get(s.ods_code) || m.set(s.ods_code, []).get(s.ods_code)).push(s);
    return [...m].map(([ods, list]) => ({ ods, list: list.sort((x, y) => String(y.detected_at).localeCompare(String(x.detected_at))) })).sort((x, y) => String(y.list[0].detected_at).localeCompare(String(x.list[0].detected_at)));
  }
  const pin = new Set(audPinned(a)), crit = audCriteria(a);
  return practices.filter(p => pin.has(p.ods_code) || (crit && matchPractice(p, crit, null))).sort((x, y) => (y.total_patients || 0) - (x.total_patients || 0)).map(p => ({ ods: p.ods_code, list: [], pinned: pin.has(p.ods_code) }));
}
const audMember = (a, id) => audMembers.find(m => m.audience_id === a.id && m.contact_id === id);
const audLock = (a, id) => { const m = audMembers.find(x => x.contact_id === id && x.audience_id !== a.id && AUD_LOCKS.includes(x.state)); return m ? (audiences.find(x => x.id === m.audience_id) || {}).name || "another audience" : null; };
const audApproved = a => audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state)).length;
async function loadAudiences() {
  const [a, m] = await Promise.all([db.from("audiences").select("*").eq("archived", false).order("created_at"), db.from("audience_members").select("*")]);
  audiences = a.data || []; audMembers = m.data || [];
  const missing = [...new Set(signals.map(s => s.trigger_type))].filter(t => t && !audiences.some(x => x.signal_type === t));
  if (missing.length) {   // a signal type that appeared after the audiences were created
    const labels = new Map(sigSettings.map(t => [t.trigger_type, t.label]));
    const { data } = await db.from("audiences").insert(missing.map(t => ({ kind: "signal", signal_type: t, name: labels.get(t) || t }))).select();
    audiences = audiences.concat(data || []);
  }
  renderAudiences();
}
function renderAudiences() {
  const box = $("aud-body"); if (!box) return;
  const a = audiences.find(x => x.id === audOpen);
  box.innerHTML = a ? audienceDetail(a) : audienceCards();
}
const audCard = a => {
  const prac = audPractices(a), custom = a.kind === "custom", sum = custom ? ((a.filters && a.filters.summary) || "Hand-picked practices") : "";
  return `<button type="button" class="aud-card rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-lalu-teal-500 hover:shadow-sm" data-aud="${esc(a.id)}">
    <div class="flex items-start justify-between gap-2"><div class="font-semibold leading-tight">${esc(a.name)}</div>${!custom && prac.length ? `<span class="shrink-0 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800">${prac.length} to review</span>` : ""}${custom ? '<span class="shrink-0 rounded-full bg-lalu-teal-50 px-2 py-0.5 text-[11px] font-semibold text-lalu-teal-800">Custom</span>' : ""}</div>
    ${custom ? `<div class="mt-1 line-clamp-2 text-xs text-slate-500">${esc(sum)}</div>` : ""}
    <div class="mt-3 flex gap-5 text-sm"><div><div class="text-lg font-bold leading-none">${prac.length.toLocaleString()}</div><div class="text-[11px] uppercase tracking-wider text-slate-500">practices</div></div>
      <div><div class="text-lg font-bold leading-none">${audApproved(a)}</div><div class="text-[11px] uppercase tracking-wider text-slate-500">approved</div></div></div>
    <div class="mt-3 truncate text-xs ${a.sequence_name ? "text-slate-600" : "text-slate-400"}">${a.sequence_name ? "Sequence: " + esc(a.sequence_name) : "No sequence set yet"}</div></button>`;
};
function audienceCards() {
  const sig = audiences.filter(a => a.kind === "signal"), cus = audiences.filter(a => a.kind === "custom");
  return `<p class="mb-4 text-sm text-slate-600">Open an audience to see its practices, choose which of their contacts should be messaged, and approve them. A contact can be approved in one audience at a time.</p>
    <h3 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Signals <span class="font-normal normal-case">(automatic)</span></h3>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${sig.map(audCard).join("") || '<p class="text-sm text-slate-500">No signal audiences yet.</p>'}</div>
    <h3 class="mb-2 mt-6 text-xs font-bold uppercase tracking-wider text-slate-500">Custom</h3>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cus.map(audCard).join("")}
      <div class="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600"><div class="font-semibold text-slate-800">New custom audience</div><p class="mt-1 text-xs">Filter the Practices table, then choose <b>Save as audience</b>. Or use <b>+ Audience</b> on a practice to hand-pick.</p>
        <button type="button" class="aud-goto-practices mt-2 text-xs font-semibold text-lalu-teal-700 hover:underline">Go to Practices →</button></div></div>`;
}
function audRoleBar() {
  return `<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Contact role">${AUD_ROLES.map(([k, l]) => `<button type="button" class="aud-role rounded-full border px-2.5 py-1 text-xs font-semibold ${audRole === k ? "border-lalu-teal-700 bg-lalu-teal-50 text-lalu-teal-800" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}" data-role="${k}">${l}</button>`).join("")}</div>`;
}
function audienceDetail(a) {
  const all = audPractices(a), prac = all.slice(0, audShown), custom = a.kind === "custom", ticked = audTicked.size;
  const rows = prac.map(({ ods, list, pinned }) => {
    const p = byOds.get(ods), open = audExpanded.has(ods), mine = audMembers.filter(m => m.audience_id === a.id && m.ods_code === ods && AUD_LOCKS.includes(m.state)).length, s0 = list[0];
    const sub = custom ? `${p && p.total_patients > 0 ? p.total_patients.toLocaleString() + " patients" : "No list size"}${p && p.price_tier ? " · " + tier(p) : ""}${p ? " · " + HS_LABEL[hsState(p)] : ""}${pinned ? " · hand-picked" : ""}` : `${s0.headline || ""} · ${fmtDate(s0.detected_at)}${list.length > 1 ? ` · +${list.length - 1} more` : ""}`;
    return `<div class="border-t border-slate-100 first:border-0"><div class="flex items-center hover:bg-slate-50"><button type="button" class="aud-row flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left" data-ods="${esc(ods)}" aria-expanded="${open}">
      <span class="inline-block text-slate-400 transition-transform ${open ? "rotate-90" : ""}">▸</span>
      <span class="min-w-0 flex-1"><span class="block truncate font-semibold">${esc(p ? p.practice_name : ods)}</span><span class="block truncate text-xs text-slate-500">${esc(sub)}</span></span>
      ${mine ? `<span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">${mine} approved</span>` : ""}</button>
      ${pinned ? `<button type="button" class="aud-unpin mr-3 shrink-0 text-xs text-slate-400 hover:text-rose-700" data-ods="${esc(ods)}" title="Remove this practice from the audience">Remove</button>` : ""}</div>
      ${open ? `<div class="bg-slate-50 px-4 pb-3 pt-1" data-rows="${esc(ods)}">${audContactsHtml(a, ods)}</div>` : ""}</div>`;
  }).join("");
  const crit = custom ? ((a.filters && a.filters.summary) || "") : "";
  return `<div class="mb-3 flex flex-wrap items-center gap-3"><button type="button" class="aud-back text-sm font-semibold text-lalu-teal-700 hover:underline">← All audiences</button><h3 class="text-lg font-bold">${esc(a.name)}</h3>
      <span class="text-sm text-slate-500">${all.length.toLocaleString()} practice${all.length === 1 ? "" : "s"} · ${audApproved(a)} contact${audApproved(a) === 1 ? "" : "s"} approved</span>
      ${custom ? '<span class="ml-auto flex gap-2"><button type="button" class="aud-rename rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">Rename</button><button type="button" class="aud-delete rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50">Delete</button></span>' : ""}</div>
    ${custom ? `<p class="mb-3 text-xs text-slate-500">${crit ? "Live filter: " + esc(crit) : "Hand-picked practices"}${crit && audPinned(a).length ? ` plus ${audPinned(a).length} hand-picked` : ""}. Practices that start matching appear here automatically.</p>` : ""}
    <div class="mb-3 flex flex-wrap items-center gap-3">${audRoleBar()}<span class="ml-auto flex items-center gap-2"><button type="button" class="aud-expand-all rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">Expand first ${AUD_EXPAND_ALL}</button>
      ${ticked ? `<button type="button" class="aud-approve-all rounded-md bg-lalu-navy px-3 py-1 text-xs font-semibold text-white hover:bg-lalu-navy-700">Approve ${ticked} ticked</button>` : ""}</span></div>
    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">${rows || `<p class="p-4 text-sm text-slate-500">${custom ? "No practice matches this audience right now." : "No practice has this signal open right now. They appear here as signals are detected."}</p>`}</div>
    ${all.length > prac.length ? `<div class="pt-3 text-center"><button type="button" class="aud-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(all.length - prac.length).toLocaleString()} more)</button></div>` : ""}`;
}
function audContactsHtml(a, ods) {
  const c = audContacts.get(ods), p = byOds.get(ods);
  if (!p || !p.hubspot_company_id) return '<p class="py-2 text-sm text-slate-600">This practice is not in HubSpot yet, so its contacts cannot be listed. Add it to HubSpot from its profile first.</p>';
  if (!c || c.loading) return '<p class="py-2 text-sm text-slate-500">Loading contacts from HubSpot…</p>';
  if (c.error) return `<p class="py-2 text-sm text-rose-700">${esc(c.error)}</p>`;
  if (!c.list.length) return '<p class="py-2 text-sm text-slate-600">HubSpot holds no contacts for this practice.</p>';
  const shown = c.list.filter(k => audRole === "all" || audRoleOf(k.title) === audRole), hidden = c.list.length - shown.length;
  const line = k => {
    const m = audMember(a, k.id), lock = audLock(a, k.id), done = m && m.state === "approved", skipped = m && m.state === "skipped", why = !k.email ? "No email address" : k.optout ? "Opted out of email" : k.bad ? "Email address is invalid" : null;
    const state = lock ? `<span class="text-xs font-semibold text-amber-700">Locked: ${esc(lock)}</span>` : why ? `<span class="text-xs font-semibold text-slate-500">${why}</span>` : done ? '<span class="text-xs font-bold text-emerald-700">Approved</span>' : skipped ? '<span class="text-xs font-semibold text-slate-500">Skipped</span>' : "";
    const off = lock || why || done;
    return `<label class="flex items-center gap-3 border-t border-slate-200 py-2 first:border-0 ${off ? "opacity-70" : "cursor-pointer"}"><input type="checkbox" class="aud-chk h-4 w-4 accent-lalu-teal-700" data-id="${esc(k.id)}" ${off ? "disabled" : ""} ${audTicked.has(k.id) && !off ? "checked" : ""}>
      <span class="min-w-0 flex-1"><span class="block text-sm font-semibold leading-tight">${esc(k.name || k.email || "Unnamed contact")}</span><span class="block truncate text-xs text-slate-500">${esc(k.title || "No job title")}${k.email ? " · " + esc(k.email) : ""}</span></span>${state}</label>`;
  };
  return `${shown.map(line).join("") || '<p class="py-2 text-sm text-slate-600">No contact here matches this role.</p>'}${hidden ? `<p class="pt-1 text-[11px] text-slate-400">${hidden} hidden by the role filter</p>` : ""}
    <div class="mt-2 flex justify-end gap-2"><button type="button" class="aud-skip rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50" data-ods="${esc(ods)}">Skip ticked</button>
    <button type="button" class="aud-approve rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700" data-ods="${esc(ods)}">Approve ticked</button></div>`;
}
async function audLoadContacts(ods) {
  const p = byOds.get(ods); if (!p || !p.hubspot_company_id || (audContacts.has(ods) && !audContacts.get(ods).error)) return;
  audContacts.set(ods, { loading: true }); renderAudiences();
  try {
    const r = await hsCall({ action: "contacts", companyId: String(p.hubspot_company_id) });
    audContacts.set(ods, { list: (r.contacts || []).map(k => ({ id: String(k.id), name: [k.firstname, k.lastname].filter(Boolean).join(" "), title: k.jobtitle || "", email: k.email || "", optout: String(k.hs_email_optout) === "true", bad: String(k.hs_email_bad_address) === "true" })) });
  } catch (e) { audContacts.set(ods, { error: e.message }); }
  renderAudiences();
}
// Tick the eligible contacts (an email, not opted out, not locked, not decided yet) whose job title fits the chosen role, in every practice opened so far.
function audTickRole() {
  audTicked.clear(); if (audRole === "all") return;
  const a = audiences.find(x => x.id === audOpen); if (!a) return;
  for (const [ods, c] of audContacts) for (const k of c.list || []) if (audRoleOf(k.title) === audRole && k.email && !k.optout && !k.bad && !audLock(a, k.id) && !audMember(a, k.id)) audTicked.add(k.id);
}
async function audDecideIds(a, ids, state) {
  const me = (await db.auth.getSession()).data.session?.user?.email || "unknown", now = new Date().toISOString(), rows = [];
  for (const [ods, c] of audContacts) { const p = byOds.get(ods); for (const k of c.list || []) if (ids.has(k.id) && !audLock(a, k.id)) rows.push({ audience_id: a.id, contact_id: k.id, ods_code: ods, company_id: String(p.hubspot_company_id), contact_name: k.name, job_title: k.title, email: k.email, state, state_by: me, state_at: now }); }
  if (!rows.length) return;
  const { error } = await db.from("audience_members").upsert(rows, { onConflict: "audience_id,contact_id" });
  if (error) { alert("Could not save: " + error.message); return; }
  for (const r of rows) { audTicked.delete(r.contact_id); const i = audMembers.findIndex(m => m.audience_id === r.audience_id && m.contact_id === r.contact_id); if (i >= 0) audMembers[i] = { ...audMembers[i], ...r }; else audMembers.push(r); }
  renderAudiences();
}

/* ---------- dialogs: save a Practices filter, add a practice, rename, delete ---------- */
function audModal(title, body, onOk, okLabel = "Save") {
  const m = $("aud-modal"); $("aud-modal-title").textContent = title; $("aud-modal-body").innerHTML = body + `<div id="aud-modal-msg" class="mt-2 text-sm text-rose-700" role="status"></div>
    <div class="mt-4 flex justify-end gap-2"><button type="button" id="aud-modal-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Cancel</button>${onOk ? `<button type="button" id="aud-modal-ok" class="rounded-lg bg-lalu-navy px-4 py-2 text-sm font-semibold text-white hover:bg-lalu-navy-700">${okLabel}</button>` : ""}</div>`;
  m.classList.remove("hidden"); $("aud-modal-cancel").onclick = audModalClose; const f = $("aud-modal-body").querySelector("input[type=text]"); if (f) { f.focus(); f.select(); }
  if (onOk) $("aud-modal-ok").onclick = async () => { const b = $("aud-modal-ok"); b.disabled = true; try { await onOk(); } catch (e) { $("aud-modal-msg").textContent = e.message || String(e); b.disabled = false; } };
}
const audModalClose = () => $("aud-modal").classList.add("hidden");
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("aud-modal").classList.contains("hidden")) audModalClose(); });
async function audCreate(name, filters) {
  const me = (await db.auth.getSession()).data.session?.user?.email || "unknown";
  const { data, error } = await db.from("audiences").insert({ kind: "custom", name, filters, created_by: me }).select().single();
  if (error) throw error; audiences.push(data); return data;
}
const audDone = (msg, a) => audModal("Done", `<p class="text-sm">${esc(msg)}</p>${a ? `<div class="mt-3"><button type="button" id="aud-open-it" class="text-sm font-semibold text-lalu-teal-700 hover:underline">Open it in Audiences →</button></div>` : ""}`, null);
function audOpenIt(a) { audModalClose(); audOpen = a.id; audExpanded.clear(); audTicked.clear(); showTab("audiences"); }
function audSaveOpen() {      // from the Practices filters
  const flt = readFilters(), chips = [...$("f-chips").querySelectorAll(".chip")].map(c => c.childNodes[0].textContent.trim()), n = filtered.length;
  if (!chips.length) { audModal("Save as audience", '<p class="text-sm text-slate-600">No filters are set, so this would be every practice. Filter the table first (for example Country, Tier or HubSpot status), then save it.</p>', null); return; }
  const summary = chips.join(", ");
  audModal("Save as audience", `<label class="block text-xs font-semibold text-slate-600">Name<input type="text" id="aud-name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="${esc(summary.length > 60 ? summary.slice(0, 57) + "…" : summary)}" maxlength="80"></label>
    <p class="mt-3 text-sm"><b>${n.toLocaleString()}</b> practice${n === 1 ? "" : "s"} match now.</p><p class="mt-1 text-xs text-slate-500">Filters: ${esc(summary)}. The audience stays live: practices that start matching later appear for review, and ones that stop matching drop out. Contacts you approve are kept.</p>`,
    async () => { const name = $("aud-name").value.trim(); if (!name) throw new Error("Give the audience a name."); const a = await audCreate(name, { criteria: flt, pinned: [], summary }); audDone(`Saved “${name}” with ${n.toLocaleString()} practices.`, a); $("aud-open-it").onclick = () => audOpenIt(a); });
}
async function audAddOpen(ods) {      // from a practice profile
  if (!audiences.length) await loadAudiences();
  const cus = audiences.filter(a => a.kind === "custom"), p = byOds.get(ods);
  audModal("Add to audience", `<p class="mb-2 text-sm text-slate-600">${esc(p ? p.practice_name : ods)}</p>
    <div class="space-y-1">${cus.map((a, i) => `<label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"><input type="radio" name="aud-pick" value="${esc(a.id)}" ${i === 0 ? "checked" : ""}><span class="min-w-0 flex-1 truncate font-semibold">${esc(a.name)}</span>${audPinned(a).includes(ods) ? '<span class="text-xs text-emerald-700">already in</span>' : ""}</label>`).join("")}
    <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"><input type="radio" name="aud-pick" value="new" ${cus.length ? "" : "checked"}><span class="font-semibold">New audience</span><input type="text" id="aud-new-name" placeholder="Name" maxlength="80" class="ml-2 min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"></label></div>`,
    async () => {
      const pick = document.querySelector('input[name=aud-pick]:checked').value;
      if (pick === "new") { const name = $("aud-new-name").value.trim(); if (!name) throw new Error("Give the new audience a name."); const a = await audCreate(name, { criteria: null, pinned: [ods], summary: "" }); audDone(`Added to the new audience “${name}”.`, a); $("aud-open-it").onclick = () => audOpenIt(a); return; }
      const a = audiences.find(x => x.id === pick), pinned = [...new Set([...audPinned(a), ods])], filters = { ...(a.filters || { criteria: null, summary: "" }), pinned };
      const { error } = await db.from("audiences").update({ filters }).eq("id", a.id); if (error) throw error; a.filters = filters; audDone(`Added to “${a.name}”.`, a); $("aud-open-it").onclick = () => audOpenIt(a);
    }, "Add");
}
document.addEventListener("click", e => {
  const t = e.target;
  if (t.closest("#btn-save-aud")) { audSaveOpen(); return; }
  const add = t.closest(".aud-add"); if (add) { audAddOpen(add.dataset.ods); return; }
  if (t.closest(".aud-goto-practices")) { showTab("practices"); return; }
  const card = t.closest(".aud-card"); if (card) { audOpen = card.dataset.aud; audExpanded.clear(); audTicked.clear(); audRole = "all"; audShown = AUD_PAGE; renderAudiences(); return; }
  if (t.closest(".aud-back")) { audOpen = null; renderAudiences(); return; }
  const a = audiences.find(x => x.id === audOpen);
  const role = t.closest(".aud-role"); if (role) { audRole = role.dataset.role; audTickRole(); renderAudiences(); return; }
  if (t.closest(".aud-more")) { audShown += AUD_PAGE; renderAudiences(); return; }
  if (t.closest(".aud-expand-all") && a) { const first = audPractices(a).slice(0, AUD_EXPAND_ALL).map(r => r.ods); first.forEach(o => audExpanded.add(o)); renderAudiences(); (async () => { for (const o of first) await audLoadContacts(o); audTickRole(); renderAudiences(); })(); return; }
  const un = t.closest(".aud-unpin"); if (un && a) { const pinned = audPinned(a).filter(x => x !== un.dataset.ods), filters = { ...a.filters, pinned }; db.from("audiences").update({ filters }).eq("id", a.id).then(({ error }) => { if (!error) { a.filters = filters; renderAudiences(); } }); return; }
  if (t.closest(".aud-rename") && a) { audModal("Rename audience", `<label class="block text-xs font-semibold text-slate-600">Name<input type="text" id="aud-name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="${esc(a.name)}" maxlength="80"></label>`,
    async () => { const name = $("aud-name").value.trim(); if (!name) throw new Error("Give the audience a name."); const { error } = await db.from("audiences").update({ name }).eq("id", a.id); if (error) throw error; a.name = name; audModalClose(); renderAudiences(); }); return; }
  if (t.closest(".aud-delete") && a) { audModal("Delete audience", `<p class="text-sm">Delete “${esc(a.name)}”? Contacts you approved in it are kept on record, but they are no longer locked into this audience.</p>`,
    async () => { const { error } = await db.from("audiences").update({ archived: true }).eq("id", a.id); if (error) throw error; audiences = audiences.filter(x => x.id !== a.id); audMembers = audMembers.filter(m => m.audience_id !== a.id); audOpen = null; audModalClose(); renderAudiences(); }, "Delete"); return; }
  const row = t.closest(".aud-row"); if (row) { const o = row.dataset.ods; audExpanded.has(o) ? audExpanded.delete(o) : audExpanded.add(o); renderAudiences(); if (audExpanded.has(o)) audLoadContacts(o).then(() => { if (audRole !== "all") { audTickRole(); renderAudiences(); } }); return; }
  const ok = t.closest(".aud-approve"), sk = t.closest(".aud-skip");
  if (a && (ok || sk)) { const ods = (ok || sk).dataset.ods, mine = new Set(((audContacts.get(ods) || {}).list || []).map(k => k.id)); audDecideIds(a, new Set([...audTicked].filter(id => mine.has(id))), ok ? "approved" : "skipped"); return; }
  if (t.closest(".aud-approve-all") && a) audDecideIds(a, new Set(audTicked), "approved");
});
document.addEventListener("change", e => { const c = e.target.closest(".aud-chk"); if (c) { c.checked ? audTicked.add(c.dataset.id) : audTicked.delete(c.dataset.id); const a = audiences.find(x => x.id === audOpen); if (a) renderAudiences(); } });
