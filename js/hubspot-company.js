// HubSpot, part 2 of 3: finding the company, the company page (contacts, leads, deals), the create forms, and the pricing preview / write / check. Loaded after hubspot.js.
/* step 1: find the company and deal */
const hsFind = () => `<p class="text-slate-600">Find the HubSpot company for this practice, then choose its deal. This is saved so you only do it once.</p>
  <div class="mt-3 flex gap-2"><input id="hs-q" class="flex-1 rounded-lg border border-slate-300 px-3 py-2" value="${esc(hs.p.practice_name + " " + hs.p.ods_code)}" aria-label="Search HubSpot companies">
  <button id="hs-search" class="rounded-lg bg-lalu-navy px-3 py-2 font-semibold text-white">Search</button></div><div id="hs-results" class="mt-3"></div>`;
function hsBindFind(auto) {
  const run = async () => {
    const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Searching HubSpot…</p>';
    try {
      const { companies } = await hsCall({ action: "find", ods: hs.p.ods_code, name: hs.p.practice_name, query: $("hs-q").value });
      box.innerHTML = companies.length ? companies.map(c => `<button type="button" data-co="${esc(c.id)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-lalu-teal hover:bg-lalu-teal-50">
          <div class="flex justify-between gap-3"><b>${esc(c.name)}</b><span class="text-xs ${c.match === "ODS code" ? "text-emerald-700" : "text-slate-500"}">matched on ${esc(c.match)}</span></div>
          <div class="text-xs text-slate-500">ODS ${esc(c.partner_organisation_code || "not set")} · list size ${c.patient_list_size ? Number(c.patient_list_size).toLocaleString() : "not set"}</div></button>`).join("")
        : '<p class="text-slate-500 italic">No companies found. Try a shorter name.</p>';
      box.insertAdjacentHTML("beforeend", `<div class="mt-1 flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500"><span>${companies.length ? "Not the right one?" : "Nothing matches."}</span><button id="hs-new" class="font-semibold text-lalu-teal-700 hover:underline">Create ${esc(hs.p.practice_name)} in HubSpot</button></div>`);
      $("hs-new").onclick = () => hsCreateOpen(hs.p);
      box.querySelectorAll("[data-co]").forEach(b => b.onclick = () => hsCompanyPage(b.dataset.co));
    } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
  };
  $("hs-search").onclick = run; $("hs-q").onkeydown = e => { if (e.key === "Enter") run(); };
  if (auto) run();
}
// shared form pieces for the create-deal and create-lead forms
const hsField = (label, inner) => `<label class="block"><span class="mb-0.5 block text-xs font-semibold text-slate-600">${label}</span>${inner}</label>`, hsInp = "w-full rounded-lg border border-slate-300 px-2 py-1.5";
const hsOpts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
// owners and pipelines are fetched once per modal in the background, so the lead and deal forms open without waiting on HubSpot
let hsPreCache = null;   // owners and pipelines do not depend on the company: reuse them for ten minutes
const hsPrefill = companyId => hs.pre ? Promise.resolve(hs.pre) : (hs.prePromise = hs.prePromise || hsCall({ action: "deal_prefill", companyId, noContacts: true }).then(r => (hsPreCache = { at: Date.now(), pre: r }, hs.pre = r), e => { hs.prePromise = null; throw e; }));
const hsSkeleton = n => '<div class="space-y-3" aria-label="Loading">' + Array.from({ length: n }, () => '<div class="h-16 animate-pulse rounded-xl bg-slate-100"></div>').join("") + '</div>';
const hsHubCache = {};   // companyId -> { at, hub }: reopening a company shows the last read at once, then refreshes it
const hsTitle = (...parts) => { $("hs-title").textContent = ["Atlas", hs.p.practice_name, ...parts].join(" › "); };
/* contacts Atlas holds for a practice: those that can be sent to HubSpot, and those that cannot (with the reason) */
async function hsAtlasContacts(p, have = new Set()) {
  const { data: cs } = await db.from("contacts").select("full_name,job_title,email,phone,email_opt_out,hubspot_status").eq("ods_code", p.ods_code).limit(50);
  const rows = (cs || []).filter(c => c.hubspot_status !== "Imported").map(c => ({ name: c.full_name, jobtitle: c.job_title, email: c.email, phone: c.phone, optout: c.email_opt_out }));
  if (!rows.length && p.manager_email) rows.push({ name: p.manager_name, jobtitle: p.manager_title, email: p.manager_email, phone: p.manager_phone, optout: p.manager_email_opt_out });
  const ok = [], skipped = [];
  for (const c of rows) {
    const why = !c.email ? "no email address" : c.optout ? "email opt-out" : have.has(c.email.toLowerCase()) ? "already in HubSpot" : "";
    if (!why) ok.push(c); else if (why !== "already in HubSpot") skipped.push({ ...c, why });
  }
  return { ok, skipped };
}
/* one contact picker for create-company and add-contacts: ticked list, skipped people greyed with the reason */
const hsPicker = (list, cls, skipped = []) => list.map((c, i) => `<label class="flex cursor-pointer items-start gap-2 border-t border-slate-100 py-1.5 first:border-0"><input type="checkbox" class="${cls} mt-1" data-i="${i}" checked><span class="min-w-0"><b>${esc(c.name || "Unnamed")}</b> <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} · ${esc(c.email)}</span></span></label>`).join("")
  + skipped.map(c => `<div class="flex items-start gap-2 border-t border-slate-100 py-1.5 text-slate-400"><input type="checkbox" disabled class="mt-1"><span><b>${esc(c.name || "Unnamed")}</b> <span class="text-xs">not added: ${esc(c.why)}</span></span></div>`).join("");
const hsPicked = (list, cls) => [...document.querySelectorAll("." + cls + ":checked")].map(x => list[+x.dataset.i]);
const hsNameOf = c => [c.firstname, c.lastname].filter(Boolean).join(" ") || c.email || "Unnamed";

/* the company page: Company > Contacts > Leads > Deals. Loaded once, then updated in place so going back is instant. */
const hsStep = (n, label, done, note) => `<div class="flex min-w-0 flex-1 items-center gap-2"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}">${done ? "✓" : n}</span><div class="min-w-0"><div class="text-xs font-semibold text-slate-700">${label}</div><div class="truncate text-[11px] text-slate-500">${note}</div></div></div>`;
async function hsCompanyPage(companyId, force) {
  if (!hs.pre && hsPreCache && Date.now() - hsPreCache.at < 600000) hs.pre = hsPreCache.pre;
  hsRender('<div id="hs-results"></div>'); hsTitle();
  const load = async () => {
    const h = await hsCall({ action: "hub", companyId }), a = await hsAtlasContacts(hs.p, new Set(h.contacts.map(c => (c.email || "").toLowerCase())));
    return (hsHubCache[companyId] = { at: Date.now(), hub: { ...h, extra: a.ok, skipped: a.skipped } }).hub;
  };
  const cached = hsHubCache[companyId];
  if (!force && hs.hub && hs.hub.company.id === companyId) return hsHubRender();
  if (!force && cached && Date.now() - cached.at < 300000) {
    hs.hub = cached.hub; hsHubRender(); hsPrefill(companyId).catch(() => {});
    load().then(h => { const idle = $("hs-newlead") && $("hs-addpanel")?.classList.contains("hidden") !== false; if (hs && idle && hs.hub === cached.hub) { hs.hub = h; hsHubRender(); } }).catch(() => {});   // refresh quietly unless the user is mid-action
    return;
  }
  $("hs-results").innerHTML = hsSkeleton(3);
  try { hs.hub = await load(); } catch (e) { $("hs-results").innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Retry</button>`; $("hs-retry").onclick = () => hsCompanyPage(companyId, true); return; }
  hsHubRender(); hsPrefill(companyId).catch(() => {});
}
function hsHubRender() {
  const box = $("hs-results"), p = hs.p, h = hs.hub, co = h.company, leads = h.leads, nLeads = leads ? leads.length : 0, next = !h.contacts.length ? 2 : !nLeads && !h.deals.length ? 3 : 4;
  const btn = (id, label, primary) => `<button id="${id}" class="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold ${primary ? "bg-lalu-navy text-white hover:bg-lalu-navy-700" : "border border-slate-300 hover:bg-slate-50"}">${label}</button>`;
  const card = (n, title, count, action, body) => `<section class="rounded-xl border ${next === n ? "border-slate-400 shadow-sm" : "border-slate-200"} p-3"><div class="mb-2 flex items-center justify-between gap-3"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">${n}. ${title} <span class="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] normal-case text-slate-600">${count}</span></h4>${action}</div>${body}</section>`;
  const row = (l, r, fresh) => `<div class="flex items-center justify-between gap-3 border-t border-slate-100 py-1.5 first:border-0 ${fresh ? "-mx-1 rounded bg-emerald-50 px-1" : ""}"><div class="min-w-0">${l}</div><div class="shrink-0 text-right text-xs text-slate-500">${r}</div></div>`;
  const empty = t => `<p class="text-sm italic text-slate-500">${t}</p>`, flash = hs.flash; hs.flash = null;
  const fresh = new Set(hs.fresh || []); hs.fresh = null;
  box.innerHTML = (flash ? `<div class="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900" role="status">${flash}</div>` : "")
    + `<div class="mb-3 flex gap-3" aria-label="Progress">${hsStep(1, "Company", true, "in HubSpot")}${hsStep(2, "Contacts", h.contacts.length > 0, h.contacts.length + " linked")}${hsStep(3, "Lead", nLeads > 0, leads ? nLeads + " found" : "unknown")}${hsStep(4, "Deal", h.deals.length > 0, h.deals.length + " found")}</div>
    <div class="space-y-3">
    ${card(1, "Company", "✓", hsLink("0-2", co.id, "Open"), `<div class="font-medium">${esc(co.name)}</div><div class="text-xs text-slate-500">ODS ${esc(co.partner_organisation_code || "not set")} · list size ${co.patient_list_size ? Number(co.patient_list_size).toLocaleString() : "not set"}</div>`)}
    ${card(2, "Contacts", h.contacts.length, h.extra.length ? btn("hs-addcontacts", `Add from Atlas (${h.extra.length})`, next === 2) : "",
      (h.contacts.map(c => row(`<b>${esc(hsNameOf(c))}</b> <span class="text-xs text-slate-500">${esc(c.jobtitle || "")}</span>`, hsLink("0-1", c.id, c.email || "open"), fresh.has(c.id))).join("") || empty("No contacts on this company yet."))
      + `<div id="hs-addpanel" class="mt-2 hidden rounded-lg bg-slate-50 p-2"><div class="mb-1 text-xs font-semibold text-slate-600">Choose who to add to ${esc(co.name)}</div>${hsPicker(h.extra, "ac-pick", h.skipped)}<div class="mt-2 flex justify-end gap-2"><button id="hs-addcancel" class="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Cancel</button><button id="hs-addgo" class="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">Add selected</button></div><div id="hs-addmsg" class="mt-1 text-xs" role="status"></div></div>`
      + (!h.extra.length && h.skipped.length ? `<div class="mt-2 text-xs text-slate-500">Not added: ${h.skipped.map(c => esc((c.name || c.email || "Unnamed") + " (" + c.why + ")")).join(", ")}</div>` : ""))}
    ${card(3, "Leads", leads ? nLeads : "?", btn("hs-newlead", "+ Create lead", next === 3),
      leads ? (leads.map(l => row(`<b>${esc(l.name)}</b>`, `${l.open ? "" : "closed · "}${esc(l.stage)} ${hsLink("0-136", l.id, "open")}`, fresh.has(l.id))).join("") || empty("No leads yet. A lead tracks the practice before there is a deal.")) : '<p class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Leads could not be read: add the crm.objects.leads.read scope to the HubSpot token.</p>')}
    ${card(4, "Deals", h.deals.length, btn("hs-newdeal", "+ Create deal", next === 4),
      h.deals.length ? '<div class="mb-1 text-xs text-slate-500">Choose a deal to push this practice\'s pricing to it.</div>' + h.deals.map(d => `<button type="button" data-deal="${esc(d.id)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-lalu-teal hover:bg-lalu-teal-50">
        <div class="flex justify-between gap-3"><b>${esc(d.dealname)}</b><span class="text-xs text-slate-500">${esc(d.dealstage || "")}</span></div>
        <div class="text-xs text-slate-500">${d.amount ? "£" + Number(d.amount).toLocaleString() : "no amount"} · ${esc(d.size_tier || "no size tier")} · ${esc(d.value_per_patient || "no value per patient")}</div></button>`).join("") : empty("No deals yet."))}</div>`;
  const company = { id: co.id, name: co.name };
  $("hs-newdeal").onclick = () => hsDealForm(company);
  $("hs-newlead").onclick = () => hsLeadForm(company);
  const ac = $("hs-addcontacts");
  if (ac) {
    ac.onclick = () => { $("hs-addpanel").classList.remove("hidden"); ac.classList.add("hidden"); };
    $("hs-addcancel").onclick = () => { $("hs-addpanel").classList.add("hidden"); ac.classList.remove("hidden"); };
    $("hs-addgo").onclick = async () => {
      const chosen = hsPicked(h.extra, "ac-pick"), go = $("hs-addgo"), msg = $("hs-addmsg"); if (!chosen.length) { msg.innerHTML = '<span class="text-rose-700">Tick at least one person.</span>'; return; }
      go.disabled = true; go.textContent = "Adding…"; msg.innerHTML = "";
      try {
        const r = await hsCall({ action: "add_contacts", ods: p.ods_code, companyId: co.id, contacts: chosen }), added = [];
        for (const d of r.contacts) { const src = chosen.find(c => c.email.toLowerCase() === d.email); const [f, ...l] = String(src?.name || "").split(/\s+/);
          h.contacts.push({ id: d.id, firstname: f || "", lastname: l.join(" "), jobtitle: src?.jobtitle || "", email: d.email }); added.push(d.id); }
        h.extra = h.extra.filter(c => !r.contacts.some(d => d.email === c.email.toLowerCase()));
        hs.fresh = added; hs.flash = `${r.contacts.length} contact${r.contacts.length === 1 ? "" : "s"} added to HubSpot.` + (r.warnings.length ? " " + esc(r.warnings.join("; ")) : "");
        hsHubRender();
      } catch (e) { go.disabled = false; go.textContent = "Retry"; msg.innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
    };
  }
  box.querySelectorAll("[data-deal]").forEach(b => b.onclick = async () => {
    box.innerHTML = '<p class="text-slate-500">Reading the records…</p>';
    try { Object.assign(hs, await hsCall({ action: "read", companyId: co.id, dealId: b.dataset.deal }), { linked: false }); hsPreview(); } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Back</button>`; $("hs-retry").onclick = () => hsHubRender(); }
  });
}

/* create a deal: every field is editable, then the normal push preview follows */
async function hsDealForm(company) {
  const box = $("hs-results");
  try {
    hsTitle("Create deal"); if (!hs.pre) box.innerHTML = hsSkeleton(3); const pre = await hsPrefill(company.id), p = hs.p, want = hs.want || hsDesired(p), contacts = (hs.hub && hs.hub.contacts) || pre.contacts;
    const lead = contacts[0] ? hsNameOf(contacts[0]) : (p.manager_name || "");
    const pipes = pre.pipelines, def = pipes.find(x => x.id === "default") || pipes[0], stageNew = def.stages.find(s => s.id === "appointmentscheduled") || def.stages[0];
    const close = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), amount = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
    const field = hsField, inp = hsInp;
    const opts = hsOpts;
    const w = want.line, annual = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
    const pt = (k, v, sub = "") => `<div class="rounded-lg bg-white px-2.5 py-1.5"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="font-mono font-semibold">${v}</div>${sub ? `<div class="text-[11px] text-slate-500">${sub}</div>` : ""}</div>`;
    const pricing = `<div class="mb-3 rounded-xl bg-slate-50 p-3"><div class="mb-2 flex items-center justify-between"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Pricing to be sent with this deal</h4><span class="text-xs text-slate-500">from the price card: ${esc(want.label)}</span></div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${pt("Patients", p.total_patients.toLocaleString(), esc(want.tier))}${pt("List price", "£" + rate3(want.list) + " /mo", "per patient")}
        ${pt("Total discount", pct(want.total), `size ${pct(want.size)} · term ${pct(want.term)} · speed ${pct(want.speed)}${want.referral > 0 ? " · referral " + pct(want.referral) : ""}`)}${pt("Net price", "£" + rate3(want.rate) + " /mo", "per patient")}</div>
      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">${pt("Annual revenue", gbpFull(annual), "becomes the deal Amount")}${pt("Line item", esc(w.productName), "billed monthly")}
        ${pt("Unit discount", "£" + rate3(Math.max(0, w.listUnit - w.netUnit)), "off £" + rate3(w.listUnit) + " /mo")}${pt("Contract term", w.term + " month" + (w.term > 1 ? "s" : ""), "the product")}</div></div>`;
    box.innerHTML = `${pricing}<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New deal on ${esc(company.name)}</h4>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="sm:col-span-2">${field("Deal name", `<input id="nd-name" class="${inp}" value="${esc(lead ? lead + " - " + company.name : company.name)}">`)}</div>
        ${field("Pipeline", `<select id="nd-pipe" class="${inp}">${opts(pipes.map(x => [x.id, x.label]), def.id)}</select>`)}
        ${field("Stage", `<select id="nd-stage" class="${inp}">${opts(def.stages.map(s => [s.id, s.label]), stageNew.id)}</select>`)}
        ${field("Deal type", `<select id="nd-type" class="${inp}">${opts([["newbusiness", "New Business"], ["New Business GP eMR", "New Business GP eMR"], ["Existing Business - Freemium", "Existing Business - Freemium"], ["Existing Business - PAYG", "Existing Business - PAYG"], ["Existing Business - SAR Only", "Existing Business - SAR Only"], ["Existing Business - GP eMR", "Existing Business - GP eMR"], ["Renewal", "Renewal"]], "newbusiness")}</select>`)}
        ${field("Product / service", `<select id="nd-prod" class="${inp}">${opts([["eMR+", "ReportSure - Managed Service"], ["eMR", "ReportSure - Self Service"]], "eMR+")}</select>`)}
        ${field("Deal owner", pre.owners ? `<select id="nd-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
        ${field("Close date", `<input id="nd-close" type="date" class="${inp}" value="${close}">`)}
        ${field("Amount (£, per year)", `<input id="nd-amount" type="number" min="0" step="0.01" class="${inp}" value="${amount}">`)}</div>
      ${contacts.length ? `<div class="mt-3"><div class="mb-1 text-xs font-semibold text-slate-600">Associate contacts</div>${contacts.map(c => `<label class="flex items-center gap-2 py-0.5"><input type="checkbox" data-nd-contact="${esc(c.id)}" ${!hs.picked || hs.picked.includes(c.id) ? "checked" : ""}><span>${esc([c.firstname, c.lastname].filter(Boolean).join(" ") || c.email)} <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} ${esc(c.email || "")}</span></span></label>`).join("")}</div>` : '<p class="mt-3 text-xs text-slate-500">This company has no contacts to associate.</p>'}
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <p class="mt-2 text-xs text-slate-500">The Amount starts at the annual revenue above. The pricing above (discounts, size tier, value per patient, commercial model and line item) is written to the deal straight after it is created, and checked against HubSpot on the same page.</p>
      <div id="nd-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nd-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nd-create" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Create deal and push pricing</button></div></div>`;
    $("nd-pipe").onchange = e => { const pp = pipes.find(x => x.id === e.target.value); $("nd-stage").innerHTML = opts(pp.stages.map(s => [s.id, s.label]), pp.stages[0].id); };
    $("nd-cancel").onclick = () => hsCompanyPage(company.id);
    $("nd-create").onclick = async () => {
      const b = $("nd-create"), msg = $("nd-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const close = $("nd-close").value, r = await hsCall({ action: "create_deal", ods: p.ods_code, companyId: company.id, contactIds: [...document.querySelectorAll("[data-nd-contact]:checked")].map(x => x.dataset.ndContact),
          deal: { dealname: $("nd-name").value.trim(), pipeline: $("nd-pipe").value, dealstage: $("nd-stage").value, dealtype: $("nd-type").value, product___service: $("nd-prod").value,
            hubspot_owner_id: $("nd-owner")?.value || "", closedate: close ? close + "T00:00:00Z" : "", amount: $("nd-amount").value } });
        hs.hub = null; delete hsHubCache[company.id]; Object.assign(hs, await hsCall({ action: "read", companyId: company.id, dealId: r.dealId }), { linked: false, auto: true }); hsPreview();
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create deal and push pricing"; }
    };
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
}

/* create a lead (Prospecting pipeline, New) before there is a deal */
async function hsLeadForm(company) {
  const box = $("hs-results"); hsTitle("Create lead");
  try {
    if (!hs.pre) box.innerHTML = hsSkeleton(2); const pre = await hsPrefill(company.id), p = hs.p, contacts = (hs.hub && hs.hub.contacts) || pre.contacts, openLeads = ((hs.hub && hs.hub.leads) || []).filter(l => l.open);
    const field = hsField, inp = hsInp;
    const opts = hsOpts;
    box.innerHTML = `<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New lead on ${esc(company.name)}</h4>
      <div class="grid gap-2 sm:grid-cols-2">
        <div class="sm:col-span-2">${field("Lead name", `<input id="nl-name" class="${inp}" value="${esc(company.name + " | Atlas")}">`)}</div>
        ${field("Primary contact", contacts.length ? `<select id="nl-contact" class="${inp}">${opts(contacts.map(c => [c.id, hsNameOf(c) + (c.jobtitle ? " · " + c.jobtitle : "")]), (hs.picked && hs.picked[0]) || contacts[0].id)}</select>` : '<div class="rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-800">A lead needs a contact. <button id="nl-addfirst" type="button" class="font-semibold underline">Add contacts first</button></div>')}
        ${field("Lead owner", pre.owners ? `<select id="nl-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
        ${field("Lead type", `<select id="nl-type" class="${inp}">${opts([["NEW_BUSINESS", "New business"], ["RE_ATTEMPTING", "Re-attempting"]], "NEW_BUSINESS")}</select>`)}
        ${field("Source campaign", `<select id="nl-camp" class="${inp}">${opts([["Atlas", "Atlas"], ["", "None"], ["Field Based Lead", "Field Based Lead"], ["PCN Prospecting", "PCN Prospecting"], ["ICB Prospecting", "ICB Prospecting"], ["ICB April 26", "ICB April 26"]], "Atlas")}</select>`)}</div>
      ${openLeads.length ? `<p id="nl-dup" class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">This company already has an open lead: ${openLeads.map(l => esc(l.name) + " (" + esc(l.stage) + ")").join(", ")}. Check it is not the same opportunity.</p>` : ""}
      <details class="mt-3 text-xs text-slate-600"><summary class="cursor-pointer font-semibold">What happens in HubSpot next</summary><p class="mt-1">The lead goes into the Prospecting Pipeline at New. HubSpot's lifecycle workflow then sets the contact to the Prospecting lifecycle stage (only when it is New or Engaged). Leads made here get no owner rotation and no sequence.</p></details>
      ${pre.warnings.map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <div id="nl-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nl-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Back</button><button id="nl-create" ${contacts.length ? "" : "disabled"} class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">Create lead</button></div></div>`;
    $("nl-cancel").onclick = () => hsHubRender();
    const af = $("nl-addfirst"); if (af) af.onclick = () => hsHubRender();
    const go = async force => {
      const b = $("nl-create"), msg = $("nl-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const contactId = $("nl-contact").value, r = await hsCall({ action: "create_lead", ods: p.ods_code, companyId: company.id, contactId, name: $("nl-name").value.trim(), ownerId: $("nl-owner")?.value || "", leadType: $("nl-type").value, campaign: $("nl-camp").value, force });
        if (r.ok === false) {
          msg.innerHTML = `<div class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">This contact already has an open lead: ${r.existing.map(l => esc(l.name)).join(", ")}. Creating another can duplicate work. <button id="nl-force" class="ml-1 font-semibold underline">Create anyway</button></div>`;
          $("nl-force").onclick = () => go(true); b.disabled = false; b.textContent = "Create lead"; return;
        }
        (hs.hub.leads = hs.hub.leads || []).unshift({ id: r.leadId, name: $("nl-name").value.trim(), stage: "New (Prospecting Pipeline)", open: true });
        hs.picked = [contactId]; hs.fresh = [r.leadId];
        hs.flash = `Lead created. ${hsLink("0-136", r.leadId, "Open it in HubSpot")}${r.companyLinked ? "" : " It could not be linked to the company; link it in HubSpot."}`;
        hsHubRender();
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create lead"; }
    };
    $("nl-create").onclick = () => go(false);
  } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><button id="hs-retry" class="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">Back</button>`; $("hs-retry").onclick = () => hsHubRender(); }
}

/* step 2: preview exactly what will be written */
const monthlyNote = () => " p/month";
function hsPreview() {
  hsTitle(hs.auto ? "Create deal" : "Push pricing");
  const { p, want, company, deal } = hs, pctShow = v => v == null ? "not set" : pct(v / HS_PCT);
  const sameNum = hsSame;
  const row = (label, now, next, same, note = "") => `<tr class="border-t border-slate-100"><td class="py-1.5 pr-2">${label}${note ? `<div class="text-xs text-slate-500">${note}</div>` : ""}</td><td class="py-1.5 px-2 text-right font-mono text-slate-600">${now}</td><td class="py-1.5 pl-2 text-right font-mono font-semibold ${same ? "text-slate-400" : "text-emerald-700"}">${same ? "no change" : next}</td></tr>`;
  const ch = hsChanges(p, want, company, deal, hs), checks = ch.fixes, diffs = checks.filter(c => !c.same), line = ch.line, w = want.line;
  const warn = diffs.length ? `<div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"><label class="flex items-start gap-2"><input id="hs-fix-all" type="checkbox" class="mt-0.5" checked>
        <span class="font-semibold text-amber-900">Update HubSpot to match the tool <span class="font-normal text-xs">(${diffs.length} field${diffs.length > 1 ? "s" : ""})</span></span></label>
      <ul class="mt-2 space-y-1 text-sm">${diffs.map(c => `<li class="flex justify-between gap-3"><span class="text-amber-900">${c.label}</span><span class="font-mono">${esc(c.now)} <span class="text-slate-400">→</span> <b>${esc(c.next)}</b></span></li>`).join("")}</ul>
      <div class="mt-1 text-xs text-amber-800">Check this is the right company and deal before writing. Untick to leave these fields alone.</div></div>`
    : '<div class="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900">List size, size tier, commercial model and value per patient all match the tool.</div>';
  // Sectioned preview: who it goes to, what changes (before -> after), the line item as a card, and what HubSpot will recalculate.
  const sectionCard = (title, badge, inner) => `<section class="mt-3 rounded-xl border border-slate-200 p-3"><div class="mb-1 flex items-center justify-between"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">${title}</h4>${badge}</div>${inner}</section>`;
  const badge = n => n ? `<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">${n} change${n > 1 ? "s" : ""}</span>` : '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">no changes</span>';
  const chg = (label, now, next, same) => `<div class="flex items-baseline justify-between gap-3 border-t border-slate-100 py-1.5 first:border-0"><span class="text-slate-700">${label}</span>${same
    ? `<span class="font-mono text-slate-400">${now} <span class="text-[11px]">unchanged</span></span>` : `<span class="font-mono"><span class="text-slate-500">${now}</span> <span class="text-slate-400">→</span> <b class="text-emerald-700">${next}</b></span>`}</div>`;
  const refShown = want.referral > 0 || hsNum(deal.referral_discount) > 0;
  const discRows = [["Size discount", deal.size_discount, hsPct(want.size), want.size], ["Speed discount", deal.speed_discount, hsPct(want.speed), want.speed], ["Term length discount", deal.term_length_discount, hsPct(want.term), want.term],
    ...(refShown ? [["Referral group discount", deal.referral_discount || 0, hsPct(want.referral), want.referral]] : [])]
    .map(([l, nowV, hv, tv]) => chg(l, pctShow(hsNum(nowV)), pct(tv), sameNum(nowV, hv))).join("") + chg("Term length (years)", esc(deal.term_length_years || "not set"), String(want.termYears), String(deal.term_length_years) === String(want.termYears));
  const nDeal = [sameNum(deal.size_discount, hsPct(want.size)), sameNum(deal.speed_discount, hsPct(want.speed)), sameNum(deal.term_length_discount, hsPct(want.term)), String(deal.term_length_years) === String(want.termYears), !refShown || sameNum(deal.referral_discount || 0, hsPct(want.referral))].filter(x => !x).length;
  const tile = (k, v, changed, sub = "") => `<div class="rounded-lg ${changed ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-slate-50"} px-3 py-2"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="font-mono font-semibold">${v}</div>${sub ? `<div class="text-[11px] text-slate-500">${sub}</div>` : ""}</div>`;
  const cur = line.cur, discNew = Math.max(0, w.listUnit - w.netUnit);
  const lineCard = line.unreadable ? '<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Line items cannot be read with the current HubSpot token. Add the <b>crm.objects.line_items.read / write</b> scopes (and e-commerce) to include the line item in this push.</div>'
    : `<div class="mb-2 text-sm font-semibold">${esc(w.productName)} ${line.action === "create" ? '<span class="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">new line</span>' : line.action === "replace" ? '<span class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">replaces ' + esc(cur.name || "existing line") + '</span>' : ""}</div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">${tile("Quantity", w.quantity.toLocaleString() + " patients", !cur || Number(cur.quantity) !== w.quantity, cur ? "now " + Number(cur.quantity).toLocaleString() : "")}
        ${tile("Unit price", "£" + rate3(w.listUnit) + " /mo", !cur || Math.abs((Number(cur.price) || 0) - w.listUnit) >= 0.0006, cur ? "now £" + rate3(Number(cur.price) || 0) : "set by the tool")}
        ${tile("Unit discount", "£" + rate3(discNew), !cur || Math.abs((Number(cur.discount) || 0) - discNew) >= 0.0006, cur ? "now £" + rate3(Number(cur.discount) || 0) : "")}
        ${tile("Net unit price", "£" + rate3(w.netUnit) + " /mo", false, "p/month")}
        ${tile("Contract term", w.term + " month" + (w.term > 1 ? "s" : ""), false, "the product (Annual or Monthly)")}
        ${tile("Billing", "Monthly", !cur || cur.recurringbillingfrequency !== "monthly", cur ? "now " + esc(cur.recurringbillingfrequency || "not set") : "everyone is billed monthly")}</div>`;
  const nLine = line.unreadable || line.same ? 0 : 1;
  const g = want.group, removing = !g && !want.member && hsNum(deal.referral_discount) > 0, mg = !g && want.member;
  const groupCard = g ? sectionCard("Referral group", '<span class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Conditional</span>', `<div class="text-sm text-slate-700">${g.members.map(m => esc(m.name) + " · " + m.patients.toLocaleString()).join("<br>")}</div>
      <p class="mt-2 text-xs text-slate-500">Combined list size ${g.combined.toLocaleString()}. This push writes Referral Discount ${pct(g.extra)}, adds a note to the deal listing the group and the 90-day condition, saves the group in the tool, and labels this deal against each referred practice's linked deal ("Referring practice" / "Referred practice"). A referred practice's deal is linked automatically when it is created or pushed in the tool.</p><div id="hs-rg-status" class="mt-2"></div>`)
    : mg ? sectionCard("Referred practice", want.referral > 0 ? '<span class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Group price</span>' : '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Priced alone</span>',
      `<p class="text-xs text-slate-600">${want.referral > 0 ? `Part of ${esc(byOds.get(want.member.lead_ods)?.practice_name || want.member.lead_ods)}'s referral group: Referral Discount ${pct(want.referral)} is written and the line item is priced at the group rate.` : "Priced alone: no referral discount is written."} This deal is linked to the referring practice's deal automatically.</p>`)
    : removing ? sectionCard("Referral group", '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Removing</span>', '<p class="text-xs text-slate-600">No referral group is selected in the profile, so Referral Discount goes back to 0, the line item is repriced for this practice alone, and the group is closed with a note on the deal.</p>') : "";
  hsRender(`<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div class="min-w-0"><div class="truncate font-semibold">${hsLink("0-2", company.id, company.name)}</div><div class="text-xs text-slate-500">ODS ${esc(company.partner_organisation_code || "not set")}</div></div>
      <div class="min-w-0 text-right"><div class="truncate font-semibold">${hsLink("0-3", deal.id, deal.dealname)}</div><div class="text-xs text-slate-500">${esc(deal.dealstage || "")} · ${hs.linked ? "saved link" : "link saved after the write"}</div></div></div>
    ${hs.auto ? '<div class="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900">Deal created. Writing the pricing and checking it against HubSpot…</div>' : ""}
    <div class="mt-1 flex items-center justify-between text-xs"><span class="font-semibold text-slate-600">Selected in the profile: ${esc(want.label)}</span>${hs.linked ? '<button id="hs-relink" class="text-lalu-teal-700 hover:underline">Choose a different deal</button>' : '<button id="hs-back" class="text-lalu-teal-700 hover:underline">Choose a different deal</button>'}</div>
    ${warn}
    ${sectionCard("Deal pricing fields", badge(nDeal), discRows)}
    ${groupCard}
    ${sectionCard("Line item", badge(nLine), lineCard)}
    ${sectionCard("HubSpot recalculates, then we check", "", `<div class="grid grid-cols-2 gap-2">${tile("Total discount", pctShow(hsNum(deal.total_discount)) + ' <span class="text-slate-400">→</span> ' + pct(want.total), false, "expected after the write")}
      ${tile("Actual value per patient", (deal.actual_value_per_patient_calculated ? "£" + rate3(deal.actual_value_per_patient_calculated) : "not set") + ' <span class="text-slate-400">→</span> £' + rate3(want.rate), false, "per month, expected")}</div>`)}
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-slate-200 bg-white pt-3"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Cancel</button><button id="hs-write" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Push pricing</button></div>`);
  $("hs-cancel").onclick = hsClose;
  if (g && $("hs-rg-status")) refLinkedSet(g.members).then(set => { const el = $("hs-rg-status"); if (el) el.innerHTML = refStatusLines(g.members, set); }).catch(() => {});
  const re = $("hs-relink") || $("hs-back"); if (re) re.onclick = () => { hs.linked = false; hsRender(hsFind()); hsBindFind(); };
  $("hs-write").onclick = () => hsWrite(checks);
  if (hs.auto) { hs.auto = false; hsWrite(checks); }   // a deal made here already shows its pricing in the form: write it without a second confirmation
}

/* step 3: write, then wait for HubSpot's calculated fields and compare them with the tool */
async function hsWrite(checks) {
  const { p, want, company, deal } = hs, msg = $("hs-msg"), fixIds = new Set(checks.filter(c => !c.same).map(c => c.id)), ticked = id => !!$("hs-fix-all")?.checked && fixIds.has(id);
  const dealProps = { size_discount: hsPct(want.size), speed_discount: hsPct(want.speed), term_length_discount: hsPct(want.term), term_length_years: String(want.termYears) };
  const companyProps = {};
  if (want.referral > 0 || hsNum(deal.referral_discount) > 0) dealProps.referral_discount = hsPct(want.referral);
  const referral = want.group ? want.group : hsNum(deal.referral_discount) > 0 && !want.member ? { revert: true } : undefined;
  if (ticked("tier")) dealProps.size_tier = want.tier;
  if (ticked("cm")) dealProps.commercial_model = want.model;
  if (ticked("vpp")) dealProps.value_per_patient = want.vpp;
  if (ticked("ls")) companyProps.patient_list_size = p.total_patients;
  $("hs-write").disabled = true; $("hs-write").textContent = "Writing…"; msg.innerHTML = "";
  try {
    const w = want.line, wr = await hsCall({ action: "write", ods: p.ods_code, companyId: company.id, dealId: deal.id, deal: dealProps, company: companyProps, referral,
      lineItem: hs.lineItems == null ? undefined : { productId: w.productId, quantity: w.quantity, listUnit: w.listUnit, netUnit: w.netUnit, termMonths: w.termMonths, frequency: w.frequency, terms: w.terms, payments: w.payments } });
    hs.lineItems = wr.lineItems ?? hs.lineItems; hs.warnings = wr.warnings || [];
    refSaved.delete(p.ods_code); refGroups = null; repaintPriceCards();   // the saved group strip reloads
    $("hs-write").classList.add("hidden"); $("hs-cancel").textContent = "Close";
    await hsValidate(6);
    hsSetLink(p, { company_id: company.id, deal_id: deal.id });   // the bar on the price card now reflects the saved link and the new values
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; $("hs-write").disabled = false; $("hs-write").textContent = "Push pricing"; }
}

// Read the deal back until HubSpot's calculated fields match the tool (or give up after `tries` reads), then show the comparison.
// The Re-check button runs it again, in case HubSpot is slower than usual.
async function hsValidate(tries) {
  if (!hs) return;
  const { want, company, deal } = hs, msg = $("hs-msg"), expectTotal = hsPct(want.total);
  try {
    let last = null, lastFull = null;
    for (let i = 0; i < tries; i++) {
      msg.innerHTML = `<p class="text-slate-500">Waiting for HubSpot to recalculate… (${i + 1}/${tries})</p>`;
      lastFull = await hsCall({ action: "read", companyId: company.id, dealId: deal.id }); last = lastFull.deal;
      if (!hs) return;
      if (Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6 && (hsNum(last.actual_value_per_patient_calculated) == null ? i >= 2 : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4)) break;
      if (i < tries - 1) await new Promise(r => setTimeout(r, window.__hsPoll ?? 4000));
    }
    const okT = Math.abs(hsNum(last.total_discount) - expectTotal) < 1e-6, blankV = hsNum(last.actual_value_per_patient_calculated) == null;
    const okV = blankV ? null : Math.abs(hsNum(last.actual_value_per_patient_calculated) - want.rate) < 5e-4;   // null: HubSpot has not filled it in
    const line = (ok, label, got, exp) => `<div class="flex items-center justify-between rounded-lg border ${ok === null ? "border-amber-300 bg-amber-50 text-amber-900" : ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-rose-300 bg-rose-50 text-rose-900"} px-3 py-2"><span>${ok === null ? "?" : ok ? "✓" : "✗"} ${label}</span><span class="font-mono">HubSpot ${got} · tool ${exp}</span></div>`;
    const lineNow = hsOurLine(lastFull), lw = want.line;   // the last poll already read the line items
    const lineNet = lineNow ? (Number(lineNow.price) - (Number(lineNow.discount) || 0)) : null, okL = lineNow == null ? null : Math.abs(lineNet - lw.netUnit) < 0.0006 && Number(lineNow.quantity) === lw.quantity;
    const PER_YEAR = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, per_six_months: 2, annually: 1 }, perYear = lineNow ? PER_YEAR[lineNow.recurringbillingfrequency] : null;
    const amt = hsNum(last.amount), lineAmt = lineNow && perYear ? hsNum(lineNow.amount) * perYear : null, okA = amt == null || lineAmt == null || Number.isNaN(lineAmt) ? null : Math.abs(amt - lineAmt) < 0.5;      // HubSpot puts the line item's yearly value in the deal Amount: a monthly line of £352.25 gives £4,227      // the deal's Amount should be the line item's amount (HubSpot sums line items), not something a workflow wrote
    const done = okT && okV && okL !== false && okA !== false;
    hsCall({ action: "log_check", ods: hs.p.ods_code, dealId: deal.id, dealName: deal.dealname, ok: okT && okV !== false && okL !== false && okA !== false,
      note: !okT ? "Total Discount % does not match the tool" : okV === false ? "Actual Value per Patient (Calculated) does not match the tool" : okA === false ? "The deal Amount does not follow the line item (a workflow may be rewriting it)" : "HubSpot does not match the tool",
      hubspot: { total_discount: last.total_discount, actual_value: last.actual_value_per_patient_calculated }, tool: { total_discount: want.total, actual_value: want.rate } }).catch(() => {});
    msg.innerHTML = `<div class="space-y-2">${line(okT, "Total Discount %", last.total_discount == null ? "not set" : pct(hsNum(last.total_discount) / HS_PCT), pct(want.total))}
      ${line(okV, "Actual Value per Patient (Calculated)", blankV ? "not set" : "£" + rate3(last.actual_value_per_patient_calculated), "£" + rate3(want.rate))}
      ${okA === null ? "" : line(okA, "Deal amount = line item per year", "£" + amt.toLocaleString(undefined, { maximumFractionDigits: 2 }), "£" + lineAmt.toLocaleString(undefined, { maximumFractionDigits: 2 }))}
      ${lineNow || hs.lineItems != null ? line(okL, "Line item net unit price", lineNow ? "£" + rate3(lineNet) + " /mo" : "none", "£" + rate3(lw.netUnit) + " /mo") : ""}</div>
      <p class="mt-2 text-xs text-slate-500">${done ? "HubSpot matches the tool. The link is saved for next time." : okT && okV === null ? "Total Discount % matches. HubSpot has not filled in Actual Value per Patient (Calculated) yet, so it could not be compared. The link is saved." : "HubSpot's calculated fields do not match the tool yet. Re-check in a moment, or check the deal's workflow and whether the price floor applies in the tool but not in HubSpot."}</p>
      ${(hs.warnings || []).map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      ${done ? "" : '<div class="mt-2 text-right"><button id="hs-recheck" class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50">Re-check HubSpot</button></div>'}`;
    const rc = $("hs-recheck"); if (rc) rc.onclick = () => { rc.disabled = true; hsValidate(3); };
  } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p><div class="mt-2 text-right"><button id="hs-recheck" class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold">Re-check HubSpot</button></div>`; $("hs-recheck").onclick = () => hsValidate(3); }
}
