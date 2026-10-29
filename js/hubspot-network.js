// HubSpot, part 4: a deal for a whole network (federation, provider group, PCN or ICB). Find or create the HubSpot company, then create the deal linked to the network's own
// PCN and ICB records, with a note on the deal saying what was created. Loaded after hubspot-group.js; the practice flow in hubspot-company.js is untouched.
async function hsNetDealOpen(n, parts) {
  const key = keyOf(n), members = practices.filter(p => p.status === "Active" && netMatch(p, { kind: n.kind, key }));
  hs = { p: { practice_name: n.name, ods_code: "", total_patients: Number(n.patients) || 0 }, net: n, parts, members };
  $("hs-modal").classList.remove("hidden"); hsTitle("Create deal");
  hsRender(`<p class="text-slate-600">Find the HubSpot company for <b>${esc(n.name)}</b>, or create it, then make its deal.</p>
    <div class="mt-3 flex gap-2"><input id="hs-q" class="flex-1 rounded-lg border border-slate-300 px-3 py-2" value="${esc(n.name)}" aria-label="Search HubSpot companies"><button id="hs-search" class="rounded-lg bg-lalu-navy px-3 py-2 font-semibold text-white">Search</button></div><div id="hs-results" class="mt-3"></div>`);
  const run = async () => {
    const box = $("hs-results"); box.innerHTML = '<p class="text-slate-500">Searching HubSpot…</p>';
    try {
      const { companies } = await hsCall({ action: "find", ods: "", name: n.name, query: $("hs-q").value });
      box.innerHTML = (companies.length ? companies.map(c => `<button type="button" data-co="${esc(c.id)}" data-name="${esc(c.name)}" class="mb-2 w-full rounded-lg border border-slate-200 p-3 text-left hover:border-lalu-teal hover:bg-lalu-teal-50"><div class="flex justify-between gap-3"><b>${esc(c.name)}</b><span class="text-xs text-slate-500">${c.patient_list_size ? Number(c.patient_list_size).toLocaleString() + " patients" : ""}</span></div></button>`).join("")
        : '<p class="text-slate-500 italic">No companies found. Try a shorter name.</p>')
        + `<div class="mt-1 flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500"><span>${companies.length ? "Not the right one?" : "Nothing matches."}</span><button id="hs-newco" class="font-semibold text-lalu-teal-700 hover:underline">Create ${esc(n.name)} in HubSpot</button></div><div id="hs-newmsg" class="mt-2 text-xs" role="status"></div>`;
      box.querySelectorAll("[data-co]").forEach(b => b.onclick = () => hsNetDealForm({ id: b.dataset.co, name: b.dataset.name }));
      $("hs-newco").onclick = async e => {
        e.target.disabled = true; e.target.textContent = "Creating…";
        try { const r = await hsCall({ action: "create_company_for_network", name: n.name, kind: n.kind }); hsNetDealForm({ id: r.companyId, name: n.name }); }
        catch (err) { $("hs-newmsg").innerHTML = `<span class="text-rose-700">${esc(err.message)}</span>`; e.target.disabled = false; e.target.textContent = "Create " + n.name + " in HubSpot"; }
      };
    } catch (e) { box.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; }
  };
  $("hs-search").onclick = run; $("hs-q").onkeydown = e => { if (e.key === "Enter") run(); }; run();
}
// The HubSpot PCN / ICB records this network is made of: its own record for a PCN or ICB, and the PCN and ICB records of its practices for a federation or group.
async function hsNetObjects(n, parts) {
  const orgs = (n.kind === "pcn" || n.kind === "icb" ? [n] : []).concat([...(parts?.pcns || []), ...(parts?.icbs || [])].map(o => networks.find(x => x.kind === o.kind && keyOf(x) === o.key)).filter(Boolean));
  if (!orgs.length) return [];
  const { data } = await db.from("hubspot_network_links").select("org_id,object_type,object_id").in("org_id", orgs.map(o => o.id));
  const name = new Map(orgs.map(o => [o.id, o.name]));
  return (data || []).map(l => ({ type: l.object_type, id: l.object_id, name: name.get(l.org_id) || "" }));
}
async function hsNetDealForm(company) {
  const { net: n, parts } = hs, box = $("hs-results") || $("hs-body"); hsRender(hsSkeleton(3)); hsTitle("Create deal");
  try {
    const [pre, hub, objs] = await Promise.all([hsCall({ action: "deal_prefill", companyId: company.id, noContacts: true }), hsCall({ action: "hub", companyId: company.id }), hsNetObjects(n, parts)]);
    const pipes = pre.pipelines, def = pipes.find(x => x.id === "default") || pipes[0], stageNew = def.stages.find(s => s.id === "appointmentscheduled") || def.stages[0];
    const annual = Math.round(Number(n.arr_network != null ? n.arr_network : n.arr_single) || 0), close = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), inp = hsInp, field = hsField, opts = hsOpts;
    const KIND = { pcn: "PCN", icb: "ICB", group: "provider group", federation: "federation" }[n.kind];
    const existing = hub.deals.length ? `<div class="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"><b>${esc(company.name)} already has ${hub.deals.length} deal${hub.deals.length > 1 ? "s" : ""}:</b> ${hub.deals.map(d => `${esc(d.dealname)} (${d.amount ? "£" + Number(d.amount).toLocaleString() : "no amount"}) ${hsLink("0-3", d.id, "open")}`).join(" · ")}. Create another only if this is a separate deal.</div>` : "";
    const pt = (k, v, sub = "") => `<div class="rounded-lg bg-white px-2.5 py-1.5"><div class="text-[11px] uppercase tracking-wider text-slate-500">${k}</div><div class="font-mono font-semibold">${v}</div>${sub ? `<div class="text-[11px] text-slate-500">${sub}</div>` : ""}</div>`;
    const price = n.network_tier ? `<div class="mb-3 rounded-xl bg-slate-50 p-3"><div class="mb-2 flex items-center justify-between"><h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Network price from Atlas</h4><span class="text-xs text-slate-500">${esc(KIND)} route · Tier ${n.network_tier}</span></div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${pt("Practices", Number(n.practices).toLocaleString(), Number(n.patients).toLocaleString() + " patients")}${pt("MRR", gbpFull(annual / 12), "network price")}${pt("ARR", gbpFull(annual), "becomes the deal Amount")}${pt("Signed separately", gbpFull(n.arr_single), "ARR, for comparison")}</div></div>` : "";
    const nPcn = objs.filter(o => o.type === "p145802630_pcns").length, nIcb = objs.filter(o => o.type === "p145802630_icbs").length;
    hsRender(`${existing}${price}<div class="rounded-xl border border-slate-200 p-3"><h4 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">New deal on ${esc(company.name)}</h4><div class="grid gap-2 sm:grid-cols-2">
      <div class="sm:col-span-2">${field("Deal name", `<input id="nd-name" class="${inp}" value="${esc(n.name)}">`)}</div>
      ${field("Pipeline", `<select id="nd-pipe" class="${inp}">${opts(pipes.map(x => [x.id, x.label]), def.id)}</select>`)}${field("Stage", `<select id="nd-stage" class="${inp}">${opts(def.stages.map(s => [s.id, s.label]), stageNew.id)}</select>`)}
      ${field("Deal type", `<select id="nd-type" class="${inp}">${opts([["newbusiness", "New Business"], ["New Business GP eMR", "New Business GP eMR"], ["Existing Business - SAR Only", "Existing Business - SAR Only"], ["Existing Business - GP eMR", "Existing Business - GP eMR"], ["Renewal", "Renewal"]], "newbusiness")}</select>`)}
      ${field("Product / service", `<select id="nd-prod" class="${inp}">${opts([["eMR+", "ReportSure - Managed Service"], ["eMR", "ReportSure - Self Service"]], "eMR+")}</select>`)}
      ${field("Deal owner", pre.owners ? `<select id="nd-owner" class="${inp}"><option value="">Unassigned</option>${opts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}</select>` : '<div class="rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Owners unavailable</div>')}
      ${field("Close date", `<input id="nd-close" type="date" class="${inp}" value="${close}">`)}${field("Amount (£, per year)", `<input id="nd-amount" type="number" min="0" step="0.01" class="${inp}" value="${annual}">`)}</div>
      ${hub.contacts.length ? `<div class="mt-3"><div class="mb-1 text-xs font-semibold text-slate-600">Associate contacts</div>${hub.contacts.slice(0, 10).map(c => `<label class="flex items-center gap-2 py-0.5"><input type="checkbox" data-nd-contact="${esc(c.id)}"><span>${esc(hsNameOf(c))} <span class="text-xs text-slate-500">${esc(c.jobtitle || "")} ${esc(c.email || "")}</span></span></label>`).join("")}</div>` : ""}
      <label class="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" id="nd-link" class="mt-1" ${objs.length ? "checked" : "disabled"}><span>Link the deal to its HubSpot ${objs.length ? `records: <b>${nPcn}</b> PCN${nPcn === 1 ? "" : "s"}${nIcb ? ` and <b>${nIcb}</b> ICB` : ""}` : "PCN and ICB records (none found in HubSpot)"}
        ${objs.length ? `<details class="text-xs text-slate-500"><summary class="cursor-pointer">Show them</summary>${esc(objs.map(o => o.name).sort().join(", "))}</details>` : ""}</span></label>
      ${(pre.warnings || []).map(w => `<p class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</p>`).join("")}
      <p class="mt-2 text-xs text-slate-500">The deal is created in HubSpot with a note saying where it came from. Pricing for individual practices is not pushed: the Amount is the network price above.</p>
      <div id="nd-msg" class="mt-2" role="status"></div>
      <div class="mt-3 flex justify-end gap-2"><button id="nd-cancel" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Cancel</button><button id="nd-create" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Create deal</button></div></div>`);
    $("nd-pipe").onchange = e => { const pp = pipes.find(x => x.id === e.target.value); $("nd-stage").innerHTML = opts(pp.stages.map(s => [s.id, s.label]), pp.stages[0].id); };
    $("nd-cancel").onclick = hsClose;
    $("nd-create").onclick = async () => {
      const b = $("nd-create"), msg = $("nd-msg"); b.disabled = true; b.textContent = "Creating…"; msg.innerHTML = "";
      try {
        const close = $("nd-close").value, r = await hsCall({ action: "create_deal", network: { kind: n.kind, name: n.name, orgId: n.id }, companyId: company.id, contactIds: [...document.querySelectorAll("[data-nd-contact]:checked")].map(x => x.dataset.ndContact),
          networkObjects: $("nd-link").checked ? objs : [], deal: { dealname: $("nd-name").value.trim(), pipeline: $("nd-pipe").value, dealstage: $("nd-stage").value, dealtype: $("nd-type").value, product___service: $("nd-prod").value,
            hubspot_owner_id: $("nd-owner")?.value || "", closedate: close ? close + "T00:00:00Z" : "", amount: $("nd-amount").value } });
        hsRender(`<div class="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900" role="status">Deal created: ${hsLink("0-3", r.dealId, "open it in HubSpot")}<div class="text-xs">Linked to ${r.linked || 0} PCN / ICB record${r.linked === 1 ? "" : "s"}, with a note on the deal.</div></div>
          ${(r.warnings || []).map(w => `<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">${esc(w)}</div>`).join("")}<div class="mt-3 flex justify-end"><button id="nd-done" class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Close</button></div>`);
        $("nd-done").onclick = hsClose;
      } catch (e) { msg.innerHTML = `<p class="text-rose-700">${esc(e.message)}</p>`; b.disabled = false; b.textContent = "Create deal"; }
    };
  } catch (e) { hsRender(`<p class="text-rose-700">${esc(e.message)}</p>`); }
}
// The strip at the top of a network profile: same shape and place as a practice's (#dr-hs), with the one action on the right.
let hsNetCur = null;
function hsNetBar(n, parts, st) {
  const box = $("dr-hs"); if (!box || !$("dr-hsnet") || $("dr-title").textContent !== n.name) return;
  hsNetCur = { n, parts };
  const KIND = { pcn: "PCN", icb: "ICB", group: "Provider group", federation: "Federation" }[n.kind] || "Network", act = label => `<button type="button" id="hs-netdeal" class="shrink-0 rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">${label}</button>`;
  let dot, text, right;
  if (st.deals.length) { const d = st.deals[0]; dot = "bg-emerald-500"; text = `${esc(d.deal_name || "Deal")}${st.deals.length > 1 ? ` and ${st.deals.length - 1} more` : ""}: linked`;
    right = `<div class="flex shrink-0 items-center gap-3 text-xs">${hsLink("0-3", d.deal_id, "Open deal")}${act("New deal")}</div>`; }
  else if (st.own ? st.record : st.found) { dot = "bg-amber-400"; text = st.own ? `${KIND} record in HubSpot, no deal linked yet` : `Company in HubSpot, no deal linked yet`; right = act("Create deal"); }
  else { dot = "bg-amber-400"; text = `Not in HubSpot yet`; right = act("Create deal"); }
  box.innerHTML = hsBarShell(dot, text, right); box.classList.remove("hidden");
}
document.addEventListener("click", e => { if (e.target.closest("#dr-hs #hs-netdeal") && hsNetCur) hsNetDealOpen(hsNetCur.n, hsNetCur.parts); });
