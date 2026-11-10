// HubSpot, part 4: a deal for a whole network (federation, provider group, PCN or ICB). Find or create the HubSpot company, then create the deal linked to the network's own
// PCN and ICB records, with a note on the deal saying what was created. Loaded after hubspot-group.js; the practice flow in hubspot-company.js is untouched.
// A network (or the part of it a deal covers) as the entity the practice flow prices: its patients, the tier its patients reach on its own route.
function hsNetEntity(n, members, covers) {
  const cov = (covers || []).length ? members.filter(p => covers.includes(p.ods_code)) : members, pts = cov.reduce((t, p) => t + (p.total_patients > 0 ? p.total_patients : 0), 0);
  const tier = cfgTiers.filter(t => t.route === n.kind).sort((a, b) => b.threshold - a.threshold).find(t => pts >= t.threshold);
  return { practice_name: n.name, ods_code: "", total_patients: pts, price_tier: tier ? tier.tier : n.network_tier, route: n.kind, net: n, covers: (covers || []).slice() };
}
async function hsNetDealOpen(n, parts, covers) {
  const key = keyOf(n), members = practices.filter(p => p.status === "Active" && netMatch(p, { kind: n.kind, key }));
  hs = { p: hsNetEntity(n, members, covers), net: n, parts, members }; hs.want = hsDesired(hs.p);
  $("hs-modal").classList.remove("hidden"); hsTitle("Create deal");
  const known = hsOrgCo.get(n.id); if (known) return hsNetDealForm({ id: known.company_id, name: n.name });   // the daily sync already matched this network to its HubSpot company
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
        try {
          const r = await hsCall({ action: "create_company_for_network", name: n.name, kind: n.kind }), memberCompanyIds = members.map(p => p.hubspot_company_id).filter(Boolean);
          if (r.ok === false) throw new Error("A HubSpot company called " + n.name + " already exists: choose it from the list above.");
          if (memberCompanyIds.length && (n.kind === "federation" || n.kind === "group")) {   // its practices join it with the account's association labels (Federation / Member Practice, Operating Provider / Operated Practice)
            try { await hsCall({ action: "link_network_members", companyId: r.companyId, kind: n.kind, memberCompanyIds }); } catch (le) { $("hs-newmsg").innerHTML = `<span class="text-amber-700">Company created, but its practices were not linked: ${esc(le.message)}</span>`; }
          }
          hsNetDealForm({ id: r.companyId, name: n.name });
        }
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
// The deal form and the push are the practice ones (hsDealForm, hsPreview, hsWrite): a network is priced as an entity of its own route, on the practices a deal covers.
const hsNetDealForm = company => { hsRender('<div id="hs-results"></div>'); return hsDealForm(company); };

// The strip at the top of a network profile: same shape and place as a practice's (#dr-hs), with the one action on the right.
let hsNetCur = null;
function hsNetBar(n, parts, st) {
  const box = $("dr-hs"); if (!box || !$("dr-hsnet") || $("dr-title").textContent !== n.name) return;
  hsNetCur = { n, parts };
  const KIND = { pcn: "PCN", icb: "ICB", group: "Provider group", federation: "Federation" }[n.kind] || "Network", act = label => `<button type="button" id="hs-netdeal" class="shrink-0 rounded-md bg-lalu-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-lalu-navy-700">${label}</button>`;
  let dot, text, right;
  if (st.deals.length) { const d = st.deals[0]; dot = "bg-emerald-500"; text = `${esc(d.deal_name || "Deal")}${st.deals.length > 1 ? ` and ${st.deals.length - 1} more` : ""}: linked`;
    right = `<div class="flex shrink-0 items-center gap-3 text-xs">${hsLink("0-3", d.deal_id, "Open deal")}${act("New deal")}</div>`; }
  else if (st.own ? st.record : (st.found || st.company)) { dot = "bg-amber-400"; text = st.own ? `${KIND} record in HubSpot, no deal linked yet` : `Company in HubSpot, no deal linked yet`; right = act("Create deal"); }
  else { dot = "bg-amber-400"; text = `Not in HubSpot yet`; right = act("Create deal"); }
  box.innerHTML = hsBarShell(dot, text, right); box.classList.remove("hidden");
}
document.addEventListener("click", e => { if (e.target.closest("#dr-hs #hs-netdeal") && hsNetCur) hsNetDealOpen(hsNetCur.n, hsNetCur.parts); });
