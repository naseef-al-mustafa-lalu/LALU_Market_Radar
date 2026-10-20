// Supabase client, formatting helpers and sign-in.
const SUPABASE_URL = "https://qvdnpvouqecfsinsvvwf.supabase.co";
const SUPABASE_KEY = "sb_publishable_LpkAFZSZ977KX590OHJcXw_MMhtKxUy"; // publishable key: safe to expose, access is enforced by RLS
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const PAGE = 100;
let practices = [], byOds = new Map(), filtered = [], shown = 0, signals = [], sigShown = 0, sigList = [], channel = null, lastRunDate = null;
let signalCodes = new Set(), signalCounts = new Map();
let networks = [], netKind = "pcn", netShown = 0, netList = [], netFilter = null, fromNetworks = false, cfgTiers = [], cfgSettings = {};
let sort = { key: "patients", dir: -1 }, revMetric = "arr", drawerCode = null;

/* ---------- formatting and palette (one scale for tiers, colour only for exceptions) ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Per-patient prices show three decimals, or four when the fourth matters (SAR only: £0.0475 must not read as £0.048).
const rate3 = x => { x = Number(x); const f4 = x.toFixed(4); return f4.endsWith("0") ? x.toFixed(3) : f4; };
// HubSpot record links (portal 145802630, EU1): contact 0-1, company 0-2, deal 0-3, lead 0-136
const hsUrl = (type, id) => `https://app-eu1.hubspot.com/contacts/145802630/record/${type}/${encodeURIComponent(id)}`;
const hsLink = (type, id, text) => `<a class="text-blue-600 hover:underline" target="_blank" rel="noopener" href="${hsUrl(type, id)}">${esc(text)} ↗</a>`;
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
  : "Not in the monthly NHS patient register. Usually a service rather than a registering practice (walk-in centre, hub, federation), or a practice too new to be published.";
const TIER_CLS = { "Tier 1": "bg-purple-200 text-purple-900", "Tier 2": "bg-purple-100 text-purple-800", "Tier 3": "bg-violet-50 text-violet-700", "Tier 4": "bg-slate-100 text-slate-600", "Tier 5": "bg-slate-50 text-slate-500" };
const CQC_CHIP = { "Outstanding": "bg-emerald-100 text-emerald-800", "Requires improvement": "bg-amber-100 text-amber-800", "Inadequate": "bg-rose-100 text-rose-800" };   // "Good" is the norm: plain text
const CQC_RANK = { "Inadequate": 1, "Requires improvement": 2, "Good": 3, "Outstanding": 4 };
const HS_CLS = { customer: "bg-emerald-100 text-emerald-800", engaged: "bg-blue-100 text-blue-800", imported: "bg-slate-100 text-slate-700", none: "bg-slate-50 text-slate-500" };
const HS_LABEL = { customer: "Customer", engaged: "Engaged", imported: "In HubSpot", none: "Not in HubSpot" };
const HS_RANK = { customer: 1, engaged: 2, imported: 3, none: 4 };
const hsState = p => p.hubspot_customer ? "customer" : p.hubspot_engaged ? "engaged" : p.hs_imported > 0 ? "imported" : "none";
const NET_KINDS = { pcn: "PCNs", group: "Provider groups", federation: "Federations", icb: "ICBs" };
const SYS = { "EMIS Web": "EMIS", "SystmOne": "SystmOne", "Vision": "Vision" };
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
