/* Contacts: which people we may contact, and why not. Two sets of rules that anyone can switch on and off in Contacts > Settings:
   - JOB ROLES: a contact's job title falls into one role group; each group is Main (decision-makers), Other, or Off.
   - SUPPRESSION RULES: reasons to hold a contact back from campaigns. They follow HubSpot's "Campaign Exclusion List", and nothing is written back to HubSpot.
   The rules themselves run in the database (see contact_status); this file keeps the labels and the Settings helpers. Saved in app_flags.contact_rules. */

// Role groups. [id, label, (unused), default section, locked]. The patterns that decide which group a title falls into now live in the database (ct_role), so there is one copy. Anything with a name and a direct address is wanted, so the default for a group that is not a decision-maker is Other.
const CT_ROLES = [
  ["dropped", "Marked as dropped", null, "off", true],
  ["deputy", "Deputy / assistant manager", null, "main"],
  ["pm", "Practice / business / general manager", null, "main"],
  ["ops", "Operations manager", null, "main"],
  ["director", "Practice / managing / executive director", null, "main"],
  ["partner", "GP / senior / managing partner", null, "main"],
  ["pcn", "PCN director or manager", null, "main"],
  ["senior", "Senior manager / head of", null, "main"],
  ["finance", "Finance, HR and business partner", null, "other"],
  ["digital", "Digital, IT and transformation", null, "other"],
  ["services", "Patient services and administration manager", null, "other"],
  ["gp", "GPs (not partners)", null, "other"],
  ["clinical", "Nurses and other clinicians", null, "other"],
  ["admin", "Reception, secretaries and clerks", null, "other"],
  ["other", "Other titles", null, "other"],
  ["none", "No job title", null, "other"],
];
const CT_ROLE = Object.fromEntries(CT_ROLES.map(r => [r[0], { id: r[0], label: r[1], re: r[2], def: r[3], locked: !!r[4] }]));
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
const CT_DEFAULTS = () => ({ roles: {}, titles: {}, titleModes: {}, dq: {}, suppression: {}, likely: false, strictValid: false, owners: ["78343211", "34750167", "34750166", "9112363"] });
let ctRules = CT_DEFAULTS(), ctMode = "standard";   // ctMode: standard campaigns, or re-engagement (lifts the lifecycle rule)
const ctRoleMode = id => (ctRules.roles[id] === "main" || ctRules.roles[id] === "other" || ctRules.roles[id] === "off") ? ctRules.roles[id] : CT_ROLE[id].def;
// A job title can be set on its own: Main, Other or Off, ahead of the group default it falls into.
const ctTitleMode = t => { const m = ctRules.titleModes && ctRules.titleModes[String(t || "").trim().toLowerCase()]; return m === "main" || m === "other" || m === "off" ? m : null; };
const ctRuleOn = id => ctRules.suppression[id] === undefined ? (CT_RULES.find(r => r[0] === id) || [])[3] !== false : !!ctRules.suppression[id];
function ctSetRules(v) { const d = CT_DEFAULTS(); ctRules = { ...d, ...(v || {}), roles: { ...(v || {}).roles }, titles: { ...(v || {}).titles }, titleModes: { ...(v || {}).titleModes }, dq: { ...(v || {}).dq }, suppression: { ...(v || {}).suppression }, owners: Array.isArray((v || {}).owners) ? v.owners.map(String) : d.owners }; }

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
