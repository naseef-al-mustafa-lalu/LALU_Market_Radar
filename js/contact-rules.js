/* Contacts: which people we may contact, and why not. Two sets of rules that anyone can switch on and off in Contacts > Settings:
   - JOB ROLES: a contact's job title falls into one role group; each group is Main (decision-makers), Other, or Off.
   - SUPPRESSION RULES: reasons to hold a contact back from campaigns. They follow HubSpot's "Campaign Exclusion List", and nothing is written back to HubSpot.
   Loaded after contact-import.js, whose cqEmailQuality() grades an email address. Saved in app_flags.contact_rules. */

// Role groups, first match wins. [id, label, pattern, default section]. Anything with a name and a direct address is wanted, so the default for a group that is not a decision-maker is Other.
const CT_ROLES = [
  ["dropped", "Marked as dropped", /dropped on/i, "off", true],
  ["deputy", "Deputy / assistant manager", /(deputy|assistant).*(manager|director)|(manager|director).*(deputy|assistant)/i, "main"],
  ["pm", "Practice / business / general manager", /practice\s*\/?\s*(business\s*)?manager|business\s*\/?\s*practice\s*manager|general\s*(practice\s*)?manager|business manager|site manager|surgery manager|office manager|^manager$/i, "main"],
  ["ops", "Operations manager", /operations?\s*manager|operational manager/i, "main"],
  ["director", "Practice / managing / executive director", /practice director|managing director|executive (manager|director)|chief (executive|operating)|^director$/i, "main"],
  ["partner", "GP / senior / managing partner", /(?<!business\s)(?<!finance\s)partner(?!ship)/i, "main"],
  ["pcn", "PCN director or manager", /pcn\s*(clinical\s*)?(director|manager|lead)|network (director|manager)|clinical director/i, "main"],
  ["senior", "Senior manager / head of", /senior\s+\w*\s*manager|head of|service (manager|lead)|(group|area|hub|cluster|regional)\s+\w*\s*manager/i, "main"],
  ["finance", "Finance, HR and business partner", /finance|account|payroll|\bhr\b|human resources|business partner|procurement/i, "other"],
  ["digital", "Digital, IT and transformation", /digital|\bit\b|information|informatics|systems|data\b|transformation|innovation|project/i, "other"],
  ["services", "Patient services and administration manager", /patient services|administration manager|admin(istrat\w+)? (lead|manager)|reception manager|care navigat|team leader|supervisor/i, "other"],
  ["gp", "GPs (not partners)", /\bgp\b|general practitioner|doctor|\bdr\.?\b|salaried|locum|registrar|trainee/i, "other"],
  ["clinical", "Nurses and other clinicians", /nurse|anp\b|practitioner|paramedic|pharmac|physio|health ?care assistant|\bhca\b|phlebot|midwi|dietit|therapist/i, "other"],
  ["admin", "Reception, secretaries and clerks", /reception|secretar|clerk|summar|coder|dispens|care coordinator|administrator|admin\b|assistant/i, "other"],
  ["other", "Other titles", /./, "other"],
  ["none", "No job title", /^$/, "other"],
];
const CT_ROLE = Object.fromEntries(CT_ROLES.map(r => [r[0], { id: r[0], label: r[1], re: r[2], def: r[3], locked: !!r[4] }]));
function ctRoleOf(title) {
  const t = String(title || "").trim(); if (!t) return CT_ROLE.none;
  const mapped = ctRules.titles && ctRules.titles[t.toLowerCase()]; if (mapped && CT_ROLE[mapped]) return CT_ROLE[mapped];   // a title someone added to the approved mapping in Review
  const hit = CT_ROLES.find(([id, , re]) => id !== "none" && id !== "other" && re.test(t));
  return hit ? CT_ROLE[hit[0]] : CT_ROLE.other;
}

// Hard stops and soft stops. [id, label, what it does, default on]. The first group are facts in the contact's own record; the second need what HubSpot knows (synced daily).
const CT_RULES = [
  ["optout", "Unsubscribed from all email", "The contact opted out in Oscar or HubSpot.", true],
  ["mkt_optout", "Opted out of Marketing Information", "Unsubscribed from the Marketing Information emails and has been sent one.", true],
  ["bounced", "Email bounced", "A hard bounce (unknown user, other, policy), or any bounce after a marketing email was sent.", true],
  ["sequence", "Already in a HubSpot sequence", "Not enrolled in a second campaign while one is running.", true],
  ["in_audience", "Already approved in another Atlas audience", "Held for the audience that has them first.", true],
  ["lifecycle", "Lifecycle stage is not New or Engaged", "Only New and Engaged contacts get campaigns (customers, past customers, MQL, SQL and the rest are held back). Switch the view to Re-engagement to lift this.", true],
  ["customer", "At a customer practice", "The practice is a customer, so its contacts are not prospected.", true],
  ["closed", "At a closed or merged practice", "The practice no longer exists as a buyer.", true],
  ["owner", "Contact owner excluded", "Owned by someone whose contacts are kept out of campaigns (the IDs are below).", true],
  ["neverbounce", "NeverBounce says Invalid or Disposable", "The address failed verification. Unknown results are allowed unless 'only Valid' is ticked.", true],
];
const CT_NOT_EVALUATED = [["disqualified", "Disqualified lead, or closed-lost deal while New / Engaged", "HubSpot's exclusion list holds these; Atlas does not read lead or deal outcomes yet, so they stay excluded in HubSpot only."]];
const CT_LIFECYCLE = { lead: "New", "2207373534": "Engaged", marketingqualifiedlead: "MQL", "5640141025": "Prospecting", salesqualifiedlead: "SQL", opportunity: "Opportunity", customer: "Customer", "4726262995": "Past customer", evangelist: "Evangelist", other: "Other", "4025181418": "Client services" };
const CT_BAD_BOUNCE = new Set(["UNKNOWN_USER", "OTHER", "POLICY", "Unknown user", "Other", "Policy"]);
const CT_DEFAULTS = () => ({ roles: {}, titles: {}, titleModes: {}, dq: {}, suppression: {}, likely: false, strictValid: false, owners: ["78343211", "34750167", "34750166", "9112363"] });
let ctRules = CT_DEFAULTS(), ctMode = "standard";   // ctMode: standard campaigns, or re-engagement (lifts the lifecycle rule)
const ctRoleMode = id => (ctRules.roles[id] === "main" || ctRules.roles[id] === "other" || ctRules.roles[id] === "off") ? ctRules.roles[id] : CT_ROLE[id].def;
// A job title can be set on its own: Main, Other or Off, ahead of the group default it falls into.
const ctTitleMode = t => { const m = ctRules.titleModes && ctRules.titleModes[String(t || "").trim().toLowerCase()]; return m === "main" || m === "other" || m === "off" ? m : null; };
const ctRuleOn = id => ctRules.suppression[id] === undefined ? (CT_RULES.find(r => r[0] === id) || [])[3] !== false : !!ctRules.suppression[id];
function ctSetRules(v) { const d = CT_DEFAULTS(); ctRules = { ...d, ...(v || {}), roles: { ...(v || {}).roles }, titles: { ...(v || {}).titles }, titleModes: { ...(v || {}).titleModes }, dq: { ...(v || {}).dq }, suppression: { ...(v || {}).suppression }, owners: Array.isArray((v || {}).owners) ? v.owners.map(String) : d.owners }; }

// Everything about one contact: its role group, which section it belongs in (or why it does not), and the suppression rules that hold it back.
// c: a row of public.contacts; p: its practice; locked: Map of hubspot contact id -> audience name (approved elsewhere).
function ctEvaluate(c, p, locked = new Map()) {
  const role = ctRoleOf(c.job_title || c.title), mode = role.locked ? ctRoleMode(role.id) : (ctTitleMode(c.job_title || c.title) || ctRoleMode(role.id)), name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.full_name || "";
  const q = c.email_quality || (typeof cqEmailQuality === "function" ? cqEmailQuality(c.email, c.first_name || (c.full_name || "").split(" ")[0], c.last_name || (c.full_name || "").split(" ").slice(1).join(" "))[0] : null);
  const direct = q === "direct" || (q === "likely_direct" && ctRules.likely);
  const out = { role, quality: q, name, section: null, excluded: "", reasons: [], status: "excluded" };
  if (!c.email || q === "no_email" || q === "invalid" || q === "reject") out.excluded = "no usable email";
  else if (q === "shared") out.excluded = "shared mailbox, not a person";
  else if (!direct) out.excluded = q === "likely_direct" ? "address only partly matches the name" : "address does not clearly belong to this person";
  else if (mode === "off") out.excluded = "role switched off: " + role.label;
  else out.section = mode;
  if (out.excluded) { if (c.held_reason) out.excluded = "held back at import: " + c.held_reason; return out; }
  const why = [], on = ctRuleOn, hs = c.hubspot_contact_id, lc = c.hs_lifecycle;
  if (on("optout") && (c.email_opt_out || c.hs_optout_all)) why.push("optout");
  if (on("mkt_optout") && c.hs_mkt_optout && c.hs_last_sent) why.push("mkt_optout");
  if (on("bounced") && ((c.hs_bounced && c.hs_last_sent) || CT_BAD_BOUNCE.has(c.hs_bounce_reason))) why.push("bounced");
  if (on("sequence") && c.hs_in_sequence) why.push("sequence");
  if (on("in_audience") && hs && locked.has(String(hs))) why.push("in_audience");
  if (on("lifecycle") && ctMode === "standard" && lc && lc !== "lead" && lc !== "2207373534") why.push("lifecycle");
  if (on("customer") && p && p.hubspot_customer) why.push("customer");
  if (on("closed") && p && (p.merged_into || isClosed(p) || p.status !== "Active")) why.push("closed");
  if (on("owner") && c.hs_owner && ctRules.owners.includes(String(c.hs_owner))) why.push("owner");
  if (on("neverbounce") && c.hs_neverbounce && (["Invalid", "Disposable"].includes(c.hs_neverbounce) || (ctRules.strictValid && c.hs_neverbounce !== "Valid"))) why.push("neverbounce");
  out.reasons = why; out.status = why.length ? "suppressed" : "eligible";
  return out;
}
// One set of status badges everywhere a contact appears (Contacts, Audiences, Signals): NeverBounce result, unsubscribes, marketing consent, bounce and HubSpot sequence membership.
function ctBadges(c) {
  const out = [], nb = c.hs_neverbounce || c.nb_result;
  if (nb) out.push(chip("NB: " + nb.replace(" (Unverifiable)", ""), { Valid: "bg-emerald-100 text-emerald-800", "Accept All (Unverifiable)": "bg-teal-100 text-teal-800", Unknown: "bg-amber-100 text-amber-800" }[nb] || "bg-rose-100 text-rose-800", "NeverBounce: " + nb));
  if (c.email_opt_out || c.hs_optout_all) out.push(chip("Unsubscribed", "bg-rose-100 text-rose-800", "Opted out of all email"));
  if (c.hs_mkt_optout) out.push(chip("No marketing consent", "bg-rose-100 text-rose-800", "Opted out of Marketing Information"));
  if (c.hs_bounced) out.push(chip("Bounced", "bg-rose-100 text-rose-800", c.hs_bounce_reason || "Email bounced"));
  if (c.hs_in_sequence) out.push(chip("In sequence", "bg-purple-100 text-purple-800", "Enrolled in a HubSpot sequence"));
  else if (c.hs_seq_exit) out.push(chip("Left sequence: " + c.hs_seq_exit, "bg-slate-100 text-slate-700", "HubSpot took them out of the sequence" + (c.hs_seq_ended_at ? " on " + String(c.hs_seq_ended_at).slice(0, 10) : "")));   // HubSpot unenrols by its own rules; Atlas records the reason
  return out.join(" ");
}
// Why Atlas's suppression rules hold a contact back (blank when nothing does): the single answer used to disable ticking in Audiences and Signals.
const ctSuppressedWhy = (c, p) => { const e = ctEvaluate(c, p, new Map()); return e.status === "suppressed" ? e.reasons.map(ctRuleLabel).join("; ") : ""; };
// Re-engagement: the Lead property Disqualification Reason (internal values as HubSpot stores them). These reasons are not worth re-contacting by default; every reason can be switched in Settings.
const CT_DQ = { BAD_TIMING: "Bad Timing", BUDGET_CONSTRAINTS: "Budget Constraints", NO_DECISION_MAKING_POWER: "No Decision-making Power", COMPETITOR_PREFERENCE: "Competitor Preference", NOT_A_GOOD_FIT: "Not a Good Fit", NO_INTEREST: "No Interest",
  PRIOR_NEGATIVE_EXPERIENCE: "Prior Negative Experience", TECHNICAL_LIMITATIONS: "Technical Limitations", Other: "Other", "Stale Contact": "Stale Contact", "No Response / Ghosted": "No Response / Ghosted", "No Email": "No Email",
  "Engaged With Another Contact at Practice": "Engaged With Another Contact at Practice", Unsubscribed: "Unsubscribed" };
const CT_DQ_OFF = new Set(["Unsubscribed", "PRIOR_NEGATIVE_EXPERIENCE", "No Email", "NOT_A_GOOD_FIT"]);
// Closed-lost deals (the Deal property UM Closed Lost Reasons) also make a contact a re-engagement candidate; the key in the switches is "lost:" + reason.
const CT_LOST = ["No Budget / Too Expensive", "Timing / Project Delayed", "No Decision / Chose to Do Nothing", "Selected Competitor", "Poor Fit / Missing Requirements", "Lost Stakeholder Buy-In", "Sales Process Issue", "Other External Factors", "No reason recorded"];
CT_DQ_OFF.add("lost:Poor Fit / Missing Requirements");
const CT_LOST_KIND = { lead: "was a lead", freemium: "was a freemium user", customer: "was a customer" };
const ctLostOn = c => !!c.hs_lost_reason && ctDqOn("lost:" + c.hs_lost_reason);
const ctDqIn = c => !!c.hs_dq_reason && ctDqOn(c.hs_dq_reason);
const ctReReasons = c => [c.hs_dq_reason, c.hs_lost_reason].filter(Boolean);   // every reason that puts the contact in Re-engagement
const ctDqLabel = v => CT_DQ[v] || v;
const ctDqOn = v => ctRules.dq && ctRules.dq[v] !== undefined ? !!ctRules.dq[v] : !CT_DQ_OFF.has(v);
const ctRuleLabel = id => (CT_RULES.find(r => r[0] === id) || [id, id])[1];
