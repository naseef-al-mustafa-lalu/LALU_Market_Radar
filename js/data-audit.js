// Data > HubSpot audit: the mismatch list built by the HubSpot sync. Loaded after data-uploads.js.
/* ---------- Data > HubSpot audit: HubSpot companies that do not match the NHS practice list (rebuilt by every HubSpot sync) ---------- */
const AUDIT_ISSUES = {
  closed_practice: { label: "Closed or merged practice", tone: "bg-rose-100 text-rose-800", help: "The NHS shows this practice as closed or merged, but HubSpot still has a company for it." },
  name_mismatch: { label: "Name differs", tone: "bg-amber-100 text-amber-800", help: "Same ODS code, but the HubSpot company name and the NHS practice name look like different places. One of them is probably on the wrong code." },
  duplicate_code: { label: "Code on several companies", tone: "bg-violet-100 text-violet-800", help: "More than one HubSpot company carries the same GP ODS Code. Merge or correct them." },
  unknown_code: { label: "Not a GP practice code", tone: "bg-slate-200 text-slate-700", help: "The code is not a GP practice in the NHS list (a typo, a PCN or hospital code, or a practice that no longer exists)." },
  pcn_no_code: { label: "PCN record has no code", group: "net", tone: "bg-amber-100 text-amber-800", help: "A HubSpot PCN record with no ODS code cannot be linked to the NHS PCN. Where one NHS PCN has the same name the suggested code is shown. Until it has a code, the sync will not create a second record for that PCN." },
  pcn_duplicate: { label: "PCN code on several records", group: "net", tone: "bg-violet-100 text-violet-800", help: "More than one HubSpot PCN record carries the same code. Merge them." },
  pcn_unknown_code: { label: "PCN code not in NHS list", group: "net", tone: "bg-slate-200 text-slate-700", help: "The code is not in the NHS PCN list: a typo, or a PCN that no longer exists." },
  pcn_name_mismatch: { label: "PCN name differs", group: "net", tone: "bg-amber-100 text-amber-800", help: "Same code, but the HubSpot PCN name and the NHS name look different." },
  pcn_association: { label: "Practice on another PCN too", group: "net", tone: "bg-rose-100 text-rose-800", help: "This practice's company is associated with a PCN record other than its own NHS PCN. The sync only adds associations, so the wrong one stays until someone removes it in HubSpot." },
  icb_issue: { label: "ICB records", group: "net", tone: "bg-sky-100 text-sky-800", help: "An ICB record with no ODS code, or two records sharing the same code or name. Atlas matches ICBs by name, so duplicates make the match unreliable." },
};
const AUDIT_OBJECT = { company: "0-2", pcn: "2-203659326", icb: "2-203659324" };
let auditRows = [], auditIssue = "all", auditQuery = "", auditShown = 100;
async function renderAudit() {
  const box = $("d-audit"); if (!box.innerHTML) box.innerHTML = '<p class="text-sm text-slate-500">Loading…</p>';
  try { auditRows = await fetchAll("hubspot_audit", "*", "id"); } catch (e) { box.innerHTML = `<p class="text-sm text-rose-700">${esc(e.message || e)}</p>`; return; }
  const when = auditRows.reduce((m, r) => (r.found_at > m ? r.found_at : m), "");
  const count = k => auditRows.filter(r => r.issue === k).length;
  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-bold">HubSpot audit <span class="text-xs font-normal text-slate-500">HubSpot companies that do not match the NHS practice list${when ? ", as of the sync " + hsAgo(when) : ""}</span></h2>
      <div class="flex items-center gap-2"><input id="au-q" value="${esc(auditQuery)}" placeholder="Search name or code" class="rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="Search the audit"><button id="au-csv" class="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold hover:bg-slate-50">Download CSV</button></div></div>
    <div class="mt-3"><button data-au="all" class="rounded-xl border px-3 py-2 text-left ${auditIssue === "all" ? "border-slate-500 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}"><span class="text-xs uppercase tracking-wider text-slate-500">All issues</span> <span class="ml-2 text-lg font-bold">${auditRows.length.toLocaleString()}</span></button></div>
    ${[["Practice companies", null], ["PCN, ICB and association records", "net"]].map(([title, grp]) => `<div class="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">${title}</div>
      <div class="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">${Object.entries(AUDIT_ISSUES).filter(([, v]) => (v.group || null) === grp).map(([k, v]) => `<button data-au="${k}" class="rounded-xl border p-3 text-left ${auditIssue === k ? "border-slate-500 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}"><div class="text-xs leading-tight text-slate-500">${esc(v.label)}</div><div class="text-xl font-bold">${count(k).toLocaleString()}</div></button>`).join("")}</div>`).join("")}
    <p id="au-help" class="mt-2 text-xs text-slate-500">${auditIssue === "all" ? "Pick a tile to see what each issue means." : esc(AUDIT_ISSUES[auditIssue].help)}</p>
    <div id="au-list" class="mt-2"></div>`;
  box.querySelectorAll("[data-au]").forEach(b => b.onclick = () => { auditIssue = b.dataset.au; auditShown = 100; renderAudit(); });
  $("au-q").oninput = e => { auditQuery = e.target.value; auditShown = 100; auditList(); };
  $("au-csv").onclick = () => downloadCsv("Lalu_HubSpot_audit", ["Issue", "HubSpot company", "HubSpot company id", "ODS code", "NHS name", "NHS status", "Detail", "HubSpot object"], auditFiltered().map(r => [AUDIT_ISSUES[r.issue]?.label || r.issue, r.company_name, r.company_id, r.ods_code, r.nhs_name, r.nhs_status, r.detail, r.object_type || "company"]));
  auditList();
}
function auditFiltered() {
  const q = auditQuery.trim().toLowerCase();
  return auditRows.filter(r => (auditIssue === "all" || r.issue === auditIssue) && (!q || [r.company_name, r.ods_code, r.nhs_name].some(v => (v || "").toLowerCase().includes(q))))
    .sort((a, b) => Object.keys(AUDIT_ISSUES).indexOf(a.issue) - Object.keys(AUDIT_ISSUES).indexOf(b.issue) || (a.company_name || "").localeCompare(b.company_name || ""));
}
function auditList() {
  const box = $("au-list"); if (!box) return;
  if (!auditRows.length) { box.innerHTML = '<p class="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No mismatches recorded. The list is rebuilt by each HubSpot sync (daily 08:30 UTC, or Run sync now on Overview). If it has never run since this tab was added, run it once.</p>'; return; }
  const rows = auditFiltered();
  box.innerHTML = rows.slice(0, auditShown).map(r => { const iss = AUDIT_ISSUES[r.issue] || { label: r.issue, tone: "bg-slate-100 text-slate-700" }, p = practices.find(x => x.ods_code === r.ods_code);
    return `<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2 first:border-0"><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${iss.tone}">${esc(iss.label)}</span>${p && p.hubspot_customer ? chip("Customer", "bg-emerald-100 text-emerald-800") : ""}
        <span class="font-mono text-xs text-slate-500">${esc(r.ods_code || "")}</span></div>
      <div class="mt-0.5 text-sm"><span class="text-xs text-slate-500">HubSpot${r.object_type === "pcn" ? " PCN" : r.object_type === "icb" ? " ICB" : ""}</span> <b>${esc(r.company_name || "(no name)")}</b>${r.nhs_name ? ` <span class="ml-2 text-xs text-slate-500">NHS</span> <b>${esc(r.nhs_name)}</b>` : ""}</div><div class="text-xs text-slate-500">${esc(r.detail || "")}</div></div>
      <div class="flex shrink-0 items-center gap-3 text-xs">${hsLink(AUDIT_OBJECT[r.object_type] || "0-2", r.company_id, r.object_type === "pcn" ? "PCN record" : r.object_type === "icb" ? "ICB record" : "Company")}${p && (r.object_type || "company") === "company" ? `<button data-au-open="${esc(p.ods_code)}" class="font-semibold text-blue-600 hover:underline">Open practice</button>` : ""}</div></div>`; }).join("")
    || '<p class="text-sm text-slate-500">Nothing matches.</p>';
  if (rows.length > auditShown) box.insertAdjacentHTML("beforeend", `<div class="pt-2 text-center"><button id="au-more" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Show more (${(rows.length - auditShown).toLocaleString()} left)</button></div>`);
  const more = $("au-more"); if (more) more.onclick = () => { auditShown += 200; auditList(); };
  box.querySelectorAll("[data-au-open]").forEach(b => b.onclick = () => { const p = practices.find(x => x.ods_code === b.dataset.auOpen); if (p) { showTab("practices"); openDrawer(p); } });
}
