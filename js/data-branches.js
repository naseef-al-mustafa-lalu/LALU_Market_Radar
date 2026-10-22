// Data > Branch sites: how ODS branch records were resolved (src/branches.py) and the matches that need a person. Loaded after data-audit.js.
/* ---------- Data > Branch sites ---------- */
const BRANCH_KINDS = {
  branch: { label: "Real branch", tone: "bg-emerald-100 text-emerald-800", help: "ODS says a GP practice we hold operates it (a 9-character code is that practice's code plus a suffix). Certainly a site of that practice." },
  duplicate_branch: { label: "Repeats a branch", tone: "bg-sky-100 text-sky-800", help: "An operator's listing (for example South Doc Virtual Services) of a site that already exists as a real branch. Noted on that site, not counted again." },
  duplicate_practice: { label: "Repeats a practice", tone: "bg-sky-100 text-sky-800", help: "An operator's listing of a practice we already hold, matched by address and name. Noted on the practice, not counted again." },
  hosted: { label: "Hosted building", tone: "bg-amber-100 text-amber-800", help: "A differently named building at the address of exactly one practice. It may be a building the practice uses, or a rename. Confirm to list it as one of that practice's sites." },
  shared: { label: "Shared building", tone: "bg-slate-200 text-slate-700", help: "A building with several practices. It belongs to none of them, so it is kept as a site only." },
  other: { label: "Other site", tone: "bg-slate-200 text-slate-700", help: "No GP practice at this address: a hospital, urgent care or vaccination site, a PCN hub or similar." }
};
let brFilter = "review", brShown = 100;
const brPractice = b => (b.practice_code && (byOds.get(b.practice_code) || {}).practice_name) || b.practice_code || "";
function renderBranchReview() {
  const box = $("d-branches"); if (!box) return;
  const count = k => branches.filter(b => b.resolution === k).length, review = branches.filter(b => ["probable", "review"].includes(b.match_status)), decided = branches.filter(b => ["confirmed", "rejected"].includes(b.match_status));
  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-bold">Branch sites <span class="text-xs font-normal text-slate-500">ODS branch surgery records, sorted by what they really are</span></h2></div>
    <p class="mt-1 text-xs text-slate-500">ODS says who operates each branch record. Where that is a GP practice we hold, it is a real branch of it. Where it is something else (South Doc Virtual Services, an urgent-care provider, a PCN), the record is the operator's listing, which often repeats a practice or branch we already hold. Each day's ODS load re-sorts every record. Your confirm or reject decisions are kept while the match is unchanged.</p>
    <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">${Object.entries(BRANCH_KINDS).map(([k, v]) => `<div class="rounded-xl border border-slate-200 p-3"><div class="flex items-center"><span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.tone}">${v.label}</span>${infoIcon(v.help)}</div><div class="mt-1 text-lg font-bold">${count(k).toLocaleString()}</div></div>`).join("")}</div>
    <div class="mt-4 flex gap-1 rounded-lg bg-slate-100 p-0.5 text-sm font-semibold w-fit"><button data-br="review" class="rounded-md px-3 py-1 ${brFilter === "review" ? "bg-white shadow-sm" : "text-slate-500"}">To review (${review.length})</button><button data-br="decided" class="rounded-md px-3 py-1 ${brFilter === "decided" ? "bg-white shadow-sm" : "text-slate-500"}">Decided (${decided.length})</button></div>
    <div id="br-list" class="mt-2"></div>`;
  box.querySelectorAll("[data-br]").forEach(b => b.onclick = () => { brFilter = b.dataset.br; brShown = 100; renderBranchReview(); });
  const list = (brFilter === "review" ? review : decided).sort((a, b) => (a.parent_name || "").localeCompare(b.parent_name || "") || a.branch_name.localeCompare(b.branch_name));
  $("br-list").innerHTML = list.length ? list.slice(0, brShown).map(b => { const k = BRANCH_KINDS[b.resolution] || BRANCH_KINDS.other, st = b.match_status;
    return `<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2 first:border-0"><div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${k.tone}">${k.label}</span>${chip(st === "probable" ? "Probable" : st === "review" ? "Needs a decision" : st === "confirmed" ? "Confirmed" : "Rejected", st === "confirmed" ? "bg-emerald-100 text-emerald-800" : st === "rejected" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800")}<span class="font-mono text-xs text-slate-500">${esc(b.branch_code)}</span></div>
      <div class="mt-0.5 text-sm"><b>${esc(b.branch_name)}</b> <span class="text-xs text-slate-500">${esc([b.address, b.town, b.postcode].filter(Boolean).join(", "))}</span></div>
      <div class="text-xs text-slate-500">Listed by ${esc(b.parent_name || b.parent_code || "an unknown organisation")} → ${b.practice_code ? `<b class="text-slate-700">${esc(brPractice(b))}</b> <span class="font-mono">${esc(b.practice_code)}</span>` : "no practice"} · ${esc(b.match_note || "")}</div></div>
      <div class="flex shrink-0 items-center gap-2 text-xs">${b.practice_code ? `<button data-br-open="${esc(b.practice_code)}" class="font-semibold text-lalu-teal-700 hover:underline">Open practice</button>` : ""}
        ${brFilter === "review" ? `<button data-br-set="confirmed" data-code="${esc(b.branch_code)}" class="rounded-md bg-lalu-teal-700 px-2.5 py-1 font-semibold text-white hover:bg-lalu-teal-800">Confirm</button><button data-br-set="rejected" data-code="${esc(b.branch_code)}" class="rounded-md border border-slate-300 px-2.5 py-1 font-semibold hover:bg-slate-50">Reject</button>`
          : `<button data-br-set="${b.resolution === "hosted" ? "review" : "probable"}" data-code="${esc(b.branch_code)}" class="rounded-md border border-slate-300 px-2.5 py-1 font-semibold hover:bg-slate-50">Undo</button>`}</div></div>`; }).join("")
    : `<p class="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">${brFilter === "review" ? "Nothing to review." : "No decisions yet."}</p>`;
  $("br-list").querySelectorAll("[data-br-open]").forEach(b => b.onclick = () => { const p = byOds.get(b.dataset.brOpen); if (p) { showTab("practices"); openDrawer(p); } });
  $("br-list").querySelectorAll("[data-br-set]").forEach(b => b.onclick = async () => {
    b.disabled = true; const { error } = await db.from("practice_branches").update({ match_status: b.dataset.brSet }).eq("branch_code", b.dataset.code);
    if (error) { b.disabled = false; b.textContent = "Not saved"; b.title = error.message; return; }
    const row = branches.find(x => x.branch_code === b.dataset.code); if (row) row.match_status = b.dataset.brSet;
    indexBranches(); renderBranchReview(); applyFilters();
  });
}
function setBranchBadge() {
  const n = branches.filter(b => ["probable", "review"].includes(b.match_status)).length, el = $("br-badge");
  if (el) { el.textContent = n; el.classList.toggle("hidden", !n); }
}
