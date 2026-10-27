// Keeping HubSpot's company properties in step with the NHS-derived values in Atlas: Org Type, Operating status and Website URL.
const HS_ORG_LABEL = { practice: "Practice", branch_site: "Branch (Site)", pcn: "PCN", "sub-icb": "Sub-ICB", icb: "ICB", group: "Group", federation: "Federation" }, HS_OPSTATUS_LABEL = { active: "Active", closed: "Closed", merged: "Merged" };
const alignRead = () => practices.some(p => p.hubspot_org_type || p.hubspot_operating_status || p.hubspot_website);      // false until the sync has read these from HubSpot once
const normPc = v => String(v || "").replace(/\s+/g, "").toUpperCase(), hostOf = u => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const NAME_NOISE = new Set(["surgery", "medical", "centre", "center", "practice", "health", "group", "partners", "partnership", "doctors", "care", "general", "the", "and"]);
const nameKeys = n => String(n || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !NAME_NOISE.has(w));
// A closed code whose site goes on as an active branch of another practice (same postcode and name). The old company stays as the closed record (its ODS code is never rewritten), linked under the operating practice; the site gets its own Branch (Site) company.
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
const atlasOpStatus = p => p.merged_into ? "merged" : (isClosed(p) || p.status !== "Active") ? "closed" : "active";
const atlasOrgType = () => "practice";

function alignOf(p) {      // null when the practice is not in HubSpot
  if (!p.hubspot_company_id) return null;
  const c = hsCase(p), org = { atlas: atlasOrgType(p), hs: String(p.hubspot_org_type || "").toLowerCase() }, st = { atlas: atlasOpStatus(p), hs: String(p.hubspot_operating_status || "").toLowerCase() };
  const web = p.website || "", hw = p.hubspot_website || "", wstate = !web ? "none" : !hw ? "missing" : hostOf(web) === hostOf(hw) ? "ok" : "differs";
  const link = c ? { parent: c.parent, expected: String(c.parent.hubspot_company_id || ""), hs: String(p.hubspot_parent_company_id || ""), ok: !!c.parent.hubspot_company_id && String(c.parent.hubspot_company_id) === String(p.hubspot_parent_company_id || "") } : null;
  return { c, org: { ...org, ok: org.hs === org.atlas }, status: { ...st, ok: st.hs === st.atlas }, web: { atlas: web, hs: hw, state: wstate }, link };
}
let hsAlignFlag = {};      // app_flags.alignment_sync: { enabled, approve_once }
const ALIGN_MAX = 100;      // the same limit as the sync: a bigger run waits for approval
const ALIGN_FLAG = chip("Needs updating", "bg-amber-100 text-amber-800");
const alignNeeds = a => !!a && (!a.org.ok || !a.status.ok || (a.link && !a.link.ok));
function alignHsRows(p) {      // inside the profile's HubSpot section: HubSpot's own values, flagged when they do not match the NHS data (which sits in Practice details)
  const a = alignOf(p); if (!a || !alignRead()) return "";
  const val = (v, labels) => v ? esc(labels[v] || v) : '<span class="text-slate-500">Blank</span>';
  const rows = [];
  rows.push(kv("Org Type", val(a.org.hs, HS_ORG_LABEL) + (a.org.ok ? "" : " " + ALIGN_FLAG)), kv("Operating status", val(a.status.hs, HS_OPSTATUS_LABEL) + (a.status.ok ? "" : " " + ALIGN_FLAG)));
  if (a.link) rows.push(kv("Parent company", a.link.ok ? esc(a.link.parent.practice_name) : (a.link.hs ? '<span class="text-slate-600">A different company</span>' : '<span class="text-slate-500">Not linked</span>') + " " + ALIGN_FLAG + ` <span class="text-xs text-slate-400">${a.c.mode === "merged" ? "merged into " : "site operated by "}${esc(a.link.parent.practice_name)}</span>`));
  const web = a.web.hs ? kv("Website", `<span class="break-all">${esc(a.web.hs)}</span>`) : a.web.atlas ? kv("Website", '<span class="text-slate-500">Blank</span> ' + ALIGN_FLAG) : "";
  const note = p.hubspot_change_note ? `<div class="mt-1 text-xs text-slate-500">${esc(p.hubspot_change_note)}</div>` : "";
  const act = alignNeeds(a) && a.c ? `<div class="mt-1"><button type="button" class="hs-entity rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50" data-ods="${esc(p.ods_code)}">Update HubSpot…</button></div>` : "";
  return rows.join("") + web + act + note;
}
function alignPlan() {
  const rows = practices.filter(p => p.hubspot_company_id), read = alignRead(), out = { rows, read, org: 0, status: 0, webMissing: 0, webDiffers: 0, autoN: 0, cases: [] };
  for (const p of rows) {
    const a = alignOf(p); if (!a.org.ok) out.org++; if (!a.status.ok) out.status++; if (a.web.state === "missing") out.webMissing++; if (a.web.state === "differs") out.webDiffers++;
    if (a.c) { if (alignNeeds(a)) out.cases.push([p, a]); continue; }      // merged practices and moved sites are changed one by one from their profile
    if (!a.org.hs || !a.status.ok) out.autoN++;      // what the sync would write on its own: a blank Org Type, or a different Operating status
  }
  return out;
}
function alignCard() {
  const s = alignPlan(), n = x => x.toLocaleString();
  return `<div class="mt-4 rounded-lg border border-slate-200 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div><div class="text-sm font-bold">Alignment with NHS data</div><div class="text-xs text-slate-500">Org Type, Operating status and Website URL on the HubSpot company, against what Atlas knows from NHS data.</div></div>
    <div class="flex gap-2">${s.cases.length ? `<button type="button" id="hsp-align-cases" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">Merged and moved sites (${s.cases.length})</button>` : ""}</div></div>
    <div class="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2"><label class="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" id="hsp-align-auto" class="h-4 w-4 accent-lalu-teal-700" ${hsAlignFlag.enabled ? "checked" : ""}> Keep these in step automatically</label>
      <span class="text-xs text-slate-500">${hsAlignFlag.enabled ? `Each daily sync sets Operating status from NHS data (and fills a blank Org Type). ${s.read ? `${n(s.autoN || 0)} companies to change.` : "Run the sync once to compare."}` : "Off. When on, the daily sync keeps them aligned, so no import file is needed."}</span>
      ${hsAlignFlag.enabled && (s.autoN || 0) > ALIGN_MAX && !hsAlignFlag.approve_once ? `<button type="button" id="hsp-align-ok" class="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100">Approve this run (${n(s.autoN)} companies)</button>` : ""}${hsAlignFlag.approve_once ? '<span class="text-xs font-semibold text-emerald-700">Approved: applies at the next sync</span>' : ""}</div>
    <div class="mt-2 text-sm">${s.read ? `<b>${n(s.org)}</b> Org Type differ · <b>${n(s.status)}</b> Operating status differ · <b>${n(s.webMissing)}</b> websites blank in HubSpot${s.webDiffers ? ` · ${n(s.webDiffers)} websites differ (not changed: HubSpot uses the website to identify companies)` : ""}`
      : "These have not been read from HubSpot yet. Run the sync once to compare them."}</div>
    ${s.cases.length ? `<div class="mt-1 text-xs text-slate-500">${s.cases.length} merged practices or moved sites are never changed automatically: each needs its parent company linked, so they are updated one by one.</div>` : ""}</div>`;
}
// One merged practice or moved site: show exactly what will change in HubSpot, then do it (edge action entity_change). No ODS code is rewritten; every company touched is linked and gets a note.
function alignEntityOpen(p) {
  const a = alignOf(p), c = a && a.c; if (!c) return;
  const par = c.parent, br = c.branch, row = (k, from, to) => `<div class="flex justify-between gap-3 border-t border-slate-100 py-1.5 text-sm"><span class="text-slate-500">${k}</span><span class="text-right"><span class="text-slate-400">${from}</span> → <b>${to}</b></span></div>`;
  const blank = v => v || "blank", lines = [row("Operating status", esc(HS_OPSTATUS_LABEL[a.status.hs] || blank(a.status.hs)), esc(HS_OPSTATUS_LABEL[a.status.atlas])), row("Org Type", esc(HS_ORG_LABEL[a.org.hs] || blank(a.org.hs)), esc(HS_ORG_LABEL[a.org.atlas])), row("Parent company", a.link.hs ? "another company" : "none", esc(par.practice_name) + " (" + esc(par.ods_code) + ")")];
  if (br) lines.push(row("Branch company", "none yet", `${esc(br.branch_name)} (${esc(br.branch_code)}), Branch (Site), Active, under ${esc(par.practice_name)}; created if HubSpot does not have it, and linked to this company`));
  const why = c.mode === "merged" ? `${esc(p.practice_name)} merged into ${esc(par.practice_name)}. Its company stays in HubSpot with its code and history, marked Merged, with ${esc(par.practice_name)} as its parent company.`
    : `${esc(p.practice_name)}'s code (${esc(p.ods_code)}) has closed but its site goes on as ${esc(br.branch_name)} (${esc(br.branch_code)}), a branch of ${esc(par.practice_name)}. This company stays as the closed record and keeps its history. The branch gets its own company, and the two are linked to each other and to ${esc(par.practice_name)}.`;
  audModal("Update " + p.practice_name + " in HubSpot", `<p class="text-sm">${why}</p><div class="mt-2">${lines.join("")}</div>
    ${br ? '<label class="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" id="ent-contacts" class="mt-0.5 h-4 w-4 accent-lalu-teal-700" checked><span>Also associate this company\'s contacts with the branch company, so their emails and activity show on both records</span></label>' : ""}
    <p class="mt-2 text-xs text-slate-500">A note is added to each company explaining the change. No ODS code is changed.</p>
    ${p.hubspot_customer ? '<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">This is a paying customer. Its deals and contract stay on this company. Check with Customer Success whether the contract moves to the parent.</p>' : ""}
    ${par.hubspot_company_id ? "" : '<p class="mt-2 text-xs text-rose-700">The parent practice is not in HubSpot yet, so it cannot be linked.</p>'}`,
    par.hubspot_company_id ? async () => {
      const r = await hsCall({ action: "entity_change", mode: c.mode, ods: p.ods_code, companyId: String(p.hubspot_company_id), parentOds: par.ods_code, parentCompanyId: String(par.hubspot_company_id),
        ...(br ? { branch: { code: br.branch_code, name: br.branch_name, address: br.address || "", town: br.town || "", postcode: br.postcode || "", phone: br.phone || "" }, moveContacts: !!$("ent-contacts").checked } : {}) });
      const day = new Date().toISOString().slice(0, 10), me = await audMe();
      p.hubspot_operating_status = c.mode === "merged" ? "merged" : "closed"; p.hubspot_org_type = "practice"; p.hubspot_parent_company_id = String(par.hubspot_company_id);
      p.hubspot_change_note = (c.mode === "merged" ? `Merged into ${par.practice_name} (${par.ods_code}); marked Merged and linked to its parent in HubSpot` : `Closed; site continues as ${br.branch_code}, a branch of ${par.practice_name} (${par.ods_code}); marked Closed in HubSpot and linked to the parent and the branch company`) + ` on ${day} by ${me}`;
      audModalClose(); if (r.warnings && r.warnings.length) alert(r.warnings.join("\n")); openDrawer(p); if (typeof renderHubspotPanel === "function") renderHubspotPanel();
    } : null, "Update HubSpot");
}
function alignCasesOpen() {
  const s = alignPlan();
  audModal("Merged practices and moved sites", `<p class="mb-2 text-xs text-slate-500">Each needs its parent company linked in HubSpot, so they are done one at a time. Nothing changes until you confirm.</p><table class="w-full text-sm"><tbody>${s.cases.map(([p, a]) => `<tr class="border-t border-slate-100"><td class="py-1.5 pr-2">${esc(p.practice_name)} <span class="font-mono text-xs text-slate-400">${esc(p.ods_code)}</span><div class="text-xs text-slate-500">${a.c.mode === "merged" ? "Merged into " : "Closed; site now a branch of "}${esc(a.c.parent.practice_name)}${p.hubspot_customer ? " · customer" : ""}</div></td><td class="text-right"><button type="button" class="hs-entity rounded-md border border-slate-300 px-2 py-0.5 text-xs font-semibold hover:bg-slate-50" data-ods="${esc(p.ods_code)}">Review</button></td></tr>`).join("")}</tbody></table>`, null);
}
document.addEventListener("click", e => { const b = e.target.closest(".hs-entity"); if (b) { const p = byOds.get(b.dataset.ods); if (p) alignEntityOpen(p); } });
