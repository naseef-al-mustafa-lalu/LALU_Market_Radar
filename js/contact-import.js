/* Data > Data sources: contacts from a HubSpot export. The file is read and checked in the browser (the browser twin of src/contact_quality.py: keep them in step),
   then staged in contact_candidates. Direct addresses for decision-makers are approved into Atlas's contacts, shared mailboxes become the practice's one generic address,
   and everything unclear waits here for a person. Uploading the next export updates known contacts and sends new ones through the same checks. */
const CQ = {
  genStart: /^(enquir|info|admin|reception|contact|office|practice|manager|secretar|appointment|hello|test|noreply|no-reply|team|general|help|booking|dispensary|prescription|referral|complaint|feedback|patient|surgery|medical|health|clinic|nursing|front|desk|hr|finance|accounts|pcn|gp|enq|mail|post|duty|triage|admissions|records|wecare|care)/i,
  genAny: /(surgery|medical|practice|centre|center|health|clinic|reception|admin|enquir|team|office|partnership|dispens|appointment|secretar|manager|pcn|nhs|icb|ccg|group|mailbox|shared)/i,
  odsIn: /(^|[._-])[a-z]\d{5}($|[._-])/i, mail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  exclude: /nurse|anp\b|practitioner|paramedic|pharmac|physio|health ?care assistant|hca|phlebot|receptionist|reception(?!\s*manager)|secretar|clerk|summar|coder|dispens|care coordinator|salaried|locum|registrar|trainee|student|apprentice|dropped on|gp staff|other practice staff|administrator$|^admin$|^administrator/i,
  tierA: /practice\s*\/?\s*(business\s*)?manager|business\s*\/?\s*practice\s*manager|general\s*(practice\s*)?manager|business manager|operations? manager|operational manager|practice director|managing director|executive manager|office manager|^manager$|group practice manager|joint practice manager|senior partner|managing partner|management partner|gp partner|partner|^practice\s*manager/i,
  tierB: /deputy|assistant (practice )?manager|assistant manager|finance|hr manager|human resources|pcn (clinical )?director|pcn manager|clinical director|digital|transformation|patient services manager|administration manager|reception manager|business partner|head of|lead$/i,
  roleA: new Set(["Practice Manager", "Senior Partner / Managing Partner", "GP Partner", "Business Manager", "Operations Manager", "PCN Clinical Director"]), badBounce: new Set(["Unknown user", "Other", "Policy"]),
};
const cqLetters = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
function cqEmailQuality(email, first = "", last = "") {
  const e = (email || "").trim().toLowerCase(); if (!e) return ["no_email", "no email"]; if (!CQ.mail.test(e)) return ["invalid", "bad syntax"];
  const loc = e.split("@")[0], f = cqLetters(first), l = cqLetters(last), plain = loc.replace(/\d+/g, ""), ll = cqLetters(plain);
  if (ll === "test") return ["reject", "test address"];
  const fIn = !!f && f.length > 1 && ll.includes(f), lIn = !!l && l.length > 2 && ll.includes(l);
  if ((fIn && lIn) || (f && l && ll.startsWith(f[0]) && ll.includes(l))) return ["direct", "name in address"];
  if (CQ.odsIn.test(loc) || CQ.genStart.test(loc) || CQ.genAny.test(plain)) return ["shared", "generic or shared mailbox pattern"];
  if (fIn || lIn) return ["likely_direct", "part of the name is in the address"];
  if (/^[a-z]+[._][a-z]+$/.test(plain)) return f && l ? ["check", "personal-style address, name differs"] : ["likely_direct", "personal-style address, no name on record"];
  return ["check", "unclear"];
}
function cqRoleTier(title, role = "") {
  const t = (title || "").trim(), r = (role || "").trim();
  if (/dropped on/i.test(t)) return ["x", "dropped"];
  if (/deputy|assistant/i.test(t) && CQ.tierB.test(t)) return ["B", "secondary decision-maker"];
  if ((CQ.tierA.test(t) || (!t && CQ.tierA.test(r))) && !/nurse|anp|practitioner/i.test(t)) return ["A", "decision-maker"];
  if (CQ.tierB.test(t) || (!t && CQ.tierB.test(r))) return ["B", "secondary decision-maker"];
  if (CQ.exclude.test(`${t} | ${r}`)) return ["x", "not a decision-maker"];
  if (!t && CQ.roleA.has(r)) return ["A", "role field"];
  return ["?", "unclear role"];
}
function cqSuggest(quality, tier, hasCompany = true, optedOut = false, bounce = "") {
  if (optedOut || CQ.badBounce.has(bounce)) return ["suppressed", optedOut ? "opted out" : "email bounced"];
  if (!hasCompany) return ["rejected", "no company on the HubSpot contact"];
  if (["no_email", "invalid", "reject"].includes(quality)) return ["rejected", { no_email: "no email", invalid: "bad email syntax", reject: "test address" }[quality]];
  if (quality === "shared") return ["generic", "shared mailbox: kept as the practice's generic address"];
  if (tier === "x") return ["rejected", "not a decision-maker"];
  if (quality === "direct" && tier === "A") return ["approved", "direct address, decision-maker"];
  return ["review", "needs a person to check " + (quality === "direct" ? "the role" : tier === "A" || tier === "B" ? "the address" : "address and role")];
}
// Rows of a HubSpot contacts export -> what load_contact_candidates takes. Contacts without an email are not stored.
function readHubspotContacts(text) {
  const rows = parseCsv(text.replace(/^﻿/, "")), head = (rows[0] || []).map(h => h.trim()), ix = n => head.indexOf(n);
  for (const need of ["Record ID", "Email", "Primary Associated Company ID", "First Name", "Last Name"]) if (ix(need) < 0) throw new Error(`Not a HubSpot contacts export: no "${need}" column.`);
  const g = (x, n) => { const i = ix(n); return i >= 0 && x[i] != null ? x[i].trim() : ""; }, out = []; let noEmail = 0, noOptCols = ix("Opted out of email: One to One") < 0;
  for (const x of rows.slice(1)) {
    if (!x.length || !g(x, "Record ID")) continue;
    if (!g(x, "Email")) { noEmail++; continue; }
    const first = g(x, "First Name"), last = g(x, "Last Name"), title = g(x, "Job Title"), role = g(x, "Job Role"), email = g(x, "Email").toLowerCase(), optedOut = g(x, "Opted out of email: One to One") === "Yes", bounce = g(x, "Email hard bounce reason");
    const [quality] = cqEmailQuality(email, first, last), [tier] = cqRoleTier(title, role), [status, reason] = cqSuggest(quality, tier, !!g(x, "Primary Associated Company ID"), optedOut, bounce);
    const bounced = CQ.badBounce.has(bounce), phone = g(x, "Phone Number");
    out.push({ id: g(x, "Record ID"), company_id: g(x, "Primary Associated Company ID"), first, last, email, phone, title, role, quality: quality === "reject" || quality === "invalid" || quality === "no_email" ? null : quality, tier, status, reason, opted_out: optedOut, bounced,
      hash: [first, last, email, phone, title, role, g(x, "Primary Associated Company ID"), optedOut, bounced].join("|") });
  }
  return { rows: out, noEmail, noOptCols };
}
// The export arrives as a zip holding one CSV; read it with the browser's own inflate, or take a plain CSV as it is.
async function contactFileText(file) {
  if (!/\.zip$/i.test(file.name)) return file.text();
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer), td = new TextDecoder();
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--; if (e < 0) throw new Error(`${file.name} is not a zip file.`);
  let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0; i--) {
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), name = td.decode(buf.subarray(p + 46, p + 46 + nl)), method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), off = dv.getUint32(p + 42, true);
    if (/\.csv$/i.test(name)) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = buf.subarray(start, start + size);
      return method === 0 ? td.decode(data) : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error("No CSV inside the zip.");
}
const CI_LABEL = { approved: "Approved", review: "To review", generic: "Generic address", rejected: "Rejected", suppressed: "Suppressed (opted out or bounced)" };
let ciParsed = null, ciReview = [];
function renderContactImport() {
  const box = $("contact-import"); if (!box || box.dataset.ready) return; box.dataset.ready = "1";
  box.innerHTML = `<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><h2 class="font-bold">Contacts from HubSpot <span class="text-xs font-normal text-slate-500">(export all contacts, choose the zip or CSV, check the counts, press Load)</span></h2>
    <p class="mt-1 text-xs text-slate-500">Only direct email addresses for decision-makers (practice, business and operations managers, partners, directors) are approved. Shared mailboxes such as enquiries@ become the practice's single generic address, never a contact. Anything unclear waits for you below. Opted-out and bounced addresses are suppressed. Upload a fresh export any time: known contacts are updated, new ones go through the same checks.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2"><input type="file" id="ci-file" accept=".zip,.csv,text/csv" class="max-w-[22rem] text-xs"><button type="button" id="ci-load" disabled class="rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Load</button></div>
    <p id="ci-msg" class="mt-2 min-h-[1rem] whitespace-pre-line text-xs text-slate-600"></p><div id="ci-state" class="mt-3"></div></div>`;
  const say = t => { $("ci-msg").textContent = t; };
  $("ci-file").addEventListener("change", async e => {
    const f = e.target.files[0]; ciParsed = null; $("ci-load").disabled = true; if (!f) return;
    if (f.size > 80 * 1024 * 1024) { say("That file is too large: check it is the contacts export."); return; }
    try {
      ciParsed = readHubspotContacts(await contactFileText(f)); const c = {}; for (const r of ciParsed.rows) c[r.status] = (c[r.status] || 0) + 1;
      say(`${ciParsed.rows.length.toLocaleString()} contacts with an email (${ciParsed.noEmail.toLocaleString()} without an email are skipped): ` + Object.keys(CI_LABEL).map(k => `${(c[k] || 0).toLocaleString()} ${CI_LABEL[k].toLowerCase()}`).join(", ") + "."
        + (ciParsed.noOptCols ? "\nThis export has no opt-out column: re-export with the opt-out and bounce columns before loading." : "\nPress Load."));
      $("ci-load").disabled = ciParsed.noOptCols;
    } catch (err) { say(err.message); }
  });
  $("ci-load").addEventListener("click", async () => {
    if (!ciParsed) return; $("ci-load").disabled = true; const t = { new: 0, changed: 0, suppressed: 0, promoted: 0, generic: 0 };
    try {
      for (let i = 0; i < ciParsed.rows.length; i += 1000) {
        say(`Loading ${Math.min(i + 1000, ciParsed.rows.length).toLocaleString()} of ${ciParsed.rows.length.toLocaleString()}…`);
        const { data, error } = await db.rpc("load_contact_candidates", { p_rows: ciParsed.rows.slice(i, i + 1000), p_first: i === 0 }); if (error) throw error;
        for (const k of Object.keys(t)) t[k] += data[k] || 0;
      }
      say(`Done: ${t.new.toLocaleString()} new contacts staged, ${t.changed.toLocaleString()} updated, ${t.promoted.toLocaleString()} added to Atlas contacts, ${t.suppressed.toLocaleString()} suppressed, ${t.generic.toLocaleString()} practice generic addresses added.`);
      ciParsed = null; await contactImportState();
    } catch (err) { say(err.message); $("ci-load").disabled = false; }
  });
  contactImportState();
}
async function contactImportState() {
  const el = $("ci-state"); if (!el) return;
  const count = async (tbl, f) => { let q = db.from(tbl).select("*", { count: "exact", head: true }); if (f) q = f(q); const { count: n } = await q; return n || 0; };
  const [st, gen, changed, missing] = await Promise.all([Promise.all(Object.keys(CI_LABEL).map(k => count("contact_candidates", q => q.eq("status", k)))), count("practice_generic_emails"), count("contact_candidates", q => q.not("change_note", "is", null)), count("contact_candidates", q => q.eq("in_latest", false))]);
  const total = st.reduce((a, b) => a + b, 0); if (!total) { el.innerHTML = '<p class="text-sm text-slate-500">Nothing loaded yet.</p>'; return; }
  const { data } = await db.from("contact_candidates").select("hubspot_contact_id,email,ods_code,first_name,last_name,job_title,job_role,email_quality,role_tier,reason,change_note").eq("status", "review").order("ods_code").limit(200);
  ciReview = data || [];
  el.innerHTML = `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">${Object.keys(CI_LABEL).map((k, i) => `<div class="rounded-lg border border-slate-200 p-2"><div class="text-[11px] uppercase tracking-wider text-slate-500">${CI_LABEL[k]}</div><div class="text-lg font-bold">${st[i].toLocaleString()}</div></div>`).join("")}
      <div class="rounded-lg border border-slate-200 p-2"><div class="text-[11px] uppercase tracking-wider text-slate-500">Practices with a generic address</div><div class="text-lg font-bold">${gen.toLocaleString()}</div></div></div>
    ${changed ? `<p class="mt-2 text-xs text-slate-600"><b>${changed.toLocaleString()}</b> contacts changed in the last export${missing ? `; <b>${missing.toLocaleString()}</b> are no longer in the latest export (kept, not deleted)` : ""}.</p>` : missing ? `<p class="mt-2 text-xs text-slate-600"><b>${missing.toLocaleString()}</b> are no longer in the latest export (kept, not deleted).</p>` : ""}
    ${ciReview.length ? `<div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-sm font-bold">To review</span><span class="text-xs text-slate-500">${st[1].toLocaleString()} waiting; showing the first ${ciReview.length}. Approve only people with a direct address who make decisions.</span>
      <span class="ml-auto flex gap-2"><button type="button" id="ci-approve" class="rounded-md bg-lalu-navy px-3 py-1 text-xs font-semibold text-white">Approve ticked</button><button type="button" id="ci-reject" class="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold">Reject ticked</button></span></div>
      <div class="mt-1 max-h-96 overflow-y-auto rounded-lg border border-slate-200">${ciReview.map(r => { const p = byOds.get(r.ods_code), nm = [r.first_name, r.last_name].filter(Boolean).join(" ") || "No name";
        return `<label class="flex cursor-pointer items-start gap-3 border-t border-slate-100 px-3 py-2 first:border-0 hover:bg-slate-50"><input type="checkbox" class="ci-chk mt-1 h-4 w-4 accent-lalu-teal-700" value="${esc(r.hubspot_contact_id)}">
          <span class="min-w-0 flex-1"><span class="block text-sm font-semibold">${esc(nm)} <span class="font-normal text-slate-500">${esc(r.job_title || r.job_role || "no title")}</span></span><span class="block truncate text-xs text-slate-600">${esc(r.email || "")} · ${esc(p ? p.practice_name : r.ods_code || "")}</span>
          <span class="block text-[11px] text-amber-700">${esc(r.change_note || r.reason || "")}</span></span></label>`; }).join("")}</div>` : '<p class="mt-3 text-sm text-slate-500">Nothing is waiting for review.</p>'}`;
  const decide = async decision => {
    const ids = [...el.querySelectorAll(".ci-chk:checked")].map(c => c.value); if (!ids.length) return;
    const { data: r, error } = await db.rpc("review_contact_candidates", { p_ids: ids, p_decision: decision }); if (error) { $("ci-msg").textContent = error.message; return; }
    $("ci-msg").textContent = `${r.decided} contact${r.decided === 1 ? "" : "s"} ${decision}.`; contactImportState();
  };
  const a = $("ci-approve"), r = $("ci-reject"); if (a) { a.onclick = () => decide("approved"); r.onclick = () => decide("rejected"); }
}
