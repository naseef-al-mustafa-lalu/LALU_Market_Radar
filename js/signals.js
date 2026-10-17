// Signals: signal settings, job matches and the feed.
/* ---------- signal types: catalogue and on/off ---------- */
let sigSettings = [], sigSub = "feed";
async function loadSignalSettings() {
  const { data } = await db.from("signal_settings").select("*").order("sort_order");
  sigSettings = data || []; renderSignalTypes();
}
function setSigSub(which) {
  sigSub = which;
  $("sig-feed").classList.toggle("hidden", which !== "feed"); $("sig-jobs").classList.toggle("hidden", which !== "jobs"); $("sig-mergers").classList.toggle("hidden", which !== "mergers");
  $("s-type").classList.toggle("hidden", which !== "feed"); $("sig-settings-link").classList.toggle("hidden", which !== "feed"); $("s-search").classList.toggle("hidden", which !== "feed"); $("s-count").classList.toggle("hidden", which !== "feed"); $("s-status").classList.toggle("hidden", which !== "feed"); $("s-export").classList.toggle("hidden", which !== "feed");
  $("sig-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.s === which ? "bg-white shadow-sm" : "text-slate-500"));
  stateToUrl();
}
$("sig-sub").querySelectorAll("button").forEach(b => b.onclick = () => setSigSub(b.dataset.s));
$("sig-settings-link").onclick = () => { showTab("data"); setDataSub("signals"); };
function renderSignalTypes() {
  const cut = Date.now() - 30 * 864e5, tot = new Map(), rec = new Map();
  for (const s of signals) { tot.set(s.trigger_type, (tot.get(s.trigger_type) || 0) + 1); if (new Date(s.detected_at) > cut) rec.set(s.trigger_type, (rec.get(s.trigger_type) || 0) + 1); }
  $("sig-types-rows").innerHTML = sigSettings.map(t => `<tr class="align-top ${t.enabled ? "" : "opacity-60"}"><td class="py-2 pr-3"><div class="font-semibold leading-tight">${esc(t.label)}</div><div class="font-mono text-xs text-slate-500">${esc(t.trigger_type)}</div></td>
    <td class="pr-3 text-xs text-slate-700">${esc(t.source)}</td><td class="pr-3 text-xs text-slate-600">${esc(t.rule)}</td><td class="pr-3 text-xs text-slate-500">${esc(t.why)}</td>
    <td class="pr-3 text-right font-mono">${rec.get(t.trigger_type) || 0}</td><td class="pr-3 text-right font-mono">${tot.get(t.trigger_type) || 0}</td>
    <td class="text-center"><input type="checkbox" class="h-4 w-4 accent-blue-600" data-t="${esc(t.trigger_type)}" ${t.enabled ? "checked" : ""} aria-label="Enable ${esc(t.label)}"></td></tr>`).join("") || '<tr><td colspan="7" class="py-4 text-slate-500 italic">No signal catalogue found.</td></tr>';
}
$("sig-types-rows").addEventListener("change", async e => {
  const cb = e.target.closest("input[data-t]"); if (!cb) return;
  const row = sigSettings.find(t => t.trigger_type === cb.dataset.t), msg = $("sig-types-msg"); cb.disabled = true;
  const { error } = await db.from("signal_settings").update({ enabled: cb.checked, updated_at: new Date().toISOString() }).eq("trigger_type", row.trigger_type);
  cb.disabled = false;
  if (error) { cb.checked = row.enabled; msg.textContent = "Could not save: " + (error.message || error); return; }
  row.enabled = cb.checked; msg.textContent = `${row.label} ${row.enabled ? "enabled" : "disabled"}.`; renderSignalTypes();
});
/* ---------- job matches: link NHS Jobs employers to practices (exact or confirmed, never guessed) ---------- */
let jobEmployers = [], jobAdverts = [], jmShown = 0, jmList = [];
async function loadJobs() {
  const [e, a] = await Promise.all([fetchAll("job_employers", "*", "employer_code"), fetchAll("job_adverts", "*", "advert_id")]);
  jobEmployers = e; jobAdverts = a; fillNetList(); renderJobMatches(); renderSignals();
  const withAdv = new Set(a.map(j => j.employer_code)), n = e.filter(x => x.match_status === "review" && withAdv.has(x.employer_code)).length;
  $("jobs-badge").textContent = n; $("jobs-badge").classList.toggle("hidden", !n);
}
function fillNetList() {
  $("jm-netlist").innerHTML = networks.filter(n => ["pcn", "federation", "group"].includes(n.kind)).sort((x, y) => x.name.localeCompare(y.name)).map(n => `<option value="${esc(n.name)} (${esc(n.kind)})">`).join("");
}
function renderJobMatches() {
  const adv = new Map();
  const LABEL = { review: "To review", network: "PCNs / federations (not linked)", auto: "Auto-matched", confirmed: "Confirmed", rejected: "Rejected" };
  const cur = $("jm-status").value || "auto";   // opens on the auto-matched employers
  jobAdverts.forEach(j => (adv.get(j.employer_code) || adv.set(j.employer_code, []).get(j.employer_code)).push(j));
  // Employers with no current advert have nothing to act on, so only confirmed / rejected ones (which can be reopened) show without one.
  const relevant = e => adv.has(e.employer_code) || e.match_status === "confirmed" || e.match_status === "rejected", count = k => jobEmployers.filter(e => e.match_status === k && relevant(e)).length;
  $("jm-status").innerHTML = Object.entries(LABEL).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v} (${count(k).toLocaleString()})</option>`).join("");
  const st = $("jm-status").value, q = $("jm-search").value.trim().toLowerCase();
  jmList = jobEmployers.filter(e => e.match_status === st && (!q || e.employer_name.toLowerCase().includes(q)) && relevant(e))
    .sort((a, b) => (adv.get(b.employer_code) || []).length - (adv.get(a.employer_code) || []).length || a.employer_name.localeCompare(b.employer_name));
  jmShown = 0; $("jm-rows").innerHTML = ""; $("jm-rows").dataset.adv = ""; window.__adv = adv; renderMoreJobMatches();
  $("jm-count").textContent = `${jmList.length.toLocaleString()} employers with a report / records advert`;
}
function renderMoreJobMatches() {
  const slice = jmList.slice(jmShown, jmShown + 50); jmShown += slice.length; const adv = window.__adv;
  $("jm-rows").insertAdjacentHTML("beforeend", slice.map(e => {
    const ads = adv.get(e.employer_code) || [], cur = e.ods_code ? byOds.get(e.ods_code) : null;
    const linkedNet = e.org_id ? networks.find(n => n.id === e.org_id) : null; const opts = (e.candidates || []).map(c => `<option value="${esc(c.ods_code)}" ${c.ods_code === e.ods_code ? "selected" : ""}>${esc(c.name)} (${esc(c.ods_code)})</option>`).join("");
    return `<tr class="align-top" data-c="${esc(e.employer_code)}"><td class="py-2 pr-3"><div class="font-semibold leading-tight">${esc(e.employer_name)}</div><div class="font-mono text-xs text-slate-500">${esc(e.employer_code)} · ${esc((e.postcodes || []).slice(0, 3).join(", "))}</div></td>
      <td class="pr-3 text-xs">${ads.length ? ads.slice(0, 3).map(j => `<div><a class="text-blue-600 hover:underline" target="_blank" rel="noopener" href="${esc(j.url)}">${esc(j.title)}</a> <span class="text-slate-500">${esc(fmtDate(j.post_date))}</span></div>`).join("") + (ads.length > 3 ? `<div class="text-slate-500">+${ads.length - 3} more</div>` : "") : '<span class="text-slate-300">none</span>'}</td>
      <td class="pr-3 text-xs">${e.match_status === "confirmed" || e.match_status === "auto" ? `<b>${esc(cur ? cur.practice_name : linkedNet ? linkedNet.name : (e.ods_code || e.org_id || ""))}</b> <span class="text-slate-500">${esc(e.ods_code || (linkedNet ? linkedNet.kind : ""))}</span>` :
        `<select class="jm-pick border border-slate-300 rounded px-2 py-1 text-xs max-w-[18rem]"><option value="">${opts ? "Choose the practice…" : "No practice at this postcode"}</option>${opts}</select><div class="mt-1 flex gap-1"><input class="jm-ods border border-slate-300 rounded px-2 py-0.5 text-xs w-24" placeholder="or ODS code"><input list="jm-netlist" class="jm-net border border-slate-300 rounded px-2 py-0.5 text-xs w-44" placeholder="or PCN / federation / group"></div>`}</td>
      <td class="whitespace-nowrap text-xs">${e.match_status === "confirmed" || e.match_status === "auto" || e.match_status === "rejected" ? `<button data-a="reopen" class="jm-act text-slate-500 hover:underline">Reopen</button>` :
        `<button data-a="confirm" class="jm-act bg-blue-600 text-white rounded px-2 py-1 mr-1">Confirm</button><button data-a="reject" class="jm-act text-slate-500 hover:underline">Not a practice</button>`}</td></tr>`; }).join(""));
  $("jm-more").classList.toggle("hidden", jmShown >= jmList.length);
  if (!jmList.length) $("jm-rows").innerHTML = '<tr><td colspan="4" class="py-4 text-slate-500 italic">Nothing here.</td></tr>';
}
$("jm-rows").addEventListener("click", async ev => {
  const b = ev.target.closest(".jm-act"); if (!b) return;
  const tr = b.closest("tr"), code = tr.dataset.c, action = b.dataset.a, msg = $("jm-msg");
  let ods = null, org = null;
  if (action === "confirm") {
    const typed = tr.querySelector(".jm-net").value.trim(), net = typed && networks.find(n => `${n.name} (${n.kind})` === typed);
    if (typed && !net) { msg.textContent = "Pick the network from the list."; return; }
    if (net) org = net.id; else ods = (tr.querySelector(".jm-ods").value.trim() || tr.querySelector(".jm-pick").value).toUpperCase();
    if (!org && !/^[A-Z][0-9]{5}$/.test(ods || "")) { msg.textContent = "Choose a practice, type its ODS code, or pick a network first."; return; }
  }
  b.disabled = true;
  const { error } = await db.rpc("link_job_employer", { p_code: code, p_ods: ods, p_org: org, p_action: action });
  if (error) { msg.textContent = "Could not save: " + (error.message || error); b.disabled = false; return; }
  msg.textContent = action === "confirm" ? "Linked. Its existing signals have moved to that practice / network." : action === "reject" ? "Marked as not a practice." : "Reopened.";
  await loadJobs(); await loadSignals();
});
$("jm-status").addEventListener("change", renderJobMatches); $("jm-search").addEventListener("input", renderJobMatches); $("jm-more").addEventListener("click", renderMoreJobMatches);
/* ---------- signals ---------- */
function renderSignals() {
  const types = [...new Set(signals.map(s => s.trigger_type))].sort(), cur = $("s-type").value;
  $("s-type").innerHTML = '<option value="">All signal types</option>' + types.map(t => `<option value="${t}" ${t === cur ? "selected" : ""}>${esc(t.replaceAll("_", " ").toLowerCase())}</option>`).join("");
  const q = $("s-search").value.trim().toLowerCase(), ty = $("s-type").value, st = $("s-status").value;
  sigList = signals.filter(s => (!ty || s.trigger_type === ty) && (st === "all" || (st === "open" ? ["new", "in_progress"].includes(s.status || "new") : (s.status || "new") === st)) && (!q || [s.headline, s.description, s.ods_code, sigTarget(s).label].some(v => (v || "").toLowerCase().includes(q))));
  sigShown = 0; $("s-rows").innerHTML = ""; renderMoreSignals();
  $("s-count").textContent = `${sigList.length.toLocaleString()} signals`;
}
const linkIcon = '<svg viewBox="0 0 20 20" class="inline w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 3h6v6M17 3l-8 8M8 5H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3"/></svg>';
const sigLink = s => s.url && /^https?:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-blue-600 hover:text-blue-800" title="Open source: ${esc(s.url)}" aria-label="Open source" onclick="event.stopPropagation()">${linkIcon}</a>` : "";
const SIG_STATUS = { new: "New", in_progress: "In progress", done: "Done", dismissed: "Dismissed" };
const SIG_STATUS_CLS = { new: "bg-white", in_progress: "bg-blue-50", done: "bg-emerald-50", dismissed: "bg-slate-100 text-slate-500" };
async function saveSignal(id, patch) {
  const s = signals.find(x => String(x.id) === String(id)); if (!s) return;
  const before = { status: s.status, note: s.note, handled_at: s.handled_at };
  Object.assign(s, patch);
  const { error } = await db.from("sales_triggers").update(patch).eq("id", id);
  if (error) { Object.assign(s, before); $("s-count").textContent = "Could not save: " + (error.message || error); renderSignals(); return false; }
  indexSignals(); return true;
}
const sigTarget = s => {
  if (s.ods_code && byOds.get(s.ods_code)) { const p = byOds.get(s.ods_code); return { kind: "practice", label: p.practice_name, sub: s.ods_code, p }; }
  if (s.org_id) { const n = networks.find(x => x.id === s.org_id); return { kind: "network", label: n ? n.name : "Network", sub: n ? ({ pcn: "PCN / cluster", icb: "ICB", group: "Provider group", federation: "Federation" }[n.kind] || n.kind) : "", n }; }
  if (s.employer_code) { const e = jobEmployers.find(x => x.employer_code === s.employer_code); return { kind: "unlinked", label: e ? e.employer_name : s.employer_code, sub: "unlinked employer: link it in Job matches", e }; }
  return { kind: "none", label: s.ods_code || "", sub: s.ods_code || "" };
};
function renderMoreSignals() {
  const slice = sigList.slice(sigShown, sigShown + PAGE); sigShown += slice.length;
  const frag = document.createDocumentFragment();
  for (const s of slice) {
    const t = sigTarget(s), tr = document.createElement("tr"); tr.className = "hover:bg-blue-50/50 cursor-pointer align-top"; tr.tabIndex = 0; tr.setAttribute("role", "button");
    tr.innerHTML = `<td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-slate-500">${esc(fmtDate(s.detected_at))}</td>
      <td class="px-3 py-2 whitespace-nowrap">${chip(s.trigger_type.replaceAll("_", " ").toLowerCase(), HOT.includes(s.trigger_type) ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-700")}</td>
      <td class="px-3 py-2"><div class="font-semibold leading-tight">${esc(t.label)}${t.kind === "unlinked" ? " " + chip("unlinked", "bg-amber-100 text-amber-800") : t.kind === "network" ? " " + chip("network", "bg-indigo-100 text-indigo-800") : ""}</div><div class="text-xs text-slate-500 ${t.kind === "practice" ? "font-mono" : ""}">${esc(t.sub)}</div></td>
      <td class="px-3 py-2"><div class="font-medium">${esc(s.headline)}</div><div class="text-xs text-slate-500">${esc(s.description)}</div></td>
      <td class="px-3 py-2 text-xs text-blue-800">${esc(s.action || "")}</td>
      <td class="px-3 py-2 sg-ctl" data-id="${esc(s.id)}"><select class="sg-status border border-slate-300 rounded px-1.5 py-1 text-xs w-full ${SIG_STATUS_CLS[s.status || "new"]}" aria-label="Status of ${esc(s.headline)}">${Object.entries(SIG_STATUS).map(([k, v]) => `<option value="${k}" ${k === (s.status || "new") ? "selected" : ""}>${v}</option>`).join("")}</select>
        <input class="sg-note mt-1 border border-slate-200 rounded px-1.5 py-1 text-xs w-full" placeholder="Add a note…" value="${esc(s.note || "")}" maxlength="500" aria-label="Note for ${esc(s.headline)}"></td>
      <td class="px-3 py-2 text-center">${sigLink(s)}</td>`;
    tr.onclick = ev => {
      if (ev.target.closest(".sg-ctl")) return;
      if (t.kind === "practice") { clearFilters(); showTab("practices"); $("f-search").value = t.p.ods_code; applyFilters(); openDrawer(t.p); }
      else if (t.kind === "network" && t.n) { netKind = t.n.kind; showTab("networks"); renderNetworks(); openNetworkProfile(t.n); }
      else if (t.kind === "unlinked") { setSigSub("jobs"); $("jm-status").value = t.e ? t.e.match_status : "review"; $("jm-search").value = t.label; renderJobMatches(); }
    };
    frag.appendChild(tr);
  }
  $("s-rows").appendChild(frag);
  $("s-more").classList.toggle("hidden", sigShown >= sigList.length);
  if (!sigList.length) $("s-rows").innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-500 italic">No signals match. They appear when something changes between daily runs (closures, list growth, CQC changes, takeovers…).</td></tr>';
}
$("s-rows").addEventListener("change", async e => {
  const td = e.target.closest(".sg-ctl"); if (!td) return;
  if (e.target.matches(".sg-status")) { const st = e.target.value; await saveSignal(td.dataset.id, { status: st, handled_at: st === "new" ? null : new Date().toISOString() }); renderSignals(); }
  else if (e.target.matches(".sg-note")) await saveSignal(td.dataset.id, { note: e.target.value.trim() || null });
});
["s-type", "s-status", "s-search"].forEach(id => $(id).addEventListener(id === "s-search" ? "input" : "change", renderSignals));
$("s-more").addEventListener("click", renderMoreSignals);
