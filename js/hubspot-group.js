/* Create the missing companies and deals for the referred practices of a pushed referral group, at the group rate, from one screen.
   Runs after the referring practice has been pushed (that is what saves the group), so each deal links to the referring practice's automatically. */
async function hsGroupOpen(lead) {
  const c = refSaved.get(lead.ods_code), g = c && c.row; if (!g) return;
  const link = (await hsLinks(lead)) || {};
  hs = { p: lead, group: true, companyId: link.company_id || lead.hubspot_company_id };
  $("hs-modal").classList.remove("hidden"); hsTitle("Create referred practices' deals");
  hsRender('<p class="text-slate-500">Checking the referred practices…</p>');
  try {
    const grp = refTierFor(Number(g.combined_patients)), linked = await refLinkedSet(g.members || []);
    const pre = await hsCall({ action: "deal_prefill", companyId: String(hs.companyId), noContacts: true });
    const plan = (g.members || []).map(m => {
      const p = byOds.get(m.ods), own = p && p.total_patients > 0 ? refTierFor(p.total_patients) : null;
      let todo = "company+deal", why = "";
      if (!p || !own || !p.price_tier || p.status !== "Active") { todo = "skip"; why = "No active practice record with a list size"; }
      else if (p.hubspot_customer) { todo = "skip"; why = "Already a customer"; }
      else if (linked.has(m.ods)) { todo = "skip"; why = "Already has a deal"; }
      else if (p.hubspot_company_id) todo = "deal";
      return { m, p, todo, why, extra: own ? Math.max(0, Number(grp.size_discount) - Number(own.size_discount)) : 0 };
    });
    await hsGroupContacts(plan);
    hs.plan = plan; hs.pre = pre; hsGroupRender();
  } catch (e) { hsRender(`<p class="text-rose-700">${esc(e.message)}</p>`); }
}
// Every deal needs a primary contact. For each practice to create: its HubSpot company's contacts if it has any, else its best Atlas contacts (added to the company first).
async function hsGroupContacts(plan) {
  const todo = plan.filter(r => r.todo !== "skip");
  let atlas = [];
  try { const { data } = await db.from("contacts").select("contact_urn,ods_code,full_name,job_title,email,phone,email_opt_out,is_primary,role_tier,hubspot_contact_id").in("ods_code", todo.map(r => r.m.ods)).not("email", "is", null).eq("email_opt_out", false); atlas = data || []; } catch (e) { /* no Atlas contacts: only HubSpot's are offered */ }
  await Promise.all(todo.map(async r => {
    const mine = atlas.filter(c => c.ods_code === r.m.ods).sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || String(a.role_tier || "z").localeCompare(String(b.role_tier || "z"))).slice(0, 8);
    let hsC = [];
    if (r.p.hubspot_company_id) { try { hsC = (await hsCall({ action: "deal_prefill", companyId: String(r.p.hubspot_company_id) })).contacts || []; } catch (e) { /* offered from Atlas instead */ } }
    const have = new Set(hsC.map(c => String(c.email || "").toLowerCase()));
    r.opts = [...hsC.map(c => ["hs:" + c.id, hsNameOf(c) + (c.jobtitle ? " · " + c.jobtitle : "")]), ...mine.filter(c => !have.has(String(c.email).toLowerCase())).map(c => ["at:" + c.contact_urn, (c.full_name || c.email) + (c.job_title ? " · " + c.job_title : "") + " (from Atlas)"])];
    r.atlas = mine;
    if (!r.opts.length) { r.todo = "skip"; r.why = "No contact to make primary: add one to the practice first"; }
  }));
}
const hsLinks = async lead => { try { const { data } = await db.from("hubspot_links").select("company_id,deal_id").eq("ods_code", lead.ods_code).limit(1); return (data || [])[0]; } catch (e) { return null; } };
function hsGroupRender() {
  const { plan, pre, p } = hs, n = plan.filter(r => r.todo !== "skip").length, want = hsDesired(p), close = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const label = r => r.res ? r.res : r.todo === "skip" ? `<span class="text-slate-500">${esc(r.why)}</span>` : r.todo === "deal" ? "Create deal" : "Create company and deal";
  hsRender(`<p class="text-sm text-slate-600">Creates a deal for each referred practice below at the group rate, linked to ${esc(p.practice_name)}'s deal. Priced with the current choices: ${esc(want.label)}.</p>
    <div class="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">${plan.map((r, i) => `<div class="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-gp="${i}"><div class="min-w-0"><div class="truncate font-semibold">${esc(r.m.name)}</div><div class="text-[11.5px] text-slate-500"><span class="font-mono">${esc(r.m.ods)}</span> · ${refN(r.m.patients)} patients${r.todo !== "skip" ? ` · referral discount ${pct(r.extra)}` : ""}</div></div><div class="shrink-0 text-right text-xs font-semibold ${r.todo === "skip" ? "" : "text-lalu-teal-700"}">${label(r)}${r.todo !== "skip" && r.opts ? `<label class="mt-1 block text-[11px] font-normal text-slate-500">Primary contact<select class="gp-primary ${hsInp} mt-0.5 max-w-[16rem]" data-i="${i}">${hsOpts(r.opts, r.opts[0][0])}</select></label>` : ""}</div></div>`).join("")}</div>
    ${n ? `<div class="mt-3 grid gap-2 sm:grid-cols-2"><label class="text-xs font-semibold text-slate-600">Deal owner<select id="gp-owner" class="${hsInp} mt-0.5">${pre.owners ? `<option value="">Unassigned</option>${hsOpts(pre.owners.map(o => [o.id, o.name]), pre.ownerId || "")}` : '<option value="">Owners unavailable</option>'}</select></label>
      <label class="text-xs font-semibold text-slate-600">Close date<input id="gp-close" type="date" class="${hsInp} mt-0.5" value="${close}"></label></div>
      <p class="mt-2 text-xs text-slate-500">New deals go in the Sales pipeline at its first stage, as New Business, ReportSure - Managed Service. Each deal needs a primary contact: pick one per practice (a contact from Atlas is added to the company first). The daily sync links each new company to its PCN.</p>` : '<p class="mt-3 text-sm text-slate-600">Every referred practice already has a deal or cannot be created here.</p>'}
    <div id="hs-msg" class="mt-3" role="status"></div>
    <div class="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-slate-200 bg-white pt-3"><button id="hs-cancel" class="rounded-lg border border-slate-300 px-3 py-2 font-semibold">Close</button>${n ? `<button id="gp-go" class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700">Create ${n} deal${n > 1 ? "s" : ""}</button>` : ""}</div>`);
  $("hs-cancel").onclick = hsClose;
  if ($("gp-go")) $("gp-go").onclick = hsGroupRun;
}
async function hsGroupRun() {
  const go = $("gp-go"), owner = $("gp-owner")?.value || "", close = $("gp-close").value, pipe = (hs.pre.pipelines.find(x => x.id === "default") || hs.pre.pipelines[0]);
  go.disabled = true; go.textContent = "Creating…";
  const row = (i, html) => { const el = document.querySelector(`[data-gp="${i}"] div:last-child`); if (el) el.innerHTML = html; };
  let done = 0, failed = 0;
  for (const [i, r] of hs.plan.entries()) {
    if (r.todo === "skip") continue;
    row(i, '<span class="text-slate-500">Working…</span>');
    try {
      const p = r.p; let companyId = p.hubspot_company_id;
      const pick = document.querySelector(`.gp-primary[data-i="${i}"]`)?.value || "", asContact = c => ({ name: c.full_name || "", email: c.email, phone: c.phone || "", jobtitle: c.job_title || "" });
      if (!pick) throw new Error("Pick a primary contact");
      const atl = pick.startsWith("at:") ? r.atlas.find(c => "at:" + c.contact_urn === pick) : null; let primary = pick.startsWith("hs:") ? pick.slice(3) : "";
      if (!companyId) { const cc = await hsCall({ action: "create_company", ods: p.ods_code, company: hsCompanyProps(p), contacts: atl ? [asContact(atl)] : [], networks: [] }); companyId = cc.companyId; if (atl) primary = String((cc.contacts || [])[0]?.id || ""); }
      else if (atl) primary = String(((await hsCall({ action: "add_contacts", ods: p.ods_code, companyId: String(companyId), contacts: [asContact(atl)] })).contacts || [])[0]?.id || "");
      if (!primary) throw new Error("The primary contact could not be added to HubSpot");
      const want = hsDesired(p, { referral: r.extra, member: hs.p ? refSaved.get(hs.p.ods_code).row : null }), amount = Math.round(p.total_patients * want.rate * 12 * 100) / 100;
      const d = await hsCall({ action: "create_deal", ods: p.ods_code, companyId: String(companyId), primaryContactId: primary, contactIds: [], deal: { dealname: p.practice_name, pipeline: pipe.id, dealstage: (pipe.stages.find(s => s.id === "appointmentscheduled") || pipe.stages[0]).id,
        dealtype: "newbusiness", product___service: "eMR+", hubspot_owner_id: owner, closedate: close ? close + "T00:00:00Z" : "", amount } });
      const w = want.line;
      await hsCall({ action: "write", ods: p.ods_code, companyId: String(companyId), dealId: d.dealId, company: { patient_list_size: p.total_patients },
        deal: { size_discount: hsPct(want.size), speed_discount: hsPct(want.speed), term_length_discount: hsPct(want.term), term_length_years: String(want.termYears), referral_discount: hsPct(want.referral), size_tier: want.tier, commercial_model: want.model, value_per_patient: want.vpp, contracted_patient_list_size: w.quantity },
        lineItem: { productId: w.productId, quantity: w.quantity, listUnit: w.listUnit, netUnit: w.netUnit, termMonths: w.termMonths, frequency: w.frequency, terms: w.terms, payments: w.payments } });
      done++; row(i, `<span class="text-emerald-700">✓ Created</span> ${hsLink("0-3", d.dealId, "Open deal")}`);
    } catch (e) { failed++; row(i, `<span class="text-rose-700" title="${esc(e.message)}">✗ ${esc(e.message.slice(0, 90))}</span>`); }
  }
  refSaved.delete(hs.p.ods_code); refGroups = null; repaintPriceCards();
  go.classList.add("hidden"); $("hs-msg").innerHTML = `<p class="text-sm ${failed ? "text-amber-800" : "text-emerald-800"}">${done} deal${done === 1 ? "" : "s"} created${failed ? `, ${failed} failed (the rest are unaffected; run it again to retry them)` : ", linked to the referring practice's deal"}.</p>`;
}

document.addEventListener("click", e => { const b = e.target.closest(".rg-create"); if (b) hsGroupOpen(byOds.get(b.dataset.lead)); });
