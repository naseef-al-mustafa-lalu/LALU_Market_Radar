// Audiences: signal audiences (one per signal type, automatic) and custom audiences (a saved Practices filter, hand-picked practices, or both).
// A practice appears in an audience; the salesperson expands it, ticks the contacts worth messaging and approves them. Suggested contacts are read live from HubSpot
// (Atlas holds none); only decisions (approved, skipped) are stored. A contact approved for one audience is locked in every other. Loaded after mergers.js.
let audiences = [], audMembers = [], audOpen = null, audRole = "all", audShown = 100, audSub = "signals", audNotice = "", audStats = null;      // audStats: { at, contacts: { id: HubSpot sequence fields } }
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
const audNewSignalSince = (a, ods, at) => a.kind === "signal" && signals.some(s => s.trigger_type === a.signal_type && s.ods_code === ods && String(s.detected_at) > String(at));      // a skipped contact is offered again when a newer signal fires for the practice
const audMember = (a, id) => audMembers.find(m => m.audience_id === a.id && m.contact_id === id);
const audLock = (a, id) => { const m = audMembers.find(x => x.contact_id === id && x.audience_id !== a.id && AUD_LOCKS.includes(x.state)); return m ? (audiences.find(x => x.id === m.audience_id) || {}).name || "another audience" : null; };
const audApproved = a => audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state)).length;
async function loadAudiences() {
  const [a, m] = await Promise.all([db.from("audiences").select("*").eq("archived", false).order("created_at"), db.from("audience_members").select("*"), audLoadTests()]);
  audiences = a.data || []; audMembers = m.data || [];
  const missing = [...new Set(signals.map(s => s.trigger_type))].filter(t => t && !audiences.some(x => x.signal_type === t));
  if (missing.length) {   // a signal type that appeared after the audiences were created
    const labels = new Map(sigSettings.map(t => [t.trigger_type, t.label]));
    const { data } = await db.from("audiences").insert(missing.map(t => ({ kind: "signal", signal_type: t, name: labels.get(t) || t }))).select();
    audiences = audiences.concat(data || []);
  }
  renderAudiences();
  audLoadSeqStatus();
  if (!audStats && audMembers.some(m => m.state === "enrolled")) audLoadStats();   // the cards show performance, so fetch it once when anyone is enrolled
}
function setAudSub(which) {      // the two sub tabs in the second row: automatic signal audiences, and custom ones
  audSub = which; audOpen = null;
  $("aud-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.a === which ? "bg-white shadow-sm" : "text-slate-500"));
  renderAudiences();
}
$("aud-sub").querySelectorAll("button").forEach(b => b.onclick = () => setAudSub(b.dataset.a));
function renderAudiences() {
  const box = $("aud-body"); if (!box) return;
  const a = audiences.find(x => x.id === audOpen);
  box.innerHTML = a ? `<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">${audienceDetail(a)}</div>` : audSub === "performance" ? audPerformance() : audSub === "tests" ? audTestsPage() : audienceCards();
  $("aud-sub").querySelectorAll("button").forEach(b => { if (b.dataset.a === "performance") return; if (b.dataset.a === "tests") { const r = audTests.filter(x => x.status === "running").length; b.querySelector("span").textContent = r || ""; return; } const n = audiences.filter(x => x.kind === (b.dataset.a === "custom" ? "custom" : "signal")).length; b.querySelector("span").textContent = n || ""; });
}
const AUD_ICON = { signal: '<svg viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path d="M11 2L4 11h5l-1 7 7-9h-5z"/></svg>', custom: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="h-5 w-5"><path d="M3 5h14M6 10h8M9 15h2"/></svg>' };
const audCard = a => {
  const prac = audPractices(a), custom = a.kind === "custom", appr = audApproved(a), enr = audMembers.filter(m => m.audience_id === a.id && m.state === "enrolled").length, tone = custom ? ["bg-lalu-teal-50", "text-lalu-teal-700", "from-lalu-teal-600 to-lalu-teal"] : ["bg-purple-50", "text-purple-700", "from-purple-600 to-fuchsia-400"];
  const cfg = custom ? null : sigSettings.find(t => t.trigger_type === a.signal_type), sum = custom ? ((a.filters && a.filters.summary) || "Hand-picked practices") : (cfg && (cfg.why || cfg.rule)) || "Practices are added as this signal is detected";
  const stat = (v, l, hot) => `<span class="px-1"><span class="block text-base font-bold leading-tight ${hot ? hot : v === 0 || v === "–" ? "text-slate-400" : "text-slate-900"}">${typeof v === "number" ? v.toLocaleString() : v}</span><span class="block truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500">${l}</span></span>`;
  const perf = enr && audPerfFor(a), ks = audKpisOf(a), run = audRunning(a);
  return `<button type="button" class="aud-card group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-lalu-teal-600 hover:shadow-md" data-aud="${esc(a.id)}">
    <span class="h-1 w-full bg-gradient-to-r ${tone[2]}"></span>
    <span class="flex flex-1 flex-col gap-2.5 p-3">
      <span class="flex items-start gap-2.5"><span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone[0]} ${tone[1]}">${AUD_ICON[custom ? "custom" : "signal"]}</span>
        <span class="min-w-0 flex-1"><span class="block text-sm font-semibold leading-snug text-slate-900">${esc(a.name)}</span><span class="line-clamp-2 block text-xs leading-snug text-slate-500">${esc(sum)}</span></span>
        ${!custom && prac.length ? `<span class="shrink-0 rounded-full bg-purple-600 px-2 py-0.5 text-[11px] font-bold text-white">${prac.length} to review</span>` : ""}</span>
      <span class="grid grid-cols-3 divide-x divide-slate-200 rounded-lg bg-slate-50 py-1.5 text-center">${stat(prac.length, "Practices")}${stat(appr, "Approved", appr ? "text-emerald-700" : "")}${stat(enr, "In sequence", enr ? "text-lalu-teal-700" : "")}</span>
      <span class="grid divide-x divide-slate-200 rounded-lg border border-slate-100 py-1.5 text-center" style="grid-template-columns:repeat(${ks.length},minmax(0,1fr))" title="${enr ? "Sequence performance of enrolled contacts" : "Nobody enrolled yet, so no performance to show"}">${ks.map(k => stat(perf ? audKpiText(k, perf) : "–", AUD_KPIS[k].short)).join("")}</span></span>
    <span class="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs"><span class="flex min-w-0 items-center gap-2"><span class="truncate ${a.sequence_name ? "text-slate-700" : "text-slate-400"}">${run ? "A/B test: " + esc(run.name) : a.sequence_name ? esc(a.sequence_name) : "No sequence set yet"}</span>${a.sequence_id && !run ? audSeqBadge(a.sequence_id) : ""}</span><span class="shrink-0 font-semibold text-lalu-teal-700 group-hover:underline">Open →</span></span></button>`;
};
function audienceCards() {
  const list = audiences.filter(a => a.kind === (audSub === "custom" ? "custom" : "signal"));
  const intro = audSub === "custom" ? "Audiences you build: save the Practices filters, or hand-pick practices from a profile. Practices matching a saved filter appear here automatically."
    : "One audience per signal type, filled automatically as signals are detected. Open one to choose which contacts at each practice to message.";
  const empty = audSub === "custom" ? `<div class="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-6 text-sm text-slate-600 sm:col-span-2 lg:col-span-3"><div class="font-semibold text-slate-800">No custom audiences yet</div><p class="mt-1">Filter the Practices table, then choose <b>Save as audience</b>. Or use <b>+ Audience</b> in a practice's profile to hand-pick.</p><button type="button" class="aud-goto-practices mt-3 rounded-lg bg-lalu-navy px-3 py-2 text-sm font-semibold text-white hover:bg-lalu-navy-700">Go to Practices</button></div>` : '<p class="text-sm text-slate-500">No signal audiences yet.</p>';
  return `<p class="mb-4 text-sm text-slate-600">${intro} A contact can be approved in one audience at a time.</p>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${list.map(audCard).join("") || empty}</div>`;
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
    ${audSequenceRow(a)}${audTestNote(a)}${audNotice ? `<p class="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">${esc(audNotice)}</p>` : ""}
    <div class="mb-3 flex flex-wrap items-center gap-3">${audRoleBar()}<span class="ml-auto flex items-center gap-2"><button type="button" class="aud-expand-all rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">Expand first ${AUD_EXPAND_ALL}</button>
      ${ticked ? `<button type="button" class="aud-skip-all rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold hover:bg-slate-50">Skip ${ticked} ticked</button><button type="button" class="aud-approve-all rounded-md border border-lalu-navy bg-white px-3 py-1 text-xs font-semibold text-lalu-navy hover:bg-slate-50">Approve ${ticked} ticked</button><button type="button" class="aud-enrol-all rounded-md bg-lalu-navy px-3 py-1 text-xs font-semibold text-white hover:bg-lalu-navy-700">Approve and enrol ${ticked}</button>` : ""}</span></div>
    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">${rows || `<p class="p-4 text-sm text-slate-500">${custom ? "No practice matches this audience right now." : "No practice has this signal open right now. They appear here as signals are detected."}</p>`}</div>
    ${all.length > prac.length ? `<div class="pt-3 text-center"><button type="button" class="aud-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(all.length - prac.length).toLocaleString()} more)</button></div>` : ""}`;
}
function audContactsHtml(a, ods) {
  const c = audContacts.get(ods), p = byOds.get(ods);
  if (!p || !p.hubspot_company_id) return '<p class="py-2 text-sm text-slate-600">This practice is not in HubSpot yet, so its contacts cannot be listed. Add it to HubSpot from its profile first.</p>';
  if (!c || c.loading) return '<p class="py-2 text-sm text-slate-500">Loading contacts…</p>';
  if (c.error) return `<p class="py-2 text-sm text-rose-700">${esc(c.error)}</p>`;
  const more = c.all ? "" : `<div class="pt-2"><button type="button" class="aud-all text-xs font-semibold text-lalu-teal-700 hover:underline" data-ods="${esc(ods)}" ${c.loading2 ? "disabled" : ""}>${c.loading2 ? "Loading…" : "Show all HubSpot contacts"}</button>${c.error2 ? ` <span class="text-xs text-rose-700">${esc(c.error2)}</span>` : ""}</div>`;
  if (!c.list.length) return '<p class="py-2 text-sm text-slate-600">No approved contacts for this practice yet.</p>' + more;
  const shown = c.list.filter(k => audRole === "all" || audRoleOf(k.title) === audRole), hidden = c.list.length - shown.length;
  const line = k => {
    const m = audMember(a, k.id), lock = audLock(a, k.id), done = m && (m.state === "approved" || m.state === "enrolled"), fresh = m && m.state === "skipped" && audNewSignalSince(a, ods, m.state_at), skipped = m && m.state === "skipped" && !fresh, why = !k.email ? "No email address" : k.noHs ? "Not in HubSpot yet" : k.optout ? "Opted out of email" : k.bad ? "Email address is invalid" : null;
    const state = lock ? `<span class="text-xs font-semibold text-amber-700">Locked: ${esc(lock)}</span>` : why ? `<span class="text-xs font-semibold text-slate-500">${why}</span>` : done ? `<span class="text-xs font-bold text-emerald-700">${m.state === "enrolled" ? "Enrolled" : "Approved"}</span>` : fresh ? '<span class="text-xs font-semibold text-purple-700">New signal since you skipped</span>' : skipped ? '<span class="text-xs font-semibold text-slate-500">Skipped</span>' : "";
    const off = lock || why || done;
    return `<label class="flex items-center gap-3 border-t border-slate-200 py-2 first:border-0 ${off ? "opacity-70" : "cursor-pointer"}"><input type="checkbox" class="aud-chk h-4 w-4 accent-lalu-teal-700" data-id="${esc(k.id)}" ${off ? "disabled" : ""} ${audTicked.has(k.id) && !off ? "checked" : ""}>
      <span class="min-w-0 flex-1"><span class="block text-sm font-semibold leading-tight">${esc(k.name || k.email || "Unnamed contact")}</span><span class="block truncate text-xs text-slate-500">${esc(k.title || "No job title")}${k.email ? " · " + esc(k.email) : ""}</span></span>${state}</label>`;
  };
  return `${shown.map(line).join("") || '<p class="py-2 text-sm text-slate-600">No contact here matches this role.</p>'}${hidden ? `<p class="pt-1 text-[11px] text-slate-400">${hidden} hidden by the role filter</p>` : ""}${more}`;
}
// A practice's contacts for an audience: Atlas's approved contacts first (direct addresses for decision-makers, opted-out and bounced already removed); "Show all HubSpot contacts" adds everyone else HubSpot holds.
// Opt-out, bounce and presence in HubSpot are re-checked live when the ticked contacts are approved (audLiveCheck).
const audFromHubspot = k => ({ id: String(k.id), name: [k.firstname, k.lastname].filter(Boolean).join(" "), title: k.jobtitle || "", email: k.email || "", optout: String(k.hs_email_optout) === "true", bad: String(k.hs_email_bad_address) === "true", hs: true });
async function audLoadContacts(ods) {
  const p = byOds.get(ods); if (!p || !p.hubspot_company_id || (audContacts.has(ods) && !audContacts.get(ods).error)) return;
  audContacts.set(ods, { loading: true }); renderAudiences();
  try {
    const { data, error } = await db.from("contacts").select("contact_urn,hubspot_contact_id,full_name,job_title,email,email_opt_out,role_tier").eq("ods_code", ods); if (error) throw error;
    const tier = { A: 0, B: 1, "?": 2 };
    audContacts.set(ods, { list: (data || []).sort((x, y) => ((tier[x.role_tier] ?? 3) - (tier[y.role_tier] ?? 3)) || String(x.full_name).localeCompare(String(y.full_name))).map(k => ({ id: k.hubspot_contact_id ? String(k.hubspot_contact_id) : "u" + k.contact_urn, name: k.full_name || "", title: k.job_title || "", email: k.email || "", optout: !!k.email_opt_out, bad: false, noHs: !k.hubspot_contact_id })), all: false });
  } catch (e) { audContacts.set(ods, { error: e.message }); }
  renderAudiences();
}
async function audLoadAllHubspot(ods) {      // add the practice's other HubSpot contacts (nurses, reception and so on) to its list
  const p = byOds.get(ods), c = audContacts.get(ods); if (!p || !c || !c.list) return;
  c.loading2 = true; renderAudiences();
  try {
    const r = await hsCall({ action: "contacts", companyId: String(p.hubspot_company_id) }), have = new Set(c.list.map(k => k.id)), seen = new Map(c.list.filter(k => !k.noHs).map(k => [k.id, k]));
    for (const k of (r.contacts || []).map(audFromHubspot)) { if (seen.has(k.id)) Object.assign(seen.get(k.id), { optout: k.optout, bad: k.bad }); else if (!have.has(k.id)) c.list.push(k); }
    c.all = true;
  } catch (e) { c.error2 = e.message; }
  c.loading2 = false; renderAudiences();
}
// Before anything is approved or enrolled: read the ticked contacts' practices live from HubSpot and drop anyone who has since opted out, bounced, or left HubSpot.
async function audLiveCheck(ids) {
  const keep = new Set(), dropped = [], by = new Map();
  for (const [ods, c] of audContacts) for (const k of c.list || []) if (ids.has(k.id)) (by.get(ods) || by.set(ods, []).get(ods)).push(k);
  for (const [ods, ks] of by) {
    const p = byOds.get(ods); let live = null;
    try { live = (await hsCall({ action: "contacts", companyId: String(p.hubspot_company_id) })).contacts || []; } catch (_) { /* HubSpot unreachable: the push itself will say so */ }
    const m = new Map((live || []).map(x => [String(x.id), x]));
    for (const k of ks) {
      const h = m.get(k.id), who = k.name || k.email || "A contact";
      if (live && !h) { dropped.push(`${who}: no longer in HubSpot`); k.noHs = true; }
      else if (h && String(h.hs_email_optout) === "true") { dropped.push(`${who}: has opted out`); k.optout = true; }
      else if (h && String(h.hs_email_bad_address) === "true") { dropped.push(`${who}: email address is invalid`); k.bad = true; }
      else keep.add(k.id);
    }
  }
  return { keep, dropped };
}
// Tick the eligible contacts (an email, not opted out, not locked, not decided yet) whose job title fits the chosen role, in every practice opened so far.
function audTickRole() {
  audTicked.clear(); if (audRole === "all") return;
  const a = audiences.find(x => x.id === audOpen); if (!a) return;
  for (const [ods, c] of audContacts) for (const k of c.list || []) if (audRoleOf(k.title) === audRole && k.email && !k.noHs && !k.optout && !k.bad && !audLock(a, k.id) && !audMember(a, k.id)) audTicked.add(k.id);
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

/* ---------- sequence, HubSpot list and performance ---------- */
const audMe = async () => (await db.auth.getSession()).data.session?.user?.email || "unknown";
function audSequenceRow(a) {
  const st = audPerfFor(a);
  return `<div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-3 py-2 text-sm"><span class="text-slate-500">Sequence</span>
    ${a.sequence_name ? `<span class="font-semibold">${esc(a.sequence_name)}</span><span class="text-xs text-slate-500">sends as ${esc(a.sequence_sender || "the approver")}</span>${audSeqBadge(a.sequence_id)}` : '<span class="text-slate-400">Not set: contacts can be approved to the list but not enrolled</span>'}
    <button type="button" class="aud-seq rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">${a.sequence_name ? "Change" : "Choose a sequence"}</button>
    <span class="ml-auto text-xs text-slate-500">${st ? `${st.enrolled} enrolled · ${st.active} active · ${audKpisOf(a).map(k => audKpiText(k, st) + " " + AUD_KPIS[k].short.toLowerCase()).join(" · ")}` : '<button type="button" class="aud-stats-refresh font-semibold text-lalu-teal-700 hover:underline">Load performance</button>'} <button type="button" class="aud-kpis ml-2 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">KPIs</button></span></div>`;
}
async function audSequenceOpen(a) {
  audModal("Choose a sequence", '<p class="text-sm text-slate-500">Loading your sequences from HubSpot…</p>', null);
  try {
    const me = await audMe(), r = await hsCall({ action: "sequences", sender: a.sequence_sender || me }), list = r.sequences || [];
    audModal("Choose a sequence", `<p class="mb-2 text-xs text-slate-500">Emails send as <b>${esc(r.sender)}</b> from their connected inbox. ${list.length} sequence${list.length === 1 ? "" : "s"} available.</p>
      <input type="text" id="aud-seq-q" placeholder="Search sequences" class="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
      <div id="aud-seq-list" class="max-h-72 space-y-1 overflow-y-auto">${list.map(x => `<label class="aud-seq-opt flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm" data-n="${esc(String(x.name).toLowerCase())}"><input type="radio" name="aud-seq-pick" value="${esc(x.id)}" data-name="${esc(x.name)}" ${String(x.id) === String(a.sequence_id) ? "checked" : ""}><span class="min-w-0 flex-1 truncate">${esc(x.name)}</span></label>`).join("") || '<p class="text-sm text-slate-500">No sequences available to this user.</p>'}</div>`,
      async () => {
        const pick = document.querySelector("input[name=aud-seq-pick]:checked"); if (!pick) throw new Error("Pick a sequence.");
        const patch = { sequence_id: pick.value, sequence_name: pick.dataset.name, sequence_sender: r.sender }, { error } = await db.from("audiences").update(patch).eq("id", a.id); if (error) throw error;
        Object.assign(a, patch); audModalClose(); renderAudiences(); audLoadSeqStatus();
      });
    $("aud-seq-q").oninput = e => document.querySelectorAll(".aud-seq-opt").forEach(o => o.classList.toggle("hidden", !o.dataset.n.includes(e.target.value.trim().toLowerCase())));
  } catch (e) { audModal("Choose a sequence", `<p class="text-sm text-rose-700">${esc(e.message)}</p>`, null); }
}
// Approve into HubSpot: decisions are stored first, then the contacts go to the audience's list and (when asked) into its sequence.
async function audApprove(a, ids, enrol) {
  if (!ids.size) return;
  const chk = await audLiveCheck(ids), dropNote = chk.dropped.length ? "Left out after a live HubSpot check: " + chk.dropped.join("; ") : "";
  ids = chk.keep; if (!ids.size) { audNotice = dropNote; audTicked.clear(); renderAudiences(); return; }
  for (const id of [...audTicked]) if (!ids.has(id)) audTicked.delete(id);
  const n = ids.size, go = async () => {
    audNotice = dropNote; await audDecideIds(a, ids, "approved");
    try {
      const r = await hsCall({ action: "audience_push", audienceId: a.id, contactIds: [...ids], enrol });
      if (r.listId && !a.hubspot_list_id) a.hubspot_list_id = r.listId;
      const bad = Object.entries(r.results || {}).filter(([, v]) => v !== "enrolled");
      for (const [id, v] of Object.entries(r.results || {})) { const m = audMembers.find(x => x.audience_id === a.id && x.contact_id === id); if (m) { m.state = v === "enrolled" ? "enrolled" : m.state; m.hubspot_note = v === "enrolled" ? null : v; } }
      audNotice = [dropNote, ...(r.warnings || []), bad.length ? `${bad.length} contact${bad.length === 1 ? "" : "s"} could not be enrolled (${bad[0][1]})` : ""].filter(Boolean).join(" · ");
    } catch (e) { audNotice = "Saved here, but HubSpot did not accept it: " + e.message; }
    renderAudiences();
  };
  if (!enrol) return go();
  const test = audRunning(a);
  if (test) {
    const bad = [["A", test.seq_a_id, test.seq_a_name], ["B", test.seq_b_id, test.seq_b_name]].find(x => !audSeqOk(x[1]));
    if (bad) { audModal("Fix the sequence first", `<p class="text-sm">Sequence ${bad[0]} (${esc(bad[2])}) is not ready in HubSpot: ${esc(({ missing: "HubSpot cannot find it", empty: "it has no steps" })[(audSeqStatus[String(bad[1])] || {}).state] || "unknown problem")}. Fix it in HubSpot, then try again.</p>`, null); return; }
    audModal("Enrol in A/B test", `<p class="text-sm">Enrol <b>${n}</b> contact${n === 1 ? "" : "s"} split ${test.split_a}/${100 - test.split_a} between <b>A: ${esc(test.seq_a_name)}</b> and <b>B: ${esc(test.seq_b_name)}</b>, sending as <b>${esc(test.sequence_sender || "you")}</b>? Each contact is placed in one arm and stays there.</p>`, async () => { audModalClose(); await go(); }, "Approve and enrol"); return;
  }
  if (!a.sequence_id) { audModal("Choose a sequence first", '<p class="text-sm">This audience has no sequence yet. Choose one, then approve and enrol.</p>', null); return; }
  if (!audSeqOk(a.sequence_id)) { audModal("Fix the sequence first", `<p class="text-sm">${esc(a.sequence_name)} is not ready in HubSpot: ${esc(({ missing: "HubSpot cannot find it", empty: "it has no steps" })[(audSeqStatus[String(a.sequence_id)] || {}).state] || "unknown problem")}. Fix it in HubSpot, then try again.</p>`, null); return; }
  audModal("Enrol in sequence", `<p class="text-sm">Enrol <b>${n}</b> contact${n === 1 ? "" : "s"} in <b>${esc(a.sequence_name)}</b>, sending as <b>${esc(a.sequence_sender || "you")}</b>? The first email goes out according to the sequence's schedule.</p>`, async () => { audModalClose(); await go(); }, "Approve and enrol");
}
const audDate = v => { if (!v) return null; const t = isNaN(v) ? new Date(v).getTime() : Number(v); return Number.isFinite(t) ? t : null; };
function audPerfFor(a, arm) {
  if (!audStats) return null;
  const mem = audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state) && (!arm || m.arm === arm)), out = { approved: mem.length, enrolled: 0, active: 0, opened: 0, replied: 0, clicked: 0, meetings: 0, mql: 0 };
  for (const m of mem) {
    if (m.state !== "enrolled") continue; out.enrolled++;
    const c = audStats.contacts[m.contact_id] || {}, since = audDate(m.enrolled_at) || audDate(m.state_at) || 0, after = v => { const t = audDate(v); return t != null && t >= since - 60000; };
    if (String(c.hs_sequences_is_enrolled) === "true") out.active++;
    if (after(c.hs_sales_email_last_opened)) out.opened++; if (after(c.hs_sales_email_last_replied)) out.replied++; if (after(c.hs_sales_email_last_clicked)) out.clicked++; if (after(c.engagements_last_meeting_booked)) out.meetings++; if (after(c.hs_v2_date_entered_marketingqualifiedlead)) out.mql++;
  }
  return out;
}
async function audLoadStats() {
  const ids = [...new Set(audMembers.filter(m => AUD_LOCKS.includes(m.state)).map(m => m.contact_id))], contacts = {};
  try { for (let i = 0; i < ids.length; i += 400) Object.assign(contacts, (await hsCall({ action: "audience_stats", contactIds: ids.slice(i, i + 400) })).contacts || {}); audStats = { at: Date.now(), contacts }; audNotice = ""; }
  catch (e) { audNotice = "Could not load performance from HubSpot: " + e.message; }
  renderAudiences();
}
function audPerformance() {
  const rows = audiences.map(a => ({ a, s: audPerfFor(a), n: audMembers.filter(m => m.audience_id === a.id && AUD_LOCKS.includes(m.state)).length })), pct = (x, t) => t ? ` <span class="text-xs text-slate-400">${Math.round(100 * x / t)}%</span>` : "";
  return `<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div class="mb-3 flex flex-wrap items-center gap-3"><h3 class="text-lg font-bold">Performance</h3>
      <span class="text-sm text-slate-500">${audStats ? "As of " + new Date(audStats.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "Not loaded yet"}</span>
      <button type="button" class="aud-stats-refresh ml-auto rounded-lg bg-lalu-navy px-3 py-2 text-sm font-semibold text-white hover:bg-lalu-navy-700">${audStats ? "Refresh from HubSpot" : "Load from HubSpot"}</button></div>
    ${audNotice ? `<p class="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">${esc(audNotice)}</p>` : ""}
    <div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th class="px-3 py-2">Audience</th><th class="px-3 py-2 text-right">Approved</th><th class="px-3 py-2 text-right">Enrolled</th><th class="px-3 py-2 text-right">Active</th><th class="px-3 py-2 text-right">Opened</th><th class="px-3 py-2 text-right">Replied</th><th class="px-3 py-2 text-right">Link clicks</th><th class="px-3 py-2 text-right">Meetings</th><th class="px-3 py-2 text-right">MQLs</th><th class="px-3 py-2 text-right">MQL rate</th></tr></thead>
    <tbody class="divide-y divide-slate-100">${rows.map(({ a, s, n }) => `<tr class="hover:bg-slate-50"><td class="px-3 py-2"><div class="font-semibold">${esc(a.name)}</div><div class="text-xs text-slate-500">${a.kind === "custom" ? "Custom" : "Signal"} · ${a.sequence_name ? esc(a.sequence_name) : "no sequence"}</div></td>
      <td class="px-3 py-2 text-right font-mono">${n}</td>${s ? `<td class="px-3 py-2 text-right font-mono">${s.enrolled}</td><td class="px-3 py-2 text-right font-mono">${s.active}</td><td class="px-3 py-2 text-right font-mono">${s.opened}${pct(s.opened, s.enrolled)}</td><td class="px-3 py-2 text-right font-mono">${s.replied}${pct(s.replied, s.enrolled)}</td><td class="px-3 py-2 text-right font-mono">${s.clicked}${pct(s.clicked, s.enrolled)}</td><td class="px-3 py-2 text-right font-mono">${s.meetings}${pct(s.meetings, s.enrolled)}</td><td class="px-3 py-2 text-right font-mono">${s.mql}</td><td class="px-3 py-2 text-right font-mono">${s.enrolled ? Math.round(100 * s.mql / s.enrolled) + "%" : "–"}</td>` : '<td class="px-3 py-2 text-right text-slate-400" colspan="8">Load from HubSpot to see this</td>'}</tr>`).join("") || '<tr><td class="px-3 py-4 text-slate-500" colspan="10">No audiences yet.</td></tr>'}</tbody></table></div>
    <p class="mt-3 text-xs text-slate-500">Counted from each enrolled contact's HubSpot sequence and sales-email fields, from the day they were enrolled. Opened, replied and meetings are the contact's most recent activity, so a contact counts once.</p></div>`;
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
function audOpenIt(a) { audModalClose(); setAudSub("custom"); audOpen = a.id; audExpanded.clear(); audTicked.clear(); showTab("audiences"); }
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
  const card = t.closest(".aud-card"); if (card) { audNotice = ""; audOpen = card.dataset.aud; audExpanded.clear(); audTicked.clear(); audRole = "all"; audShown = AUD_PAGE; renderAudiences(); audLoadSeqStatus(); return; }
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
  const all = t.closest(".aud-all"); if (all) { audLoadAllHubspot(all.dataset.ods); return; }
  if (a && t.closest(".aud-skip-all")) { audDecideIds(a, new Set(audTicked), "skipped"); return; }
  if (a && t.closest(".aud-approve-all")) { audApprove(a, new Set(audTicked), false); return; }
  if (a && t.closest(".aud-enrol-all")) { audApprove(a, new Set(audTicked), true); return; }
  if (a && t.closest(".aud-seq")) { audSequenceOpen(a); return; }
  if (t.closest(".aud-stats-refresh")) { audLoadStats(); return; }
});
document.addEventListener("change", e => { const c = e.target.closest(".aud-chk"); if (c) { c.checked ? audTicked.add(c.dataset.id) : audTicked.delete(c.dataset.id); const a = audiences.find(x => x.id === audOpen); if (a) renderAudiences(); } });
