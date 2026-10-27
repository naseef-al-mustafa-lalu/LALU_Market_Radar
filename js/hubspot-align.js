// Keeping HubSpot's company properties in step with the NHS-derived values in Atlas: Org Type, Operating status and Website URL.
const HS_ORG_LABEL = { practice: "Practice", branch_site: "Branch (Site)", pcn: "PCN", "sub-icb": "Sub-ICB", icb: "ICB", group: "Group", federation: "Federation" }, HS_OPSTATUS_LABEL = { active: "Active", closed: "Closed", merged: "Merged" };
const alignRead = () => practices.some(p => p.hubspot_org_type || p.hubspot_operating_status || p.hubspot_website);      // false until the sync has read these from HubSpot once
const normPc = v => String(v || "").replace(/\s+/g, "").toUpperCase(), hostOf = u => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const NAME_NOISE = new Set(["surgery", "medical", "centre", "center", "practice", "health", "group", "partners", "partnership", "doctors", "care", "general", "the", "and"]);
const nameKeys = n => String(n || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !NAME_NOISE.has(w));
// A closed code whose site goes on as an active branch of another practice (same postcode and name): HubSpot's company should take the branch's code, be a Branch (Site), and sit under that practice.
function siteMove(p) {
  if (!(p.merged_into || isClosed(p) || p.status !== "Active")) return null;
  const keys = nameKeys(p.practice_name), pc = normPc(p.postcode); if (!keys.length || !pc) return null;
  const br = branches.find(x => branchRes(x) === "branch" && x.practice_code && x.practice_code !== p.ods_code && normPc(x.postcode) === pc && nameKeys(x.branch_name).some(k => keys.includes(k)));
  const parent = br && byOds.get(br.practice_code); return br && parent ? { branch: br, parent } : null;
}
// What HubSpot should hold for a practice that has merged, or whose site continues as a branch: { mode: "merged" | "branch", parent, branch? }
function hsCase(p) {
  const par = p.merged_into && byOds.get(p.merged_into); if (par) return { mode: "merged", parent: par };
  const m = siteMove(p); return m ? { mode: "branch", parent: m.parent, branch: m.branch } : null;
}
const atlasOpStatus = p => { const c = hsCase(p); return c ? (c.mode === "merged" ? "merged" : "active") : (p.merged_into ? "merged" : (isClosed(p) || p.status !== "Active") ? "closed" : "active"); };
const atlasOrgType = p => { const c = hsCase(p); return c && c.mode === "branch" ? "branch_site" : "practice"; };

function alignOf(p) {      // null when the practice is not in HubSpot
  if (!p.hubspot_company_id) return null;
  const c = hsCase(p), org = { atlas: atlasOrgType(p), hs: String(p.hubspot_org_type || "").toLowerCase() }, st = { atlas: atlasOpStatus(p), hs: String(p.hubspot_operating_status || "").toLowerCase() };
  const web = p.website || "", hw = p.hubspot_website || "", wstate = !web ? "none" : !hw ? "missing" : hostOf(web) === hostOf(hw) ? "ok" : "differs";
  const link = c ? { parent: c.parent, expected: String(c.parent.hubspot_company_id || ""), hs: String(p.hubspot_parent_company_id || ""), ok: !!c.parent.hubspot_company_id && String(c.parent.hubspot_company_id) === String(p.hubspot_parent_company_id || "") } : null;
  const code = c && c.mode === "branch" ? { hs: p.ods_code, atlas: c.branch.branch_code, ok: false } : null;
  return { c, org: { ...org, ok: org.hs === org.atlas }, status: { ...st, ok: st.hs === st.atlas }, web: { atlas: web, hs: hw, state: wstate }, link, code };
}
const ALIGN_FLAG = chip("Needs updating", "bg-amber-100 text-amber-800");
const alignNeeds = a => !!a && (!a.org.ok || !a.status.ok || (a.link && !a.link.ok) || !!a.code);
function alignHsRows(p) {      // inside the profile's HubSpot section: HubSpot's own values, flagged when they do not match the NHS data (which sits in Practice details)
  const a = alignOf(p); if (!a || !alignRead()) return "";
  const val = (v, labels) => v ? esc(labels[v] || v) : '<span class="text-slate-500">Blank</span>';
  const rows = [];
  if (a.code) rows.push(kv("GP ODS Code", `<span class="font-mono">${esc(a.code.hs)}</span> ${ALIGN_FLAG} <span class="text-xs text-slate-400">site now ${esc(a.code.atlas)}</span>`));
  rows.push(kv("Org Type", val(a.org.hs, HS_ORG_LABEL) + (a.org.ok ? "" : " " + ALIGN_FLAG)), kv("Operating status", val(a.status.hs, HS_OPSTATUS_LABEL) + (a.status.ok ? "" : " " + ALIGN_FLAG)));
  if (a.link) rows.push(kv("Parent company", a.link.ok ? esc(a.link.parent.practice_name) : (a.link.hs ? '<span class="text-slate-600">A different company</span>' : '<span class="text-slate-500">Not linked</span>') + " " + ALIGN_FLAG + ` <span class="text-xs text-slate-400">${a.c.mode === "merged" ? "merged into " : "branch of "}${esc(a.link.parent.practice_name)}</span>`));
  const web = a.web.hs ? kv("Website", `<span class="break-all">${esc(a.web.hs)}</span>`) : a.web.atlas ? kv("Website", '<span class="text-slate-500">Blank</span> ' + ALIGN_FLAG) : "";
  const act = alignNeeds(a) && a.c ? `<div class="mt-1"><button type="button" class="hs-entity rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50" data-ods="${esc(p.ods_code)}">Update HubSpot…</button></div>` : "";
  return rows.join("") + web + act;
}
function alignPlan() {
  const rows = practices.filter(p => p.hubspot_company_id), read = alignRead(), out = { rows, read, org: 0, status: 0, webMissing: 0, webDiffers: 0, todo: [], cases: [] };
  for (const p of rows) {
    const a = alignOf(p); if (!a.org.ok) out.org++; if (!a.status.ok) out.status++; if (a.web.state === "missing") out.webMissing++; if (a.web.state === "differs") out.webDiffers++;
    if (a.c) { if (alignNeeds(a)) out.cases.push([p, a]); continue; }      // merged practices and moved sites are changed one by one from their profile, not in the file
    if (!read || !a.org.ok || !a.status.ok || a.web.state === "missing") out.todo.push([p, a]);
  }
  return out;
}
function alignCard() {
  const s = alignPlan(), n = x => x.toLocaleString();
  return `<div class="mt-4 rounded-lg border border-slate-200 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div><div class="text-sm font-bold">Alignment with NHS data</div><div class="text-xs text-slate-500">Org Type, Operating status and Website URL on the HubSpot company, against what Atlas knows from NHS data.</div></div>
    <div class="flex gap-2">${s.cases.length ? `<button type="button" id="hsp-align-cases" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">Merged and moved sites (${s.cases.length})</button>` : ""}<button type="button" id="hsp-align" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50">Alignment import file</button></div></div>
    <div class="mt-2 text-sm">${s.read ? `<b>${n(s.org)}</b> Org Type differ · <b>${n(s.status)}</b> Operating status differ · <b>${n(s.webMissing)}</b> websites blank in HubSpot${s.webDiffers ? ` · ${n(s.webDiffers)} websites differ (not changed: HubSpot uses the website to identify companies)` : ""}`
      : "These have not been read from HubSpot yet. Run the sync once to compare them; the import file below lists every linked practice until then."}</div>
    ${s.cases.length ? `<div class="mt-1 text-xs text-slate-500">${s.cases.length} merged practices or moved sites are kept out of the file: each needs its parent company linked, so they are updated one by one.</div>` : ""}</div>`;
}
function alignDownload() {
  const s = alignPlan();
  downloadCsv("Lalu_HubSpot_Alignment", ["Record ID", "Company name", "GP ODS Code", "Org Type", "Operating status", "Website URL"],
    s.todo.map(([p, a]) => [p.hubspot_company_id, p.practice_name, p.ods_code, HS_ORG_LABEL[a.org.atlas], HS_OPSTATUS_LABEL[a.status.atlas], a.web.state === "missing" || (!s.read && a.web.atlas) ? a.web.atlas : ""]));
  return s.todo.length;
}
// One merged practice or moved site: show exactly what will change in HubSpot, then do it (edge action entity_change).
function alignEntityOpen(p) {
  const a = alignOf(p), c = a && a.c; if (!c) return;
  const par = c.parent, row = (k, from, to) => `<div class="flex justify-between gap-3 border-t border-slate-100 py-1.5 text-sm"><span class="text-slate-500">${k}</span><span class="text-right"><span class="text-slate-400">${from}</span> → <b>${to}</b></span></div>`;
  const blank = v => v || "blank", lines = [];
  if (c.mode === "branch") lines.push(row("GP ODS Code", esc(p.ods_code), esc(c.branch.branch_code)));
  lines.push(row("Org Type", esc(HS_ORG_LABEL[a.org.hs] || blank(a.org.hs)), esc(HS_ORG_LABEL[a.org.atlas])), row("Operating status", esc(HS_OPSTATUS_LABEL[a.status.hs] || blank(a.status.hs)), esc(HS_OPSTATUS_LABEL[a.status.atlas])), row("Parent company", a.link.hs ? "another company" : "none", esc(par.practice_name) + " (" + esc(par.ods_code) + ")"));
  const why = c.mode === "merged" ? `${esc(p.practice_name)} merged into ${esc(par.practice_name)}. Its company stays in HubSpot, marked Merged, with ${esc(par.practice_name)} as its parent company.`
    : `${esc(p.practice_name)}'s code has closed but its site goes on as ${esc(c.branch.branch_name)} (${esc(c.branch.branch_code)}), a branch of ${esc(par.practice_name)}. The company takes the branch's code and becomes a Branch (Site) under ${esc(par.practice_name)}.`;
  audModal("Update " + p.practice_name + " in HubSpot", `<p class="text-sm">${why}</p><div class="mt-2">${lines.join("")}</div>
    ${p.hubspot_customer ? '<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">This is a paying customer. Its deals and contract stay on this company. Check with Customer Success whether the contract moves to the parent.</p>' : ""}
    ${par.hubspot_company_id ? "" : '<p class="mt-2 text-xs text-rose-700">The parent practice is not in HubSpot yet, so it cannot be linked.</p>'}`,
    par.hubspot_company_id ? async () => {
      const r = await hsCall({ action: "entity_change", mode: c.mode, ods: p.ods_code, companyId: String(p.hubspot_company_id), parentOds: par.ods_code, parentCompanyId: String(par.hubspot_company_id), branchCode: c.mode === "branch" ? c.branch.branch_code : "" });
      if (c.mode === "merged") { p.hubspot_operating_status = "merged"; p.hubspot_org_type = "practice"; p.hubspot_parent_company_id = String(par.hubspot_company_id); } else { p.hubspot_company_id = null; p.hubspot_org_type = null; p.hubspot_operating_status = null; p.hubspot_parent_company_id = null; }
      audModalClose(); if (r.warnings && r.warnings.length) alert(r.warnings.join("\n")); openDrawer(p); if (typeof renderHubspotPanel === "function") renderHubspotPanel();
    } : null, "Update HubSpot");
}
function alignCasesOpen() {
  const s = alignPlan();
  audModal("Merged practices and moved sites", `<p class="mb-2 text-xs text-slate-500">Each needs its parent company linked in HubSpot, so they are done one at a time. Nothing changes until you confirm.</p><table class="w-full text-sm"><tbody>${s.cases.map(([p, a]) => `<tr class="border-t border-slate-100"><td class="py-1.5 pr-2">${esc(p.practice_name)} <span class="font-mono text-xs text-slate-400">${esc(p.ods_code)}</span><div class="text-xs text-slate-500">${a.c.mode === "merged" ? "Merged into " : "Site continues as a branch of "}${esc(a.c.parent.practice_name)}${p.hubspot_customer ? " · customer" : ""}</div></td><td class="text-right"><button type="button" class="hs-entity rounded-md border border-slate-300 px-2 py-0.5 text-xs font-semibold hover:bg-slate-50" data-ods="${esc(p.ods_code)}">Review</button></td></tr>`).join("")}</tbody></table>`, null);
}
document.addEventListener("click", e => { const b = e.target.closest(".hs-entity"); if (b) { const p = byOds.get(b.dataset.ods); if (p) alignEntityOpen(p); } });
