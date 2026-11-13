/* Contacts tab: every contact Atlas holds, who may be contacted and why not, saved segments, and the settings that switch job roles and suppression rules on and off.
   The rules live in contact-rules.js. Loaded after contact-rules.js. Contacts are read from public.contacts; their HubSpot state (lifecycle, sequence, bounce...) is kept there by the daily HubSpot sync. */
let ctNbSet = { enabled: true, days: [0], auto_push: true }, ctNbWaiting = 0, ctNbMsg = "";   // NeverBounce schedule (saved on its own, the moment a choice changes)
let ctSub = "contacts", ctShown = 100, ctDirty = false, ctSegments = [], ctHeld = null, ctSaving = false;
let ctMoreOpen = false, ctF = { dq: "", q: "", section: "", status: "", role: "", source: "", reason: "", lifecycle: "" };
// Hand-picking: null while the filters decide who is in; once a box is ticked or unticked it is the explicit set of contact urns (a saved segment keeps it as its members).
let ctPick = new Set(), ctOff = new Set(), ctEditing = null,   // ctPick: the urns ticked (none to begin with); null only after Select all = everything the filters show except the urns in ctOff
   ctNoEmail = 0;   // ctNoEmail: contacts with no email address, kept as a count only (never stored)
// Job titles, one by one: each distinct title with how many contacts carry it, set Main, Other or Off. A title nobody has set follows the group default (its group is shown).
let ctTitleQ = "", ctTitleF = "all", ctTitleShown = 100;
function ctTitlesSection() {
  const q = ctTitleQ.trim().toLowerCase(), all = (ctStats ? ctStats.titles : []).map(e => ({ t: e.t, n: e.n, set: ctTitleMode(e.t), group: CT_ROLE[e.role] || CT_ROLE.other })).filter(e => !e.group.locked);
  const list = all.filter(e => (!q || e.t.toLowerCase().includes(q)) && (ctTitleF === "all" || (ctTitleF === "unset" ? !e.set : !!e.set))).sort((a, b) => b.n - a.n || a.t.localeCompare(b.t)), shown = list.slice(0, ctTitleShown);
  const btn = (e, k, l, cur) => `<button type="button" class="ct-title-set rounded-md px-2.5 py-1 ${cur === k ? "bg-lalu-navy text-white" : "text-slate-600 hover:bg-slate-50"}" data-t="${esc(e.t)}" data-m="${k}" aria-pressed="${cur === k}">${l}</button>`;
  return `<section class="rounded-xl border border-slate-200 bg-white p-4"><h3 class="font-bold">Job titles</h3><p class="text-xs text-slate-500">Every title in your contacts, most common first. <b>Main</b> is for decision-makers, <b>Other</b> for anyone else we want, <b>Off</b> leaves the title out. A title you have not set follows its group's default (shown in grey).</p>
    <div class="mt-2 flex flex-wrap items-center gap-2"><input id="ct-title-q" type="search" value="${esc(ctTitleQ)}" placeholder="Search titles…" class="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" aria-label="Search job titles">
      <select id="ct-title-f" class="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" aria-label="Which titles">${[["all", "All titles"], ["unset", "Not set yet"], ["set", "Set by you"]].map(([v, l]) => `<option value="${v}" ${v === ctTitleF ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span class="text-xs text-slate-500">${list.length.toLocaleString()} title${list.length === 1 ? "" : "s"}</span></div>
    <div class="mt-2 max-h-[28rem] divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">${shown.map(e => { const cur = e.set || ctRoleMode(e.group.id); return `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"><div class="min-w-0"><div class="text-sm font-medium">${esc(e.t)}</div><div class="text-xs ${e.set ? "text-slate-500" : "text-slate-400"}">${e.n.toLocaleString()} contact${e.n === 1 ? "" : "s"} · ${e.set ? "set by you" : "group default: " + esc(e.group.label)}</div></div>
      <div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold ${e.set ? "" : "opacity-70"}" role="group" aria-label="Section for ${esc(e.t)}">${btn(e, "main", "Main", cur)}${btn(e, "other", "Other", cur)}${btn(e, "off", "Off", cur)}</div></div>`; }).join("") || '<p class="p-4 text-center text-sm italic text-slate-500">No title matches.</p>'}</div>
    ${list.length > shown.length ? `<div class="pt-2 text-center"><button type="button" id="ct-title-more" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(list.length - shown.length).toLocaleString()})</button></div>` : ""}</section>`;
}
const ctInSel = r => ctPick ? ctPick.has(r.c.contact_urn) : !ctOff.has(r.c.contact_urn);   // every row shown already matches the filters
const CT_COLS = "contact_urn,ods_code,full_name,first_name,last_name,job_title,title,email,phone,email_opt_out,is_primary,hubspot_status,hubspot_contact_id,source,email_quality,role_tier,hs_lifecycle,hs_in_sequence,hs_bounced,hs_bounce_reason,hs_last_sent,hs_mkt_optout,hs_optout_all,hs_owner,hs_neverbounce,held_reason,nb_state,nb_result,nb_checked_at,nb_approved_by,hs_lost_reason,hs_lost_at,hs_lost_deal,hs_lost_kind,hs_dq_reason,hs_dq_note,hs_dq_at,hs_reengage_date,hs_seq_exit,hs_seq_ended_at";
const CT_STATUS = { eligible: ["Eligible", "bg-emerald-100 text-emerald-800"], suppressed: ["Held back", "bg-amber-100 text-amber-800"], excluded: ["Not used", "bg-slate-100 text-slate-600"] };
const CT_SECTION = { main: ["Main", "bg-teal-100 text-teal-800"], other: ["Other", "bg-sky-100 text-sky-800"] };


// ---- Loading ----
// Every view asks the database for just what it shows: the list one page of 100 at a time, and each other tab its own small summary. No tab downloads the whole contact list.
let ctSrvRows = [], ctSrvTotal = 0, ctSrvEligible = 0, ctSrvCounts = null, ctSrvBusy = false, ctSrvReady = false, ctSrvSeq = 0, ctSrvRe = { total: 0, eligible: 0, suppressed: 0, due: 0 }, ctSrvDq = [];
let ctSegOthers = [], ctSegOthersTotal = 0, ctSegOthersOpen = false, ctOscar = null, ctFlagsReady = false, ctStats = null, ctNbQ = null, ctRev = { counts: {}, rows: [], titles: [] }, ctSegStatsMap = {}, ctSegCounts = new Map();
const ctWrap = c => ({ c, p: byOds.get(c.ods_code), ev: { role: CT_ROLE[c.st_role] || CT_ROLE.other, quality: c.email_quality, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.full_name || "", section: c.st_section, excluded: c.st_excluded || "", reasons: c.st_reasons || [], status: c.st_status } });

const ctPageBox = f => ({ q: f.q, section: f.section, status: f.status, role: f.role, source: f.source, reason: f.reason, lifecycle: f.lifecycle, dq: ctMode === "reengage" ? f.dq : "" });
async function ctLoadPage() {
  const seq = ++ctSrvSeq; ctSrvBusy = true; if (!ctSrvReady) $("ct-body").innerHTML = '<p class="p-6 text-sm text-slate-500">Loading contacts…</p>'; else renderContacts();
  try {
    const flags = ctLoadFlags();   // read alongside the first page, not before it
    const [page, counts, osc] = await Promise.all([db.rpc("contacts_query", { p_f: ctPageBox(ctF), p_mode: ctMode, p_what: "rows", p_limit: 100, p_offset: 0 }), ctSrvCounts ? null : db.rpc("contacts_counts"), ctOscar ? null : db.rpc("contacts_oscar_summary")]);
    await flags; if (seq !== ctSrvSeq) return;   // a newer search or filter has replaced this one
    if (page.error) throw page.error;
    if (counts) { if (counts.error) throw counts.error; ctSrvCounts = counts.data; }
    if (osc && !osc.error) ctOscar = osc.data;
    const d = page.data || {}; ctSrvRows = (d.rows || []).map(ctWrap); ctSrvTotal = d.total || 0; ctSrvEligible = d.eligible || 0; ctSrvRe = { total: d.total || 0, eligible: d.eligible || 0, suppressed: d.suppressed || 0, due: d.due || 0 }; if (ctMode === "reengage") ctSrvDq = d.reasons || [];
    ctSrvReady = true; ctSrvBusy = false; const q = $("ct-q"), pos = q && document.activeElement === q ? q.selectionStart : null; renderContacts(); if (pos != null) { const n = $("ct-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  } catch (e) { ctSrvBusy = false; $("ct-body").innerHTML = `<p class="p-6 text-sm text-rose-700">Could not load contacts: ${esc(e.message || e)}</p>`; }
}
async function ctLoadMore() {   // exactly 100 more, added to the list: nothing already shown is fetched again
  if (ctSrvBusy) return; ctSrvBusy = true; renderContacts();
  try {
    const { data, error } = await db.rpc("contacts_query", { p_f: ctPageBox(ctF), p_mode: ctMode, p_what: "rows", p_limit: 100, p_offset: ctSrvRows.length }); if (error) throw error;
    ctSrvRows = ctSrvRows.concat((data.rows || []).map(ctWrap));
  } catch (e) { alert("Could not load more: " + (e.message || e)); }
  ctSrvBusy = false; renderContacts();
}

const ctQueryFilters = () => ({ q: ctF.q, section: ctF.section, status: ctF.status, role: ctF.role, source: ctF.source, reason: ctF.reason, lifecycle: ctF.lifecycle, dq: ctMode === "reengage" ? ctF.dq : "" });
async function ctMatchIds(f = ctQueryFilters()) {   // the ids (never the records) of every contact matching: what ticking, select all and Create audience work from
  const { data, error } = await db.rpc("contacts_query", { p_f: f, p_mode: ctMode, p_what: "ids", p_limit: 0, p_offset: 0 }); if (error) throw error; return data;
}
// CSV exports come from the database, which refuses anyone who is not on the download list (app_flags.download_allowed).
async function ctExport(f, urns, name, off) {
  const { data, error } = await db.rpc("contacts_export", { p_f: { ...(urns ? {} : f), status: "eligible", ...(urns ? { urns: [...urns] } : off && off.size ? { exclude: [...off] } : {}) }, p_mode: ctMode });
  if (error) { alert(/restricted/.test(error.message || "") ? "Downloads are restricted to the account owner for now." : "Could not export: " + (error.message || error)); return; }
  ctCsv((data || []).map(ctWrap), name);
}

let ctFlagsP = null;
function ctLoadFlags() { return ctFlagsReady ? Promise.resolve() : (ctFlagsP = ctFlagsP || ctLoadFlagsNow().finally(() => { ctFlagsP = null; })); }
async function ctLoadFlagsNow() {   // the saved rules, saved filters and the count of contacts with no email: small, read once
  const [flags, waiting, ne, run] = await Promise.all([db.from("app_flags").select("key,value").in("key", ["contact_rules", "contact_segments", "neverbounce_settings"]), db.rpc("contacts_nb_waiting"), db.from("contact_noemail").select("ref", { count: "exact", head: true }),
    db.from("ingest_runs").select("stats").eq("status", "success").order("id", { ascending: false }).limit(1)]);
  const f = Object.fromEntries((flags.data || []).map(r => [r.key, r.value]));
  const nbs = f.neverbounce_settings || {}; ctNbSet = { enabled: nbs.enabled !== false, days: Array.isArray(nbs.days) ? nbs.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [0], auto_push: nbs.auto_push !== false }; ctNbWaiting = Number(waiting.data) || 0;
  ctSetRules(f.contact_rules); ctSegments = (f.contact_segments && f.contact_segments.list) || []; ctNoEmail = ne.count || 0; ctHeld = ((run.data || [])[0] || {}).stats || null; ctFlagsReady = true;
}
async function ctLoadReview(more) {   // the Review tab: the four counts, and 100 rows (or titles) of the open tab; "more" adds the next 100
  const tab = ctRevTab, off = more ? (tab === "titles" ? ctRev.titles.length : ctRev.rows.length) : 0;
  const { data, error } = await db.rpc("contacts_review", { p_tab: tab, p_source: ctRevSource, p_limit: 100, p_offset: off }); if (error) throw error;
  ctRev = { counts: data.counts || {}, rows: (more ? ctRev.rows : []).concat((data.rows || []).map(ctWrap)), titles: (more ? ctRev.titles : []).concat(data.titles || []) };
}
async function ctLoadNb() {   // the queue counts and the first 100 rows; "Show more" adds the next 100
  const [q, rows, r] = await Promise.all([db.rpc("contacts_nb_queue"), db.rpc("contacts_nb_rows", { p_limit: 100, p_offset: 0 }), db.from("neverbounce_runs").select("run_at,checked,passed,failed,created_in_hubspot,enrolled,credits_remaining,error").order("id", { ascending: false }).limit(5)]);
  if (q.error) throw q.error; if (rows.error) throw rows.error; ctNbQ = { ...q.data, rows: (rows.data || []).map(ctWrap) }; ctRuns = r.data || [];
}
async function ctLoadNbMore() {
  const { data, error } = await db.rpc("contacts_nb_rows", { p_limit: 100, p_offset: ctNbQ.rows.length }); if (error) { ctMsg = "Could not load more: " + (error.message || error); return; }
  ctNbQ.rows = ctNbQ.rows.concat((data || []).map(ctWrap));
}
const CT_SEG_COLS = "list_id,name,processing_type,size,filter_text,tracked,criteria,synced_at";
async function ctLoadSegments() {   // the tracked segments in full; the other HubSpot segments only as a count until you ask to see them
  const [s, st, oc] = await Promise.all([db.from("hubspot_segments").select(CT_SEG_COLS).eq("tracked", true).order("name"), db.rpc("contacts_segment_stats"), db.from("hubspot_segments").select("list_id", { count: "exact", head: true }).eq("tracked", false)]);
  ctSegs = s.data || []; ctSegStatsMap = st.data || {}; ctSegOthersTotal = oc.count || 0; ctSegOthers = []; ctSegOthersOpen = false; ctSegCounts = new Map();
  await Promise.all(ctSegments.map(async sg => {   // each saved filter set is counted by the database
    const f = sg.members ? { urns: sg.members } : { ...ctPageBox({ q: "", section: "", status: "", role: "", source: "", reason: "", lifecycle: "", dq: "", ...sg.filters }), ...(sg.exclude && sg.exclude.length ? { exclude: sg.exclude } : {}) };
    const { data } = await db.rpc("contacts_query", { p_f: f, p_mode: "standard", p_what: "rows", p_limit: 0, p_offset: 0 }); ctSegCounts.set(sg.id, { total: (data || {}).total || 0, eligible: (data || {}).eligible || 0 });
  }));
}
async function ctLoadSegOthers(more) {   // 100 of the other segments at a time
  const from = more ? ctSegOthers.length : 0, { data, error } = await db.from("hubspot_segments").select(CT_SEG_COLS).eq("tracked", false).order("name").range(from, from + 99);
  if (error) { ctMsg = "Could not load segments: " + (error.message || error); return; }
  ctSegOthers = (more ? ctSegOthers : []).concat(data || []); ctSegOthersOpen = true;
}
// Which view is open: load only what it needs, then draw it.
// The animated loading box shown the first time Review, Segments, NeverBounce or Settings is opened (they are fetched on that first click, once).
const CT_SUB_NAME = { review: "review", segments: "segments", neverbounce: "NeverBounce", settings: "settings" };
const ctLoadingBox = msg => `<div class="flex flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white p-12 text-center" role="status" aria-live="polite"><svg class="h-9 w-9 animate-spin text-lalu-teal-700" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".2" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><div class="text-sm font-semibold text-slate-700">${esc(msg)}</div></div>`;
let ctTabReady = {};   // the views already loaded: switching back to one draws it again without asking the database, until something changes its data
async function ctLoadTab(force) {
  const box = $("ct-body"); if (!box) return;
  if (!force && ctTabReady[ctSub]) { renderContacts(); return; }
  box.innerHTML = ctSub === "contacts" ? '<p class="p-6 text-sm text-slate-500">Loading contacts…</p>' : ctLoadingBox("Loading " + (CT_SUB_NAME[ctSub] || "") + "…");
  try {
    if (ctSub === "contacts") { ctSrvReady = false; await ctLoadPage(); ctTabReady.contacts = true; return; }
    await ctLoadFlags();
    if (ctSub === "review") await ctLoadReview(false);
    else if (ctSub === "neverbounce") await ctLoadNb();
    else if (ctSub === "segments") await ctLoadSegments();
    else if (ctSub === "settings") { const { data, error } = await db.rpc("contacts_settings_stats"); if (error) throw error; ctStats = data; }
    ctTabReady[ctSub] = true; renderContacts();
  } catch (e) { box.innerHTML = `<p class="p-6 text-sm text-rose-700">Could not load: ${esc(e.message || e)}</p>`; }
}
async function ctPreload() {   // while the sign-in pop-up is up: only the default All contacts list; the other views load on their first click
  const keep = ctSub; ctSub = "contacts";
  try { await ctLoadTab(); } finally { ctSub = keep; }
}
async function loadContacts(force) { if (force) { ctFlagsReady = false; ctSrvCounts = null; ctOscar = null; ctTabReady = {}; } await ctLoadTab(force); }

function setCtSub(which) {
  ctSub = which; ctShown = 100;
  $("ct-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.c === which ? "bg-white shadow-sm" : "text-slate-500"));
  stateToUrl(); ctLoadTab();
}
$("ct-sub").querySelectorAll("button").forEach(b => b.onclick = () => setCtSub(b.dataset.c));

const ctDue = c => !!c.hs_reengage_date && String(c.hs_reengage_date).slice(0, 10) <= new Date().toISOString().slice(0, 10);
const ctChip = ([l, cls], tip = "") => chip(l, cls, tip);
const ctOptions = (items, cur, all) => `<option value="">${all}</option>` + items.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");

function ctTiles() {
  if (ctMode === "reengage") {
    const t = (k, v, sub, cls = "") => `<div class="rounded-xl border border-slate-200 bg-white p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-2xl font-bold ${cls}">${v.toLocaleString()}</div><div class="text-xs text-slate-500">${sub}</div></div>`;
    return `<div class="grid grid-cols-2 gap-3 md:grid-cols-4">${t("Re-engagement candidates", ctSrvRe.total, "disqualified leads and lost deals")}${t("Due now", ctSrvRe.due, "asked to hear again, date reached", "text-sky-700")}${t("Eligible", ctSrvRe.eligible, "can be contacted now", "text-emerald-700")}${t("Held back", ctSrvRe.suppressed, "a suppression rule applies", "text-amber-700")}</div>`;
  }
  const C = ctSrvCounts || { total: 0, eligible: 0, main: 0, other: 0, suppressed: 0, excluded: 0 }, n = s => C[s], main = C.main, other = C.other;
  const tile = (k, v, sub, cls = "") => `<div class="rounded-xl border border-slate-200 bg-white p-3"><div class="text-xs uppercase tracking-wider text-slate-500">${k}</div><div class="text-2xl font-bold ${cls}">${v.toLocaleString()}</div><div class="text-xs text-slate-500">${sub}</div></div>`;
  const O = ctOscar, oscarTile = O ? `<div class="col-span-2 rounded-xl border border-slate-200 bg-white p-3" title="From Oscar's latest file (${esc(String(O.run_at || "").slice(0, 10))}). Contacts with no email address, or at a practice Atlas does not hold, are not imported."><div class="text-xs uppercase tracking-wider text-slate-500">Oscar contacts</div><div class="flex flex-wrap items-baseline gap-x-3"><span class="text-2xl font-bold">${O.total.toLocaleString()}</span><span class="text-xs text-slate-500">${O.stored.toLocaleString()} imported · <b class="text-slate-700">${Math.max(O.total - O.stored, 0).toLocaleString()} not imported</b></span></div>
    <div class="mt-0.5 text-xs text-slate-500"><span class="font-semibold text-emerald-700">${O.eligible.toLocaleString()}</span> eligible · <span class="font-semibold text-amber-700">${O.suppressed.toLocaleString()}</span> held back · <span class="font-semibold text-slate-600">${O.excluded.toLocaleString()}</span> not used</div></div>` : "";
  return `<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">${tile("Contacts", C.total, "held in Atlas")}${tile("Eligible", n("eligible"), `Main ${main.toLocaleString()} · Other ${other.toLocaleString()}`, "text-emerald-700")}${tile("Held back", n("suppressed"), "a suppression rule applies", "text-amber-700")}${tile("Not used", n("excluded"), "shared, partial or switched-off", "text-slate-600")}${oscarTile}</div>`;
}
const ctModeBar = () => `<div class="flex flex-wrap items-center gap-2 text-xs"><span class="font-semibold text-slate-600">Campaign type</span><div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 font-semibold" role="group" aria-label="Campaign type">
  ${[["standard", "Standard"], ["reengage", "Re-engagement"]].map(([k, l]) => `<button type="button" class="ct-mode rounded-md px-3 py-1 ${ctMode === k ? "bg-lalu-navy text-white" : "text-slate-600 hover:bg-slate-50"}" data-m="${k}" aria-pressed="${ctMode === k}">${l}</button>`).join("")}</div>
  <span class="text-slate-500">${ctMode === "standard" ? "Only New and Engaged contacts are eligible." : "Re-engagement and disqualified-lead campaigns: the lifecycle rule is lifted; every other rule still applies."}</span></div>`;

function ctRow(r) {
  const { c, p, ev } = r, st = CT_STATUS[ev.status], sec = ev.section && CT_SECTION[ev.section];
  const why = ev.status === "suppressed" ? ev.reasons.map(ctRuleLabel).join("; ") : ev.excluded;
  return `<tr class="border-t border-slate-100 align-top"><td class="py-1.5 pl-2 pr-1"><input type="checkbox" class="ct-pick h-4 w-4 accent-lalu-teal-700" data-u="${c.contact_urn}" ${ctInSel(r) ? "checked" : ""} aria-label="Include ${esc(ev.name || c.email || "this contact")}"></td><td class="py-1.5 pr-2"><div class="font-medium leading-tight">${c.hubspot_contact_id ? `<a class="text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="${esc(hsUrl("0-1", c.hubspot_contact_id))}" title="Open in HubSpot">${esc(ev.name || "(no name)")}</a>` : esc(ev.name || "(no name)")}${c.is_primary ? " " + chip("Key contact", "bg-indigo-100 text-indigo-800") : ""}</div><div class="text-xs text-slate-500 break-all">${esc(c.email || "")}</div></td>
    <td class="px-2"><div class="text-sm">${esc(c.job_title || c.title || "")}</div><div class="text-xs text-slate-500">${esc(ev.role.label)}</div></td>
    <td class="px-2">${p ? `<a href="#" class="ct-open text-lalu-teal-700 hover:underline" data-ods="${esc(p.ods_code)}">${esc(p.practice_name)}</a>` : esc(c.ods_code || "")}<div class="font-mono text-xs text-slate-500">${esc(c.ods_code || "")}</div></td>
    <td class="px-2">${sec ? ctChip(sec) : '<span class="text-slate-300">–</span>'}</td>
    <td class="px-2">${ctChip(st, why)} ${ctBadges(c)}${why ? `<div class="mt-0.5 max-w-[16rem] text-xs text-slate-500">${esc(why)}</div>` : ""}</td>
    <td class="px-2 text-xs text-slate-600">${c.hs_lifecycle ? esc(CT_LIFECYCLE[c.hs_lifecycle] || c.hs_lifecycle) : '<span class="text-slate-300">not in HubSpot</span>'}</td>${ctMode === "reengage" ? `<td class="px-2 text-xs">${[c.hs_dq_reason ? chip("Disqualified: " + ctDqLabel(c.hs_dq_reason), "bg-rose-100 text-rose-800") : "", c.hs_lost_reason ? chip("Deal lost (" + (CT_LOST_KIND[c.hs_lost_kind] || "was a lead") + "): " + c.hs_lost_reason, "bg-amber-100 text-amber-800") : ""].join(" ") || '<span class="text-slate-300">–</span>'}</td><td class="max-w-[16rem] px-2 text-xs text-slate-600">${c.hs_dq_note ? esc(c.hs_dq_note) : c.hs_lost_deal ? `<span class="text-slate-500">${esc(c.hs_lost_deal)}${c.hs_lost_at ? " · lost " + esc(fmtDate(c.hs_lost_at)) : ""}</span>` : '<span class="text-slate-300">–</span>'}</td><td class="whitespace-nowrap px-2 text-xs">${c.hs_reengage_date ? `${esc(fmtDate(c.hs_reengage_date))}${ctDue(c) ? " " + chip("due", "bg-sky-100 text-sky-800") : ""}` : '<span class="text-slate-300">–</span>'}</td>` : ""}</tr>`;
}
function ctList() {
  const rows = ctSrvRows, shown = rows, total = ctSrvTotal, elig = ctSrvEligible, nF = ["section", "status", "reason", "role", "source", "lifecycle", "dq"].filter(k => ctF[k]).length, dqOpts = ctSrvDq.slice().sort().map(v => [v, ctDqLabel(v)]);
  const roleOpts = CT_ROLES.map(r => [r[0], r[1]]), reasonOpts = CT_RULES.map(r => [r[0], r[1]]);
  return `${ctTiles()}<div class="mt-3 flex flex-wrap items-center justify-between gap-2">${ctModeBar()}${ctMode === "reengage" ? `<button type="button" id="ct-make-aud" class="rounded-lg bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">Create audience from ${elig.toLocaleString()} eligible contacts</button>` : ""}</div>
    <div class="relative mt-3 flex flex-wrap items-center gap-2">
      <div class="relative min-w-[220px] max-w-lg flex-1"><svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg>
        <input id="ct-q" type="search" value="${esc(ctF.q)}" placeholder="Search name, email, job title, practice, ODS code…" class="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" aria-label="Search contacts"></div>
      <button id="ct-more-btn" type="button" aria-expanded="${ctMoreOpen}" aria-controls="ct-more" class="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50"><svg class="h-4 w-4 text-slate-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M6 10h8M9 15h2"/></svg>Filters${nF ? ` <span class="rounded-full bg-lalu-teal-700 px-1.5 text-[11px] font-bold leading-5 text-white">${nF}</span>` : ""}</button>
      <span class="ml-auto flex items-center gap-3"><span id="ct-count" class="text-sm text-slate-500">${total.toLocaleString()} contact${total === 1 ? "" : "s"} · ${elig.toLocaleString()} eligible${ctNoEmail ? ` · <span title="Contacts with no email address cannot be contacted, so they are counted here and not stored">${ctNoEmail.toLocaleString()} with no email (count only)</span>` : ""}${(ctPick ? ctPick.size > 0 : true) ? ` · <b class="text-slate-700">${ctPick ? ctPick.size.toLocaleString() + " picked" : ctOff.size ? ctOff.size.toLocaleString() + " left out" : "all selected"}</b> <button type="button" id="ct-pick-clear" class="font-semibold text-lalu-teal-700 hover:underline">back to the filters</button>` : ""}</span>
        ${ctEditing && ctSegments.find(x => x.id === ctEditing) ? `<button id="ct-seg-update" class="rounded-lg bg-lalu-navy px-3 py-2 text-sm font-semibold text-white hover:bg-lalu-navy-700">Update “${esc(ctSegments.find(x => x.id === ctEditing).name)}”</button>` : ""}<button id="ct-seg-save" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Save as segment</button><button id="ct-csv" class="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Export eligible</button></span>
      <div id="ct-more" class="${ctMoreOpen ? "" : "hidden"} absolute left-0 top-full z-20 mt-2 w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-4 shadow-xl" role="region" aria-label="Filters"><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        ${[["ct-section", "Section", ctOptions([["main", "Main"], ["other", "Other"]], ctF.section, "Any section")], ["ct-status", "Status", ctOptions([["eligible", "Eligible"], ["suppressed", "Held back"], ["excluded", "Not used"]], ctF.status, "Any status")], ["ct-reason", "Held back by", ctOptions(reasonOpts, ctF.reason, "Any rule")], ["ct-role", "Job role", ctOptions(roleOpts, ctF.role, "Any job role")], ["ct-source", "Source", ctOptions([["oscar", "Oscar"], ["hubspot", "HubSpot"]], ctF.source, "Any source")], ["ct-lifecycle", "Lifecycle stage", ctOptions(Object.entries(CT_LIFECYCLE), ctF.lifecycle, "Any stage")], ...(ctMode === "reengage" ? [["ct-dq", "Disqualification reason", ctOptions([["any", "Any disqualified lead"], ...dqOpts], ctF.dq, "Any contact")]] : [])].map(([id, l, o]) => `<label class="block text-xs font-semibold text-slate-600">${l}<span class="mt-1 block"><select id="${id}" class="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">${o}</select></span></label>`).join("")}</div>
        <div class="mt-3 text-right"><button id="ct-clear" type="button" class="text-xs font-semibold text-lalu-teal-700 hover:underline">Clear filters</button></div></div></div>
    <div class="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-white"><table class="w-full text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th class="w-8 py-2 pl-2 pr-1"><input type="checkbox" id="ct-pick-all" class="h-4 w-4 accent-lalu-teal-700" ${!ctPick && ctOff.size === 0 ? "checked" : ""} aria-label="Select or clear every contact in this list"></th><th class="px-2 py-2">Contact</th><th class="px-2">Job title</th><th class="px-2">Practice</th><th class="px-2">Section</th><th class="px-2">Status</th><th class="px-2">Lifecycle</th>${ctMode === "reengage" ? '<th class="px-2">Why (disqualified or deal lost)</th><th class="px-2">Lead disqualification note</th><th class="px-2">Hear again</th>' : ""}</tr></thead>
      <tbody>${shown.map(ctRow).join("") || '<tr><td colspan="7" class="p-6 text-center text-sm italic text-slate-500">No contact matches.</td></tr>'}</tbody></table></div>
    ${total > shown.length ? `<div class="pt-3 text-center"><button class="ct-more rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(total - shown.length).toLocaleString()} more)</button></div>` : ""}`;
}

/* ---------- Segments: saved filter sets ---------- */
function ctSegmentsPanel() {
  const cards = ctSegments.map(s => { const cnt = ctSegCounts.get(s.id) || { total: 0, eligible: 0 }, tmp = s.filters;
    return `<div class="rounded-xl border border-slate-200 bg-white p-4"><div class="flex items-start justify-between gap-3"><div><div class="font-semibold">${esc(s.name)}</div><div class="text-xs text-slate-500">${s.members ? `${s.members.length.toLocaleString()} hand-picked contacts` : esc(ctFilterText(tmp))}</div></div>
      <div class="text-right"><div class="text-xl font-bold text-emerald-700">${cnt.eligible.toLocaleString()}</div><div class="text-xs text-slate-500">eligible of ${cnt.total.toLocaleString()}</div></div></div>
      <div class="mt-3 flex gap-2 text-xs font-semibold"><button class="ct-seg-open rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50" data-id="${esc(s.id)}">Open</button><button class="ct-seg-csv rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50" data-id="${esc(s.id)}">Download eligible (CSV)</button><button class="ct-seg-del ml-auto rounded-md px-3 py-1 text-rose-700 hover:bg-rose-50" data-id="${esc(s.id)}">Delete</button></div></div>`; }).join("");
  return `<div class="space-y-3"><p class="text-sm text-slate-600">A segment is a saved set of filters on All contacts. Its count follows the job-role and suppression settings, so it is always the people who may be contacted now. Set the filters on All contacts, then <b>Save as segment</b>.</p>
    <div class="grid gap-3 lg:grid-cols-2">${cards || '<p class="rounded-xl border border-dashed border-slate-300 p-6 text-sm italic text-slate-500">No segments yet.</p>'}</div></div>`;
}
const ctFilterText = f => [f.section && "section " + (CT_SECTION[f.section] || [f.section])[0], f.role && (CT_ROLE[f.role] || {}).label, f.source && "from " + f.source, f.reason && "held by " + ctRuleLabel(f.reason), f.q && `"${f.q}"`, f.status && (CT_STATUS[f.status] || [f.status])[0]].filter(Boolean).join(" · ") || "All contacts";

/* ---------- Settings ---------- */

function ctSettings() {
  const counts = (ctStats && ctStats.roles) || {}, held = (ctStats && ctStats.held) || {};
  const seg = (id, cur) => `<div class="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-semibold" role="group" aria-label="${esc(CT_ROLE[id].label)}">${[["main", "Main"], ["other", "Other"], ["off", "Off"]].map(([k, l]) => `<button type="button" class="ct-role-set rounded-md px-3 py-1 ${cur === k ? (k === "off" ? "bg-slate-500 text-white" : "bg-lalu-navy text-white") : "text-slate-600 hover:bg-slate-50"}" data-id="${id}" data-m="${k}" aria-pressed="${cur === k}">${l}</button>`).join("")}</div>`;
  const sw = (id, on, label, sub, extra = "") => `<label class="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5"><span class="min-w-0"><span class="block text-sm font-semibold">${label}${extra}</span><span class="block text-xs text-slate-500">${sub}</span></span>
    <span class="relative mt-0.5 shrink-0"><input type="checkbox" class="peer sr-only ct-rule-set" data-id="${id}" ${on ? "checked" : ""}><span class="block h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-lalu-teal-700 peer-focus-visible:ring-2 peer-focus-visible:ring-lalu-teal-700"></span><span class="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4"></span></span></label>`;
  return `<div class="space-y-4"><div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border ${ctDirty ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"} p-3"><span class="text-sm ${ctDirty ? "text-amber-900" : "text-slate-600"}">${ctDirty ? "Not saved yet. Nothing has changed for anyone until you press Save, and leaving this page now discards these changes." : "Changes take effect when you press Save: the database then recalculates every contact, for everyone."}</span>
      <span class="flex gap-2"><button id="ct-reset" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Reset to defaults</button><button id="ct-save" class="rounded-lg bg-lalu-navy px-4 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700 disabled:opacity-50" ${ctDirty && !ctSaving ? "" : "disabled"}>${ctSaving ? "Saving…" : "Save"}</button></span></div>
    ${ctTitlesSection()}<details class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer font-bold">Group defaults <span class="text-xs font-normal text-slate-500">(used for any title you have not set above)</span></summary><p class="mt-1 text-xs text-slate-500">A contact needs a direct email address that belongs to them. <b>Main</b> is for decision-makers, <b>Other</b> for anyone else we want, <b>Off</b> leaves the role out.</p>
      <div class="mt-2 divide-y divide-slate-100">${CT_ROLES.map(([id, label, , , locked]) => `<div class="flex flex-wrap items-center justify-between gap-2 py-2"><div class="min-w-0"><div class="text-sm font-medium">${esc(label)}</div><div class="text-xs text-slate-500">${(counts[id] || 0).toLocaleString()} contact${(counts[id] || 0) === 1 ? "" : "s"}</div></div>${locked ? '<span class="text-xs text-slate-400">always off</span>' : seg(id, ctRoleMode(id))}</div>`).join("")}</div></details>
    <section class="rounded-xl border border-slate-200 bg-white p-4 space-y-2"><h3 class="font-bold">Email addresses</h3>
      ${sw("likely", ctRules.likely, "Accept likely-direct addresses", "Part of the person's name is in the address (for example jsmith@). Off by default.")}
      ${sw("strictValid", ctRules.strictValid, "NeverBounce: only Valid addresses", "Hold back Unknown and Accept-all results as well as Invalid and Disposable. Needs the NeverBounce rule below.")}
      <fieldset class="rounded-lg border border-slate-200 px-3 py-2.5"><legend class="px-1 text-sm font-semibold">NeverBounce checks <span class="text-xs font-normal text-slate-500">(saved as soon as you change them)</span></legend>
        <label class="flex cursor-pointer items-center justify-between gap-4 py-1"><span class="text-sm"><b>Run checks</b><span class="block text-xs text-slate-500">Off: no addresses are checked on any day. Contacts you approve wait in the queue.</span></span><input type="checkbox" class="ct-nbs h-4 w-4 accent-lalu-teal-700" data-k="enabled" ${ctNbSet.enabled ? "checked" : ""}></label>
        <div class="py-1"><div class="text-sm font-semibold">Days the check runs</div><div class="text-xs text-slate-500">It runs early on each ticked day (before 09:00 UK) and checks every approved contact, up to 1,500 a run.</div><div class="mt-1 flex flex-wrap gap-1.5">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs"><input type="checkbox" class="ct-nbs h-3.5 w-3.5 accent-lalu-teal-700" data-k="day" value="${i}" ${ctNbSet.days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div>
        <label class="flex cursor-pointer items-center justify-between gap-4 py-1"><span class="text-sm"><b>Push passing contacts to HubSpot automatically</b><span class="block text-xs text-slate-500">On: a contact that passes is created in HubSpot straight away. Off: the result is kept in Atlas and the contact waits here until you push it.</span></span><input type="checkbox" class="ct-nbs h-4 w-4 accent-lalu-teal-700" data-k="auto_push" ${ctNbSet.auto_push ? "checked" : ""}></label>
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><span class="text-sm"><b>${ctNbWaiting.toLocaleString()}</b> contact${ctNbWaiting === 1 ? "" : "s"} passed and ${ctNbWaiting === 1 ? "is" : "are"} waiting to be pushed to HubSpot</span><button id="ct-nb-push" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" ${ctNbWaiting ? "" : "disabled"}>Push to HubSpot now</button></div>
        <div id="ct-nbs-msg" class="min-h-[1rem] pt-1 text-xs text-slate-500" role="status">${esc(ctNbMsg)}</div></fieldset></section>
    <details class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer font-bold">Re-engagement: disqualified leads and lost deals <span class="text-xs font-normal text-slate-500">(which reasons put a contact in the Re-engagement list)</span></summary><div class="mt-2 space-y-2"><p class="text-xs text-slate-500">The Re-engagement campaign type lists contacts whose latest lead was disqualified (HubSpot's Lead property Disqualification Reason) or whose latest deal was closed lost (UM Closed Lost Reasons) for a reason switched on here. Customers are never listed, and the suppression rules below still apply.</p>
      ${Object.entries(CT_DQ).map(([v, l]) => sw("dq:" + v, ctDqOn(v), esc(l), "", `<span class="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">${(((ctStats || {}).dq || {})[v] || 0).toLocaleString()} contacts</span>`)).join("")}
      <h4 class="pt-2 text-sm font-bold">Deal lost because</h4>${CT_LOST.map(v => sw("dq:lost:" + v, ctDqOn("lost:" + v), esc(v), "", `<span class="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">${(((ctStats || {}).lost || {})[v] || 0).toLocaleString()} contacts</span>`)).join("")}</div></details>
    <section class="rounded-xl border border-slate-200 bg-white p-4 space-y-2"><h3 class="font-bold">Suppression rules</h3><p class="text-xs text-slate-500">A contact that is switched on here and matches is held back, whatever its role. These follow HubSpot's <i>Campaign Exclusion List</i>; Atlas keeps its own copy and writes nothing back to HubSpot.</p>
      ${CT_RULES.map(([id, label, sub]) => sw(id, ctRuleOn(id), esc(label), esc(sub), `<span class="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">${(held[id] || 0).toLocaleString()} held</span>`)).join("")}
      <fieldset class="rounded-lg border border-slate-200 px-3 py-2.5"><legend class="px-1 text-sm font-semibold">Bounces that hold a contact back</legend><div class="text-xs text-slate-500">Used when "Email bounced" is on. Untick a type to let those contacts through. A segment can accept more types on its own card.</div><div class="mt-1 flex flex-wrap gap-1.5">${CT_BOUNCE_TYPES.map(([v, l]) => `<label class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"><input type="checkbox" class="ct-bounce-set" value="${v}" ${ctRules.bounceHold.includes(v) ? "checked" : ""}>${esc(l)}</label>`).join("")}</div></fieldset>
      <div class="rounded-lg border border-slate-200 px-3 py-2.5"><label class="block text-sm font-semibold" for="ct-owners">Contact owners kept out of campaigns</label><input id="ct-owners" value="${esc(ctRules.owners.join(", "))}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs" aria-describedby="ct-owners-h"><div id="ct-owners-h" class="mt-0.5 text-xs text-slate-500">HubSpot owner IDs, separated by commas. Used by the owner rule.</div></div>
    </section></div>`;
}

function renderContacts() {
  const box = $("ct-body"); if (!box || currentTab !== "contacts") return;
  $("ct-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.c === ctSub ? "bg-white shadow-sm" : "text-slate-500"));
  box.innerHTML = ctSub === "review" ? ctReview() : ctSub === "segments" ? ctSegmentsHub() : ctSub === "neverbounce" ? ctNeverbounce() : ctSub === "settings" ? ctSettings() : ctList();
  }
let ctQT = null;
const ctRefilter = () => { ctShown = 100; clearTimeout(ctQT); ctQT = setTimeout(ctLoadPage, 250); };
const ctRulesChanged = () => { ctDirty = true; renderContacts(); };
window.addEventListener("beforeunload", e => { if (ctDirty) { e.preventDefault(); e.returnValue = ""; } });   // a refresh with unsaved Settings asks first
async function ctSave() {
  ctSaving = true; renderContacts();
  try {
    const { error } = await db.from("app_flags").upsert([{ key: "contact_rules", value: ctRules, updated_by: await audMe(), updated_at: new Date().toISOString() }]); if (error) throw error; ctDirty = false;
    for (let b = 0; b < 8; b++) { const r = await db.rpc("refresh_contact_status_bucket", { p_bucket: b, p_buckets: 8 }); if (r.error) throw r.error; }   // the database recalculates every contact with the new rules, in slices so no request runs long
    ctSrvCounts = null; ctOscar = null;
  } catch (e) { alert("Could not save: " + (e.message || e)); }
  ctSaving = false; ctTabReady = {}; ctLoadTab(true);
}
async function ctSaveNbSettings(el) {   // the schedule is not a contact rule: it saves at once and needs no recalculation
  const was = JSON.stringify(ctNbSet), k = el.dataset.k;
  if (k === "day") ctNbSet.days = [...document.querySelectorAll('.ct-nbs[data-k="day"]:checked')].map(x => Number(x.value)).sort(); else ctNbSet[k] = el.checked;
  const msg = $("ct-nbs-msg"); if (msg) msg.textContent = "Saving…";
  const { error } = await db.from("app_flags").upsert([{ key: "neverbounce_settings", value: ctNbSet, updated_by: await audMe(), updated_at: new Date().toISOString() }]);
  if (error) { ctNbSet = JSON.parse(was); ctNbMsg = "Could not save: " + (error.message || error); }
  else ctNbMsg = !ctNbSet.enabled ? "Saved. No checks will run." : !ctNbSet.days.length ? "Saved. No days are ticked, so no checks will run." : "Saved.";
  renderContacts();
}
async function ctNbPush(btn) {
  if (!confirm(`Create the ${ctNbWaiting.toLocaleString()} waiting contact${ctNbWaiting === 1 ? "" : "s"} in HubSpot now?`)) return;
  btn.disabled = true; const { data, error } = await db.functions.invoke("neverbounce-trigger");
  ctNbMsg = error || (data && data.error) ? "Could not start the push: " + ((data && data.error) || (error && error.message)) : "Push started. It takes a few minutes; reopen Settings afterwards to see the count drop.";
  renderContacts();
}
async function ctSaveSegments() { ctTabReady.segments = false; const { error } = await db.from("app_flags").upsert([{ key: "contact_segments", value: { list: ctSegments }, updated_by: await audMe(), updated_at: new Date().toISOString() }]); if (error) alert("Could not save: " + (error.message || error)); }
function ctCsv(rows, name) {
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Name", "Email", "Job title", "Role group", "Section", "Practice", "ODS code", "Lifecycle"].join(",")].concat(rows.map(r => [r.ev.name, r.c.email, r.c.job_title || r.c.title, r.ev.role.label, (CT_SECTION[r.ev.section] || [""])[0], r.p && r.p.practice_name, r.c.ods_code, CT_LIFECYCLE[r.c.hs_lifecycle] || r.c.hs_lifecycle || ""].map(cell).join(",")));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
document.addEventListener("input", e => { if (e.target.id === "ct-q") { ctF.q = e.target.value; ctRefilter(); } if (e.target.id === "ct-title-q") { ctTitleQ = e.target.value; ctTitleShown = 100; renderContacts(); const el = $("ct-title-q"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } });
document.addEventListener("change", e => {
  const id = e.target.id, m = { "ct-section": "section", "ct-status": "status", "ct-reason": "reason", "ct-role": "role", "ct-source": "source", "ct-lifecycle": "lifecycle", "ct-dq": "dq" }[id];
  if (m) { ctF[m] = e.target.value; ctRefilter(); return; }
  if (e.target.id === "ct-title-f") { ctTitleF = e.target.value; ctTitleShown = 100; renderContacts(); return; }
  if (e.target.classList && e.target.classList.contains("ct-bounce-set")) { ctRules.bounceHold = [...document.querySelectorAll(".ct-bounce-set:checked")].map(x => x.value); ctRulesChanged(); return; }
  if (e.target.classList && e.target.classList.contains("ct-nbs")) { ctSaveNbSettings(e.target); return; }
  if (e.target.id === "ct-owners") { ctRules.owners = e.target.value.split(/[\s,;]+/).filter(Boolean); ctRulesChanged(); return; }
  if (e.target.classList.contains("ct-rule-set")) { const k = e.target.dataset.id; if (k.startsWith("dq:")) ctRules.dq[k.slice(3)] = e.target.checked; else if (k === "likely") ctRules.likely = e.target.checked; else if (k === "strictValid") ctRules.strictValid = e.target.checked; else ctRules.suppression[k] = e.target.checked; ctRulesChanged(); }
});
document.addEventListener("click", e => {
  const t = e.target;
  const o = t.closest("a.ct-open"); if (o) { e.preventDefault(); const p = byOds.get(o.dataset.ods); if (p) openDrawer(p); return; }   // opens the profile in the side drawer, so the page and your place stay put

  if (t.closest("#ct-make-aud")) { ctMakeAudience(); return; }
  const ts = t.closest(".ct-title-set"); if (ts) { ctRules.titleModes = { ...(ctRules.titleModes || {}), [ts.dataset.t.toLowerCase()]: ts.dataset.m }; ctRulesChanged(); return; }
  if (t.closest("#ct-title-more")) { ctTitleShown += 200; renderContacts(); return; }
  const md = t.closest(".ct-mode"); if (md) { ctMode = md.dataset.m; ctShown = 100; ctLoadPage(); return; }
  const rs = t.closest(".ct-role-set"); if (rs) { ctRules.roles[rs.dataset.id] = rs.dataset.m; ctRulesChanged(); return; }
  if (t.closest("#ct-more-btn")) { ctMoreOpen = !ctMoreOpen; renderContacts(); return; }
  if (t.closest("#ct-clear")) { ctF = { ...ctF, section: "", status: "", reason: "", role: "", source: "", lifecycle: "", dq: "" }; ctShown = 100; ctLoadPage(); return; }
  if (ctMoreOpen && !t.closest("#ct-more")) { ctMoreOpen = false; renderContacts(); }
  if (t.closest("#ct-save")) { ctSave(); return; }
  if (t.closest("#ct-nb-push")) { ctNbPush(t.closest("#ct-nb-push")); return; }
  if (t.closest("#ct-reset")) { if (confirm("Reset job roles and suppression rules to the defaults?")) { ctSetRules(null); ctRulesChanged(); } return; }
  if (t.closest(".ct-more")) { ctLoadMore(); return; }
  if (t.closest("#ct-csv")) { ctExport(ctQueryFilters(), ctPick && ctPick.size ? ctPick : null, "atlas-eligible-contacts.csv", ctPick ? null : ctOff); return; }
  if (t.closest("#ct-pick-clear")) { ctPick = new Set(); ctOff = new Set(); ctEditing = null; ctKeepScroll(); return; }
  if (t.closest("#ct-seg-save")) { const name = (prompt("Name this segment") || "").trim(); if (name) { ctSegments.push({ id: "s" + Date.now().toString(36), name, filters: { ...ctF }, ...(!ctPick && ctOff.size ? { exclude: [...ctOff] } : {}), ...(ctPick && ctPick.size ? { members: [...ctPick] } : {}) }); ctSaveSegments(); setCtSub("segments"); } return; }
  if (t.closest("#ct-seg-update")) { const s = ctSegments.find(x => x.id === ctEditing); if (s) { s.filters = { ...ctF }; if (ctPick && ctPick.size) s.members = [...ctPick]; else delete s.members; if (!ctPick && ctOff.size) s.exclude = [...ctOff]; else delete s.exclude; ctSaveSegments(); ctEditing = null; ctPick = new Set(); ctOff = new Set(); setCtSub("segments"); } return; }
  const sg = t.closest(".ct-seg-open, .ct-seg-csv, .ct-seg-del"); if (sg) {
    const s = ctSegments.find(x => x.id === sg.dataset.id); if (!s) return;
    if (sg.classList.contains("ct-seg-open")) { ctF = { q: "", section: "", status: "", role: "", source: "", reason: "", lifecycle: "", ...s.filters }; ctPick = s.members ? new Set(s.members) : null; ctOff = new Set(s.exclude || []); ctEditing = s.id; ctTabReady.contacts = false; setCtSub("contacts"); }   // opening a segment lets you tick or untick who is in it, then Update
    else if (sg.classList.contains("ct-seg-csv")) { ctExport({ q: "", section: "", status: "", role: "", source: "", reason: "", lifecycle: "", ...s.filters }, s.members ? new Set(s.members) : null, "atlas-segment-" + s.name.replace(/\W+/g, "-").toLowerCase() + ".csv", new Set(s.exclude || [])); }
    else if (confirm(`Delete the segment “${s.name}”?`)) { ctSegments = ctSegments.filter(x => x.id !== s.id); ctSaveSegments(); renderContacts(); }
  }
});

// Re-engagement > "Create audience from…": a custom audience (the existing Audiences feature) holding the eligible contacts now in view, so they can be approved and enrolled in a sequence there.
// The audience keeps the contact ids; its practices are the ones those contacts belong to. Customers and held-back contacts are not included.
async function ctMakeAudience() {
  let d; try { d = await ctMatchIds(ctPick && ctPick.size ? { urns: [...ctPick] } : { ...ctQueryFilters(), exclude: ctPick ? [] : [...ctOff] }); } catch (e) { alert("Could not list the contacts: " + (e.message || e)); return; }
  const ids = (d.hubspot_ids || []).map(String), ods = d.ods || [];
  const why = ctF.dq && ctF.dq !== "any" ? ctDqLabel(ctF.dq.replace(/^lost:/, "")) : "all reasons";
  if (!ids.length) { audModal("Create audience", '<p class="text-sm text-slate-600">No eligible contacts in HubSpot are showing. Clear the filters, or check Settings for which reasons are switched on.</p>', null); return; }
  audModal("Create audience", `<label class="block text-xs font-semibold text-slate-600">Name<input type="text" id="aud-name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="${esc("Re-engagement: " + why + " " + new Date().toISOString().slice(0, 10))}" maxlength="80"></label>
    <p class="mt-3 text-sm"><b>${ids.length.toLocaleString()}</b> eligible contact${ids.length === 1 ? "" : "s"} at <b>${ods.length.toLocaleString()}</b> practice${ods.length === 1 ? "" : "s"}.</p><p class="mt-1 text-xs text-slate-500">This is a snapshot of who is eligible now. Open it in Audiences to tick, approve and enrol them in a sequence; the usual checks (opt-out, bounce, customer) run again then.</p>`,
    async () => { const name = $("aud-name").value.trim(); if (!name) throw new Error("Give the audience a name."); const a = await audCreate(name, { criteria: null, pinned: ods, contacts: ids, summary: "Re-engagement: " + why }); audDone(`Saved “${name}” with ${ids.length.toLocaleString()} contacts.`, a); $("aud-open-it").onclick = () => audOpenIt(a); }, "Create");
}

// Ticking a box: the first tick turns the filters' result into an explicit set (everything matching starts ticked), then one contact is added or taken out.
const ctKeepScroll = () => { const y = window.scrollY; renderContacts(); window.scrollTo(0, y); };
document.addEventListener("change", e => {
  const t = e.target;
  if (t.classList && t.classList.contains("ct-pick")) { const u = Number(t.dataset.u), on = t.checked; if (ctPick) on ? ctPick.add(u) : ctPick.delete(u); else on ? ctOff.delete(u) : ctOff.add(u); ctKeepScroll(); return; }   // instant: nothing is fetched to tick a box
  if (t.id === "ct-pick-all") { if (t.checked) { ctPick = null; ctOff = new Set(); } else { ctPick = new Set(); ctOff = new Set(); } ctKeepScroll(); }
});
