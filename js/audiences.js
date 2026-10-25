// Audiences: one automatic audience per signal type. A practice appears when a signal of that type is open; the salesperson expands it, ticks the contacts worth messaging and approves them.
// Suggested contacts are read live from HubSpot (Atlas holds none); only decisions (approved, skipped) are stored. A contact approved for one audience is locked in every other.
let audiences = [], audMembers = [], audOpen = null, audEmailTo = null;
const audExpanded = new Set(), audContacts = new Map();   // ODS -> { loading, list, error }
const AUD_LOCKS = ["approved", "enrolled"];
const audSignalsFor = a => signals.filter(s => s.trigger_type === a.signal_type && s.ods_code && ["new", "in_progress"].includes(s.status || "new"));
const audPractices = a => { const m = new Map(); for (const s of audSignalsFor(a)) { const g = m.get(s.ods_code) || m.set(s.ods_code, []).get(s.ods_code); g.push(s); } return [...m].map(([ods, list]) => ({ ods, list: list.sort((x, y) => String(y.detected_at).localeCompare(String(x.detected_at))) }))
  .sort((x, y) => String(y.list[0].detected_at).localeCompare(String(x.list[0].detected_at))); };
const audMember = (a, id) => audMembers.find(m => m.audience_id === a.id && m.contact_id === id);
const audLock = (a, id) => { const m = audMembers.find(x => x.contact_id === id && x.audience_id !== a.id && AUD_LOCKS.includes(x.state)); return m ? (audiences.find(x => x.id === m.audience_id) || {}).name || "another audience" : null; };
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
function audienceCards() {
  const cards = audiences.filter(a => a.kind === "signal").map(a => {
    const prac = audPractices(a), approved = audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state)).length;
    return `<button type="button" class="aud-card rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-lalu-teal-500 hover:shadow-sm" data-aud="${esc(a.id)}">
      <div class="flex items-start justify-between gap-2"><div class="font-semibold leading-tight">${esc(a.name)}</div>${prac.length ? `<span class="shrink-0 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800">${prac.length} to review</span>` : ""}</div>
      <div class="mt-3 flex gap-5 text-sm"><div><div class="text-lg font-bold leading-none">${prac.length}</div><div class="text-[11px] uppercase tracking-wider text-slate-500">practices</div></div>
        <div><div class="text-lg font-bold leading-none">${approved}</div><div class="text-[11px] uppercase tracking-wider text-slate-500">approved</div></div></div>
      <div class="mt-3 truncate text-xs ${a.sequence_name ? "text-slate-600" : "text-slate-400"}">${a.sequence_name ? "Sequence: " + esc(a.sequence_name) : "No sequence set yet"}</div></button>`;
  }).join("");
  return `<p class="mb-3 text-sm text-slate-600">One audience per signal. Open one to see the practices where the signal is live, choose which of their contacts should be messaged, and approve them. Approved contacts can be in one audience at a time.</p>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards || '<p class="text-sm text-slate-500">No audiences yet.</p>'}</div>`;
}
function audienceDetail(a) {
  const prac = audPractices(a), approved = audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state)).length;
  const rows = prac.map(({ ods, list }) => {
    const p = byOds.get(ods), open = audExpanded.has(ods), mine = audMembers.filter(m => m.audience_id === a.id && m.ods_code === ods && AUD_LOCKS.includes(m.state)).length, s0 = list[0];
    return `<div class="border-t border-slate-100 first:border-0"><button type="button" class="aud-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" data-ods="${esc(ods)}" aria-expanded="${open}">
      <span class="inline-block text-slate-400 transition-transform ${open ? "rotate-90" : ""}">▸</span>
      <span class="min-w-0 flex-1"><span class="block truncate font-semibold">${esc(p ? p.practice_name : ods)}</span><span class="block truncate text-xs text-slate-500">${esc(s0.headline || "")} · ${esc(fmtDate(s0.detected_at))}${list.length > 1 ? ` · +${list.length - 1} more` : ""}</span></span>
      ${mine ? `<span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">${mine} approved</span>` : ""}</button>
      ${open ? `<div class="bg-slate-50 px-4 pb-3 pt-1" data-rows="${esc(ods)}">${audContactsHtml(a, ods)}</div>` : ""}</div>`;
  }).join("");
  return `<div class="mb-3 flex flex-wrap items-center gap-3"><button type="button" class="aud-back text-sm font-semibold text-lalu-teal-700 hover:underline">← All audiences</button><h3 class="text-lg font-bold">${esc(a.name)}</h3>
      <span class="text-sm text-slate-500">${prac.length} practice${prac.length === 1 ? "" : "s"} · ${approved} contact${approved === 1 ? "" : "s"} approved</span></div>
    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">${rows || '<p class="p-4 text-sm text-slate-500">No practice has this signal open right now. They appear here as signals are detected.</p>'}</div>`;
}
function audContactsHtml(a, ods) {
  const c = audContacts.get(ods), p = byOds.get(ods);
  if (!p || !p.hubspot_company_id) return '<p class="py-2 text-sm text-slate-600">This practice is not in HubSpot yet, so its contacts cannot be listed. Add it to HubSpot from its profile first.</p>';
  if (!c || c.loading) return '<p class="py-2 text-sm text-slate-500">Loading contacts from HubSpot…</p>';
  if (c.error) return `<p class="py-2 text-sm text-rose-700">${esc(c.error)}</p>`;
  if (!c.list.length) return '<p class="py-2 text-sm text-slate-600">HubSpot holds no contacts for this practice.</p>';
  const line = k => {
    const m = audMember(a, k.id), lock = audLock(a, k.id), done = m && m.state === "approved", skipped = m && m.state === "skipped", why = !k.email ? "No email address" : k.optout ? "Opted out of email" : k.bad ? "Email address is invalid" : null;
    const state = lock ? `<span class="text-xs font-semibold text-amber-700">Locked: ${esc(lock)}</span>` : why ? `<span class="text-xs font-semibold text-slate-500">${why}</span>` : done ? '<span class="text-xs font-bold text-emerald-700">Approved</span>' : skipped ? '<span class="text-xs font-semibold text-slate-500">Skipped</span>' : "";
    const off = lock || why || done;
    return `<label class="flex items-center gap-3 border-t border-slate-200 py-2 first:border-0 ${off ? "opacity-70" : "cursor-pointer"}"><input type="checkbox" class="aud-chk h-4 w-4 accent-lalu-teal-700" data-id="${esc(k.id)}" ${off ? "disabled" : ""}>
      <span class="min-w-0 flex-1"><span class="block text-sm font-semibold leading-tight">${esc(k.name || k.email || "Unnamed contact")}</span><span class="block truncate text-xs text-slate-500">${esc(k.title || "No job title")}${k.email ? " · " + esc(k.email) : ""}</span></span>${state}</label>`;
  };
  return `${c.list.map(line).join("")}<div class="mt-2 flex justify-end gap-2"><button type="button" class="aud-skip rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50" data-ods="${esc(ods)}">Skip selected</button>
    <button type="button" class="aud-approve rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700" data-ods="${esc(ods)}">Approve selected</button></div>`;
}
async function audLoadContacts(ods) {
  const p = byOds.get(ods); if (!p || !p.hubspot_company_id || audContacts.has(ods) && !audContacts.get(ods).error) return;
  audContacts.set(ods, { loading: true }); renderAudiences();
  try {
    const r = await hsCall({ action: "contacts", companyId: String(p.hubspot_company_id) });
    audContacts.set(ods, { list: (r.contacts || []).map(k => ({ id: String(k.id), name: [k.firstname, k.lastname].filter(Boolean).join(" "), title: k.jobtitle || "", email: k.email || "", optout: String(k.hs_email_optout) === "true", bad: String(k.hs_email_bad_address) === "true" })) });
  } catch (e) { audContacts.set(ods, { error: e.message }); }
  renderAudiences();
}
async function audDecide(a, ods, state) {
  const ids = [...document.querySelectorAll(`[data-rows="${CSS.escape(ods)}"] .aud-chk:checked`)].map(x => x.dataset.id), c = audContacts.get(ods); if (!ids.length || !c || !c.list) return;
  const me = (await db.auth.getSession()).data.session?.user?.email || "unknown", p = byOds.get(ods), now = new Date().toISOString();
  const rows = c.list.filter(k => ids.includes(k.id) && !audLock(a, k.id)).map(k => ({ audience_id: a.id, contact_id: k.id, ods_code: ods, company_id: String(p.hubspot_company_id), contact_name: k.name, job_title: k.title, email: k.email, state, state_by: me, state_at: now }));
  const { error } = await db.from("audience_members").upsert(rows, { onConflict: "audience_id,contact_id" });
  if (error) { alert("Could not save: " + error.message); return; }
  for (const r of rows) { const i = audMembers.findIndex(m => m.audience_id === r.audience_id && m.contact_id === r.contact_id); if (i >= 0) audMembers[i] = { ...audMembers[i], ...r }; else audMembers.push(r); }
  renderAudiences();
}
document.addEventListener("click", e => {
  const card = e.target.closest(".aud-card"); if (card) { audOpen = card.dataset.aud; audExpanded.clear(); renderAudiences(); return; }
  if (e.target.closest(".aud-back")) { audOpen = null; renderAudiences(); return; }
  const row = e.target.closest(".aud-row"); if (row) { const o = row.dataset.ods; audExpanded.has(o) ? audExpanded.delete(o) : audExpanded.add(o); renderAudiences(); if (audExpanded.has(o)) audLoadContacts(o); return; }
  const a = audiences.find(x => x.id === audOpen), ok = e.target.closest(".aud-approve"), sk = e.target.closest(".aud-skip");
  if (a && (ok || sk)) audDecide(a, (ok || sk).dataset.ods, ok ? "approved" : "skipped");
});
