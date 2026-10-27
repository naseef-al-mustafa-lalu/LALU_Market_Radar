/* Audiences: whether each sequence is visible and set up in HubSpot, and A/B tests between two sequences (loaded after audiences.js). */
// The KPIs an audience card or an A/B test can show. "n" KPIs are counts, "pct" KPIs are shares of those enrolled; each reads one count from audPerfFor.
const AUD_KPIS = { opened: { label: "Opened", short: "Opened", f: "opened", n: false }, replied: { label: "Replied", short: "Replied", f: "replied", n: false }, clicked: { label: "Link clicks (CTA)", short: "Clicked", f: "clicked", n: false },
  meetings: { label: "Meetings booked", short: "Meetings", f: "meetings", n: true }, mql: { label: "MQLs created", short: "MQLs", f: "mql", n: true }, mqlrate: { label: "MQL rate (MQLs ÷ enrolled)", short: "MQL rate", f: "mql", n: false } };
const AUD_KPI_DEFAULT = ["opened", "replied", "meetings"], AUD_TEST_KPI_DEFAULT = ["replied", "clicked", "meetings", "mql"];
const audKpisOf = a => (a.kpis && a.kpis.length ? a.kpis : AUD_KPI_DEFAULT).filter(k => AUD_KPIS[k]).slice(0, 3);
const audKpiText = (k, s) => { const d = AUD_KPIS[k]; return !s ? "–" : d.n ? String(s[d.f]) : s.enrolled ? Math.round(100 * s[d.f] / s.enrolled) + "%" : "–"; };
let audTests = [], audSeqStatus = {};      // audSeqStatus: sequence id -> { state: ready|empty|missing|error, steps, message }
const audRunning = a => audTests.find(t => t.audience_id === a.id && t.status === "running") || null;
const audLastEnded = a => audTests.filter(t => t.audience_id === a.id && t.status === "ended").sort((x, y) => String(y.ended_at).localeCompare(String(x.ended_at)))[0] || null;

async function audLoadTests() {
  const { data } = await db.from("audience_tests").select("*").order("created_at", { ascending: false });
  audTests = data || [];
}
async function audLoadSeqStatus() {      // one call for every sequence in use; the badge shows "Checking" until it returns
  const seen = new Map();
  for (const a of audiences) { if (a.sequence_id) seen.set(String(a.sequence_id), a.sequence_sender || ""); }
  for (const t of audTests) if (t.status === "running") for (const id of [t.seq_a_id, t.seq_b_id]) if (id) seen.set(String(id), t.sequence_sender || "");
  if (!seen.size) return;
  try { Object.assign(audSeqStatus, (await hsCall({ action: "sequence_status", sequences: [...seen].map(([id, sender]) => ({ id, sender })) })).status || {}); }
  catch (e) { for (const id of seen.keys()) audSeqStatus[id] = { state: "error", message: e.message }; }
  renderAudiences();
}
function audSeqBadge(id, plain) {      // is this sequence visible to its sender in HubSpot, and does it have steps
  const s = id && audSeqStatus[String(id)], tone = { ready: "bg-emerald-100 text-emerald-800", empty: "bg-amber-100 text-amber-800", missing: "bg-rose-100 text-rose-800", error: "bg-slate-200 text-slate-700" };
  if (!id) return `<span class="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Not chosen</span>`;
  if (!s) return `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">Checking…</span>`;
  const label = { ready: `Ready in HubSpot${s.steps ? ` · ${s.steps} step${s.steps === 1 ? "" : "s"}` : ""}`, empty: "In HubSpot but has no steps", missing: "Not found in HubSpot", error: "Could not check" }[s.state];
  const tip = { missing: "HubSpot cannot see this sequence for its sender. It may have been deleted or belong to another user.", empty: "Add at least one email step in HubSpot before enrolling.", error: s.message || "" }[s.state] || "";
  return `<span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone[s.state]}" ${tip ? `title="${esc(tip)}"` : ""}>${label}</span>`;
}
const audSeqOk = id => { const s = audSeqStatus[String(id)]; return !s || s.state === "ready" || s.state === "error"; };      // unknown or unchecked does not block; a known problem does

// Results for one arm (or the whole audience), as shares of those enrolled.
function audArm(a, arm) { const s = audPerfFor(a, arm); return s; }
function audVerdict(t, A, B) {      // decided on the test's deciding KPI, as a share of those enrolled in each arm
  if (!A || !B) return "Load performance to see how each sequence is doing.";
  if (A.enrolled < t.min_per_arm || B.enrolled < t.min_per_arm) return `Too early: A has ${A.enrolled} and B has ${B.enrolled} enrolled, ${t.min_per_arm} each are needed for a read.`;
  const k = AUD_KPIS[t.primary_kpi] ? t.primary_kpi : "replied", d = AUD_KPIS[k], pa = A[d.f] / A.enrolled, pb = B[d.f] / B.enrolled, p = (A[d.f] + B[d.f]) / (A.enrolled + B.enrolled), se = Math.sqrt(p * (1 - p) * (1 / A.enrolled + 1 / B.enrolled));
  const z = se ? (pa - pb) / se : 0, lead = pa > pb ? "A" : "B", w = d.short.toLowerCase();
  if (Math.abs(z) >= 1.96) return `${lead} is ahead on ${w} (${Math.round(100 * Math.max(pa, pb))}% vs ${Math.round(100 * Math.min(pa, pb))}% of those enrolled) and the gap is unlikely to be chance.`;
  return `No clear difference in ${w} yet (A ${Math.round(100 * pa)}%, B ${Math.round(100 * pb)}%). Keep enrolling or end the test.`;
}
function audTestCard(a, t) {      // one running test: its two arms, the verdict and how to end it
  const cell = (arm, name, id) => {
    const s = audArm(a, arm), n = audMembers.filter(m => m.test_id === t.id && m.arm === arm).length, ks = (t.kpis && t.kpis.length ? t.kpis : ["replied", "meetings", "opened"]).filter(k => AUD_KPIS[k]);
    const tile = (v, l, hot) => `<span><span class="block font-bold ${hot ? "text-purple-700" : ""}">${v}</span><span class="text-[10px] uppercase tracking-wider text-slate-500">${l}</span></span>`;
    return `<div class="rounded-lg border border-slate-200 bg-white p-3"><div class="flex items-center gap-2"><span class="flex h-6 w-6 items-center justify-center rounded-md ${arm === "a" ? "bg-lalu-navy" : "bg-purple-600"} text-xs font-bold text-white">${arm.toUpperCase()}</span><span class="min-w-0 flex-1 truncate text-sm font-semibold">${esc(name)}</span></div>
      <div class="mt-1">${audSeqBadge(id)}</div>
      <div class="mt-2 grid gap-1 text-center" style="grid-template-columns:repeat(${ks.length + 1},minmax(0,1fr))">${tile(n, "Enrolled")}${ks.map(k => tile(audKpiText(k, s), AUD_KPIS[k].short, k === t.primary_kpi)).join("")}</div></div>`;
  };
  return `<div class="rounded-xl border border-purple-200 bg-purple-50/40 p-3"><div class="flex flex-wrap items-center gap-2"><span class="rounded-full bg-purple-600 px-2 py-0.5 text-[11px] font-bold text-white">A/B test running</span><span class="font-semibold">${esc(t.name)}</span>${t.variable ? `<span class="text-xs text-slate-500">testing ${esc(t.variable)}</span>` : ""}
      <span class="font-mono text-xs text-slate-500">${esc(a.name)}</span><button type="button" data-aud="${esc(a.id)}" class="aud-test-end ml-auto rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">End test</button></div>
    ${t.hypothesis ? `<p class="mt-1 text-xs text-slate-600">${esc(t.hypothesis)}</p>` : ""}
    <div class="mt-2 grid gap-2 sm:grid-cols-2">${cell("a", t.seq_a_name, t.seq_a_id)}${cell("b", t.seq_b_name, t.seq_b_id)}</div>
    <p class="mt-2 text-xs text-slate-700">${esc(audVerdict(t, audArm(a, "a"), audArm(a, "b")))}</p>
    <p class="mt-1 text-[11px] text-slate-500">While this runs, each approved and enrolled contact goes to A or B (${t.split_a}/${100 - t.split_a}), not to the audience's own sequence. The highlighted KPI decides the result. Opens are inflated by mail privacy features, and an MQL after enrolment is not proof the sequence caused it.</p></div>`;
}
function audTestNote(a) {      // inside an audience: only a pointer to its running test, which lives under A/B tests
  const t = audRunning(a); if (!t) return "";
  return `<p class="mb-3 text-xs text-slate-600"><span class="rounded-full bg-purple-600 px-2 py-0.5 text-[11px] font-bold text-white">A/B test running</span> ${esc(t.name)}: approved contacts are split between its two sequences. <button type="button" class="aud-test-go font-semibold text-lalu-teal-700 hover:underline" data-aud="${esc(a.id)}">See it under A/B tests</button></p>`;
}
function audTestsPage() {      // the A/B tests sub tab: running tests, planning a new one, and past results
  const running = audTests.filter(t => t.status === "running"), ended = audTests.filter(t => t.status === "ended").sort((x, y) => String(y.ended_at).localeCompare(String(x.ended_at)));
  const free = audiences.filter(a => !audRunning(a)), byId = new Map(audiences.map(a => [a.id, a]));
  const past = ended.map(t => { const a = byId.get(t.audience_id); return `<tr class="border-t border-slate-100"><td class="py-1.5 pr-3 font-semibold">${esc(t.name)}</td><td class="px-2 text-slate-600">${esc(a ? a.name : "")}</td><td class="px-2">${t.winner ? t.winner.toUpperCase() + ": " + esc(t.winner === "a" ? t.seq_a_name : t.seq_b_name) : '<span class="text-slate-400">No winner</span>'}</td><td class="px-2 text-slate-600">${esc(t.conclusion || "")}</td><td class="pl-2 text-right text-xs text-slate-500">${fmtDate(t.ended_at)}</td></tr>`; }).join("");
  return `<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div class="mb-3 flex flex-wrap items-center gap-3"><h3 class="text-lg font-bold">A/B tests</h3><span class="text-sm text-slate-500">Compare two sequences on the same audience. Each approved contact goes to one of them.</span>
      <span class="ml-auto flex items-center gap-2">${free.length ? `<select id="abt-aud" class="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm" aria-label="Audience to test">${free.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select><button type="button" class="aud-test-plan rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-50">Plan an A/B test</button>` : '<span class="text-xs text-slate-500">Every audience has a test running.</span>'}</span></div>
    <div class="space-y-3">${running.map(t => { const a = byId.get(t.audience_id); return a ? audTestCard(a, t) : ""; }).join("") || '<p class="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">No test is running.</p>'}</div>
    ${ended.length ? `<h4 class="mb-1 mt-5 text-xs font-bold uppercase tracking-wider text-slate-500">Past tests</h4><div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-[11px] uppercase tracking-wider text-slate-500"><tr><th>Test</th><th class="px-2">Audience</th><th class="px-2">Winner</th><th class="px-2">What we learned</th><th class="pl-2 text-right">Ended</th></tr></thead><tbody>${past}</tbody></table></div>` : ""}</div>`;
}

async function audTestPlan(a) {
  audModal("Plan an A/B test", '<p class="text-sm text-slate-500">Loading your sequences from HubSpot…</p>', null);
  try {
    const me = await audMe(), sender = a.sequence_sender || me, list = (await hsCall({ action: "sequences", sender })).sequences || [];
    if (list.length < 2) throw new Error("An A/B test needs two sequences available to " + sender + ". Build the second one in HubSpot first.");
    const opts = pick => list.map(x => `<option value="${esc(x.id)}" ${String(x.id) === String(pick) ? "selected" : ""}>${esc(x.name)}</option>`).join(""), f = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm", lab = "mb-0.5 block text-xs font-semibold text-slate-600";
    audModal("Plan an A/B test", `<div class="space-y-3"><div><label class="${lab}" for="abt-name">Test name</label><input type="text" id="abt-name" class="${f}" placeholder="e.g. Practice name in subject line"></div>
      <div><label class="${lab}" for="abt-hyp">What do you expect, and why?</label><input type="text" id="abt-hyp" class="${f}" placeholder="e.g. A subject naming the practice gets more replies"></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="${lab}" for="abt-a">Sequence A</label><select id="abt-a" class="${f}">${opts(a.sequence_id)}</select></div><div><label class="${lab}" for="abt-b">Sequence B</label><select id="abt-b" class="${f}">${opts((list.find(x => String(x.id) !== String(a.sequence_id)) || {}).id)}</select></div></div>
      <div class="grid grid-cols-3 gap-3"><div><label class="${lab}" for="abt-var">What differs</label><select id="abt-var" class="${f}"><option>Subject line</option><option>First line</option><option>Call to action</option><option>Send timing</option><option>Sequence length</option><option>Other</option></select></div>
        <div><label class="${lab}" for="abt-split">Share to A (%)</label><input type="number" id="abt-split" min="10" max="90" value="50" class="${f}"></div><div><label class="${lab}" for="abt-min">Min per arm</label><input type="number" id="abt-min" min="1" value="20" class="${f}"></div></div>
      <fieldset><legend class="${lab}">What to measure (tick the ones to show, pick one to decide the result)</legend><div class="grid grid-cols-1 gap-1 sm:grid-cols-2">${Object.entries(AUD_KPIS).map(([k, d]) => `<label class="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><input type="checkbox" class="abt-kpi" value="${k}" ${AUD_TEST_KPI_DEFAULT.includes(k) ? "checked" : ""}><span class="min-w-0 flex-1 truncate">${d.label}</span><label class="flex items-center gap-1 text-[11px] text-slate-500"><input type="radio" name="abt-primary" value="${k}" ${k === "replied" ? "checked" : ""}>decides</label></label>`).join("")}</div></fieldset>
      <p class="text-xs text-slate-500">Sequences send as <b>${esc(sender)}</b>. Change only one thing between A and B, or the result will not tell you why.</p></div>`,
      async () => {
        const v = id => $(id).value.trim(), A = $("abt-a"), B = $("abt-b"), name = v("abt-name"); if (!name) throw new Error("Give the test a name.");
        if (A.value === B.value) throw new Error("Pick two different sequences.");
        const kpis = [...document.querySelectorAll(".abt-kpi:checked")].map(x => x.value), primary = document.querySelector("input[name=abt-primary]:checked").value; if (!kpis.length) throw new Error("Tick at least one KPI."); if (!kpis.includes(primary)) kpis.push(primary);
        const split = Math.round(Number(v("abt-split"))), min = Math.round(Number(v("abt-min"))); if (!(split >= 10 && split <= 90)) throw new Error("Share to A must be between 10 and 90."); if (!(min >= 1)) throw new Error("Minimum per arm must be at least 1.");
        const row = { audience_id: a.id, name, hypothesis: v("abt-hyp") || null, variable: v("abt-var"), seq_a_id: A.value, seq_a_name: A.selectedOptions[0].text, seq_b_id: B.value, seq_b_name: B.selectedOptions[0].text, sequence_sender: sender, split_a: split, min_per_arm: min, status: "running", kpis, primary_kpi: primary, created_by: me };
        const { data, error } = await db.from("audience_tests").insert(row).select().single(); if (error) throw new Error(/one_running/.test(error.message) ? "This audience already has a running test." : error.message);
        audTests.unshift(data); audModalClose(); renderAudiences(); audLoadSeqStatus();
      }, "Start test");
  } catch (e) { audModal("Plan an A/B test", `<p class="text-sm text-rose-700">${esc(e.message)}</p>`, null); }
}
function audTestEnd(a) {
  const t = audRunning(a); if (!t) return;
  audModal("End the test", `<div class="space-y-2 text-sm"><p>Which sequence won? The winner becomes this audience's sequence from now on.</p>
    ${[["a", t.seq_a_name], ["b", t.seq_b_name], ["", "No winner (keep the audience's current sequence)"]].map(([k, n]) => `<label class="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2"><input type="radio" name="abt-win" value="${k}" ${k === "" ? "checked" : ""}><span>${k ? k.toUpperCase() + ": " : ""}${esc(n)}</span></label>`).join("")}
    <input type="text" id="abt-note" class="w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="What did you learn? (optional)"></div>`,
    async () => {
      const w = document.querySelector("input[name=abt-win]:checked").value || null, patch = { status: "ended", winner: w, conclusion: $("abt-note").value.trim() || null, ended_at: new Date().toISOString() };
      const { error } = await db.from("audience_tests").update(patch).eq("id", t.id); if (error) throw error; Object.assign(t, patch);
      if (w) { const up = { sequence_id: w === "a" ? t.seq_a_id : t.seq_b_id, sequence_name: w === "a" ? t.seq_a_name : t.seq_b_name, sequence_sender: t.sequence_sender }, r = await db.from("audiences").update(up).eq("id", a.id); if (r.error) throw r.error; Object.assign(a, up); }
      audModalClose(); renderAudiences(); audLoadSeqStatus();
    }, "End test");
}
document.addEventListener("click", e => {
  const t = e.target, open = audiences.find(x => x.id === audOpen);
  if (t.closest(".aud-kpis")) { if (open) audKpiPick(open); return; }
  if (t.closest(".aud-test-plan")) { const a = audiences.find(x => x.id === ($("abt-aud") || {}).value); if (a) audTestPlan(a); return; }
  const en = t.closest(".aud-test-end"); if (en) { const a = audiences.find(x => x.id === en.dataset.aud); if (a) audTestEnd(a); return; }
  const go = t.closest(".aud-test-go"); if (go) setAudSub("tests");
});

function audKpiPick(a) {      // which (up to three) KPIs this audience's card and summary line show
  const cur = audKpisOf(a);
  audModal("KPIs for " + a.name, `<p class="mb-2 text-xs text-slate-500">Pick up to three. They appear on the audience card and in its summary line.</p><div class="space-y-1">${Object.entries(AUD_KPIS).map(([k, d]) => `<label class="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"><input type="checkbox" class="aud-kpi-opt" value="${k}" ${cur.includes(k) ? "checked" : ""}>${d.label}</label>`).join("")}</div>`, async () => {
    const kpis = [...document.querySelectorAll(".aud-kpi-opt:checked")].map(x => x.value); if (!kpis.length || kpis.length > 3) throw new Error("Pick between one and three.");
    const { error } = await db.from("audiences").update({ kpis }).eq("id", a.id); if (error) throw error; a.kpis = kpis; audModalClose(); renderAudiences();
  });
}
