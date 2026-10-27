// Keeping HubSpot's company properties in step with the NHS-derived values in Atlas: Org Type, Operating status and Website URL.
const HS_ORG_LABEL = { practice: "Practice", branch_site: "Branch (Site)", pcn: "PCN", "sub-icb": "Sub-ICB", icb: "ICB", group: "Group", federation: "Federation" }, HS_OPSTATUS_LABEL = { active: "Active", closed: "Closed", merged: "Merged" };
const atlasOpStatus = p => p.merged_into ? "merged" : (isClosed(p) || p.status !== "Active") ? "closed" : "active";
const hostOf = u => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const alignRead = () => practices.some(p => p.hubspot_org_type || p.hubspot_operating_status || p.hubspot_website);      // false until the sync has read these from HubSpot once

function alignOf(p) {      // null when the practice is not in HubSpot
  if (!p.hubspot_company_id) return null;
  const org = { atlas: "practice", hs: String(p.hubspot_org_type || "").toLowerCase() }, st = { atlas: atlasOpStatus(p), hs: String(p.hubspot_operating_status || "").toLowerCase() };
  const web = p.website || "", hw = p.hubspot_website || "", wstate = !web ? "none" : !hw ? "missing" : hostOf(web) === hostOf(hw) ? "ok" : "differs";
  return { org: { ...org, ok: org.hs === org.atlas }, status: { ...st, ok: st.hs === st.atlas }, web: { atlas: web, hs: hw, state: wstate } };
}
const ALIGN_FLAG = chip("Needs updating", "bg-amber-100 text-amber-800");
function alignHsRows(p) {      // inside the profile's HubSpot section: HubSpot's own values, flagged when they do not match the NHS data (which sits in Practice details)
  const a = alignOf(p); if (!a || !alignRead()) return "";
  const val = (v, labels) => v ? esc(labels[v] || v) : '<span class="text-slate-500">Blank</span>';
  return kv("Org Type", val(a.org.hs, HS_ORG_LABEL) + (a.org.ok ? "" : " " + ALIGN_FLAG)) + kv("Operating status", val(a.status.hs, HS_OPSTATUS_LABEL) + (a.status.ok ? "" : " " + ALIGN_FLAG)) +
    (a.web.hs ? kv("Website", `<span class="break-all">${esc(a.web.hs)}</span>`) : a.web.atlas ? kv("Website", '<span class="text-slate-500">Blank</span> ' + ALIGN_FLAG) : "");
}
function alignPlan() {
  const rows = practices.filter(p => p.hubspot_company_id), read = alignRead(), out = { rows, read, org: 0, status: 0, webMissing: 0, webDiffers: 0, todo: [] };
  for (const p of rows) {
    const a = alignOf(p); if (!a.org.ok) out.org++; if (!a.status.ok) out.status++; if (a.web.state === "missing") out.webMissing++; if (a.web.state === "differs") out.webDiffers++;
    if (!read || !a.org.ok || !a.status.ok || a.web.state === "missing") out.todo.push([p, a]);
  }
  return out;
}
function alignCard() {
  const s = alignPlan(), n = x => x.toLocaleString();
  return `<div class="mt-4 rounded-lg border border-slate-200 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div><div class="text-sm font-bold">Alignment with NHS data</div><div class="text-xs text-slate-500">Org Type, Operating status and Website URL on the HubSpot company, against what Atlas knows from NHS data.</div></div>
    <button type="button" id="hsp-align" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Alignment import file</button></div>
    <div class="mt-2 text-sm">${s.read ? `<b>${n(s.org)}</b> Org Type differ · <b>${n(s.status)}</b> Operating status differ · <b>${n(s.webMissing)}</b> websites blank in HubSpot${s.webDiffers ? ` · ${n(s.webDiffers)} websites differ (not changed: HubSpot uses the website to identify companies)` : ""}`
      : "These have not been read from HubSpot yet. Run the sync once to compare them; the import file below lists every linked practice until then."}</div></div>`;
}
function alignDownload() {
  const s = alignPlan();
  downloadCsv("Lalu_HubSpot_Alignment", ["Record ID", "Company name", "GP ODS Code", "Org Type", "Operating status", "Website URL"],
    s.todo.map(([p, a]) => [p.hubspot_company_id, p.practice_name, p.ods_code, HS_ORG_LABEL[a.org.atlas], HS_OPSTATUS_LABEL[a.status.atlas], a.web.state === "missing" || (!s.read && a.web.atlas) ? a.web.atlas : ""]));
  return s.todo.length;
}
