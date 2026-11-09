/* Contacts tab: every contact Atlas holds, who may be contacted and why not, saved segments, the HubSpot export import, and the settings that switch job roles and suppression rules on and off.
   The rules live in contact-rules.js. Loaded after contact-rules.js. Contacts are read from public.contacts; their HubSpot state (lifecycle, sequence, bounce...) is kept there by the daily HubSpot sync. */
let ctAll = [], ctLoaded = false, ctSub = "contacts", ctShown = 100, ctDirty = false, ctSegments = [], ctLocked = new Map(), ctHeld = null, ctSaving = false;
let ctMoreOpen = false, ctF = { q: "", section: "", status: "", role: "", source: "", reason: "" };
const CT_COLS = "contact_urn,ods_code,full_name,first_name,last_name,job_title,title,email,phone,email_opt_out,is_primary,hubspot_status,hubspot_contact_id,source,email_quality,role_tier,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,held_reason,nb_state,nb_result,nb_checked_at,nb_approved_by";
const CT_STATUS = { eligible: ["Eligible", "bg-emerald-100 text-emerald-800"], suppressed: ["Held back", "bg-amber-100 text-amber-800"], excluded: ["Not used", "bg-slate-100 text-slate-600"] };
const CT_SECTION = { main: ["Main", "bg-teal-100 text-teal-800"], other: ["Other", "bg-sky-100 text-sky-800"] };

async function loadContacts(force) {
  if (ctLoaded && !force) { renderContacts(); return; }
  $("ct-body").innerHTML = '<p class="p-6 text-sm text-slate-500">Loading contacts…</p>';
  try {
    const [rows, flags, am, au, run] = await Promise.all([fetchAll("contacts", CT_COLS, "contact_urn"), db.from("app_flags").select("key,value").in("key", ["contact_rules", "contact_segments"]),
      db.from("audience_members").select("audience_id,contact_id,state"), db.from("audiences").select("id,name").eq("archived", false), db.from("ingest_runs").select("stats").eq("status", "success").order("id", { ascending: false }).limit(1)]);
    const f = Object.fromEntries((flags.data || []).map(r => [r.key, r.value]));
    ctSetRules(f.contact_rules); ctSegments = (f.contact_segments && f.contact_segments.list) || [];
    const names = new Map((au.data || []).map(a => [a.id, a.name]));
    ctLocked = new Map((am.data || []).filter(m => AUD_LOCKS.includes(m.state) && m.contact_id).map(m => [String(m.contact_id), names.get(m.audience_id) || "an audience"]));
    ctHeld = ((run.data || [])[0] || {}).stats || null;
    await ctLoadExtra(); ctRows = rows; ctLoaded = true; ctDirty = false; ctEvalAll(); renderContacts();
  } catch (e) { $("ct-body").innerHTML = `<p class="p-6 text-sm text-rose-700">Could not load contacts: ${esc(e.message || e)}</p>`; }
}
let ctRows = [];
function ctEvalAll() { ctAll = ctRows.map(c => { const p = byOds.get(c.ods_code); return { c, p, ev: ctEvaluate(c, p, ctLocked) }; }); }

function setCtSub(which) {
  ctSub = which; ctShown = 100;
  $("ct-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.c === which ? "bg-white shadow-sm" : "text-slate-500"));
  renderContacts(); stateToUrl();
}
$("ct-sub").querySelectorAll("button").forEach(b => b.onclick = () => setCtSub(b.dataset.c));

const ctMatch = r => {
  const { c, p, ev } = r, f = ctF, q = f.q.trim().toLowerCase();
  return (!f.section || ev.section === f.section) && (!f.status || ev.status === f.status) && (!f.role || ev.role.id === f.role) && (!f.source || (c.source || "oscar") === f.source) && (!f.reason || ev.reasons.includes(f.reason))
    && (!q || [ev.name, c.email, c.job_title, c.title, c.ods_code, p && p.practice_name, p && p.postcode].some(v => (v || "").toLowerCase().includes(q)));
};
const ctSortKey = r => (r.ev.status === "eligible" ? 0 : r.ev.status === "suppressed" ? 1 : 2) + (r.ev.section === "main" ? 0 : 0.5);
const ctChip = ([l, cls], tip = "") => chip(l, cls, tip);
const ctOptions = (items, cur, all) => `<option value="">${all}</option>` + items.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");

function ctTiles() {
  const n = s => ctAll.filter(r => r.ev.status === s).length, main = ctAll.filter(r => r.ev.status === "eligible" && r.ev.section === "main").length, other = ctAll.filter(r => r.ev.status === "eligible" && r.ev.section === "other").length;
  const tile = (k, v, sub, cls = "") => `<div class="rounded-xl border border-slate-200 bg-white p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-2xl font-bold ${cls}">${v.toLocaleString()}</div><div class="text-xs text-slate-500">${sub}</div></div>`;
  return `<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">${tile("Contacts", ctAll.length, "held in Atlas")}${tile("Eligible", n("eligible"), "can be in a campaign now", "text-emerald-700")}${tile("Main", main, "decision-makers", "text-teal-700")}${tile("Other", other, "any role, direct address", "text-sky-700")}
    ${tile("Held back", n("suppressed"), "a suppression rule applies", "text-amber-700")}${tile("Not used", n("excluded"), "shared, partial or switched-off", "text-slate-600")}</div>`;
}
const ctModeBar = () => `<div class="flex flex-wrap items-center gap-2 text-xs"><span class="font-semibold text-slate-600">Campaign type</span><div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 font-semibold" role="group" aria-label="Campaign type">
  ${[["standard", "Standard"], ["reengage", "Re-engagement"]].map(([k, l]) => `<button type="button" class="ct-mode rounded-md px-3 py-1 ${ctMode === k ? "bg-lalu-navy text-white" : "text-slate-600 hover:bg-slate-50"}" data-m="${k}" aria-pressed="${ctMode === k}">${l}</button>`).join("")}</div>
  <span class="text-slate-500">${ctMode === "standard" ? "Only New and Engaged contacts are eligible." : "Re-engagement and disqualified-lead campaigns: the lifecycle rule is lifted; every other rule still applies."}</span></div>`;

function ctRow(r) {
  const { c, p, ev } = r, st = CT_STATUS[ev.status], sec = ev.section && CT_SECTION[ev.section];
  const why = ev.status === "suppressed" ? ev.reasons.map(ctRuleLabel).join("; ") : ev.excluded;
  return `<tr class="border-t border-slate-100 align-top"><td class="py-1.5 pr-2"><div class="font-medium leading-tight">${c.hubspot_contact_id ? `<a class="text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="${esc(hsUrl("0-1", c.hubspot_contact_id))}" title="Open in HubSpot">${esc(ev.name || "(no name)")}</a>` : esc(ev.name || "(no name)")}${c.is_primary ? " " + chip("Key contact", "bg-indigo-100 text-indigo-800") : ""}</div><div class="text-xs text-slate-500 break-all">${esc(c.email || "")}</div></td>
    <td class="px-2"><div class="text-sm">${esc(c.job_title || c.title || "")}</div><div class="text-xs text-slate-500">${esc(ev.role.label)}</div></td>
    <td class="px-2">${p ? `<a href="#" class="ct-open text-lalu-teal-700 hover:underline" data-ods="${esc(p.ods_code)}">${esc(p.practice_name)}</a>` : esc(c.ods_code || "")}<div class="font-mono text-xs text-slate-500">${esc(c.ods_code || "")}</div></td>
    <td class="px-2">${sec ? ctChip(sec) : '<span class="text-slate-300">–</span>'}</td>
    <td class="px-2">${ctChip(st, why)} ${ctBadges(c)}${why ? `<div class="mt-0.5 max-w-[16rem] text-xs text-slate-500">${esc(why)}</div>` : ""}</td>
    <td class="px-2 text-xs text-slate-600">${c.hs_lifecycle ? esc(CT_LIFECYCLE[c.hs_lifecycle] || c.hs_lifecycle) : '<span class="text-slate-300">not in HubSpot</span>'}</td></tr>`;
}
function ctList() {
  const rows = ctAll.filter(ctMatch).sort((a, b) => ctSortKey(a) - ctSortKey(b)), shown = rows.slice(0, ctShown), nF = ["section", "status", "reason", "role", "source"].filter(k => ctF[k]).length;
  const roleOpts = CT_ROLES.map(r => [r[0], r[1]]), reasonOpts = CT_RULES.map(r => [r[0], r[1]]);
  return `${ctTiles()}<div class="mt-3">${ctModeBar()}</div>
    <div class="relative mt-3 flex flex-wrap items-center gap-2">
      <div class="relative min-w-[220px] max-w-lg flex-1"><svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg>
        <input id="ct-q" type="search" value="${esc(ctF.q)}" placeholder="Search name, email, job title, practice, ODS code…" class="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" aria-label="Search contacts"></div>
      <button id="ct-more-btn" type="button" aria-expanded="${ctMoreOpen}" aria-controls="ct-more" class="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50"><svg class="h-4 w-4 text-slate-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M6 10h8M9 15h2"/></svg>Filters${nF ? ` <span class="rounded-full bg-lalu-teal-700 px-1.5 text-[11px] font-bold leading-5 text-white">${nF}</span>` : ""}</button>
      <span class="ml-auto flex items-center gap-3"><span id="ct-count" class="text-sm text-slate-500">${rows.length.toLocaleString()} contact${rows.length === 1 ? "" : "s"} · ${rows.filter(r => r.ev.status === "eligible").length.toLocaleString()} eligible</span>
        <button id="ct-seg-save" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Save as segment</button><button id="ct-csv" class="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Export eligible</button></span>
      <div id="ct-more" class="${ctMoreOpen ? "" : "hidden"} absolute left-0 top-full z-20 mt-2 w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-4 shadow-xl" role="region" aria-label="Filters"><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        ${[["ct-section", "Section", ctOptions([["main", "Main"], ["other", "Other"]], ctF.section, "Any section")], ["ct-status", "Status", ctOptions([["eligible", "Eligible"], ["suppressed", "Held back"], ["excluded", "Not used"]], ctF.status, "Any status")], ["ct-reason", "Held back by", ctOptions(reasonOpts, ctF.reason, "Any rule")], ["ct-role", "Job role", ctOptions(roleOpts, ctF.role, "Any job role")], ["ct-source", "Source", ctOptions([["oscar", "Oscar"], ["hubspot", "HubSpot"]], ctF.source, "Any source")]].map(([id, l, o]) => `<label class="block text-xs font-semibold text-slate-600">${l}<span class="mt-1 block"><select id="${id}" class="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">${o}</select></span></label>`).join("")}</div>
        <div class="mt-3 text-right"><button id="ct-clear" type="button" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Clear filters</button></div></div></div>
    <div class="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-white"><table class="w-full text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th class="px-2 py-2">Contact</th><th class="px-2">Job title</th><th class="px-2">Practice</th><th class="px-2">Section</th><th class="px-2">Status</th><th class="px-2">Lifecycle</th></tr></thead>
      <tbody>${shown.map(ctRow).join("") || '<tr><td colspan="6" class="p-6 text-center text-sm italic text-slate-500">No contact matches.</td></tr>'}</tbody></table></div>
    ${rows.length > shown.length ? `<div class="pt-3 text-center"><button class="ct-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(rows.length - shown.length).toLocaleString()} more)</button></div>` : ""}`;
}

/* ---------- Segments: saved filter sets ---------- */
function ctSegmentsPanel() {
  const cards = ctSegments.map(s => { const saved = ctF, tmp = s.filters; ctF = { ...ctF, ...tmp }; const m = ctAll.filter(ctMatch); ctF = saved;
    return `<div class="rounded-xl border border-slate-200 bg-white p-4"><div class="flex items-start justify-between gap-3"><div><div class="font-semibold">${esc(s.name)}</div><div class="text-xs text-slate-500">${esc(ctFilterText(tmp))}</div></div>
      <div class="text-right"><div class="text-xl font-bold text-emerald-700">${m.filter(r => r.ev.status === "eligible").length.toLocaleString()}</div><div class="text-xs text-slate-500">eligible of ${m.length.toLocaleString()}</div></div></div>
      <div class="mt-3 flex gap-2 text-xs font-semibold"><button class="ct-seg-open rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50" data-id="${esc(s.id)}">Open</button><button class="ct-seg-csv rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50" data-id="${esc(s.id)}">Download eligible (CSV)</button><button class="ct-seg-del ml-auto rounded-md px-3 py-1 text-rose-700 hover:bg-rose-50" data-id="${esc(s.id)}">Delete</button></div></div>`; }).join("");
  return `<div class="space-y-3"><p class="text-sm text-slate-600">A segment is a saved set of filters on All contacts. Its count follows the job-role and suppression settings, so it is always the people who may be contacted now. Set the filters on All contacts, then <b>Save as segment</b>.</p>
    <div class="grid gap-3 lg:grid-cols-2">${cards || '<p class="rounded-xl border border-dashed border-slate-300 p-6 text-sm italic text-slate-500">No segments yet.</p>'}</div></div>`;
}
const ctFilterText = f => [f.section && "section " + (CT_SECTION[f.section] || [f.section])[0], f.role && (CT_ROLE[f.role] || {}).label, f.source && "from " + f.source, f.reason && "held by " + ctRuleLabel(f.reason), f.q && `"${f.q}"`, f.status && (CT_STATUS[f.status] || [f.status])[0]].filter(Boolean).join(" · ") || "All contacts";

/* ---------- Settings ---------- */
function ctSettings() {
  const counts = {}; for (const r of ctAll) counts[r.ev.role.id] = (counts[r.ev.role.id] || 0) + 1;
  const held = {}; for (const r of ctAll) for (const x of r.ev.reasons) held[x] = (held[x] || 0) + 1;
  const seg = (id, cur) => `<div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold" role="group" aria-label="${esc(CT_ROLE[id].label)}">${[["main", "Main"], ["other", "Other"], ["off", "Off"]].map(([k, l]) => `<button type="button" class="ct-role-set rounded-md px-3 py-1 ${cur === k ? (k === "off" ? "bg-slate-500 text-white" : "bg-lalu-navy text-white") : "text-slate-600 hover:bg-slate-50"}" data-id="${id}" data-m="${k}" aria-pressed="${cur === k}">${l}</button>`).join("")}</div>`;
  const sw = (id, on, label, sub, extra = "") => `<label class="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5"><span class="min-w-0"><span class="block text-sm font-semibold">${label}${extra}</span><span class="block text-xs text-slate-500">${sub}</span></span>
    <span class="relative mt-0.5 shrink-0"><input type="checkbox" class="peer sr-only ct-rule-set" data-id="${id}" ${on ? "checked" : ""}><span class="block h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-lalu-teal-700 peer-focus-visible:ring-2 peer-focus-visible:ring-lalu-teal-700"></span><span class="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4"></span></span></label>`;
  return `<div class="space-y-4"><div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border ${ctDirty ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"} p-3"><span class="text-sm ${ctDirty ? "text-amber-900" : "text-slate-600"}">${ctDirty ? "You have unsaved changes. The numbers above already follow them." : "Changes apply straight away to this page and to Audiences. Save to keep them for everyone."}</span>
      <span class="flex gap-2"><button id="ct-reset" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Reset to defaults</button><button id="ct-save" class="rounded-lg bg-lalu-navy px-4 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700 disabled:opacity-50" ${ctDirty && !ctSaving ? "" : "disabled"}>${ctSaving ? "Saving…" : "Save"}</button></span></div>
    <section class="rounded-xl border border-slate-200 bg-white p-4"><h3 class="font-bold">Job roles</h3><p class="text-xs text-slate-500">A contact needs a direct email address that belongs to them. <b>Main</b> is for decision-makers, <b>Other</b> for anyone else we want, <b>Off</b> leaves the role out.</p>
      <div class="mt-2 divide-y divide-slate-100">${CT_ROLES.map(([id, label, , , locked]) => `<div class="flex flex-wrap items-center justify-between gap-2 py-2"><div class="min-w-0"><div class="text-sm font-medium">${esc(label)}</div><div class="text-xs text-slate-500">${(counts[id] || 0).toLocaleString()} contact${(counts[id] || 0) === 1 ? "" : "s"}</div></div>${locked ? '<span class="text-xs text-slate-400">always off</span>' : seg(id, ctRoleMode(id))}</div>`).join("")}</div></section>
    <section class="rounded-xl border border-slate-200 bg-white p-4 space-y-2"><h3 class="font-bold">Email addresses</h3>
      ${sw("likely", ctRules.likely, "Accept likely-direct addresses", "Part of the person's name is in the address (for example jsmith@). Off by default.")}
      ${sw("strictValid", ctRules.strictValid, "NeverBounce: only Valid addresses", "Hold back Unknown and Accept-all results as well as Invalid and Disposable. Needs the NeverBounce rule below.")}</section>
    <section class="rounded-xl border border-slate-200 bg-white p-4 space-y-2"><h3 class="font-bold">Suppression rules</h3><p class="text-xs text-slate-500">A contact that is switched on here and matches is held back, whatever its role. These follow HubSpot's <i>Campaign Exclusion List</i>; Atlas keeps its own copy and writes nothing back to HubSpot.</p>
      ${CT_RULES.map(([id, label, sub]) => sw(id, ctRuleOn(id), esc(label), esc(sub), `<span class="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">${(held[id] || 0).toLocaleString()} held</span>`)).join("")}
      <div class="rounded-lg border border-slate-200 px-3 py-2.5"><label class="block text-sm font-semibold" for="ct-owners">Contact owners kept out of campaigns</label><input id="ct-owners" value="${esc(ctRules.owners.join(", "))}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs" aria-describedby="ct-owners-h"><div id="ct-owners-h" class="mt-0.5 text-xs text-slate-500">HubSpot owner IDs, separated by commas. Used by the owner rule.</div></div>
      ${CT_NOT_EVALUATED.map(([, label, sub]) => `<div class="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 opacity-70"><div class="text-sm font-semibold">${esc(label)} <span class="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal">not evaluated yet</span></div><div class="text-xs text-slate-500">${esc(sub)}</div></div>`).join("")}</section></div>`;
}

function renderContacts() {
  const box = $("ct-body"); if (!box || currentTab !== "contacts") return;
  if (!ctLoaded) return;
  $("ct-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.c === ctSub ? "bg-white shadow-sm" : "text-slate-500"));
  if (ctSub === "import") { if (!$("contact-import")) { box.innerHTML = '<div id="contact-import"></div>'; renderContactImport(); } return; }
  box.innerHTML = ctSub === "review" ? ctReview() : ctSub === "segments" ? ctSegmentsHub() : ctSub === "neverbounce" ? ctNeverbounce() : ctSub === "settings" ? ctSettings() : ctList();
  }
const ctRefilter = () => { ctShown = 100; const q = $("ct-q"), pos = q && document.activeElement === q ? q.selectionStart : null; renderContacts(); if (pos != null) { const n = $("ct-q"); n.focus(); n.setSelectionRange(pos, pos); } };
const ctRulesChanged = () => { ctDirty = true; ctEvalAll(); renderContacts(); };
async function ctSave() {
  ctSaving = true; renderContacts();
  try { const { error } = await db.from("app_flags").upsert([{ key: "contact_rules", value: ctRules, updated_by: await audMe(), updated_at: new Date().toISOString() }]); if (error) throw error; ctDirty = false; }
  catch (e) { alert("Could not save: " + (e.message || e)); }
  ctSaving = false; renderContacts();
}
async function ctSaveSegments() { const { error } = await db.from("app_flags").upsert([{ key: "contact_segments", value: { list: ctSegments }, updated_by: await audMe(), updated_at: new Date().toISOString() }]); if (error) alert("Could not save: " + (error.message || error)); }
function ctCsv(rows, name) {
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Name", "Email", "Job title", "Role group", "Section", "Practice", "ODS code", "Lifecycle"].join(",")].concat(rows.map(r => [r.ev.name, r.c.email, r.c.job_title || r.c.title, r.ev.role.label, (CT_SECTION[r.ev.section] || [""])[0], r.p && r.p.practice_name, r.c.ods_code, CT_LIFECYCLE[r.c.hs_lifecycle] || r.c.hs_lifecycle || ""].map(cell).join(",")));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
document.addEventListener("input", e => { if (e.target.id === "ct-q") { ctF.q = e.target.value; ctRefilter(); } });
document.addEventListener("change", e => {
  const id = e.target.id, m = { "ct-section": "section", "ct-status": "status", "ct-reason": "reason", "ct-role": "role", "ct-source": "source" }[id];
  if (m) { ctF[m] = e.target.value; ctRefilter(); return; }
  if (e.target.id === "ct-owners") { ctRules.owners = e.target.value.split(/[\s,;]+/).filter(Boolean); ctRulesChanged(); return; }
  if (e.target.classList.contains("ct-rule-set")) { const k = e.target.dataset.id; if (k === "likely") ctRules.likely = e.target.checked; else if (k === "strictValid") ctRules.strictValid = e.target.checked; else ctRules.suppression[k] = e.target.checked; ctRulesChanged(); }
});
document.addEventListener("click", e => {
  const t = e.target;
  const o = t.closest("a.ct-open"); if (o) { e.preventDefault(); const p = byOds.get(o.dataset.ods); if (p) openDrawer(p); return; }   // opens the profile in the side drawer, so the page and your place stay put

  const md = t.closest(".ct-mode"); if (md) { ctMode = md.dataset.m; ctEvalAll(); renderContacts(); return; }
  const rs = t.closest(".ct-role-set"); if (rs) { ctRules.roles[rs.dataset.id] = rs.dataset.m; ctRulesChanged(); return; }
  if (t.closest("#ct-more-btn")) { ctMoreOpen = !ctMoreOpen; renderContacts(); return; }
  if (t.closest("#ct-clear")) { ctF = { ...ctF, section: "", status: "", reason: "", role: "", source: "" }; renderContacts(); return; }
  if (ctMoreOpen && !t.closest("#ct-more")) { ctMoreOpen = false; renderContacts(); }
  if (t.closest("#ct-save")) { ctSave(); return; }
  if (t.closest("#ct-reset")) { if (confirm("Reset job roles and suppression rules to the defaults?")) { ctSetRules(null); ctRulesChanged(); } return; }
  if (t.closest(".ct-more")) { ctShown += 200; renderContacts(); return; }
  if (t.closest("#ct-csv")) { ctCsv(ctAll.filter(ctMatch).filter(r => r.ev.status === "eligible"), "atlas-eligible-contacts.csv"); return; }
  if (t.closest("#ct-seg-save")) { const name = (prompt("Name this segment") || "").trim(); if (name) { ctSegments.push({ id: "s" + Date.now().toString(36), name, filters: { ...ctF } }); ctSaveSegments(); setCtSub("segments"); } return; }
  const sg = t.closest(".ct-seg-open, .ct-seg-csv, .ct-seg-del"); if (sg) {
    const s = ctSegments.find(x => x.id === sg.dataset.id); if (!s) return;
    if (sg.classList.contains("ct-seg-open")) { ctF = { q: "", section: "", status: "", role: "", source: "", reason: "", ...s.filters }; setCtSub("contacts"); }
    else if (sg.classList.contains("ct-seg-csv")) { const saved = ctF; ctF = { ...ctF, ...s.filters }; const rows = ctAll.filter(ctMatch).filter(r => r.ev.status === "eligible"); ctF = saved; ctCsv(rows, "atlas-segment-" + s.name.replace(/\W+/g, "-").toLowerCase() + ".csv"); }
    else if (confirm(`Delete the segment “${s.name}”?`)) { ctSegments = ctSegments.filter(x => x.id !== s.id); ctSaveSegments(); renderContacts(); }
  }
});
