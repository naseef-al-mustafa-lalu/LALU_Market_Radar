// Referral group: price a lead's deal on the combined list size of the practices they can sign (see README, "Referral group"). Loaded after practices.js.
/* The lead and every practice they bring are priced on the combined list size, using the single-practice size-discount table. The extra discount over each
   practice's own size discount is the REFERRAL DISCOUNT, conditional on the others signing. Speed, term and product come from the price card, never from here. */
const REFERRAL_DAYS = 90;
const HS_REFERRAL_WRITES = true;   // HubSpot's Total Discount % formula includes referral_discount (confirmed 24 Oct 2026)
const referralState = new Map();    // lead ODS -> { open, sel: Set of codes, extra: [{ code, name, patients }], manual: bool }
const refState = lead => { let s = referralState.get(lead.ods_code); if (!s) referralState.set(lead.ods_code, s = { open: false, sel: new Set(), extra: [], manual: false }); return s; };
const refTiers = () => cfgTiers.filter(t => t.route === "practice").sort((a, b) => b.threshold - a.threshold);   // largest threshold first
const refTierFor = n => refTiers().find(t => n >= t.threshold) || null;
const refN = n => Math.round(n).toLocaleString("en-GB");

// The practices in the lead's PCN that could sign (largest first); customers stay in the list but cannot be added (they already pay).
function refCandidates(lead) {
  return practices.filter(x => x.ods_code !== lead.ods_code && lead.pcn_code && x.pcn_code === lead.pcn_code && x.status === "Active" && !x.merged_into && x.total_patients > 0)
    .sort((a, b) => b.total_patients - a.total_patients).map(x => ({ code: x.ods_code, name: x.practice_name, patients: x.total_patients, customer: !!x.hubspot_customer, pcn: x.pcn_name }));
}
const refPool = lead => [...refCandidates(lead), ...refState(lead).extra.filter(e => !refCandidates(lead).some(c => c.code === e.code))];
const refPicked = lead => refPool(lead).filter(c => refState(lead).sel.has(c.code));

// null when no practices are ticked (or the lead has no price tier); otherwise the combined size, both tiers and the extra discount.
function referralFor(lead) {
  const picked = refPicked(lead), own = refTierFor(lead.total_patients);
  if (!picked.length || !own) return null;
  const combined = lead.total_patients + picked.reduce((t, c) => t + c.patients, 0), grp = refTierFor(combined);
  const ownSize = Number(own.size_discount), groupSize = Number(grp.size_discount);
  return { picked, n: picked.length, combined, ownTier: own, groupTier: grp, ownSize, groupSize, extra: Math.max(0, groupSize - ownSize) };
}
const referralExtraFor = lead => (lead && lead.total_patients > 0 && billing !== "monthly" ? (referralFor(lead) || { extra: 0 }).extra : 0);
// What the push sends alongside the discount: who was counted, for the note, the tracking table and the deal links.
const referralPayload = lead => { const r = referralFor(lead); return r && r.extra > 0 ? { extra: r.extra, combined: r.combined, members: r.picked.map(c => ({ ods: /^manual/.test(c.code) ? "" : c.code, name: c.name, patients: c.patients })) } : null; };
const referralActive = lead => referralExtraFor(lead) > 0;

// Ladder: the distinct size-discount steps of the single-practice table (equal discounts merged), the first step drawn twice as wide.
function refLadder(lead, ref) {
  const steps = []; refTiers().slice().reverse().forEach(t => { const d = Number(t.size_discount), last = steps[steps.length - 1]; if (!last || last.d !== d) steps.push({ min: t.threshold, d }); });
  const W = steps.map((s, i) => (i === 0 ? 2 : 1)), total = W.reduce((a, b) => a + b, 0), top = steps[steps.length - 1].min + (steps[steps.length - 1].min - (steps[steps.length - 2] || { min: 0 }).min);
  const pos = v => { const x = Math.min(v, top); let i = steps.length - 1; while (i > 0 && x < steps[i].min) i--; const end = i + 1 < steps.length ? steps[i + 1].min : top; return (W.slice(0, i).reduce((a, b) => a + b, 0) + W[i] * (x - steps[i].min) / (end - steps[i].min)) / total * 100; };
  const lab = v => Math.min(86, Math.max(14, pos(v)));   // keep the marker labels inside the bar
  const shade = ["bg-slate-200 text-slate-700", "bg-teal-100 text-teal-900", "bg-teal-300 text-teal-950", "bg-lalu-teal-700 text-white"], cols = W.map(w => w + "fr").join(" ");
  const bar = steps.map((s, i) => `<div class="flex h-7 items-center justify-center rounded text-[11px] font-bold ${shade[Math.min(i, 3)]}">${pct(s.d)}</div>`).join("");
  const ticks = steps.map((s, i) => `<span class="text-[10.5px] tabular-nums text-slate-500">${i === 0 ? "under " + refN(steps[1] ? steps[1].min : 0) : refN(s.min) + (i === steps.length - 1 ? "+" : "")}</span>`).join("");
  return `<div class="relative pt-5 pb-6" aria-hidden="true">
    <div class="absolute top-0 -translate-x-1/2 transition-[left]" style="left:${lab(lead.total_patients)}%"><div class="rounded-full bg-slate-200 px-2 py-0.5 text-[10.5px] font-bold text-slate-600 whitespace-nowrap">Alone ${refN(lead.total_patients)}</div></div>
    <div class="grid gap-[3px]" style="grid-template-columns:${cols}">${bar}</div><div class="mt-0.5 grid gap-[3px]" style="grid-template-columns:${cols}">${ticks}</div>
    ${ref ? `<div class="absolute bottom-0 -translate-x-1/2 transition-[left]" style="left:${lab(ref.combined)}%"><div class="rounded-full bg-lalu-teal-700 px-2 py-0.5 text-[10.5px] font-bold text-white whitespace-nowrap">Group ${refN(ref.combined)}</div></div>` : ""}</div>`;
}

// What would reach the next size-discount step: the smallest PCN practice that does it on its own.
function refTip(lead, ref) {
  const combined = ref ? ref.combined : lead.total_patients, next = refTiers().slice().reverse().find(t => t.threshold > combined && Number(t.size_discount) > Number(refTierFor(combined).size_discount));
  if (!next) return `<b>Top step reached.</b> More practices will not lower the rate further.`;
  const need = next.threshold - combined, pool = refPool(lead).filter(c => !c.customer && !refState(lead).sel.has(c.code)).sort((a, b) => a.patients - b.patients), one = pool.find(c => c.patients >= need);
  return `<b>${refN(need)} more patients</b> reach ${pct(Number(next.size_discount))} off` + (one ? `: <b>${esc(one.name)}</b> (${refN(one.patients)}) would do it.` : pool.length ? ". It would take more than one practice." : ".");
}

function referralPanel(lead, id) {
  const s = refState(lead), ref = referralFor(lead), cands = refCandidates(lead), open = s.open;
  const summary = ref ? `${refN(ref.combined)} patients · ${pct(ref.groupSize)} size discount` : "Price this deal on the practices they can sign";
  const total = ref ? ref.combined : lead.total_patients;
  const row = c => {
    const on = s.sel.has(c.code), after = on ? total : total + c.patients, tier = refTierFor(after);
    const go = c.customer && !on ? `<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Customer</span>` : on ? `<span class="text-xs font-bold text-emerald-700">Included</span>` : `<span class="text-xs tabular-nums text-slate-500">→ ${refN(after)} · <b class="text-lalu-teal-700">${pct(Number(tier.size_discount))}</b></span>`;
    return `<label class="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2.5 border-t border-slate-100 px-3 py-2 first:border-0 hover:bg-lalu-teal-50/60 ${c.customer ? "opacity-60 cursor-not-allowed" : ""}"><input type="checkbox" class="rg-chk h-4 w-4 accent-lalu-teal-700" data-lead="${esc(lead.ods_code)}" data-code="${esc(c.code)}" ${on ? "checked" : ""} ${c.customer ? "disabled" : ""}>
      <span class="min-w-0"><span class="block text-sm font-semibold leading-tight">${esc(c.name)}</span><span class="block text-[11.5px] tabular-nums text-slate-500"><span class="font-mono">${esc(c.code)}</span> · ${refN(c.patients)} patients</span></span><span class="text-right">${go}</span></label>`;
  };
  const extras = s.extra.filter(e => !cands.some(c => c.code === e.code));
  const body = !open ? "" : `<div class="space-y-4 border-t border-slate-200 p-3">
    <div><div class="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Size discount by combined list size</div>${refLadder(lead, ref)}<p class="rounded-lg bg-lalu-teal-50 px-3 py-2 text-[12.5px]">${refTip(lead, ref)}</p></div>
    ${cands.length ? `<div><div class="mb-1 flex items-center justify-between"><div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Practices in ${esc(lead.pcn_name)}</div><button type="button" class="rg-all text-xs font-semibold text-lalu-teal-700 underline" data-lead="${esc(lead.ods_code)}">${cands.filter(c => !c.customer).every(c => s.sel.has(c.code)) ? "Clear" : "Select all"}</button></div><div class="overflow-hidden rounded-lg border border-slate-200 bg-white">${cands.map(row).join("")}</div></div>`
      : `<p class="text-xs text-slate-500">${lead.pcn_code ? "No other practices in this PCN have a list size." : "This practice is not in a PCN, so search for the practices they know."}</p>`}
    <div class="space-y-2"><div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Others they know</div>
      <div class="relative"><input type="search" class="rg-q w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm" data-lead="${esc(lead.ods_code)}" placeholder="Search any practice by name, code or postcode" aria-label="Search practices to add" autocomplete="off"><div class="rg-results absolute left-0 right-0 top-full z-10 mt-1 hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"></div></div>
      ${extras.length ? `<div class="flex flex-wrap gap-1.5">${extras.map(e => `<span class="inline-flex items-center gap-1.5 rounded-full bg-lalu-teal-50 py-0.5 pl-2.5 pr-1 text-xs font-semibold">${esc(e.name)} · ${refN(e.patients)}<button type="button" class="rg-rm h-5 w-5 rounded-full bg-white text-slate-500 hover:text-slate-800" data-lead="${esc(lead.ods_code)}" data-code="${esc(e.code)}" aria-label="Remove ${esc(e.name)}">×</button></span>`).join("")}</div>` : ""}
      <button type="button" class="rg-manual text-xs font-semibold text-lalu-teal-700 underline" data-lead="${esc(lead.ods_code)}">Not in the list? Enter patients manually</button>
      ${s.manual ? `<div class="grid grid-cols-[1fr_7rem_auto] gap-1.5"><input class="rg-mn rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm" placeholder="Practice name (optional)" aria-label="Practice name"><input type="number" min="1" class="rg-mp rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm" placeholder="Patients" aria-label="Patients"><button type="button" class="rg-madd rounded-md bg-lalu-teal-700 px-3 py-1.5 text-xs font-semibold text-white" data-lead="${esc(lead.ods_code)}">Add</button></div>` : ""}</div>
    ${ref ? referralResult(lead, ref) : `<p class="text-xs text-slate-500">Tick the practices they can sign. The group price, the saving and what happens if they do not sign appear here. Speed discount, term and product follow the choices above.</p>`}</div>`;
  return `<div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white" data-rg="${esc(lead.ods_code)}">
    <button type="button" class="rg-toggle flex w-full items-center justify-between gap-3 bg-lalu-teal-50 px-3 py-2.5 text-left text-sm" data-lead="${esc(lead.ods_code)}" aria-expanded="${open}" aria-controls="rg-${id}"><span><span class="mr-1.5 inline-block transition-transform ${open ? "rotate-90" : ""}">▸</span><b>Referral group</b></span><span class="text-right text-xs font-semibold text-lalu-teal-700">${summary}</span></button>
    <div id="rg-${id}">${body}</div></div>`;
}

// Alone against the group price, using the card's current product, term and speed choices.
function referralResult(lead, ref) {
  const monthly = billing === "monthly", term = monthly ? 0 : termDiscount(termYrs), sp = speedOn && !monthly ? Number(ref.groupTier.speed_discount) : 0, own = Number(ref.ownTier.speed_discount);
  const rAlone = dealRate(ref.ownSize, term, speedOn && !monthly ? own : 0), rGroup = dealRate(ref.ownSize + ref.extra, term, sp), yAlone = yearly(lead.total_patients, rAlone), yGroup = yearly(lead.total_patients, rGroup), save = yAlone - yGroup;
  return `<div class="space-y-2 rounded-xl border border-slate-200 p-3">
    <div class="grid grid-cols-2 gap-3"><div><div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Alone</div><div class="text-lg font-bold tabular-nums">£${rate3(rAlone)}</div><div class="text-xs tabular-nums text-slate-500">${gbpFull(yAlone)} a year</div></div>
      <div><div class="text-[11px] font-bold uppercase tracking-wider text-lalu-teal-700">Referral group</div><div class="text-lg font-bold tabular-nums text-lalu-teal-700">£${rate3(rGroup)}</div><div class="text-xs tabular-nums text-slate-500">${gbpFull(yGroup)} a year</div></div></div>
    ${save > 0.5 ? `<div class="text-sm font-semibold text-emerald-700">Saves the lead ${gbpFull(save)} a year, ${Math.round((rAlone - rGroup) / rAlone * 100)}% off.</div>` : `<div class="text-xs text-slate-500">No further saving yet: the combined list size is still in the same step.</div>`}
    <dl class="divide-y divide-slate-100 rounded-lg bg-slate-50 px-3 text-[12.5px] tabular-nums">
      ${[["Combined list size", `${refN(ref.combined)} patients across ${ref.n + 1} practices`], ["Everyone pays", `£${rate3(rGroup)} per patient per month`], ["Group total", `${gbpFull(ref.combined * rGroup * 12)} a year`],
        ref.extra > 0 ? ["Referral discount", `${pct(ref.extra)} on top of the lead's own ${pct(ref.ownSize)} size discount`] : ["Size discount", `${pct(ref.groupSize)} (no step gained yet)`]]
        .map(([k, v]) => `<div class="flex items-baseline justify-between gap-3 py-1.5"><dt class="text-slate-500">${k}</dt><dd class="text-right font-semibold text-slate-800">${v}</dd></div>`).join("")}</dl>
    <div class="flex flex-wrap items-center justify-between gap-2"><span class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">Conditional on ${ref.n} ${ref.n > 1 ? "practices" : "practice"} signing within ${REFERRAL_DAYS} days ${infoIcon(`If they do not all sign in time, ${lead.practice_name} moves back to £${rate3(rAlone)} per patient per month (${gbpFull(yAlone)} a year).`)}</span>
      <button type="button" class="rg-copy rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50" data-lead="${esc(lead.ods_code)}">Copy summary</button></div></div>`;
}
function referralSummaryText(lead) {
  const ref = referralFor(lead); if (!ref) return "";
  const monthly = billing === "monthly", term = monthly ? 0 : termDiscount(termYrs), rAlone = dealRate(ref.ownSize, term, speedOn && !monthly ? Number(ref.ownTier.speed_discount) : 0), rGroup = dealRate(ref.ownSize + ref.extra, term, speedOn && !monthly ? Number(ref.groupTier.speed_discount) : 0);
  return `Referral group: ${[lead.practice_name, ...ref.picked.map(c => c.name)].join(" + ")}. ${refN(ref.combined)} patients, ${pct(ref.groupSize)} size discount, £${rate3(rGroup)} per patient per month (${termYrs}-year term${speedOn ? ", speed discount" : ""}). ${lead.practice_name} pays ${gbpFull(yearly(lead.total_patients, rGroup))} a year (alone ${gbpFull(yearly(lead.total_patients, rAlone))}). Conditional on ${ref.n} other ${ref.n > 1 ? "practices" : "practice"} signing within ${REFERRAL_DAYS} days, otherwise £${rate3(rAlone)}.`;
}

/* ---------- interactions (delegated; the price card repaints on every change, the search box only refreshes its own results) ---------- */
const refLead = el => byOds.get(el.dataset.lead);
document.addEventListener("change", e => { const c = e.target.closest(".rg-chk"); if (!c) return; const lead = refLead(c), s = lead && refState(lead); if (!s) return; c.checked ? s.sel.add(c.dataset.code) : s.sel.delete(c.dataset.code); repaintPriceCards(); hsRefreshBars(); });
document.addEventListener("click", e => {
  const t = e.target.closest(".rg-toggle, .rg-all, .rg-rm, .rg-manual, .rg-madd, .rg-add, .rg-copy"); if (!t) { document.querySelectorAll(".rg-results").forEach(r => r.classList.add("hidden")); return; }
  const lead = refLead(t) || (t.closest("[data-rg]") && byOds.get(t.closest("[data-rg]").dataset.rg)); if (!lead) return; const s = refState(lead);
  if (t.classList.contains("rg-toggle")) s.open = !s.open;
  else if (t.classList.contains("rg-all")) { const c = refCandidates(lead).filter(x => !x.customer), every = c.every(x => s.sel.has(x.code)); c.forEach(x => every ? s.sel.delete(x.code) : s.sel.add(x.code)); }
  else if (t.classList.contains("rg-rm")) { s.extra = s.extra.filter(x => x.code !== t.dataset.code); s.sel.delete(t.dataset.code); }
  else if (t.classList.contains("rg-manual")) s.manual = !s.manual;
  else if (t.classList.contains("rg-madd")) { const box = t.closest("[data-rg]"), n = parseInt(box.querySelector(".rg-mp").value, 10); if (!(n > 0)) { box.querySelector(".rg-mp").focus(); return; } const code = "manual" + (s.extra.length + 1); s.extra.push({ code, name: box.querySelector(".rg-mn").value.trim() || "Practice (manual)", patients: n }); s.sel.add(code); }
  else if (t.classList.contains("rg-add")) { const p = byOds.get(t.dataset.code); if (p && !s.extra.some(x => x.code === p.ods_code)) s.extra.push({ code: p.ods_code, name: p.practice_name, patients: p.total_patients }); s.sel.add(t.dataset.code); }
  else if (t.classList.contains("rg-copy")) { const text = referralSummaryText(lead), done = () => { t.textContent = "Copied"; setTimeout(() => { t.textContent = "Copy summary"; }, 1600); }; try { navigator.clipboard.writeText(text).then(done, () => { t.textContent = "Select and copy"; }); } catch (err) { t.textContent = "Select and copy"; } return; }
  repaintPriceCards(); hsRefreshBars();
  if (t.classList.contains("rg-manual")) document.querySelector(`[data-rg="${lead.ods_code}"] .rg-mn`)?.focus();
});
document.addEventListener("input", e => {
  const q = e.target.closest(".rg-q"); if (!q) return; const lead = refLead(q), box = q.parentElement.querySelector(".rg-results"), term = q.value.trim().toLowerCase();
  if (!lead || term.length < 2) { box.classList.add("hidden"); return; }
  const taken = new Set([lead.ods_code, ...refCandidates(lead).map(c => c.code), ...refState(lead).extra.map(c => c.code)]);
  const hits = practices.filter(p => !taken.has(p.ods_code) && p.status === "Active" && !p.merged_into && !p.hubspot_customer && p.total_patients > 0 && [p.practice_name, p.ods_code, p.postcode].some(v => (v || "").toLowerCase().includes(term))).sort((a, b) => b.total_patients - a.total_patients).slice(0, 6);
  box.innerHTML = hits.length ? hits.map(p => `<button type="button" class="rg-add flex w-full justify-between gap-3 border-t border-slate-100 px-3 py-2 text-left text-sm first:border-0 hover:bg-lalu-teal-50" data-lead="${esc(lead.ods_code)}" data-code="${esc(p.ods_code)}"><span><span class="font-semibold">${esc(p.practice_name)}</span><br><span class="text-[11.5px] text-slate-500"><span class="font-mono">${esc(p.ods_code)}</span> · ${esc(p.pcn_name || "no PCN")}${p.hubspot_customer ? " · customer" : ""}</span></span><span class="tabular-nums text-slate-600">${refN(p.total_patients)}</span></button>`).join("")
    : '<div class="px-3 py-2 text-xs text-slate-500">No match (existing customers cannot be added). Try the code or postcode, or enter patients manually.</div>';
  box.classList.remove("hidden");
});
