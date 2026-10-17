// Data tab: overview, rate card and file uploads.
/* ---------- data tab ---------- */
async function renderData() {
  const row = await latestCountRow(), withCounts = practices.filter(p => p.total_patients > 0).length, withCqc = practices.filter(p => p.cqc_location_id).length;
  renderUploads();
  $("pc-status").textContent = row ? `Data for ${row.data_month || "?"}, loaded ${fmtDate(row.updated_at)}. ${withCounts.toLocaleString()} of ${practices.length.toLocaleString()} practices have counts.` : "No patient counts loaded yet: practices show no list size or ARR until you load the NHS file.";
  $("d-fresh").innerHTML = [["Practices last refreshed", lastRunDate || "never"], ["Patient counts", row ? "NHS " + (row.data_month || "?") + ", loaded " + fmtDate(row.updated_at) : "not loaded"],
    ["Practices with a CQC match", withCqc.toLocaleString() + " of " + practices.length.toLocaleString()], ["Practices with a contact", practices.filter(p => p.manager_name).length.toLocaleString()],
    ["Provider groups", new Set(practices.filter(p => p.group_size > 1).map(p => p.cqc_provider_id)).size.toLocaleString()]].map(([k, v]) => `<div class="flex justify-between py-0.5 border-b border-slate-50"><span class="text-slate-500">${k}</span><span class="font-medium">${esc(v)}</span></div>`).join("");
  const { data: runs } = await db.from("ingest_runs").select("id,started_at,finished_at,status,error,stats").order("id", { ascending: false }).limit(6);
  $("d-runs").innerHTML = `<table class="w-full"><thead class="text-slate-500"><tr><th class="text-left font-medium py-1">Started</th><th class="text-left font-medium">Status</th><th class="text-left font-medium">Notes</th></tr></thead><tbody>` +
    (runs || []).map(r => { const st = r.stats || {}, notes = r.error ? r.error.split("\n")[0].slice(0, 90) : [st.practices_changed != null ? st.practices_changed + " practices changed" : "", st.cqc_error ? "CQC error" : "", st.oscar_error ? "Oscar not loaded" : "", st.patients_missing ? "no patient counts" : ""].filter(Boolean).join(" · ");
      return `<tr class="border-t border-slate-100"><td class="py-1 whitespace-nowrap">${esc(fmtDate(r.started_at))}</td><td>${chip(r.status, r.status === "success" ? "bg-emerald-100 text-emerald-800" : r.status === "failed" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600")}</td><td class="text-slate-500">${esc(notes)}</td></tr>`; }).join("") + `</tbody></table>`;
  renderRateCard();
}

/* ---------- Data tab: sub-tabs ---------- */
let dataSub = "overview";
function setDataSub(which) {
  dataSub = which;
  for (const k of ["overview", "sources", "signals", "pricing"]) $("dp-" + k).classList.toggle("hidden", k !== which);
  $("data-sub").querySelectorAll("button").forEach(b => b.className = "px-3 py-1 rounded-md " + (b.dataset.d === which ? "bg-white shadow-sm" : "text-slate-500"));
  stateToUrl();
}
$("data-sub").querySelectorAll("button").forEach(b => b.onclick = () => setDataSub(b.dataset.d));

/* ---------- rate card: one table per price route ---------- */
const ROUTES = [
  ["practice", "Single practices", "One practice signs on its own."],
  ["pcn", "PCNs / clusters", "Every practice in a PCN (or Scottish / Welsh cluster) signs together; tier is set by the combined list size."],
  ["group", "Provider groups", "All practices run by one CQC provider sign together (for example Modality). Starts from the PCN schedule; edit to differ."],
  ["federation", "Federations", "All practices in a federation sign together. Starts from the PCN schedule; edit to differ."]];
function renderRateCard() {
  const list = Number(cfgSettings.list_price_per_patient?.value || 0);
  const settings = Object.values(cfgSettings).filter(x => x.key !== "list_price_per_patient");
  const table = r => {
    const rows = cfgTiers.filter(t => t.route === r).sort((a, b) => a.tier - b.tier);
    if (!rows.length) return '<p class="text-sm italic text-slate-500">No tiers configured for this route.</p>';
    return `<table class="w-full text-sm"><thead class="text-xs uppercase tracking-wider text-slate-500"><tr><th class="text-left py-1.5 font-medium">Tier</th><th class="text-right font-medium">From (patients)</th><th class="text-right font-medium">Size discount</th><th class="text-right font-medium">Price / patient</th><th class="text-right font-medium">Year 1 (${pct(rows[0].speed_discount)} speed discount)</th></tr></thead><tbody>` +
      rows.map(t => { const p = list * (1 - Number(t.size_discount)), floor = Number(cfgSettings.price_floor_per_patient?.value || 0), y1 = Math.max(floor, list * (1 - Number(t.size_discount) - Number(t.speed_discount))); return `<tr class="border-t border-slate-100"><td class="py-1.5">${chip("T" + t.tier, TIER_CLS["Tier " + t.tier] || "")} ${esc(t.label)}</td><td class="text-right font-mono">${Number(t.threshold) ? Number(t.threshold).toLocaleString() + "+" : "any size"}</td>
        <td class="text-right">${pct(t.size_discount)}</td><td class="text-right font-mono font-semibold">£${p.toFixed(3)}</td><td class="text-right font-mono text-slate-600">£${y1.toFixed(3)}</td></tr>`; }).join("") + "</tbody></table>";
  };
  $("rev-config").innerHTML = `<div class="bg-white rounded-xl border border-slate-200 p-4">
      <h2 class="font-bold">How prices are worked out</h2>
      <div class="mt-2 grid gap-3 md:grid-cols-4 text-sm">
        ${[["1", "List price", `£${list.toFixed(3)} per patient per year (${esc(cfgSettings.list_price_per_patient?.description || "annual list price")})`], ["2", "Discounts add together", "Size discount (by tier), plus a term discount for 2 or 3-year commitments, plus a Year 1 speed discount. Their percentages are summed and taken off the list price."], ["3", "Price floor", "The price never drops below the floor price per patient, whatever the discounts add up to."], ["4", "× patients", "Annual revenue = price per patient × registered patients."]]
          .map(([n, h, t]) => `<div class="flex gap-2"><span class="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-800 text-xs font-bold flex items-center justify-center">${n}</span><div><div class="font-semibold">${h}</div><div class="text-xs text-slate-500">${t}</div></div></div>`).join("")}
      </div>
      <p class="mt-3 text-xs text-slate-500">The routes below are alternatives, not additive. Rates live in the <code>pricing_tiers</code> and <code>pricing_settings</code> tables (Supabase > Table Editor); changes show here and in every profile straight away.</p>
    </div>` + `<div class="grid gap-4 lg:grid-cols-2">` + ROUTES.map(([r, name, blurb]) => `<div class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-bold">${name}</h3><p class="text-xs text-slate-500 mb-2">${blurb}</p>${table(r)}</div>`).join("") + `</div>` +
    (settings.length ? `<div class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-bold mb-1">Other settings</h3>${settings.map(x => `<div class="flex justify-between border-t border-slate-100 py-1 text-sm first:border-0"><span class="text-slate-500">${esc(x.description || x.key)}</span><span class="font-mono">${esc(x.value)}</span></div>`).join("")}</div>` : "");
}

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
function readDevolvedFile(text, fileName) {
  const rows = parseCsv(text.replace(/^\uFEFF/, "")), head = (rows[0] || []).map(h => h.trim().toLowerCase());
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
const UPLOAD_KIND = { scotland: "Scotland practices", "wales-clusters": "Wales practices and clusters", "wales-sizes": "Wales patient numbers (StatsWales)" };
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
    box.innerHTML = UPLOADS.map(u => `<div class="border border-slate-200 rounded-lg p-3 ${u.multiple ? "md:col-span-2" : ""}" id="up-${u.id}">
      <div class="flex justify-between gap-2"><h3 class="font-semibold text-sm">${esc(u.title)}</h3><span class="text-xs text-slate-500 whitespace-nowrap">${esc(u.cadence)}</span></div>
      <p class="text-xs text-slate-500">${esc(u.gives)}</p>
      <p class="text-xs mt-1">${u.links.map(([h, l]) => `<a class="text-blue-600 underline" target="_blank" rel="noopener" href="${esc(h)}">${esc(l)}</a>`).join("<br>")}<br><span class="text-slate-500">File${u.multiple ? "s" : ""}: ${esc(u.file)}</span></p>
      <div class="mt-2 flex flex-wrap items-center gap-2"><input type="file" accept=".csv,text/csv" ${u.multiple ? "multiple" : ""} class="up-file text-xs max-w-[22rem]"><input type="month" class="up-month border border-slate-300 rounded px-2 py-1 text-xs"><button disabled class="up-load bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Load</button></div>
      <p class="up-msg mt-1 text-xs text-slate-600 min-h-[1rem] whitespace-pre-line"></p><p class="up-status mt-1 text-xs text-slate-500"></p></div>`).join("");
    for (const u of UPLOADS) {
      const el = $("up-" + u.id), q = c => el.querySelector(c), say = t => { q(".up-msg").textContent = t; }; let parsed = [];
      q(".up-file").addEventListener("change", async e => {
        const files = [...e.target.files]; parsed = []; q(".up-load").disabled = true; if (!files.length) return;
        const lines = []; let ok = true;
        for (const f of files) {
          if (f.size > 60 * 1024 * 1024) { lines.push(`${f.name}: too large, check you have the right file.`); ok = false; continue; }
          try { const p = u.parse(await f.text(), f.name); parsed.push(p); lines.push(`${f.name}: ${p.label ? p.label + ", " : ""}${p.count.toLocaleString()} practices${p.month ? " (" + p.month + ")" : " (month not found: check the month box)"}`); }
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
  for (const u of UPLOADS) $("up-" + u.id).querySelector(".up-status").textContent = "In the database: " + u.status();
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
