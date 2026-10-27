// Data > Data sources: patient-count and Scotland / Wales file uploads, and the NHS update button. Loaded after data-connections.js.
/* ---------- patient counts (upload / runner) ---------- */
/* parser:start */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function monthFromText(t) {
  const m = /(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\s*(\d{4})/.exec(t || "");
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}`;
  const iso = /(\d{4})-(\d{2})-\d{2}/.exec(t || "");
  return iso ? `${iso[1]}-${iso[2]}` : null;
}
function readPatientFile(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows[0] || []).map(h => h.trim().toUpperCase());
  const col = n => head.indexOf(n);
  const iCode = col("CODE"), iN = col("NUMBER_OF_PATIENTS"), iType = col("TYPE"), iSex = col("SEX"), iAge = col("AGE"), iDate = col("EXTRACT_DATE");
  if (iCode < 0 || iN < 0) throw new Error("This does not look like gp-reg-pat-prac-all.csv (no CODE / NUMBER_OF_PATIENTS columns).");
  const totals = new Map(); let month = null;
  for (let r = 1; r < rows.length; r++) {
    const x = rows[r];
    if (x.length <= Math.max(iCode, iN)) continue;
    if (iType >= 0 && x[iType].trim().toUpperCase() !== "GP") continue;
    if (iSex >= 0 && x[iSex].trim().toUpperCase() !== "ALL") continue;
    if (iAge >= 0 && x[iAge].trim().toUpperCase() !== "ALL") continue;
    const code = x[iCode].trim().toUpperCase(), n = parseInt(x[iN], 10);
    if (!/^[A-Z][0-9]{5}$/.test(code) || !Number.isFinite(n) || n < 0) continue;
    totals.set(code, (totals.get(code) || 0) + n);
    if (!month && iDate >= 0) month = monthFromText(x[iDate]);
  }
  if (totals.size < 5000) throw new Error(`Only ${totals.size} practices found: wrong file? Use the practice totals file, gp-reg-pat-prac-all.csv.`);
  return { totals, month };
}
/* parser:end */

let pcTimer = null;
async function latestCountRow() {
  const { data } = await db.from("patient_counts").select("data_month,updated_at").order("updated_at", { ascending: false }).limit(1);
  return data && data[0];
}
async function reloadAfterCounts() { await loadPractices(); applyFilters(); loadNetworks(); renderData(); }
/* devolved nations */
const SCOT_HB = { S08000015: "NHS Ayrshire and Arran", S08000016: "NHS Borders", S08000017: "NHS Dumfries and Galloway", S08000019: "NHS Forth Valley", S08000020: "NHS Grampian",
  S08000022: "NHS Highland", S08000024: "NHS Lothian", S08000025: "NHS Orkney", S08000026: "NHS Shetland", S08000028: "NHS Western Isles", S08000029: "NHS Fife",
  S08000030: "NHS Tayside", S08000031: "NHS Greater Glasgow and Clyde", S08000032: "NHS Lanarkshire" };
const titleCase = t => (t || "").trim().toLowerCase().replace(/(^|[\s(\-/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const slug = t => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Isle of Man: the health service's registrations return ("figures on which payments to doctors are based"). Practice names map to ODS codes; the last column is the total after age re-assessment.
const IOM_PRACTICES = { KENSINGTON: ["Y00005", "Kensington Group Practice"], PALATINE: ["Y00007", "Palatine Group Practice"], SNAEFELL: ["Y00011", "Snaefell Surgery"], HAILWOOD: ["Y00008", "Hailwood Medical Practice"],
  "FINCH HILL": ["Y00944", "Finch Hill Health Centre"], RAMSEY: ["Y00003", "Ramsey Group Practice"], "LAXEY/ONCHAN": ["Y00010", "Laxey & Village Walk Health Centres"], CASTLETOWN: ["Y00001", "Castletown Medical Centre"],
  SOUTHERN: ["Y00004", "Southern Group Practice"], BALLASALLA: ["Y00009", "Ballasalla Group Practice"], PEEL: ["Y00002", "Peel Group Practice"], "RAMSEY WEST": ["Y02419", "Ramsey West Practice"] };
function readIsleOfMan(rows) {
  const flat = rows.slice(0, 6).map(r => r.join(" ")).join(" "), dm = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(20\d{2})/.exec(flat), out = [], skipped = [];
  const month = dm && MONTHS[dm[2].toLowerCase()] ? `${dm[3]}-${String(MONTHS[dm[2].toLowerCase()]).padStart(2, "0")}` : null;
  for (const x of rows) {
    const name = (x[0] || "").trim().toUpperCase(), n = parseInt(String(x[x.length - 1] || "").replace(/[, ]/g, ""), 10);
    if (!name || name === "PRACTICE" || !Number.isFinite(n) || x.length < 8 || /^(KEY|TOTAL)/.test(name)) continue;
    const hit = IOM_PRACTICES[name]; if (!hit) { skipped.push(name); continue; }
    out.push({ code: hit[0], name: hit[1], postcode: "", town: "", patients: n, net_code: null, net_name: null, icb: null });
  }
  if (out.length < 8) throw new Error(`Only ${out.length} Isle of Man practices recognised: wrong file?`);
  return { kind: "iom", country: "Isle of Man", rows: out, month, skipped };
}
// Northern Ireland: the Department of Health's GMS quarterly tables, sheet 7.1 (registered patients by practice, one column per quarter). The ODS code is Z plus the practice number to five digits;
// the latest quarter is the last column; "[c]" marks a practice that has closed. Financial quarters end in June, September, December and March.
function readNorthernIreland(rows) {
  const hi = rows.findIndex(r => /^practice number$/i.test((r[0] || "").trim())); if (hi < 0) throw new Error("No 'Practice number' header row found: is this sheet 7.1?");
  const head = rows[hi].map(h => (h || "").trim()), lastCol = head.map((h, i) => h ? i : -1).filter(i => i >= 0).pop(), q = /Quarter\s+([1-4])\s+(20\d{2})\/(\d{2})/i.exec(head[lastCol] || "");
  const ci = n => head.findIndex(h => h.toLowerCase() === n), [nm, pc] = [ci("partnership name"), ci("postcode")], out = [], closed = [];
  for (const x of rows.slice(hi + 1)) {
    const num = (x[0] || "").trim(); if (!/^\d{1,5}$/.test(num)) continue;
    const n = parseInt(String(x[lastCol] || "").replace(/[, ]/g, ""), 10);
    if (!Number.isFinite(n)) { closed.push(num); continue; }      // closed, or not yet reported for the latest quarter
    out.push({ code: "Z" + num.padStart(5, "0"), name: titleCase((x[nm] || "").trim().replace(/\s+/g, " ")), postcode: (x[pc] || "").trim(), town: "", patients: n, net_code: null, net_name: null, icb: null });
  }
  if (out.length < 250) throw new Error(`Only ${out.length} Northern Ireland practices with a list size: wrong sheet?`);
  const month = q ? `${Number(q[2]) + (Number(q[1]) === 4 ? 1 : 0)}-${String({ 1: 6, 2: 9, 3: 12, 4: 3 }[q[1]]).padStart(2, "0")}` : null;
  return { kind: "ni", country: "Northern Ireland", rows: out, month, closed, quarter: q ? `Q${q[1]} ${q[2]}/${q[3]}` : "" };
}
function readDevolvedFile(text, fileName) {
  const rows = parseCsv(text.replace(/^\uFEFF/, "")), head = (rows[0] || []).map(h => h.trim().toLowerCase());
  if (/Practice number/i.test(text.slice(0, 4000)) && /Partnership name/i.test(text.slice(0, 4000))) return readNorthernIreland(rows);
  if (/ISLE OF MAN/i.test(text.slice(0, 800)) && /\bPRACTICE\b/i.test(text)) return readIsleOfMan(rows);
  const ix = n => head.indexOf(n.toLowerCase()), out = [], seen = new Set();
  const cell = (x, i) => i >= 0 && x[i] != null ? x[i].trim() : "";
  if (ix("PracticeCode") >= 0 && ix("GPPracticeName") >= 0) {
    const [c, nm, ls, pc, hb, cl] = ["PracticeCode", "GPPracticeName", "PracticeListSize", "Postcode", "HB", "GPCluster"].map(ix), addr = ["AddressLine2", "AddressLine3", "AddressLine4"].map(ix);
    for (const x of rows.slice(1)) {
      const raw = cell(x, c).replace(/\D/g, ""); if (!raw || raw.length > 5) continue;
      const code = "S" + raw.padStart(5, "0"); if (seen.has(code)) continue; seen.add(code);
      const cluster = cell(x, cl), town = addr.map(i => cell(x, i)).filter(Boolean).pop() || "";
      out.push({ code, name: cell(x, nm), postcode: cell(x, pc), town: titleCase(town), patients: parseInt(cell(x, ls), 10) || null,
        net_code: cluster ? "SC-" + slug(cluster) : null, net_name: cluster || null, icb: SCOT_HB[cell(x, hb)] || null });
    }
    const m = /(20\d{2})(\d{2})\d{2}/.exec(fileName || "");
    if (out.length < 500) throw new Error(`Only ${out.length} Scottish practices found: wrong file?`);
    return { kind: "scotland", country: "Scotland", rows: out, month: m ? `${m[1]}-${m[2]}` : null };
  }
  if (ix("Practice_reference") >= 0 && ix("Data values_sort") >= 0 && ix("Residence_reference") >= 0) {   // StatsWales: patients by practice (rows for totals, nations and health boards are skipped)
    const [pr, pn, ph, rr, v, dt, ds] = ["Practice_reference", "Practice", "Practice_hierarchy", "Residence_reference", "Data values_sort", "Date", "Date_sort"].map(ix);
    const boards = new Map(), per = new Map(); let latest = -1;
    for (const x of rows.slice(1)) {
      const ref = cell(x, pr).toUpperCase();
      if (/^7A\d$/.test(ref)) boards.set(ref, cell(x, pn));
      if (cell(x, rr) !== "P" || !/^W[0-9]{5}$/.test(ref)) continue;   // "All residence" only; real practice codes only
      const t = Number(cell(x, ds)), n = parseInt(cell(x, v), 10); if (!Number.isFinite(t) || !Number.isFinite(n)) continue;
      latest = Math.max(latest, t); (per.get(t) || per.set(t, []).get(t)).push({ code: ref, name: cell(x, pn), hb: cell(x, ph), n, date: cell(x, dt) });
    }
    const q = per.get(latest) || [], m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(q[0] ? q[0].date : "");
    for (const r of q) if (!seen.has(r.code)) { seen.add(r.code); out.push({ code: r.code, name: titleCase(r.name), postcode: "", town: "", patients: r.n, net_code: null, net_name: null, icb: boards.get(r.hb) || null }); }
    if (out.length < 300) throw new Error(`Only ${out.length} Welsh practices found in the latest quarter: wrong file?`);
    return { kind: "wales-sizes", country: "Wales", rows: out, month: m ? `${m[3]}-${m[2]}` : null };
  }
  if (ix("PracticeId") >= 0 && ix("ClusterID") >= 0) {
    const [id, st, tn, pc, cl, per] = ["PracticeId", "Street", "Posttown", "Postcode", "ClusterID", "Period"].map(ix); let month = null;
    for (const x of rows.slice(1)) {
      const code = cell(x, id).toUpperCase(); if (!/^W[0-9]{5}$/.test(code) || seen.has(code)) continue; seen.add(code);
      const cluster = cell(x, cl);
      out.push({ code, name: titleCase(cell(x, st)), postcode: cell(x, pc), town: titleCase(cell(x, tn)), patients: null,
        net_code: cluster ? "WC" + cluster : null, net_name: cluster ? "Wales cluster " + cluster : null, icb: null });
      if (!month && /^\d{6}$/.test(cell(x, per))) month = cell(x, per).slice(0, 4) + "-" + cell(x, per).slice(4);
    }
    if (out.length < 300) throw new Error(`Only ${out.length} Welsh practices found: wrong file?`);
    return { kind: "wales-clusters", country: "Wales", rows: out, month };
  }
  throw new Error("Not recognised. Expected the Scotland practice contact details CSV (PracticeCode, GPPracticeName…) , the Wales practice data CSV (PracticeId, ClusterID…) or the StatsWales patients-by-practice CSV.");
}
function readDevolved(text, name, expect) {
  const r = readDevolvedFile(text, name);
  if (r.kind !== expect) throw new Error(`This is the ${UPLOAD_KIND[r.kind]} file: use that box instead.`);
  return r;
}

/* ---------- data file uploads ----------
   One entry per source file. To support a new file: add an entry here (and, if needed, a parser above and a database load function).
   parse(text, fileName) -> { count, month, payload }   throws a readable Error if the file is the wrong one
   load(payload, month, say) -> summary text            say(text) shows progress
   status() -> text shown under the box (what is currently in the database) */
const UPLOAD_KIND = { ni: "Northern Ireland list sizes", iom: "Isle of Man list sizes", scotland: "Scotland practices", "wales-clusters": "Wales practices and clusters", "wales-sizes": "Wales patient numbers (StatsWales)" };
const latestMonth = list => list.map(p => p.data_month).filter(Boolean).sort().pop() || "?";
async function loadDevolvedRows(country, rows, month, say, create = true) {
  let stored = 0, added = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    say(`Loading ${Math.min(i + 1000, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`);
    const { data, error } = await db.rpc("load_devolved", { p_country: country, p_month: month, p_create: create, p_rows: rows.slice(i, i + 1000) });
    if (error) throw error; stored += data.stored; added += data.new;
  }
  return `${stored.toLocaleString()} practices processed (${added.toLocaleString()} new)`;
}
// An Excel workbook is a zip of XML files. Atlas reads the one sheet it needs with the browser's own inflate, so no spreadsheet library is loaded; the sheet comes back as CSV text for the normal parsers.
async function xlsxSheetCsv(file, sheetName) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer), td = new TextDecoder();
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`${file.name} is not an Excel workbook.`);
  const entries = new Map(); let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0; i--) {
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    entries.set(td.decode(buf.subarray(p + 46, p + 46 + nl)), { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) }); p += 46 + nl + xl + cl;
  }
  const read = async name => {
    const en = entries.get(name); if (!en) return null; const o = en.off, start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true), data = buf.subarray(start, start + en.size);
    return en.method === 0 ? td.decode(data) : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  };
  const xml = t => new DOMParser().parseFromString(t, "application/xml"), wb = xml(await read("xl/workbook.xml") || "<x/>"), rels = xml(await read("xl/_rels/workbook.xml.rels") || "<x/>");
  const sheet = [...wb.getElementsByTagName("sheet")].find(s => (s.getAttribute("name") || "").trim() === sheetName); if (!sheet) throw new Error(`${file.name} has no sheet "${sheetName}".`);
  const rid = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"), rel = [...rels.getElementsByTagName("Relationship")].find(r => r.getAttribute("Id") === rid);
  const target = rel && rel.getAttribute("Target").replace(/^\//, ""), sheetXml = target && await read(target.startsWith("xl/") ? target : "xl/" + target); if (!sheetXml) throw new Error("Could not read the sheet.");
  const shared = [...xml(await read("xl/sharedStrings.xml") || "<x/>").getElementsByTagName("si")].map(si => [...si.getElementsByTagName("t")].map(t => t.textContent).join(""));
  const rows = [], colOf = ref => ref.replace(/\d/g, "").split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
  for (const row of xml(sheetXml).getElementsByTagName("row")) {
    const cells = []; for (const c of row.getElementsByTagName("c")) {
      const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0], is = c.getElementsByTagName("is")[0];
      cells[colOf(c.getAttribute("r"))] = t === "s" && v ? shared[Number(v.textContent)] : t === "inlineStr" && is ? [...is.getElementsByTagName("t")].map(x => x.textContent).join("") : v ? v.textContent : "";
    }
    rows[Number(row.getAttribute("r")) - 1] = Array.from(cells, x => x == null ? "" : x);
  }
  return Array.from(rows, r => r || []).map(r => r.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(",")).join("\n");
}
const uploadText = async f => /\.xlsx$/i.test(f.name) ? xlsxSheetCsv(f, "7.1") : f.text();      // only Northern Ireland's workbook is read directly; every other box takes CSV
const UPLOADS = [
  { id: "eng", title: "England: patient counts", gives: "List size for every English practice, which drives tiers and ARR", file: "gp-reg-pat-prac-all.csv", cadence: "monthly",
    links: [["https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice", "NHS Digital: Patients registered at a GP practice (latest month)"]],
    parse: t => { const r = readPatientFile(t); return { count: r.totals.size, month: r.month, payload: r }; },
    load: async (r, month, say) => {
      const rows = [...r.totals].map(([code, n]) => ({ code, n })); let stored = 0, updated = 0;
      for (let i = 0; i < rows.length; i += 1000) {
        say(`Loading ${Math.min(i + 1000, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…`);
        const { data, error } = await db.rpc("load_patient_counts", { p_month: month, p_rows: rows.slice(i, i + 1000) });
        if (error) throw error; stored += data.stored; updated += data.practices_updated;
      }
      return `${stored.toLocaleString()} counts stored, ${updated.toLocaleString()} practices updated`;
    },
    status: () => { const l = practices.filter(p => (p.country || "England") === "England" && p.total_patients > 0); return `${l.length.toLocaleString()} English practices have list sizes (data month ${latestMonth(l)})`; } },
  { id: "sco", title: "Scotland: practices, list sizes, GP clusters", gives: "Practices, list sizes, GP clusters (PCN equivalent) and health boards (ICB equivalent)", file: "…practice_contact_details_YYYYMMDD_opendata.csv", cadence: "quarterly",
    links: [["https://www.opendata.nhs.scot/dataset/gp-practice-contact-details-and-list-sizes", "Public Health Scotland open data: GP practice contact details and list sizes"]],
    parse: (t, n) => { const r = readDevolved(t, n, "scotland"); return { count: r.rows.length, month: r.month, payload: r }; },
    load: (r, month, say) => loadDevolvedRows("Scotland", r.rows, month, say),
    status: () => { const l = practices.filter(p => p.country === "Scotland"); return l.length ? `${l.length.toLocaleString()} Scottish practices loaded (data month ${latestMonth(l)})` : "Nothing loaded yet"; } },
  { id: "ni", title: "Northern Ireland: list sizes", accept: ".xlsx,.csv", gives: "List sizes for Northern Ireland's GP practices (the practices themselves come from ODS each day), so they get tiers and ARR", file: "fps_gms_quarterly_tables_….xlsx (the workbook; Atlas reads sheet 7.1) or sheet 7.1 saved as CSV", cadence: "quarterly",
    links: [["https://bso.hscni.net/directorates/operations/family-practitioner-services/directorates-operations-family-practitioner-services-information-unit/1776-2/previous-general-medical-services-publications/", "BSO: General Medical Services publications (quarterly tables, Table 7.1)"], ["https://www.gov.uk/search/research-and-statistics?keywords=general+medical+services+statistics+for+ni", "GOV.UK: General Medical Services Statistics for NI (each quarter's workbook)"]],
    parse: (t, n) => { const r = readDevolved(t, n, "ni"); return { count: r.rows.length, month: r.month, label: `list sizes for ${r.quarter}` + (r.closed.length ? ` (${r.closed.length} closed or unreported practices skipped)` : ""), payload: r }; },
    load: (r, month, say) => loadDevolvedRows("Northern Ireland", r.rows, month, say, false),   // the practices already exist from ODS; this only sets list sizes
    status: () => { const l = practices.filter(p => p.country === "Northern Ireland"); return l.length ? `${l.length.toLocaleString()} Northern Ireland practices, ${l.filter(p => p.total_patients > 0).length.toLocaleString()} with list sizes (data month ${latestMonth(l)})` : "Nothing loaded yet"; } },
  { id: "iom", title: "Isle of Man: list sizes", gives: "List sizes for the island's GP practices (the practices themselves come from ODS each day), so they get tiers and ARR", file: "practice-registrations-….csv (the health service's quarterly registrations return)", cadence: "annual",
    links: [["https://www.gov.im/about-the-government/government/open-data/health-and-social-care/", "Isle of Man government open data: health and social care"]],
    parse: (t, n) => { const r = readDevolved(t, n, "iom"); return { count: r.rows.length, month: r.month, label: r.skipped.length ? `list sizes (not recognised and skipped: ${r.skipped.join(", ")})` : "list sizes", payload: r }; },
    load: (r, month, say) => loadDevolvedRows("Isle of Man", r.rows, month, say, false),   // the practices already exist from ODS; this only sets list sizes
    status: () => { const l = practices.filter(p => p.country === "Isle of Man"); return l.length ? `${l.length.toLocaleString()} Isle of Man practices, ${l.filter(p => p.total_patients > 0).length.toLocaleString()} with list sizes (data month ${latestMonth(l)})` : "Nothing loaded yet"; } },
  { id: "wal", title: "Wales: practices, clusters, list sizes", multiple: true, gives: "Two files, loaded together or separately: the cluster file gives each practice's cluster (PCN equivalent); the StatsWales patients file gives list sizes and health boards",
    file: "Wales_practice_data_….csv (PracticeId, ClusterID)  +  patients-registered-to-general-practices-in-wales-…-by-practice-and-country-of-residence-….csv", cadence: "quarterly",
    links: [["https://nwssp.nhs.wales/ourservices/primary-care-services/general-information/data-and-publications/gp-practice-analysis/", "NWSSP: GP practice analysis (clusters)"],
            ["https://stats.gov.wales/en-GB/75dcbf1e-9b43-4d9a-90b1-f02affe80bc2", "StatsWales: patients registered by practice (download as CSV)"]],
    parse: (t, n) => { const r = readDevolvedFile(t, n); if (r.country !== "Wales") throw new Error(`${n}: this is the ${r.country} file: use the ${r.country} box instead.`);
      return { count: r.rows.length, month: r.month, label: r.kind === "wales-sizes" ? "patient numbers and health boards" : "clusters", payload: r }; },
    load: async (r, month, say) => loadDevolvedRows("Wales", r.rows, month, say, r.kind === "wales-sizes"),   // the cluster file lists branch sites, so it may only update practices we already hold
    status: () => { const w = practices.filter(p => p.country === "Wales"); return w.length ? `${w.filter(p => p.status === "Active").length.toLocaleString()} Welsh practices: ${w.filter(p => p.network_locked).length.toLocaleString()} with a cluster, ${w.filter(p => p.total_patients > 0).length.toLocaleString()} with list sizes (data month ${latestMonth(w.filter(p => p.total_patients > 0))})` : "Nothing loaded yet"; } },
];
function renderUploads() {
  const box = $("uploads");
  if (!box.children.length) {
    box.innerHTML = UPLOADS.map(u => `<details id="up-${u.id}" class="dtile rounded-xl border border-slate-200 bg-white">
      <summary class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50"><span class="up-dot h-2.5 w-2.5 shrink-0 rounded-full bg-slate-300"></span>
        <span class="min-w-0 flex-1"><span class="block truncate font-semibold">${esc(u.title)}</span><span class="up-status block truncate text-xs text-slate-500"></span></span>
        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">${esc(u.cadence)}</span>
        <svg class="dchev h-4 w-4 shrink-0 text-slate-400 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg></summary>
      <div class="grid gap-3 border-t border-slate-100 px-3 py-3 md:grid-cols-2">
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">What it gives</div><p class="mt-0.5 text-sm text-slate-700">${esc(u.gives)}</p></div>
        <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Download</div><p class="mt-0.5 text-sm">${u.links.map(([h, l]) => `<a class="text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="${esc(h)}">${esc(l)}</a>`).join("<br>")}<span class="mt-0.5 block text-xs text-slate-500">File${u.multiple ? "s" : ""}: ${esc(u.file)}</span></p></div>
        <div class="md:col-span-2 rounded-lg bg-slate-50 p-2"><div class="flex flex-wrap items-center gap-2"><input type="file" accept="${u.accept || ".csv,text/csv"}" ${u.multiple ? "multiple" : ""} class="up-file max-w-[22rem] text-xs"><input type="month" class="up-month rounded border border-slate-300 bg-white px-2 py-1 text-xs"><button disabled class="up-load rounded-lg bg-lalu-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-teal-800 disabled:opacity-40">Load</button></div>
          <p class="up-msg mt-1 min-h-[1rem] whitespace-pre-line text-xs text-slate-600"></p></div>
      </div></details>`).join("");
    for (const u of UPLOADS) {
      const el = $("up-" + u.id), q = c => el.querySelector(c), say = t => { q(".up-msg").textContent = t; }; let parsed = [];
      q(".up-file").addEventListener("change", async e => {
        const files = [...e.target.files]; parsed = []; q(".up-load").disabled = true; if (!files.length) return; el.open = true;
        const lines = []; let ok = true;
        for (const f of files) {
          if (f.size > 60 * 1024 * 1024) { lines.push(`${f.name}: too large, check you have the right file.`); ok = false; continue; }
          try { const p = u.parse(await uploadText(f), f.name); parsed.push(p); lines.push(`${f.name}: ${p.label ? p.label + ", " : ""}${p.count.toLocaleString()} practices${p.month ? " (" + p.month + ")" : " (month not found: check the month box)"}`); }
          catch (err) { lines.push(err.message); ok = false; }
        }
        if (parsed.length) q(".up-month").value = parsed.find(p => p.month)?.month || new Date().toISOString().slice(0, 7);
        say(lines.join("\n") + (ok ? "\nPress Load." : "\nFix the file(s) above, then choose again."));
        q(".up-load").disabled = !ok;
      });
      q(".up-load").addEventListener("click", async () => {
        const month = q(".up-month").value;
        if (!parsed.length || !/^\d{4}-\d{2}$/.test(month)) { say("Choose a file and a month first."); return; }
        q(".up-load").disabled = true; const done = [];
        try {
          for (const p of [...parsed].sort((a, b) => (b.payload.kind === "wales-sizes") - (a.payload.kind === "wales-sizes"))) done.push(await u.load(p.payload, p.month || month, t => say(t)));
          parsed = []; q(".up-file").value = ""; await reloadAfterCounts(); say("Done: " + done.join("; ") + ".");
        } catch (err) { say("Load failed: " + (err.message || err)); q(".up-load").disabled = false; }
      });
    }
  }
  for (const u of UPLOADS) { const el = $("up-" + u.id), s = u.status(); el.querySelector(".up-status").textContent = "In the database: " + s; el.querySelector(".up-dot").className = "up-dot h-2.5 w-2.5 shrink-0 rounded-full " + (/nothing loaded/i.test(s) ? "bg-slate-300" : "bg-emerald-500"); }
}
$("pc-run").addEventListener("click", async () => {
  const btn = $("pc-run"), msg = $("pc-run-msg");
  btn.disabled = true; msg.textContent = "Sending request…";
  const before = await latestCountRow();
  const { data, error } = await db.functions.invoke("trigger-patient-load");
  if (error || (data && data.error)) {
    let detail = (data && data.error) || error.message;
    try { const body = await error.context.json(); detail = body.error || detail; } catch (_) {}
    msg.textContent = "Could not start: " + detail + " (use the England upload box instead)"; btn.disabled = false; return;
  }
  msg.textContent = "Started. Waiting for the office PC runner… this updates when it finishes.";
  const t0 = Date.now(); clearInterval(pcTimer);
  pcTimer = setInterval(async () => {
    const row = await latestCountRow();
    if (row && (!before || row.updated_at !== before.updated_at)) { clearInterval(pcTimer); await reloadAfterCounts(); msg.textContent = "Done: patient counts updated."; btn.disabled = false; }
    else if (Date.now() - t0 > 10 * 60 * 1000) { clearInterval(pcTimer); msg.textContent = "Still waiting after 10 minutes: is the runner on? The request stays queued. Or use the England upload box."; btn.disabled = false; }
  }, 10000);
});
