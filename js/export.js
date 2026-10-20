// CSV exports.
/* ---------- export ---------- */
function downloadCsv(name, head, lines) {
  const blob = new Blob(["﻿" + head.map(csvCell).join(",") + "\r\n" + lines.map(r => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
const csvCell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
$("btn-export").addEventListener("click", () => {
  const rows = filtered.filter(p => p.lead_status !== "Do-Not-Contact");   // never export do-not-contact leads
  const head = ["ODS Code", "Practice", "PCN", "ICB", "Group", "Federation", "Patients", "Tier", "Est ARR (All reports, annual)", "SAR-only ARR (annual)", "Clinical System", "CQC Rating", "Contact", "Job Title", "Email", "Phone", "HubSpot", "Imported to HubSpot", "Region"];
  const lines = rows.map(p => [p.ods_code, p.practice_name, p.pcn_name, p.icb_name, p.group_size > 1 ? p.group_name : "", p.gp_federation, p.total_patients, p.tier_label, p.est_arr, p.est_arr_sar, p.clinical_software, p.cqc_rating,
    p.manager_name, p.manager_title, p.manager_email_opt_out ? "" : p.manager_email, p.manager_phone, HS_LABEL[hsState(p)], p.hs_primary_imported ? fmtDate(p.hs_primary_imported_at) : "", p.region].map(csvCell).join(","));
  const blob = new Blob(["﻿" + head.map(csvCell).join(",") + "\r\n" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `Lalu_Leads_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
});
$("s-export").addEventListener("click", () => downloadCsv("Lalu_Signals", ["Detected", "Type", "Practice or network", "Code", "Signal", "Detail", "Next step", "Status", "Note", "Link"],
  sigList.map(s => { const t = sigTarget(s); return [s.detected_at ? s.detected_at.slice(0, 10) : "", s.trigger_type, t.label, s.ods_code || "", s.headline, s.description, s.action, SIG_STATUS[s.status || "new"], s.note, s.url]; })));
$("n-export").addEventListener("click", () => downloadCsv("Lalu_Networks_" + netKind, ["Name", "Kind", "Linked practices", "Patients", "Tier", "Est ARR (network route)", "Est ARR (signed separately)", "SAR-only ARR (network route)", "SAR-only ARR (signed separately)", "Engaged", "Customers", "Confirmed"],
  netList.map(n => [n.name, n.kind, n.practices, n.patients, n.network_tier ? "Tier " + n.network_tier : "", n.arr_network, n.arr_single, n.arr_network_sar, n.arr_single_sar, n.engaged, n.customers, n.confirmed === false ? "inferred" : "confirmed"])));
