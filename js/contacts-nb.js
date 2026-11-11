/* Contacts tab, second half: the NeverBounce approval queue, HubSpot segments (tracked ones with editable criteria) and the Review queue. Loaded after contacts.js, which calls ctLoadExtra()
   when it loads and renders these panels from renderContacts(). Decisions are saved through RPCs (set_neverbounce_approval, review_contact, set_segment_tracked) and the segment_set_criteria edge action. */
let ctSegs = [], ctSegMembers = new Map(), ctRuns = [], ctNbSel = new Set(), ctRevTab = "partial", ctRevShown = 25, ctMsg = "";
const CT_NB_STATUSES = ["Valid", "Accept All (Unverifiable)", "Unknown", "Disposable", "Invalid"];
const CT_JOB_ROLES = ["Practice Manager", "Senior Partner / Managing Partner", "GP Partner", "Advanced Nurse Practitioner", "Nurse Practitioner", "General Practitioner (GP)", "Business Manager", "Operations Manager", "PCN Clinical Director", "Administrator / Secretary", "Other"];
const CT_LC_OPTS = [["lead", "New"], ["2207373534", "Engaged"], ["5640141025", "Prospecting"], ["marketingqualifiedlead", "MQL"], ["salesqualifiedlead", "SQL"]];

async function ctLoadExtra() {
  try {
    const [s, m, r] = await Promise.all([db.from("hubspot_segments").select("list_id,name,processing_type,size,filter_text,tracked,criteria,synced_at").order("name"), fetchAll("hubspot_segment_members", "list_id,contact_id", "contact_id"),
      db.from("neverbounce_runs").select("run_at,checked,passed,failed,created_in_hubspot,enrolled,credits_remaining,error").order("id", { ascending: false }).limit(5)]);
    ctSegs = s.data || []; ctRuns = r.data || []; ctSegMembers = new Map();
    for (const x of m) { if (!ctSegMembers.has(x.list_id)) ctSegMembers.set(x.list_id, new Set()); ctSegMembers.get(x.list_id).add(String(x.contact_id)); }
  } catch (e) { ctSegs = []; ctRuns = []; }
}
let ctRevSource = "";
const ctCapName = s => String(s || "").split("-").map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "").join("-");
// "claire.chambers12@nhs.net" -> ["Claire", "Chambers"]: the part before the @, digits dropped, the dot as the divider; nothing is guessed when there is no dot.
function ctNameFromEmail(email) { const parts = String(email || "").split("@")[0].replace(/[0-9]+/g, "").split(".").filter(Boolean); return parts.length < 2 ? ["", ""] : [ctCapName(parts[0]), parts.slice(1).map(ctCapName).join(" ")]; }
const ctRevWho = r => { if (r.ev.name) return ctWho(r); const [f, l] = ctNameFromEmail(r.c.email), u = r.c.contact_urn, cls = "rv-name w-28 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-sm";
  return `<div class="flex gap-1"><input class="${cls}" data-u="${u}" data-k="first" value="${esc(f)}" placeholder="First name" aria-label="First name"><input class="${cls}" data-u="${u}" data-k="last" value="${esc(l)}" placeholder="Last name" aria-label="Last name"></div><div class="break-all text-xs text-slate-500">${esc(r.c.email || "")} · no name yet: check it, then Accept</div>`; };
async function ctSaveNames(urns) {
  for (const u of urns) {
    const f = document.querySelector(`.rv-name[data-u="${u}"][data-k="first"]`), l = document.querySelector(`.rv-name[data-u="${u}"][data-k="last"]`); if (!f && !l) continue;
    const first = ctCapName((f && f.value || "").trim()), last = (l && l.value || "").trim().split(/\s+/).map(ctCapName).join(" ");
    if (!first && !last) continue;
    const { error } = await db.rpc("set_contact_name", { p_urn: u, p_first: first, p_last: last }); if (error) throw error;
    const r = ctAll.find(x => x.c.contact_urn === u); if (r) { r.c.first_name = first || null; r.c.last_name = last || null; r.c.full_name = [first, last].filter(Boolean).join(" ") || null; }
  }
}
const ctWho = r => `<div class="font-medium leading-tight">${esc(r.ev.name || "(no name)")}</div><div class="break-all text-xs text-slate-500">${esc(r.c.email || "")}</div>`;
const ctPracticeLink = r => r.p ? `<a href="#" class="ct-open text-lalu-teal-700 hover:underline" data-ods="${esc(r.p.ods_code)}">${esc(r.p.practice_name)}</a>` : esc(r.c.ods_code || "");

/* ---------- NeverBounce ---------- */
function ctNeverbounce() {
  const pend = ctAll.filter(r => r.c.nb_state === "pending"), appr = ctAll.filter(r => r.c.nb_state === "approved"), done = ctAll.filter(r => r.c.nb_state === "checked"), last = ctRuns[0];
  const count = (k) => done.filter(r => r.c.nb_result === k).length, tile = (k, v, sub = "") => `<div class="rounded-xl border border-slate-200 bg-white p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-2xl font-bold">${v}</div><div class="text-xs text-slate-500">${sub}</div></div>`;
  const rows = pend.concat(appr).slice(0, 300);
  return `<div class="space-y-3"><div class="grid grid-cols-2 gap-3 md:grid-cols-4">${tile("Waiting for approval", pend.length.toLocaleString(), "new Oscar contacts that qualify")}${tile("Approved", appr.length.toLocaleString(), "checked first thing on Monday")}${tile("Checked", done.length.toLocaleString(), CT_NB_STATUSES.map(k => count(k) ? k.split(" ")[0] + " " + count(k) : "").filter(Boolean).join(" · ") || "none yet")}${tile("Credits left", last && last.credits_remaining != null ? Number(last.credits_remaining).toLocaleString() : "–", last ? "after the run on " + esc(fmtDate(last.run_at)) : "no run yet")}</div>
    <p class="text-sm text-slate-600">New contacts from Oscar with a direct address, a decision-maker or secondary role, not already in HubSpot, wait here. Anyone can approve them. The check runs <b>on Mondays before 9am</b>: Valid and Accept All (Unverifiable) contacts are created in HubSpot with their NeverBounce status and added to the segments they fit; Unknown, Disposable and Invalid are recorded and left out. The team gets a Slack alert in #lalu_atlas${infoTip("Results are written to Atlas and to HubSpot's NeverBounce Status property. A contact is only checked once. Contacts already in HubSpot are never sent to NeverBounce.")}.</p>
    <div class="flex flex-wrap items-center gap-2"><button id="nb-approve" class="rounded-lg bg-lalu-navy px-3 py-2 text-sm font-semibold text-white hover:bg-lalu-navy-700 disabled:opacity-50" ${ctNbSel.size ? "" : "disabled"}>Approve ticked (${ctNbSel.size})</button><button id="nb-approve-all" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50" ${pend.length ? "" : "disabled"}>Approve all waiting (${pend.length})</button><button id="nb-takeback" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50" ${ctNbSel.size ? "" : "disabled"}>Take ticked back</button><span class="text-xs text-slate-500" role="status">${esc(ctMsg)}</span></div>
    <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table class="w-full text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th class="w-8 px-2 py-2"><input type="checkbox" id="nb-all" aria-label="Tick all shown"></th><th class="px-2">Contact</th><th class="px-2">Job title</th><th class="px-2">Practice</th><th class="px-2">Queue</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="border-t border-slate-100 align-top"><td class="px-2 py-1.5"><input type="checkbox" class="nb-chk" data-u="${r.c.contact_urn}" ${ctNbSel.has(r.c.contact_urn) ? "checked" : ""} aria-label="Tick ${esc(r.ev.name || "contact")}"></td><td class="px-2">${ctWho(r)}</td><td class="px-2 text-sm">${esc(r.c.job_title || "")}</td><td class="px-2">${ctPracticeLink(r)}</td><td class="px-2">${r.c.nb_state === "approved" ? chip("Approved", "bg-emerald-100 text-emerald-800", "by " + (r.c.nb_approved_by || "")) : chip("Waiting", "bg-amber-100 text-amber-800")}</td></tr>`).join("") || '<tr><td colspan="5" class="p-6 text-center text-sm italic text-slate-500">Nothing is waiting. New Oscar contacts that qualify appear here after the daily load.</td></tr>'}</tbody></table></div>
    ${ctRuns.length ? `<h3 class="pt-2 text-sm font-bold">Recent runs</h3><div class="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table class="w-full text-left text-xs"><thead class="bg-slate-50 uppercase tracking-wider text-slate-500"><tr><th class="px-2 py-1.5">When</th><th class="px-2">Checked</th><th class="px-2">Passed</th><th class="px-2">Failed</th><th class="px-2">Created in HubSpot</th><th class="px-2">Added to segments</th><th class="px-2">Credits left</th></tr></thead><tbody>${ctRuns.map(x => `<tr class="border-t border-slate-100"><td class="px-2 py-1">${esc(fmtDate(x.run_at))}</td><td class="px-2">${x.checked}</td><td class="px-2">${x.passed}</td><td class="px-2">${x.failed}</td><td class="px-2">${x.created_in_hubspot}</td><td class="px-2">${x.enrolled}</td><td class="px-2">${x.credits_remaining ?? "–"}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
}
async function ctNbApprove(urns, approve) {
  if (!urns.length) return;
  const { error } = await db.rpc("set_neverbounce_approval", { p_urns: urns, p_approve: approve });
  if (error) { ctMsg = "Could not save: " + (error.message || error); renderContacts(); return; }
  for (const r of ctAll) if (urns.includes(r.c.contact_urn) && ["pending", "approved"].includes(r.c.nb_state)) { r.c.nb_state = approve ? "approved" : "pending"; r.c.nb_approved_by = approve ? "you" : null; }
  ctNbSel.clear(); ctMsg = approve ? `${urns.length} approved. They are checked on Monday morning.` : `${urns.length} taken back to waiting.`; renderContacts();
}

/* ---------- Segments ---------- */
function ctSegStats(s) {
  const ids = ctSegMembers.get(s.list_id) || new Set(), byHs = new Map(ctAll.filter(r => r.c.hubspot_contact_id).map(r => [String(r.c.hubspot_contact_id), r]));
  let inAtlas = 0, eligible = 0, held = 0, seq = 0, unsub = 0;
  for (const id of ids) { const r = byHs.get(id); if (!r) continue; inAtlas++; if (r.ev.status === "eligible") eligible++; else if (r.ev.status === "suppressed") held++; if (r.c.hs_in_sequence) seq++; if (r.c.email_opt_out || r.c.hs_optout_all || r.c.hs_mkt_optout) unsub++; }
  return { members: ids.size, inAtlas, eligible, held, seq, unsub };
}
function ctSegCard(s) {
  const st = ctSegStats(s), cr = s.criteria || {}, box = (k, opts, label) => `<fieldset class="mt-2"><legend class="text-xs font-semibold text-slate-600">${label}</legend><div class="mt-1 flex flex-wrap gap-1.5">${opts.map(([v, l]) => `<label class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"><input type="checkbox" class="seg-crit" data-list="${esc(s.list_id)}" data-k="${k}" value="${esc(v)}" ${(cr[k] || []).includes(v) ? "checked" : ""}>${esc(l)}</label>`).join("")}</div></fieldset>`;
  const stat = (k, v, tip = "") => `<div class="rounded-lg bg-slate-50 px-2.5 py-1.5" title="${esc(tip)}"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="text-lg font-bold">${v.toLocaleString()}</div></div>`;
  return `<div class="rounded-xl border border-slate-200 bg-white p-4"><div class="flex flex-wrap items-start justify-between gap-2"><div><div class="font-bold">${esc(s.name)}</div><div class="text-xs text-slate-500">${chip(s.processing_type === "DYNAMIC" ? "Active list" : "Static list", "bg-slate-100 text-slate-600")} synced ${esc(fmtDate(s.synced_at))}</div></div><a class="text-xs font-semibold text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="https://app-eu1.hubspot.com/contacts/145802630/objectLists/${esc(s.list_id)}">Open in HubSpot ↗</a></div>
    <div class="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">${stat("In HubSpot", st.members || Number(s.size || 0), "members of the list in HubSpot")}${stat("In Atlas", st.inAtlas, "members Atlas holds")}${stat("Eligible", st.eligible, "could be contacted now")}${stat("Held back", st.held, "a suppression rule applies")}${stat("In sequence", st.seq)}${stat("Unsubscribed", st.unsub)}</div>
    ${box("lifecycle", CT_LC_OPTS, "Lifecycle stage")}${box("neverbounce", CT_NB_STATUSES.map(v => [v, v]), "NeverBounce status")}${box("roles", CT_JOB_ROLES.map(v => [v, v]), "Job role")}
    <p class="mt-2 text-xs text-slate-500">${s.processing_type === "DYNAMIC" ? "Saving updates this list's filters in HubSpot, so HubSpot enrols and drops contacts itself." : "A static list: contacts that pass NeverBounce and fit these criteria are added by the Monday run."} The suppression lists it excludes stay as they are in HubSpot.</p>
    <div class="mt-2 flex items-center gap-3"><button class="seg-save rounded-lg bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700" data-list="${esc(s.list_id)}">Save criteria</button><span class="seg-msg text-xs text-slate-500" data-list="${esc(s.list_id)}" role="status"></span></div>
    ${s.filter_text ? `<details class="mt-2 text-xs text-slate-500"><summary class="cursor-pointer">Filters in HubSpot</summary><p class="mt-1 break-words">${esc(s.filter_text)}</p></details>` : ""}</div>`;
}
function ctSegmentsHub() {
  const tracked = ctSegs.filter(s => s.tracked), others = ctSegs.filter(s => !s.tracked);
  return `<div class="space-y-4"><p class="text-sm text-slate-600">HubSpot's contact segments, synced daily. The ones Atlas <b>tracks</b> show who is in them, who can be contacted now, and carry criteria you can edit here. Any new segment in HubSpot appears below and can be tracked with one tick.</p>
    ${tracked.length ? `<div class="grid gap-3 xl:grid-cols-2">${tracked.map(ctSegCard).join("")}</div>` : '<p class="rounded-xl border border-dashed border-slate-300 p-6 text-sm italic text-slate-500">No segments synced yet. They arrive with the next HubSpot sync (Data > Overview > Run sync now).</p>'}
    ${others.length ? `<div><h3 class="mb-1 text-sm font-bold">Other HubSpot segments <span class="font-normal text-slate-500">· ${others.length}</span></h3><div class="max-h-96 overflow-auto rounded-xl border border-slate-200 bg-white"><table class="w-full text-left text-sm"><thead class="sticky top-0 bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th class="px-3 py-1.5">Segment</th><th class="px-2">Type</th><th class="px-2 text-right">Size</th><th class="px-2">Track</th></tr></thead><tbody>${others.map(s => `<tr class="border-t border-slate-100"><td class="px-3 py-1">${esc(s.name)}</td><td class="px-2 text-xs text-slate-500">${s.processing_type === "DYNAMIC" ? "Active" : "Static"}</td><td class="px-2 text-right font-mono text-xs">${Number(s.size || 0).toLocaleString()}</td><td class="px-2"><input type="checkbox" class="seg-track" data-list="${esc(s.list_id)}" aria-label="Track ${esc(s.name)}"></td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <h3 class="pt-2 text-sm font-bold">Saved filters</h3>${ctSegmentsPanel()}</div>`;
}

/* ---------- Review ---------- */
function ctReview() {
  const partial = ctAll.filter(r => r.ev.excluded.startsWith("address only partly")), unclear = ctAll.filter(r => r.ev.excluded.startsWith("address does not clearly")), held = ctAll.filter(r => r.c.held_reason && r.c.held_reason !== "rejected in review" && !/^shared/.test(r.c.held_reason) && r.ev.status === "excluded" && !partial.includes(r) && !unclear.includes(r));
  const titles = new Map(); for (const r of ctAll) if (r.ev.status === "eligible" && r.ev.role.id === "other" && !ctTitleMode(r.c.job_title || r.c.title) && (r.c.job_title || r.c.title)) { const t = (r.c.job_title || r.c.title).trim(); titles.set(t, (titles.get(t) || 0) + 1); }
  const bySrc = a => ctRevSource ? a.filter(r => (r.c.source || "oscar") === ctRevSource) : a;
  const tabs = [["partial", "Partly matches", bySrc(partial)], ["unclear", "Not clearly theirs", bySrc(unclear)], ["titles", "New job titles", [...titles]], ["held", "Held at import", bySrc(held)]], cur = tabs.find(t => t[0] === ctRevTab) || tabs[0], list = cur[2];
  const head = `<div class="flex flex-wrap gap-1.5" role="tablist">${tabs.map(([k, l, a]) => `<button type="button" role="tab" aria-selected="${k === cur[0]}" class="rv-tab rounded-lg border px-3 py-1.5 text-sm font-semibold ${k === cur[0] ? "border-lalu-navy bg-lalu-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}" data-t="${k}">${l} <span class="${k === cur[0] ? "text-white/80" : "text-slate-500"}">${a.length.toLocaleString()}</span></button>`).join("")}</div>`;
  const srcSel = `<div class="flex items-center gap-2 text-xs"><label for="rv-source" class="font-semibold text-slate-600">Source</label><select id="rv-source" class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm">${[["", "All"], ["oscar", "Oscar"], ["hubspot", "HubSpot"]].map(([v, l]) => `<option value="${v}" ${v === ctRevSource ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;
  if (cur[0] === "titles") {
    const rows = list.sort((a, b) => b[1] - a[1]).slice(0, ctRevShown), roleOpts = CT_ROLES.filter(r => !r[4] && r[0] !== "other" && r[0] !== "none").map(r => `<option value="${r[0]}">${esc(r[1])}</option>`).join("");
    return `<div class="space-y-3">${head}<p class="text-sm text-slate-600">Job titles not yet set. Mark each title Main, Other or Off and it applies at once to every contact with that title (change it later in Settings > Job titles). Showing titles that fall in "Other titles" and have no setting.</p>
      <div class="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">${rows.map(([t, n]) => `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><div class="min-w-0"><div class="text-sm font-medium">${esc(t)}</div><div class="text-xs text-slate-500">${n} contact${n === 1 ? "" : "s"}</div></div><div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold" role="group" aria-label="Section for ${esc(t)}">${[["main", "Main"], ["other", "Other"], ["off", "Off"]].map(([k, l]) => `<button type="button" class="rv-title-set rounded-md px-2.5 py-1 text-slate-600 hover:bg-slate-50" data-t="${esc(t)}" data-m="${k}">${l}</button>`).join("")}</div></div>`).join("") || '<p class="p-6 text-center text-sm italic text-slate-500">Every title has a setting.</p>'}</div>
      ${list.length > rows.length ? `<div class="text-center"><button class="rv-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${list.length - rows.length})</button></div>` : ""}</div>`;
  }
  const rows = list.slice(0, ctRevShown), ids = rows.map(r => r.c.contact_urn);
  return `<div class="space-y-3">${head}${srcSel}<p class="text-sm text-slate-600">${{ partial: "Part of the name is in the address, so it is probably the person's. Accept to treat it as direct (new Oscar contacts then queue for NeverBounce), or reject.", unclear: "A personal-style address whose name differs. Check it against HubSpot or the practice, then accept or reject.", held: "Oscar contacts held at import for a reason the rules cannot settle." }[cur[0]]}</p>
    <div class="flex flex-wrap items-center gap-2"><button class="rv-bulk rounded-lg bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700 disabled:opacity-50" data-a="accept" data-u="${ids.join(",")}" ${ids.length ? "" : "disabled"}>Accept the ${ids.length} shown</button><span class="text-xs text-slate-500" role="status">${esc(ctMsg)}</span></div>
    <div class="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">${rows.map(r => `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><div class="min-w-0">${ctRevWho(r)}<div class="text-xs text-slate-500">${esc(r.c.job_title || r.c.title || "no job title")} · ${ctPracticeLink(r)}${r.c.held_reason ? " · " + esc(r.c.held_reason) : ""}</div></div><div class="flex gap-1.5"><button class="rv-act rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100" data-a="accept" data-u="${r.c.contact_urn}">Accept</button><button class="rv-act rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50" data-a="reject" data-u="${r.c.contact_urn}">Reject</button></div></div>`).join("") || '<p class="p-6 text-center text-sm italic text-slate-500">Nothing to review here.</p>'}</div>
    ${list.length > rows.length ? `<div class="text-center"><button class="rv-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${list.length - rows.length})</button></div>` : ""}</div>`;
}
async function ctReviewAct(urns, action) {
  const { error } = await db.rpc("review_contact", { p_urns: urns, p_action: action });
  if (error) { ctMsg = "Could not save: " + (error.message || error); renderContacts(); return; }
  for (const r of ctAll) if (urns.includes(r.c.contact_urn)) { if (action === "accept") { r.c.email_quality = "direct"; r.c.held_reason = null; } else r.c.held_reason = "rejected in review"; }
  ctMsg = `${urns.length} ${action === "accept" ? "accepted" : "rejected"}.`; ctEvalAll(); renderContacts();
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const t = e.target;
  if (t.id === "nb-approve") return ctNbApprove([...ctNbSel], true);
  if (t.id === "nb-approve-all") return ctNbApprove(ctAll.filter(r => r.c.nb_state === "pending").map(r => r.c.contact_urn), true);
  if (t.id === "nb-takeback") return ctNbApprove([...ctNbSel], false);
  const tab = t.closest(".rv-tab"); if (tab) { ctRevTab = tab.dataset.t; ctRevShown = 25; ctMsg = ""; return renderContacts(); }
  if (t.closest(".rv-more")) { ctRevShown += 50; return renderContacts(); }
  const tm = t.closest(".rv-title-set"); if (tm) { ctRules.titleModes = { ...(ctRules.titleModes || {}), [tm.dataset.t.toLowerCase()]: tm.dataset.m }; ctEvalAll(); ctMsg = ""; renderContacts(); ctSave(); return; }
  const act = t.closest(".rv-act, .rv-bulk"); if (act) { act.disabled = true; const urns = act.dataset.u.split(",").map(Number); try { if (act.dataset.a === "accept") await ctSaveNames(urns); } catch (err) { ctMsg = "Could not save a name: " + (err.message || err); act.disabled = false; return renderContacts(); } return ctReviewAct(urns, act.dataset.a); }
  const sv = t.closest(".seg-save"); if (sv) {
    const id = sv.dataset.list, crit = {}; document.querySelectorAll(`.seg-crit[data-list="${id}"]:checked`).forEach(c => (crit[c.dataset.k] = crit[c.dataset.k] || []).push(c.value));
    const msg = document.querySelector(`.seg-msg[data-list="${id}"]`); sv.disabled = true; msg.textContent = "Saving…";
    try { const r = await hsCall({ action: "segment_set_criteria", listId: id, criteria: crit }); const s = ctSegs.find(x => x.list_id === id); if (s) s.criteria = crit; msg.textContent = r.hubspotUpdated ? "Saved here and in HubSpot." : "Saved. The Monday run uses it to add new contacts."; }
    catch (err) { msg.textContent = "Could not save: " + err.message; }
    sv.disabled = false; return;
  }
});
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.classList.contains("nb-chk")) { const u = Number(t.dataset.u); t.checked ? ctNbSel.add(u) : ctNbSel.delete(u); return renderContacts(); }
  if (t.id === "nb-all") { document.querySelectorAll(".nb-chk").forEach(c => { c.checked = t.checked; t.checked ? ctNbSel.add(Number(c.dataset.u)) : ctNbSel.delete(Number(c.dataset.u)); }); return renderContacts(); }
  if (t.classList.contains("seg-track")) { const { error } = await db.rpc("set_segment_tracked", { p_list: t.dataset.list, p_tracked: true }); if (!error) { const s = ctSegs.find(x => x.list_id === t.dataset.list); if (s) s.tracked = true; renderContacts(); } return; }
  if (t.id === "rv-source") { ctRevSource = t.value; ctRevShown = 25; return renderContacts(); }
  if (t.classList.contains("rv-role-pick") && t.value) { ctRules.titles = { ...(ctRules.titles || {}), [t.dataset.t.toLowerCase()]: t.value }; ctEvalAll(); ctMsg = ""; renderContacts(); ctSave(); }
});
