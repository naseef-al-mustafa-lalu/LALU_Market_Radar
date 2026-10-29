// Supabase client, formatting helpers and sign-in.
const SUPABASE_URL = "https://qvdnpvouqecfsinsvvwf.supabase.co";
const SUPABASE_KEY = "sb_publishable_LpkAFZSZ977KX590OHJcXw_MMhtKxUy"; // publishable key: safe to expose, access is enforced by RLS
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const PAGE = 100;
let practices = [], byOds = new Map(), filtered = [], shown = 0, signals = [], sigShown = 0, sigList = [], channel = null, lastRunDate = null;
let signalCodes = new Set(), signalCounts = new Map();
let branches = [], branchesByParent = new Map(), branchAlso = new Map(), branchHit = new Map(), mergedHit = new Map();   // ODS branch surgeries: sites of a practice (see src/branches.py), found through search
// A branch record is one of: branch (a real site of its practice), duplicate_branch / duplicate_practice (an operator's listing of something we already hold),
// hosted (a differently named building a practice uses), shared (a building with several practices) or other (hospital, urgent care, PCN hub...).
// A person's reject turns a match into "other"; a hosted match counts once confirmed.
const branchRes = b => b.match_status === "rejected" ? "other" : b.resolution || "other";
const branchSite = b => branchRes(b) === "branch" || (branchRes(b) === "hosted" && b.match_status === "confirmed");   // listed under its practice as a site
const branchDupe = b => ["duplicate_branch", "duplicate_practice"].includes(branchRes(b));                           // already held as a practice or site: only noted
function indexBranches() {
  branchesByParent = new Map(); branchAlso = new Map();
  for (const b of branches) {
    if (!b.practice_code) continue;
    const m = branchSite(b) ? branchesByParent : branchDupe(b) ? branchAlso : null;
    if (m) m.set(b.practice_code, [...(m.get(b.practice_code) || []), b]);
  }
  if (typeof setBranchBadge === "function") setBranchBadge();
}
let networks = [], netKind = "pcn", netShown = 0, netList = [], netFilter = null, fromNetworks = false, cfgTiers = [], cfgSettings = {};
let sort = { key: "patients", dir: -1 }, revMetric = "arr", drawerCode = null;

/* ---------- formatting and palette (one scale for tiers, colour only for exceptions) ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Per-patient prices show three decimals, or four when the fourth matters (SAR only: £0.0475 must not read as £0.048).
const rate3 = x => { x = Number(x); const f4 = x.toFixed(4); return f4.endsWith("0") ? x.toFixed(3) : f4; };
// HubSpot record links (portal 145802630, EU1): contact 0-1, company 0-2, deal 0-3, lead 0-136
const hsUrl = (type, id) => `https://app-eu1.hubspot.com/contacts/145802630/record/${type}/${encodeURIComponent(id)}`;
const hsLink = (type, id, text) => `<a class="text-lalu-teal-700 hover:underline" target="_blank" rel="noopener" href="${hsUrl(type, id)}">${esc(text)} ↗</a>`;
const chip = (text, cls, title) => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
const gbp = n => n == null ? "–" : n >= 1e6 ? "£" + (n / 1e6).toFixed(2) + "m" : n >= 1e4 ? "£" + Math.round(n / 1e3).toLocaleString() + "k" : "£" + Math.round(n).toLocaleString();   // summaries
const gbpFull = n => n == null ? "–" : "£" + Math.round(n).toLocaleString();                                                                                    // table cells
const pct = n => (Number(n) * 100).toFixed(n * 1000 % 10 ? 1 : 0).replace(/\.0$/, "") + "%";
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const isClosed = p => p.status === "Closed" || !!p.closure_confirmed_at;
const tier = p => p.price_tier ? "Tier " + p.price_tier : "";
const noSizeReason = p => p.merged_into ? "Merged into another practice: its patients are counted in that practice's list."
  : p.country === "Wales" ? "No list size yet: load the StatsWales patients file (Data > Data sources)."
  : p.country === "Scotland" ? "No list size in the Scottish file for this practice."
  : p.country === "Northern Ireland" ? "No list size yet: load the Northern Ireland list sizes file (Data > Data sources)."
  : p.country === "Isle of Man" ? "No list size in the Isle of Man registrations file for this practice."
  : "Not in the monthly NHS patient register. Usually a service rather than a registering practice (walk-in centre, hub, federation), or a practice too new to be published.";
const TIER_CLS = { "Tier 1": "bg-purple-200 text-purple-900", "Tier 2": "bg-purple-100 text-purple-800", "Tier 3": "bg-violet-50 text-violet-700", "Tier 4": "bg-slate-100 text-slate-600", "Tier 5": "bg-slate-50 text-slate-500" };
const CQC_CHIP = { "Outstanding": "bg-emerald-100 text-emerald-800", "Requires improvement": "bg-amber-100 text-amber-800", "Inadequate": "bg-rose-100 text-rose-800" };   // "Good" is the norm: plain text
const CQC_RANK = { "Inadequate": 1, "Requires improvement": 2, "Good": 3, "Outstanding": 4 };
const HS_CLS = { customer: "bg-emerald-100 text-emerald-800", freemium: "bg-teal-50 text-teal-800 ring-1 ring-teal-200", engaged: "bg-blue-100 text-blue-800", imported: "bg-slate-100 text-slate-700", company: "bg-slate-100 text-slate-700", none: "bg-slate-50 text-slate-500" };
const HS_LABEL = { customer: "Customer", freemium: "Freemium", engaged: "Engaged", imported: "In HubSpot", company: "Company only", none: "Not in HubSpot" };
const HS_RANK = { customer: 1, freemium: 2, engaged: 3, imported: 4, company: 5, none: 6 };
// HubSpot company "Commercial Model" values (current_subscription) as HubSpot labels them. Freemium is a customer that brings no revenue.
const HS_COMPANY_MODEL = { "eMR Plus": "ReportSure - MS - All reports", PAYG: "ReportSure PAYG", Freemium: "ReportSure Freemium", "GP eMR": "ReportSure Self Service", "eMR+ SAR Only": "ReportSure - MS - SAR Only" };
// HubSpot's real value for a customer, beside the estimate. * = from closed-won deals (no live Service ACV), so unverified.
const contractedCell = p => {
  const c = Number(p.hubspot_contracted_arr);
  if (!(c > 0)) return p.hubspot_commercial_model === "Freemium" && p.hubspot_customer ? '<span class="text-xs text-slate-400" title="Freemium: no revenue">Freemium</span>' : '<span class="text-slate-300">–</span>';
  const est = Number(p.est_arr), d = est > 0 ? c - est : null, from = p.hubspot_contracted_src === "deal";
  return `<span class="font-mono font-semibold text-teal-700" title="${from ? "From closed-won deals: no live Service ACV, so unverified" : "Live Service ACV in HubSpot"}">${gbpFull(c)}${from ? "*" : ""}</span>` +
    (d != null ? `<div class="text-[10px] ${d < 0 ? "text-amber-700" : "text-slate-500"}" title="Contracted minus estimate">${d >= 0 ? "+" : "−"}${gbpFull(Math.abs(d))} vs est.</div>` : "");
};
const hsState = p => p.hubspot_customer ? (p.hubspot_commercial_model === "Freemium" ? "freemium" : "customer") : p.hubspot_engaged ? "engaged" : p.hs_imported > 0 ? "imported" : p.hubspot_company_id ? "company" : "none";
const NET_KINDS = { pcn: "PCNs", group: "Provider groups", federation: "Federations", icb: "ICBs" };
const HOT = ["MERGER_DETECTED", "NEW_PRACTICE", "CQC_DEREGISTERED", "CQC_PROVIDER_CHANGE"];

/* ---------- auth ---------- */
/* Invite and password-reset links arrive as #access_token=…&type=invite|recovery (or #error=… when the link has expired). */
const linkParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const clearLinkHash = () => history.replaceState(null, "", location.pathname + location.search);
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (session && ["invite", "recovery"].includes(linkParams.get("type"))) { showSetPassword(session); return; }
  if (!session && linkParams.get("error_description")) {
    showLogin(); $("login-error").textContent = /expired|invalid/i.test(linkParams.get("error_description")) ? "That link has expired or was already used. Ask for a new invite, or use “Forgot your password?”." : "Sign-in link problem: " + linkParams.get("error_description");
    clearLinkHash(); return;
  }
  session ? startApp() : showLogin();
}
function showLogin() { $("app").classList.add("hidden"); $("setpw").classList.add("hidden"); $("login").classList.remove("hidden"); }
function showSetPassword(session) {
  $("app").classList.add("hidden"); $("login").classList.add("hidden"); $("setpw").classList.remove("hidden");
  const em = session.user && session.user.email; if (em) $("setpw-who").textContent = `Set a password for ${em} to finish setting up your account.`;
}
$("setpw-form").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("setpw-error"); err.textContent = "";
  const a = $("pw1").value, b = $("pw2").value;
  if (a.length < 10) { err.textContent = "Use at least 10 characters."; return; }
  if (a !== b) { err.textContent = "The two passwords do not match."; return; }
  const { error } = await db.auth.updateUser({ password: a });
  if (error) { err.textContent = "Could not save the password: " + (error.message || error); return; }
  $("pw1").value = $("pw2").value = ""; clearLinkHash(); $("setpw").classList.add("hidden"); startApp();
});
$("forgot").addEventListener("click", async () => {
  const em = $("email").value.trim(), err = $("login-error");
  if (!em) { err.textContent = "Type your email above first."; return; }
  await db.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
  err.textContent = "If that account exists, a link to choose a new password is on its way.";
});
$("login-form").addEventListener("submit", async e => {
  e.preventDefault(); $("login-error").textContent = "";
  const { error } = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) { $("login-error").textContent = "Sign-in failed. Check your email and password."; return; }
  $("password").value = ""; startApp();
});
$("signout").addEventListener("click", async () => {
  if (channel) { db.removeChannel(channel); channel = null; }
  closeDrawer(); practices = []; filtered = []; networks = []; signals = [];
  await db.auth.signOut(); showLogin();
});

/* ---------- info icon: explanatory text lives behind a small "i" so tiles and tables stay uncluttered (hover, tap or focus to read; Escape closes) ---------- */
const infoIcon = text => `<button type="button" class="info-i ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] font-bold leading-none text-slate-500 hover:border-lalu-teal-700 hover:text-lalu-teal-700 focus:border-lalu-teal-700 focus:outline-none" data-info="${esc(text)}" aria-label="${esc(text)}">i</button>`;
(function () {
  let pop = null, pinned = null;
  const hide = () => { if (pop) pop.classList.add("hidden"); pinned = null; };
  const show = btn => {
    if (!pop) { pop = document.createElement("div"); pop.id = "info-pop"; pop.setAttribute("role", "tooltip"); pop.className = "fixed z-[60] hidden max-w-xs rounded-lg bg-lalu-navy px-3 py-2 text-xs leading-snug text-white shadow-lg"; document.body.appendChild(pop); }
    pop.textContent = btn.dataset.info; pop.classList.remove("hidden");
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + "px";
    pop.style.top = (r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
  };
  document.addEventListener("mouseover", e => { const b = e.target.closest && e.target.closest(".info-i"); if (b && !pinned) show(b); });
  document.addEventListener("mouseout", e => { if (e.target.closest && e.target.closest(".info-i") && !pinned) hide(); });
  document.addEventListener("focusin", e => { const b = e.target.closest && e.target.closest(".info-i"); if (b) show(b); });
  document.addEventListener("focusout", e => { if (e.target.closest && e.target.closest(".info-i")) hide(); });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".info-i");
    if (b) { if (pinned === b) hide(); else { pinned = b; show(b); } e.preventDefault(); e.stopPropagation(); } else if (pinned) hide();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, true);
})();
// static headings in index.html carry their explanation as <span class="info-slot" data-text="...">; each becomes an info icon
document.querySelectorAll(".info-slot").forEach(el => { el.innerHTML = infoIcon(el.dataset.text || ""); });
