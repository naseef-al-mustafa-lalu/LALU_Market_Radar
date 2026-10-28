// Dashboard -> HubSpot: find a practice's company and deal, read them, write the approved pricing fields, and keep the link.
// The HubSpot token lives only in this function's secrets (HUBSPOT_TOKEN). Callers must be signed in AND on the allowed_users list.
// Only the properties listed below can ever be written, whatever the caller sends.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const HS = "https://api.hubapi.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const COMPANY_READ = ["name", "partner_organisation_code", "patient_list_size", "domain"];
const COMPANY_FIND = [...COMPANY_READ, "zip", "address", "city", "website"];
const COMPANY_CREATE = new Set(["name", "partner_organisation_code", "patient_list_size", "address", "city", "county", "zip", "phone", "website", "country", "company_status"]);
const COMPANY_STATUS = new Set(["Prospective Customer"]);   // the only status a new company may be created with
const NETWORK_TYPES = new Set(["p145802630_pcns", "p145802630_icbs"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEAL_READ = ["dealname", "dealstage", "amount", "size_tier", "size_discount", "speed_discount", "term_length_discount", "term_length_years",
  "total_discount", "referral_discount", "value_per_patient", "actual_value_per_patient_calculated", "patient_list_size", "commercial_model"];
const COMPANY_WRITE = new Set(["patient_list_size"]);
const DEAL_WRITE = new Set(["size_tier", "size_discount", "speed_discount", "term_length_discount", "referral_discount", "term_length_years", "value_per_patient", "commercial_model"]);
const COMMERCIAL_MODEL = new Set(["Subscription", "eMR+ SAR Only"]);   // ReportSure - MS - All Reports / ReportSure - MS - SAR Only
const VALUE_PER_PATIENT = new Set(["£0.05", "£0.06", "£0.07", "£0.08", "£0.10"]);

// The four Lalu Care products (created in HubSpot on 20 Oct 2026). Unit price comes from the product; the tool sets quantity, unit discount and term.
const LINE_PRODUCTS = new Set(["440423339237", "440425147578", "440434162881", "440498134244"]);   // All Report annual / monthly, SAR Only annual / monthly
const LINE_READ = ["name", "hs_product_id", "quantity", "price", "discount", "hs_discount_percentage", "amount", "hs_recurring_billing_period", "recurringbillingfrequency",
  "hs_recurring_billing_terms", "hs_recurring_billing_number_of_payments"];
const DEAL_CREATE = new Set(["dealname", "pipeline", "dealstage", "dealtype", "product___service", "hubspot_owner_id", "closedate", "amount"]);
const DEAL_TYPES = new Set(["newbusiness", "New Business GP eMR", "Existing Business - Freemium", "Existing Business - PAYG", "Existing Business - SAR Only", "Existing Business - GP eMR", "Renewal"]);
const PRODUCT_SERVICE = new Set(["eMR", "eMR+"]);
const ASSOC_DEAL_TO_COMPANY = 5, ASSOC_DEAL_TO_CONTACT = 3;   // HubSpot-defined association types
const LEAD_PIPELINE = "1654501563", LEAD_STAGE_NEW = "2248591599";   // Prospecting Pipeline, stage New
const LEAD_TO_PRIMARY_CONTACT = 578;   // HubSpot-defined association type: lead -> primary contact
const LEAD_TYPES = new Set(["NEW_BUSINESS", "RE_ATTEMPTING"]);
const LEAD_CAMPAIGNS = new Set(["PCN Prospecting", "ICB April 26", "Field Based Lead", "ICB Prospecting", "Atlas"]);
const NOTE_TO_DEAL = 214;   // HubSpot-defined association type: note -> deal
const REF_MEMBER = "Referred practice", REF_LEAD = "Referring practice";   // labels on the deal-to-deal association
const LINE_TO_DEAL = 20;   // HubSpot-defined association type: line item -> deal

// Pipelines and owners change rarely: keep them for five minutes inside a warm function instance.
const memo = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.v as T;
  const v = await fn(); memo.set(key, { at: Date.now(), v }); return v;
}

class Fail extends Error { constructor(msg: string, public status = 400) { super(msg); } }

async function hs(path: string, init: RequestInit = {}) {
  const r = await fetch(HS + path, {
    ...init,
    headers: { Authorization: `Bearer ${Deno.env.get("HUBSPOT_TOKEN")}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
  if (!r.ok) throw new Fail(`HubSpot ${r.status}: ${body?.message ?? "request failed"}`, r.status === 429 ? 429 : 502);
  return body;
}

const idOf = (v: unknown) => { const s = String(v ?? ""); if (!/^\d{1,20}$/.test(s)) throw new Fail("Invalid HubSpot id"); return s; };

async function dealsOf(companyId: string) {
  const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/deals?limit=100`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const d = await hs(`/crm/v3/objects/deals/batch/read`, { method: "POST", body: JSON.stringify({ properties: DEAL_READ, inputs: ids.map((id: string) => ({ id })) }) });
  return (d?.results ?? []).map((x: any) => ({ id: x.id, ...x.properties }));
}

async function lineItemsOf(dealId: string) {
  const a = await hs(`/crm/v4/objects/deals/${dealId}/associations/line_items?limit=100`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const d = await hs(`/crm/v3/objects/line_items/batch/read`, { method: "POST", body: JSON.stringify({ properties: LINE_READ, inputs: ids.map((id: string) => ({ id })) }) });
  return (d?.results ?? []).map((x: any) => ({ id: x.id, ...x.properties }));
}

async function contactsOf(companyId: string) {
  const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/contacts?limit=50`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const d = await hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["firstname", "lastname", "jobtitle", "email", "lifecyclestage", "hs_email_optout", "hs_email_bad_address"], inputs: ids.map((id: string) => ({ id })) }) });
  return (d?.results ?? []).map((x: any) => ({ id: x.id, ...x.properties }));
}

async function leadsOf(companyId: string) {
  const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/leads?limit=50`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const [d, pipes] = await Promise.all([
    hs(`/crm/v3/objects/leads/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["hs_lead_name", "hs_pipeline", "hs_pipeline_stage", "hs_lead_is_open_v2", "hs_createdate"], inputs: ids.map((id: string) => ({ id })) }) }),
    cached("pipelines:leads", () => hs(`/crm/v3/pipelines/leads`)).catch(() => null),
  ]);
  const stage = new Map<string, string>();
  for (const pl of pipes?.results ?? []) for (const st of pl.stages ?? []) stage.set(String(st.id), `${st.label} (${pl.label})`);
  return (d?.results ?? []).map((x: any) => ({ id: x.id, name: x.properties?.hs_lead_name ?? "Lead", stage: stage.get(String(x.properties?.hs_pipeline_stage)) ?? "", open: String(x.properties?.hs_lead_is_open_v2) !== "false" }));
}

// Find-or-create each contact by email and associate it with the company; mirrors the result onto the tool's own contacts table.
async function importContacts(admin: any, companyId: string, ods: string, list: any[], warnings: string[], who = "Atlas", companyName = "") {
  const out: any[] = [];
  for (const c of list.slice(0, 10)) {
    const email = String(c.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { warnings.push(`Skipped a contact without a valid email (${c.name ?? "unnamed"})`); continue; }
    try {
      const found = (await hs(`/crm/v3/objects/contacts/search`, { method: "POST", body: JSON.stringify({ properties: ["email", "createdate"], limit: 1,
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }) }))?.results ?? [];
      const [first, ...rest] = String(c.name ?? "").trim().split(/\s+/);
      const cid = found[0]?.id ?? String((await hs(`/crm/v3/objects/contacts`, { method: "POST", body: JSON.stringify({ properties: { email, firstname: first || undefined, lastname: rest.join(" ") || undefined,
        phone: c.phone || undefined, jobtitle: c.jobtitle || undefined } }) })).id);
      await hs(`/crm/v4/objects/contacts/${cid}/associations/default/companies/${companyId}`, { method: "PUT" });
      out.push({ email, id: cid, existed: !!found[0], name: String(c.name ?? "").trim() });
      await noteOn("contacts", cid, noteBody(who, found[0] ? `linked to ${companyName || "the practice company"} from the practice profile` : `created from the practice profile and linked to ${companyName || "the practice company"}`,
        found[0] ? [] : [`Email: blank → ${email}`, ...(c.name ? [`Name: blank → ${String(c.name).trim()}`] : []), ...(c.jobtitle ? [`Job title: blank → ${c.jobtitle}`] : []), ...(c.phone ? [`Phone: blank → ${c.phone}`] : [])]), warnings);
    } catch (e) { warnings.push(`Contact ${email}: ${(e as Error).message}`); }
  }
  if (out.length) await noteOn("companies", companyId, noteBody(who, `${out.length} contact${out.length > 1 ? "s" : ""} added from the practice profile`, out.map((c) => `${c.name || c.email} (${c.email}): ${c.existed ? "already in HubSpot, linked" : "created"}`)), warnings);
  const now = new Date().toISOString();
  for (const c of out) await admin.from("contacts").update({ hubspot_status: "Imported", hubspot_contact_id: c.id, hubspot_imported_at: now }).eq("ods_code", ods).ilike("email", c.email);
  return out;
}

async function readPair(companyId: string, dealId: string) {
  const [company, deal, dealCompanies, lineItems] = await Promise.all([
    hs(`/crm/v3/objects/companies/${companyId}?properties=${COMPANY_READ.join(",")}`),
    hs(`/crm/v3/objects/deals/${dealId}?properties=${DEAL_READ.join(",")}`),
    hs(`/crm/v4/objects/deals/${dealId}/associations/companies?limit=100`),   // one call proves the deal belongs to the company
    lineItemsOf(dealId).catch(() => null),   // null when the token lacks the line item scope; the dashboard then says so
  ]);
  if (!(dealCompanies?.results ?? []).some((x: any) => String(x.toObjectId) === companyId)) throw new Fail("That deal is not associated with that company");
  return { company: { id: company.id, ...company.properties }, deal: { id: deal.id, ...deal.properties }, lineItems };
}

// The deal-to-deal association labels for a referral group; created once (needs the crm.schemas.deals.write scope), then reused.
async function referralLabelId(): Promise<number> {
  const find = (r: any) => (r?.results ?? []).find((x: any) => x.label === REF_MEMBER);
  let hit = find(await hs(`/crm/v4/associations/deals/deals/labels`));
  if (!hit) { await hs(`/crm/v4/associations/deals/deals/labels`, { method: "POST", body: JSON.stringify({ label: REF_MEMBER, inverseLabel: REF_LEAD, name: "referred_practice" }) });
    hit = find(await hs(`/crm/v4/associations/deals/deals/labels`)); }
  if (!hit) throw new Fail("Could not create the referral group association labels");
  return Number(hit.typeId);
}

// After a pricing write: record the group (or its revert) in our table, put a note on the deal and label the referring practice's deal against each referred practice's deal. Each step only warns on failure.
async function referralFollowUp(admin: any, who: string, ods: string, dealId: string, dealName: string, r: any, warnings: string[]) {
  const now = new Date().toISOString();
  if (r.revert) {
    const { data } = await admin.from("referral_groups").update({ status: "reverted", reverted_at: now, reverted_by: who }).eq("lead_ods", ods).eq("status", "active").select("id");
    if (!data?.length) return { reverted: false };
    await note(dealId, `Referral group discount removed by ${who} on ${now.slice(0, 10)}: the deal is priced for this practice alone again.`, warnings);
    return { reverted: true };
  }
  const members = (Array.isArray(r.members) ? r.members : []).slice(0, 40).map((m: any) => ({ ods: String(m.ods ?? "").toUpperCase().slice(0, 12), name: String(m.name ?? "").slice(0, 120), patients: Number(m.patients) || 0 }));
  if (!members.length) return null;
  const expires = new Date(Date.now() + 90 * 864e5).toISOString();
  await admin.from("referral_groups").update({ status: "reverted", reverted_at: now, reverted_by: who }).eq("lead_ods", ods).eq("status", "active");
  const ins = await admin.from("referral_groups").insert({ lead_ods: ods, lead_deal_id: dealId, members, combined_patients: Number(r.combined) || null, extra_discount: Number(r.extra) || null, created_by: who, expires_at: expires }).select("id").single();
  if (ins.error) warnings.push(`Could not record the group: ${ins.error.message}`);
  const list = members.map((m: any) => `${m.name} (${m.ods}, ${m.patients.toLocaleString()} patients)`).join("; ");
  await note(dealId, `Referral group discount of ${(Number(r.extra) * 100).toFixed(1)}% applied by ${who} on ${now.slice(0, 10)}. Conditional on these practices signing within 90 days (by ${expires.slice(0, 10)}): ${list}. Combined list size ${Number(r.combined).toLocaleString()}. If they do not sign, set Referral Discount back to 0.`, warnings);
  const linked: string[] = [];
  try {
    const typeId = await referralLabelId();
    const { data: links } = await admin.from("hubspot_links").select("ods_code,deal_id").in("ods_code", members.map((m: any) => m.ods));
    for (const l of links ?? []) {
      if (!l.deal_id || String(l.deal_id) === dealId) continue;
      try { await hs(`/crm/v4/objects/deals/${dealId}/associations/deals/${idOf(l.deal_id)}`, { method: "PUT", body: JSON.stringify([{ associationCategory: "USER_DEFINED", associationTypeId: typeId }]) }); linked.push(l.ods_code); }
      catch (e) { warnings.push(`Could not link ${l.ods_code}'s deal: ${(e as Error).message}`); }
    }
    const withDeals = members.map((m: any) => ({ ...m, deal_id: (links ?? []).find((l: any) => l.ods_code === m.ods && linked.includes(l.ods_code))?.deal_id ?? null }));
    if (ins.data?.id) await admin.from("referral_groups").update({ members: withDeals }).eq("id", ins.data.id);
  } catch (e) { warnings.push(`Deal links: ${(e as Error).message}`); }
  return { members: members.length, linked, expires };
}

// A deal for a practice that belongs to an active referral group (created or pushed later) is labelled against the referring practice's deal and gets a short note.
async function linkIntoGroup(admin: any, ods: string, dealId: string, warnings: string[]) {
  const { data: groups } = await admin.from("referral_groups").select("id,lead_ods,lead_deal_id,members,extra_discount,expires_at").eq("status", "active").contains("members", [{ ods }]);
  const done: string[] = [];
  for (const g of groups ?? []) {
    if (!g.lead_deal_id || g.lead_ods === ods || String(g.lead_deal_id) === dealId) continue;
    const mem = (g.members ?? []).find((m: any) => m.ods === ods);
    if (mem?.deal_id && String(mem.deal_id) === dealId) continue;   // already linked
    try {
      await hs(`/crm/v4/objects/deals/${idOf(g.lead_deal_id)}/associations/deals/${dealId}`, { method: "PUT", body: JSON.stringify([{ associationCategory: "USER_DEFINED", associationTypeId: await referralLabelId() }]) });
      await admin.from("referral_groups").update({ members: (g.members ?? []).map((m: any) => m.ods === ods ? { ...m, deal_id: dealId } : m) }).eq("id", g.id);
      await note(dealId, `Referred by practice ${g.lead_ods} (deal ${g.lead_deal_id}) as part of a referral group. The referring practice's referral discount of ${(Number(g.extra_discount) * 100).toFixed(1)}% depends on this practice signing by ${String(g.expires_at ?? "").slice(0, 10)}.`, warnings);
      done.push(g.lead_ods);
    } catch (e) { warnings.push(`Referral group link for ${g.lead_ods}: ${(e as Error).message}`); }
  }
  return done;
}

// Atlas's audit trail: every change it makes to a HubSpot record leaves a note on that record saying who, when, and what changed from and to.
const NOTE_TO: Record<string, number> = { companies: 190, deals: NOTE_TO_DEAL, contacts: 202 };   // HubSpot-defined association types: note -> company / deal / contact
const LABELS: Record<string, string> = { patient_list_size: "Patient List Size", size_tier: "Size tier", size_discount: "Size discount", speed_discount: "Speed discount", term_length_discount: "Term discount",
  referral_discount: "Referral discount", term_length_years: "Term length (years)", value_per_patient: "Value per patient", commercial_model: "Commercial model", org_type: "Org Type", operating_status: "Operating status",
  partner_organisation_code: "GP ODS Code", dealname: "Deal name", dealstage: "Deal stage", pipeline: "Pipeline", dealtype: "Deal type", product___service: "Product / Service", amount: "Amount", closedate: "Close date", hubspot_owner_id: "Owner" };
const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const show = (v: unknown) => (v === null || v === undefined || v === "") ? "blank" : String(v);
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
// "Label: from → to" for every key whose value changes (numbers compared as numbers, so 12000 and "12000.0" are the same)
const same = (a: unknown, b: unknown) => show(a) === show(b) || (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && show(a) !== "blank" && show(b) !== "blank" && Number(a) === Number(b));
const changes = (before: any, after: Record<string, unknown>): string[] => Object.entries(after).filter(([k, v]) => !same(before?.[k], v)).map(([k, v]) => `${LABELS[k] ?? k}: ${show(before?.[k])} → ${show(v)}`);
const noteBody = (who: string, headline: string, lines: string[] = []) => [esc(`Atlas, ${stamp()}, by ${who}: ${headline}`), ...lines.map((l) => esc("• " + l))].join("<br>");
async function noteOn(obj: string, id: string, body: string, warnings: string[]) {
  try {
    const props = { hs_timestamp: new Date().toISOString(), hs_note_body: body };
    if (NOTE_TO[obj]) await hs(`/crm/v3/objects/notes`, { method: "POST", body: JSON.stringify({ properties: props, associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO[obj] }] }] }) });
    else { const n = await hs(`/crm/v3/objects/notes`, { method: "POST", body: JSON.stringify({ properties: props }) }); await hs(`/crm/v4/objects/notes/${n.id}/associations/default/${obj}/${id}`, { method: "PUT" }); }
  } catch (e) { warnings.push(`Note not added on ${obj} ${id}: ${(e as Error).message}`); }
}
async function notesBatch(obj: string, items: [string, string][], warnings: string[]) {   // up to 100 notes per call, for the many contacts of an audience push
  for (let i = 0; i < items.length; i += 100) {
    try {
      await hs(`/crm/v3/objects/notes/batch/create`, { method: "POST", body: JSON.stringify({ inputs: items.slice(i, i + 100).map(([id, body]) => ({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
        associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO[obj] }] }] })) }) });
    } catch (e) { warnings.push(`Notes not added on ${obj}: ${(e as Error).message}`); }
  }
}
const note = (dealId: string, body: string, warnings: string[]) => noteOn("deals", dealId, body, warnings);

// Sequences belong to HubSpot users: the sequences API wants the user id, which the owners list carries beside the owner id.
async function userIdOf(email: string): Promise<string> {
  const r = await cached(`user:${email.toLowerCase()}`, () => hs(`/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`));
  const id = r?.results?.[0]?.userId;
  if (!id) throw new Fail(`${email} is not a HubSpot user, so sequences cannot be used as them`);
  return String(id);
}
const CONTACT_SEQ_PROPS = ["hs_sequences_is_enrolled", "hs_sequences_actively_enrolled_count", "hs_sequences_enrolled_count", "hs_latest_sequence_enrolled", "hs_latest_sequence_enrolled_date", "hs_latest_sequence_ended_date",
  "hs_sales_email_last_replied", "hs_sales_email_last_opened", "hs_sales_email_last_clicked", "engagements_last_meeting_booked", "hs_v2_date_entered_marketingqualifiedlead", "hs_email_optout", "hs_email_bad_address"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!Deno.env.get("HUBSPOT_TOKEN")) throw new Fail("HUBSPOT_TOKEN secret is not set for this function", 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const [{ data: allowed, error: aerr }, { data: u }] = await Promise.all([supa.rpc("am_i_allowed"), supa.auth.getUser()]);   // in parallel: both only need the caller's token
    if (aerr || allowed !== true) throw new Fail("Not authorised", 403);
    const who = u?.user?.email ?? "unknown";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json();
    const log = async (row: Record<string, unknown>) => { try { await admin.from("hubspot_activity").insert({ ok: true, ...row }); } catch (_) { /* logging must never block the action */ } };

    if (b.action === "find") {                       // companies by ODS code first, then by name
      const ods = String(b.ods ?? "").trim().toUpperCase().slice(0, 12), name = String(b.name ?? "").trim().slice(0, 100);
      const search = (body: unknown) => hs(`/crm/v3/objects/companies/search`, { method: "POST", body: JSON.stringify({ properties: COMPANY_FIND, limit: 10, ...(body as object) }) });
      const out = new Map<string, any>();
      if (ods) for (const c of (await search({ filterGroups: [{ filters: [{ propertyName: "partner_organisation_code", operator: "EQ", value: ods }] }] }))?.results ?? []) out.set(c.id, { id: c.id, ...c.properties, match: "ODS code" });
      const q = String(b.query ?? name).trim().slice(0, 100);
      if (q) for (const c of (await search({ query: q }))?.results ?? []) if (!out.has(c.id)) out.set(c.id, { id: c.id, ...c.properties, match: "Name" });
      return reply({ companies: [...out.values()] });
    }
    if (b.action === "read") return reply(await readPair(idOf(b.companyId), idOf(b.dealId)));

    if (b.action === "set_list_size") {     // a customer's renewal: write today's list size to the HubSpot company (the company must carry this practice's ODS code)
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), size = Number(b.size);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      if (!(Number.isInteger(size) && size > 0 && size <= 2000000)) throw new Fail("Invalid list size");
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name,partner_organisation_code,patient_list_size`);
      if (String(co.properties?.partner_organisation_code ?? "").toUpperCase() !== ods) throw new Fail("That HubSpot company does not carry this practice's ODS code");
      await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: { patient_list_size: String(size) } }) });
      await admin.from("gp_practices").update({ hubspot_list_size: size }).eq("ods_code", ods);
      const sizeWarn: string[] = [];
      await noteOn("companies", companyId, noteBody(who, "list size set from the practice profile (an approved NHS figure)", changes(co.properties, { patient_list_size: size })), sizeWarn);
      await log({ actor: who, kind: "list_size", ods_code: ods, target: String(co.properties?.name ?? ""), hubspot_type: "company", hubspot_id: companyId,
        summary: `Set list size on ${co.properties?.name ?? companyId} from ${co.properties?.patient_list_size ?? "blank"} to ${size.toLocaleString()}`, detail: { companyId, before: co.properties?.patient_list_size ?? null, after: size, warnings: sizeWarn } });
      return reply({ ok: true, size, warnings: sizeWarn });
    }
    if (b.action === "entity_change") {     // a merged practice stays in HubSpot as Merged under its successor; a closed code whose site goes on as a branch stays as Closed, and the site gets its own Branch company. Companies are linked for traceability; no ODS code is ever rewritten.
      const mode = String(b.mode ?? ""), ods = String(b.ods ?? "").trim().toUpperCase(), parentOds = String(b.parentOds ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), parentId = idOf(b.parentCompanyId);
      if (!["merged", "branch"].includes(mode)) throw new Fail("Unknown change");
      if (![ods, parentOds].every((c) => /^[A-Z0-9]{3,12}$/.test(c))) throw new Fail("Invalid ODS code");
      if (companyId === parentId) throw new Fail("A company cannot be its own parent");
      const zero = b.zeroSize === true;   // NHS counts this practice at 0 (its patients are with the successor), so HubSpot does too; the old size goes in the note
      const orgType = String(b.orgType ?? "practice"); if (!["practice", "branch_site"].includes(orgType)) throw new Fail("Unsupported Org Type");   // a merged practice whose site goes on as a branch of its successor is a Branch (Site)
      const br = mode === "branch" ? (b.branch ?? {}) : null, branchCode = String(br?.code ?? "").trim().toUpperCase();
      if (br && (!/^[A-Z0-9]{3,12}$/.test(branchCode) || !String(br.name ?? "").trim())) throw new Fail("The branch needs a code and a name");
      const props = "name,partner_organisation_code,org_type,operating_status,hs_parent_company_id,patient_list_size";
      const [co, parent] = await Promise.all([hs(`/crm/v3/objects/companies/${companyId}?properties=${props}`), hs(`/crm/v3/objects/companies/${parentId}?properties=${props}`)]);
      if (String(co.properties?.partner_organisation_code ?? "").toUpperCase() !== ods) throw new Fail("That HubSpot company does not carry this practice's ODS code");
      if (String(parent.properties?.partner_organisation_code ?? "").toUpperCase() !== parentOds) throw new Fail("The parent company does not carry the expected ODS code");
      const warnings: string[] = [], day = new Date().toISOString().slice(0, 10), parentName = String(parent.properties?.name ?? parentOds), oldName = String(co.properties?.name ?? ods);
      const toParent = async (childId: string, label: string) => {   // HubSpot's company hierarchy: typeId 14 is "Parent Company" from the child's side
        try {
          await hs(`/crm/v4/objects/companies/${childId}/associations/companies/${parentId}`, { method: "PUT", body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 14 }]) });
          let linked = false;   // HubSpot fills in hs_parent_company_id a moment after the association is created, so read it back a few times before warning
          for (let i = 0; i < 5 && !linked; i++) {
            await new Promise((r) => setTimeout(r, i === 0 ? 400 : 900));
            const after = await hs(`/crm/v3/objects/companies/${childId}?properties=hs_parent_company_id`);
            linked = String(Math.round(Number(after.properties?.hs_parent_company_id))) === parentId;
          }
          if (!linked) warnings.push(`${label}: HubSpot does not show the parent link yet; check it in HubSpot.`);
        } catch (e) { warnings.push(`${label} could not be linked to its parent: ${(e as Error).message}`); }
      };
      const coNote = (id: string, text: string) => noteOn("companies", id, text, warnings);   // same helper as everywhere else, on a company, collecting this action's warnings
      await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: { org_type: mode === "merged" ? orgType : "practice", operating_status: mode === "merged" ? "merged" : "closed", ...(zero ? { patient_list_size: "0" } : {}) } }) });
      await toParent(companyId, oldName);
      let branchId: string | null = null, created = false, moved = 0;
      if (br) {
        const hit = (await hs(`/crm/v3/objects/companies/search`, { method: "POST", body: JSON.stringify({ properties: ["name"], limit: 3, filterGroups: [{ filters: [{ propertyName: "partner_organisation_code", operator: "EQ", value: branchCode }] }] }) }))?.results ?? [];
        if (hit.some((c: any) => String(c.id) === companyId)) throw new Fail(`This company already carries ${branchCode}`);
        const shared = { org_type: "branch_site", operating_status: "active" };
        if (hit[0]) { branchId = String(hit[0].id); await hs(`/crm/v3/objects/companies/${branchId}`, { method: "PATCH", body: JSON.stringify({ properties: shared }) }); }
        else {
          const cp: Record<string, string> = { ...shared, name: String(br.name).trim().slice(0, 200), partner_organisation_code: branchCode };
          for (const [k, f] of [["address", "address"], ["city", "town"], ["zip", "postcode"], ["phone", "phone"]]) if (String(br[f] ?? "").trim()) cp[k] = String(br[f]).trim().slice(0, 200);
          branchId = String((await hs(`/crm/v3/objects/companies`, { method: "POST", body: JSON.stringify({ properties: cp }) })).id); created = true;
        }
        await toParent(branchId, `Branch ${branchCode}`);
        try { await hs(`/crm/v4/objects/companies/${companyId}/associations/default/companies/${branchId}`, { method: "PUT" }); } catch (e) { warnings.push(`The two companies could not be linked to each other: ${(e as Error).message}`); }
        if (b.moveContacts === true) {   // contacts keep their company; they are also associated with the branch so their emails show on both records
          try {
            const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/contacts?limit=100`);
            for (const x of a?.results ?? []) { try { await hs(`/crm/v4/objects/contacts/${idOf(x.toObjectId)}/associations/default/companies/${branchId}`, { method: "PUT" }); moved++; } catch (_) { /* one contact failing must not stop the rest */ } }
          } catch (e) { warnings.push(`Contacts were not linked to the branch: ${(e as Error).message}`); }
        }
      }
      const text = mode === "merged" ? `Atlas, ${day}, by ${who}: practice ${ods} has merged into ${parentName} (${parentOds}). Operating status set to Merged${orgType === "branch_site" ? ", Org Type set to Branch (Site) because its site continues as a branch of the successor," : ""} and linked to ${parentName} as its parent company. The company and its history stay here.${zero ? ` List size set to 0 (was ${co.properties?.patient_list_size ?? "blank"}) because its patients are counted at ${parentName}; this stops HubSpot counting them twice.` : ""}`
        : `Atlas, ${day}, by ${who}: practice code ${ods} has closed, but its site continues as ${br.name} (${branchCode}), a branch of ${parentName} (${parentOds}). This company is marked Closed and linked to ${parentName} as its parent and to the branch company${created ? " (created by Atlas)" : ""}. Its history stays here.${zero ? ` List size set to 0 (was ${co.properties?.patient_list_size ?? "blank"}) because its patients are counted at ${parentName}; this stops HubSpot counting them twice.` : ""}`;
      const diff = changes(co.properties, { org_type: mode === "merged" ? orgType : "practice", operating_status: mode === "merged" ? "merged" : "closed", ...(zero ? { patient_list_size: 0 } : {}) });
      await coNote(companyId, esc(text) + (diff.length ? "<br>" + diff.map((l) => esc("• " + l)).join("<br>") : ""));
      if (branchId) await coNote(branchId, esc(`Atlas, ${day}, by ${who}: this branch site took over from the closed practice code ${ods} (${oldName}), which is linked to this company for history. Parent: ${parentName} (${parentOds}).`) + (created ? "<br>" + esc("• Company: not in HubSpot → created by Atlas") : ""));
      const changeNote = (mode === "merged" ? `Merged into ${parentName} (${parentOds}); marked Merged${orgType === "branch_site" ? " and as a Branch (Site)" : ""} and linked to its parent in HubSpot` : `Closed; site continues as ${branchCode}, a branch of ${parentName} (${parentOds}); marked Closed in HubSpot and linked to the parent and the branch company`) + ` on ${day} by ${who}`;
      await admin.from("gp_practices").update({ hubspot_operating_status: mode === "merged" ? "merged" : "closed", hubspot_org_type: mode === "merged" ? orgType : "practice", hubspot_parent_company_id: parentId, hubspot_change_note: changeNote, ...(zero ? { hubspot_list_size: 0 } : {}) }).eq("ods_code", ods);
      if (branchId) await admin.from("practice_branches").update({ hubspot_company_id: branchId }).eq("branch_code", branchCode);
      await log({ actor: who, kind: "entity_change", ods_code: ods, target: oldName, hubspot_type: "company", hubspot_id: companyId, summary: changeNote.replace(/ on \d{4}-\d{2}-\d{2} by .*$/, ""),
        detail: { mode, companyId, parentId, branchCode: branchCode || null, branchId, created, contactsLinked: moved, before: co.properties, warnings } });
      return reply({ ok: true, branchId, created, contactsLinked: moved, warnings });
    }
    if (b.action === "write") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), dealId = idOf(b.dealId);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const dealProps: Record<string, unknown> = {}, companyProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.deal ?? {})) { if (!DEAL_WRITE.has(k)) throw new Fail(`Not allowed to write deal property ${k}`); dealProps[k] = v; }
      for (const [k, v] of Object.entries(b.company ?? {})) { if (!COMPANY_WRITE.has(k)) throw new Fail(`Not allowed to write company property ${k}`); companyProps[k] = v; }
      for (const k of ["size_discount", "speed_discount", "term_length_discount", "referral_discount"]) if (k in dealProps && !(Number(dealProps[k]) >= 0 && Number(dealProps[k]) <= 1)) throw new Fail(`${k} out of range`);
      if ("value_per_patient" in dealProps && !VALUE_PER_PATIENT.has(String(dealProps.value_per_patient))) throw new Fail("Unsupported Value per Patient option");
      if ("commercial_model" in dealProps && !COMMERCIAL_MODEL.has(String(dealProps.commercial_model))) throw new Fail("Unsupported Commercial Model option");
      if ("term_length_years" in dealProps && !["1", "2", "3"].includes(String(dealProps.term_length_years))) throw new Fail("Term length must be 1, 2 or 3");
      if ("size_tier" in dealProps && !/^Tier [1-5]$/.test(String(dealProps.size_tier))) throw new Fail("Invalid size tier");
      if ("patient_list_size" in companyProps && !(Number(companyProps.patient_list_size) >= 0)) throw new Fail("Invalid list size");

      const li = b.lineItem ?? null;
      if (li) {
        if (!LINE_PRODUCTS.has(String(li.productId))) throw new Fail("Unsupported product for the line item");
        if (!(Number.isInteger(li.quantity) && li.quantity > 0 && li.quantity <= 2000000)) throw new Fail("Invalid line item quantity");
        if (!(Number(li.netUnit) > 0 && Number(li.netUnit) < 100) || !(Number(li.listUnit) > 0 && Number(li.listUnit) < 100)) throw new Fail("Invalid line item unit price");
        if (li.termMonths != null && ![1, 12, 24, 36].includes(Number(li.termMonths))) throw new Fail("Term must be 1, 12, 24 or 36 months");
        if (!["annually", "monthly"].includes(String(li.frequency)) || !["FIXED", "AUTOMATICALLY_RENEW"].includes(String(li.terms))) throw new Fail("Invalid billing settings");
        if (li.payments != null && !(Number.isInteger(li.payments) && li.payments >= 1 && li.payments <= 36)) throw new Fail("Invalid number of payments");
      }
      const before = await readPair(companyId, dealId);   // also proves the deal belongs to the company
      if (li && before.lineItems == null) throw new Fail("The HubSpot token cannot read line items: add the crm.objects.line_items.read and write scopes (and e-commerce for products). Nothing was written.");
      if (Object.keys(companyProps).length) await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: companyProps }) });
      if (Object.keys(dealProps).length) await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: dealProps }) });

      const noteWarn: string[] = [];
      const dealLines = changes(before.deal, dealProps), pushed = "pricing pushed from the Atlas pricing tool";
      if (Object.keys(companyProps).length) await noteOn("companies", companyId, noteBody(who, pushed + " (company)", changes(before.company, companyProps)), noteWarn);
      let lineResult: any = null, lineLines: string[] = [];
      if (li) {
        const ours = before.lineItems.filter((x: any) => LINE_PRODUCTS.has(String(x.hs_product_id)));
        if (ours.length > 1) throw new Fail("This deal has more than one Lalu Care line item. Remove the extras in HubSpot first.");
        const billing = { ...(li.termMonths != null ? { hs_recurring_billing_period: `P${Number(li.termMonths)}M` } : {}), recurringbillingfrequency: String(li.frequency), hs_recurring_billing_terms: String(li.terms),   // everyone is billed monthly; Annual or Monthly is the product, so no period is set unless one is sent
         
          ...(li.payments != null ? { hs_recurring_billing_number_of_payments: String(li.payments) } : {}) };
        let lineId: string, action: string;
        if (ours.length && String(ours[0].hs_product_id) === String(li.productId)) {
          lineId = ours[0].id; action = "updated";
          await hs(`/crm/v3/objects/line_items/${lineId}`, { method: "PATCH", body: JSON.stringify({ properties: { quantity: String(li.quantity), price: String(li.listUnit), ...billing } }) });
        } else {
          if (ours.length) { await hs(`/crm/v3/objects/line_items/${ours[0].id}`, { method: "DELETE" }); }   // the tool's own line, for a different product
          const c = await hs(`/crm/v3/objects/line_items`, { method: "POST", body: JSON.stringify({ properties: { hs_product_id: String(li.productId), quantity: String(li.quantity), price: String(li.listUnit), ...billing },
            associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LINE_TO_DEAL }] }] }) });
          lineId = String(c.id); action = ours.length ? "replaced" : "created";
        }
        const unit = Number(li.listUnit);   // the price is written explicitly, per patient per month, so it never depends on the product's own price or on what someone later edited
        const discount = Math.max(0, Math.round((unit - Number(li.netUnit)) * 10000) / 10000);   // flat per-unit discount: the tool's list price less the calculator's net price
        await hs(`/crm/v3/objects/line_items/${lineId}`, { method: "PATCH", body: JSON.stringify({ properties: { discount: String(discount), hs_discount_percentage: "" } }) });
        lineResult = { id: lineId, action, unit, discount };
        const old = action === "updated" ? ours[0] : null;
        lineLines = [`Line item ${action}${action === "replaced" && ours[0] ? ` (was ${ours[0].name ?? ours[0].hs_product_id})` : ""}`, ...changes(old ?? {}, { quantity: li.quantity, price: unit, discount, recurringbillingfrequency: li.frequency, hs_recurring_billing_terms: li.terms, ...(li.termMonths != null ? { hs_recurring_billing_period: `P${Number(li.termMonths)}M` } : {}) })
          .map((l) => l.replace(/^quantity:/, "Patients:").replace(/^price:/, "List price p/patient/month:").replace(/^discount:/, "Unit discount:").replace(/^recurringbillingfrequency:/, "Billing frequency:").replace(/^hs_recurring_billing_terms:/, "Billing terms:").replace(/^hs_recurring_billing_period:/, "Billing period:"))];
      }
      if (dealLines.length || lineLines.length) await noteOn("deals", dealId, noteBody(who, pushed, [...dealLines, ...lineLines]), noteWarn);
      await admin.from("hubspot_links").upsert({ ods_code: ods, company_id: companyId, company_name: before.company.name ?? null, deal_id: dealId, deal_name: before.deal.dealname ?? null,
        linked_by: who, linked_at: new Date().toISOString(), last_pushed_at: new Date().toISOString() }, { onConflict: "ods_code" });
      await log({ actor: who, kind: "push", ods_code: ods, target: before.deal.dealname ?? before.company.name ?? null, hubspot_type: "deal", hubspot_id: dealId,
        summary: `Pushed pricing to ${before.deal.dealname ?? "deal"}: ${Object.keys(dealProps).length} deal field(s)${Object.keys(companyProps).length ? ", company list size" : ""}${lineResult ? `, line item ${lineResult.action}` : ""}`,
        detail: { companyId, dealId, before: { company: before.company, deal: before.deal, lineItems: before.lineItems }, written: { company: companyProps, deal: dealProps, lineItem: li, lineResult } } });
      const warnings: string[] = [...noteWarn];
      const grouped = b.referral ? [] : await linkIntoGroup(admin, ods, dealId, warnings).catch(() => []);
      const referral = b.referral ? await referralFollowUp(admin, who, ods, dealId, String(before.deal.dealname ?? "deal"), b.referral, warnings).catch((e) => { warnings.push(`Referral group: ${(e as Error).message}`); return null; }) : null;
      return reply({ ok: true, ...(await readPair(companyId, dealId)), referral, grouped, warnings });
    }
    if (b.action === "create_company" || b.action === "link_company") {
      const ods = String(b.ods ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const warnings: string[] = [];
      const existing = (await hs(`/crm/v3/objects/companies/search`, { method: "POST", body: JSON.stringify({ properties: COMPANY_FIND, limit: 5,
        filterGroups: [{ filters: [{ propertyName: "partner_organisation_code", operator: "EQ", value: ods }] }] }) }))?.results ?? [];
      if (existing.length) throw new Fail(`A HubSpot company with ODS code ${ods} already exists (${existing[0].properties?.name ?? existing[0].id}). Run the HubSpot sync to link it.`);
      let companyId: string;
      if (b.action === "link_company") {      // give an existing company with no ODS code its GP ODS Code, so the sync links it
        companyId = idOf(b.companyId);
        const cur = await hs(`/crm/v3/objects/companies/${companyId}?properties=partner_organisation_code,name`);
        if (cur.properties?.partner_organisation_code) throw new Fail("That company already has a GP ODS Code");
        await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: { partner_organisation_code: ods } }) });
        await noteOn("companies", companyId, noteBody(who, "linked to its NHS practice record in Atlas", changes(cur.properties, { partner_organisation_code: ods })), warnings);
      } else {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b.company ?? {})) { if (!COMPANY_CREATE.has(k)) throw new Fail(`Not allowed to set company property ${k}`); if (v !== null && v !== "") props[k] = v; }
        if (!props.name || String(props.partner_organisation_code ?? "").toUpperCase() !== ods) throw new Fail("A name and the matching GP ODS Code are required");
        if (props.company_status && !COMPANY_STATUS.has(String(props.company_status))) throw new Fail("Unsupported Company Status for a new company");
        props.partner_organisation_code = ods;
        companyId = String((await hs(`/crm/v3/objects/companies`, { method: "POST", body: JSON.stringify({ properties: props }) })).id);
        await noteOn("companies", companyId, noteBody(who, "company created from the practice profile", changes({}, props)), warnings);
      }
      const done: any = { companyId, contacts: [] as any[], networks: [] as string[] };
      done.contacts = await importContacts(admin, companyId, ods, Array.isArray(b.contacts) ? b.contacts : [], warnings, who, String((b.company ?? {}).name ?? ""));
      for (const n of (Array.isArray(b.networks) ? b.networks : []).slice(0, 4)) {
        if (!NETWORK_TYPES.has(String(n.type))) continue;
        try {
          await hs(`/crm/v4/objects/companies/${companyId}/associations/default/${n.type}/${idOf(n.id)}`, { method: "PUT" }); done.networks.push(`${n.type}:${n.id}`);
          await noteOn("companies", companyId, noteBody(who, `associated with a ${n.type === "p145802630_pcns" ? "PCN" : "ICB"} record`, [`${n.type === "p145802630_pcns" ? "PCN" : "ICB"}: blank → ${String(n.name ?? n.id)}`]), warnings);
        }
        catch (e) { warnings.push(`Association to ${n.type === "p145802630_pcns" ? "PCN" : "ICB"} record: ${(e as Error).message}`); }
      }
      const now = new Date().toISOString();
      await admin.from("gp_practices").update({ hubspot_company_id: companyId, hubspot_company_imported_at: now, hubspot_synced_at: now }).eq("ods_code", ods);
      await log({ actor: who, kind: b.action, ods_code: ods, target: String((b.company ?? {}).name ?? ""), hubspot_type: "company", hubspot_id: companyId,
        summary: b.action === "create_company" ? `Created company ${(b.company ?? {}).name ?? ods} with ${done.contacts.length} contact(s) and ${done.networks.length} PCN/ICB association(s)` : `Linked existing company ${companyId} to ${ods}`,
        detail: { done, warnings, company: b.company ?? null } });
      return reply({ ok: true, ...done, warnings });
    }
    if (b.action === "hub") {               // everything the company page shows in one call: company, its contacts, leads and deals
      const companyId = idOf(b.companyId);
      const [company, contacts, deals, leads] = await Promise.all([
        hs(`/crm/v3/objects/companies/${companyId}?properties=${COMPANY_READ.join(",")}`), contactsOf(companyId), dealsOf(companyId), leadsOf(companyId).catch(() => null)]);
      return reply({ company: { id: company.id, ...company.properties }, contacts, deals, leads });   // leads is null when the token cannot read them
    }
    if (b.action === "sequences") {        // the sequences a HubSpot user can use, for choosing an audience's sequence
      const email = String(b.sender ?? who).trim(), uid = await userIdOf(email), out: any[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await hs(`/automation/v4/sequences?userId=${uid}&limit=100${after ? `&after=${after}` : ""}`);
        for (const x of r?.results ?? []) out.push({ id: String(x.id), name: x.name });
        after = r?.paging?.next?.after; if (!after) break;
      }
      return reply({ sender: email, sequences: out.sort((x, y) => String(x.name).localeCompare(String(y.name))) });
    }
    if (b.action === "sequence_status") {   // is each sequence visible to its sender in HubSpot, and does it have steps
      const ids = [...new Set((Array.isArray(b.sequences) ? b.sequences : []).map((x: any) => `${x.id}|${x.sender ?? ""}`))].slice(0, 20), out: Record<string, any> = {};
      for (const key of ids) {
        const [id, sender] = key.split("|"); const email = sender || who;
        try {
          const uid = await userIdOf(email), d = await hs(`/automation/v4/sequences/${idOf(id)}?userId=${uid}`);
          const steps = Array.isArray(d?.steps) ? d.steps.length : null;
          out[id] = steps === 0 ? { state: "empty", sender: email } : { state: "ready", steps, sender: email, name: d?.name ?? null };
        } catch (e) { out[id] = { state: (e as Fail).status === 502 && /404|not found/i.test((e as Error).message) ? "missing" : "error", message: (e as Error).message.slice(0, 160), sender: email }; }
      }
      return reply({ status: out });
    }
    if (b.action === "audience_push") {     // approved contacts: into the audience's HubSpot list, and (when asked) into its sequence
      const { data: a } = await admin.from("audiences").select("*").eq("id", String(b.audienceId ?? "")).eq("archived", false).maybeSingle();
      if (!a) throw new Fail("Audience not found");
      const ids = [...new Set((Array.isArray(b.contactIds) ? b.contactIds : []).map(idOf))].slice(0, 200);
      if (!ids.length) throw new Fail("No contacts to add");
      const warnings: string[] = [], results: Record<string, string> = {};
      let listId = a.hubspot_list_id as string | null;
      if (!listId) {
        const mk = (name: string) => hs(`/crm/v3/lists`, { method: "POST", body: JSON.stringify({ name, objectTypeId: "0-1", processingType: "MANUAL" }) });
        let made: any;
        try { made = await mk(`Atlas: ${a.name}`); } catch (_) { made = await mk(`Atlas: ${a.name} (${String(a.id).slice(0, 6)})`); }
        listId = String(made?.list?.listId ?? made?.listId);
        if (!listId || listId === "undefined") throw new Fail("HubSpot did not return the new list id");
        await admin.from("audiences").update({ hubspot_list_id: listId }).eq("id", a.id);
      }
      const perContact: Record<string, string[]> = {};
      let listed = false;
      try { await hs(`/crm/v3/lists/${listId}/memberships/add`, { method: "PUT", body: JSON.stringify(ids) }); listed = true; for (const id of ids) perContact[id] = [`HubSpot list "Atlas: ${a.name}": not a member → added`]; } catch (e) { warnings.push(`Could not add to the HubSpot list: ${(e as Error).message}`); }
      if (b.enrol === true) {
        const { data: test } = await admin.from("audience_tests").select("*").eq("audience_id", a.id).eq("status", "running").maybeSingle();
        if (test ? !(test.seq_a_id && test.seq_b_id) : !a.sequence_id) throw new Fail(test ? "This audience's test needs both sequences" : "Choose a sequence for this audience first");
        const sender = String((test ? test.sequence_sender : a.sequence_sender) || who), uid = await userIdOf(sender), now = new Date().toISOString();
        const { data: have } = test ? await admin.from("audience_members").select("contact_id,arm").eq("test_id", test.id) : { data: [] };
        const arms: Record<string, string> = Object.fromEntries((have ?? []).filter((x: any) => x.arm).map((x: any) => [x.contact_id, x.arm]));
        const count = { a: Object.values(arms).filter((x) => x === "a").length, b: Object.values(arms).filter((x) => x === "b").length };
        for (const id of ids) {
          let arm: string | null = null, seq = String(a.sequence_id);
          if (test) {   // keep a contact's earlier arm; otherwise give the arm furthest below its target share, so the split stays balanced
            arm = arms[id] ?? ((count.a + 1) / test.split_a <= (count.b + 1) / (100 - test.split_a) ? "a" : "b");
            if (!arms[id]) count[arm as "a" | "b"]++;
            seq = String(arm === "a" ? test.seq_a_id : test.seq_b_id);
          }
          try {
            await hs(`/automation/v4/sequences/enrollments?userId=${uid}`, { method: "POST", body: JSON.stringify({ sequenceId: seq, contactId: id, senderEmail: sender }) });
            results[id] = "enrolled";
            (perContact[id] = perContact[id] ?? []).push(`Sequence ${seq}${arm ? ` (test arm ${arm.toUpperCase()})` : ""}: not enrolled → enrolled as ${sender}`);
            await admin.from("audience_members").update({ state: "enrolled", enrolled_at: now, hubspot_note: null, ...(test ? { test_id: test.id, arm } : {}) }).eq("audience_id", a.id).eq("contact_id", id);
          } catch (e) { results[id] = (e as Error).message; if (test && !arms[id]) count[arm as "a" | "b"]--; await admin.from("audience_members").update({ hubspot_note: (e as Error).message.slice(0, 300) }).eq("audience_id", a.id).eq("contact_id", id); }
        }
      }
      await notesBatch("contacts", Object.entries(perContact).map(([id, lines]) => [id, noteBody(who, `audience "${a.name}" pushed from Atlas`, lines)] as [string, string]), warnings);
      return reply({ ok: true, listId, listed, results, warnings });
    }
    if (b.action === "audience_stats") {    // contact-level sequence and sales email fields for the performance view
      const ids = [...new Set((Array.isArray(b.contactIds) ? b.contactIds : []).map(idOf))].slice(0, 500), out: Record<string, any> = {};
      for (let i = 0; i < ids.length; i += 100) {
        const d = await hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: JSON.stringify({ properties: CONTACT_SEQ_PROPS, inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) });
        for (const x of d?.results ?? []) out[x.id] = x.properties;
      }
      return reply({ contacts: out });
    }
    if (b.action === "contacts") return reply({ contacts: await contactsOf(idOf(b.companyId)) });   // a company's contacts with their email status, for the Audiences review
    if (b.action === "add_contacts") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), warnings: string[] = [];
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`);
      const done = await importContacts(admin, companyId, ods, Array.isArray(b.contacts) ? b.contacts : [], warnings, who, String(co.properties?.name ?? ""));
      await log({ actor: who, kind: "add_contacts", ods_code: ods, target: String(co.properties?.name ?? ""), hubspot_type: "company", hubspot_id: companyId,
        summary: `Added ${done.length} contact(s) to ${co.properties?.name ?? companyId}`, detail: { done, warnings } });
      return reply({ ok: true, contacts: done, warnings });
    }
    if (b.action === "deal_prefill") {      // what the create forms need: pipelines and stages, owners and the signed-in user's owner (and, unless noContacts, the company's contacts); fetched in parallel
      const companyId = idOf(b.companyId), warnings: string[] = [];
      const contactsP = b.noContacts === true ? Promise.resolve([]) : (async () => {
        const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/contacts?limit=10`);
        const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId)).slice(0, 5);
        return ids.length ? ((await hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["firstname", "lastname", "jobtitle", "email"], inputs: ids.map((id: string) => ({ id })) }) }))?.results ?? []).map((c: any) => ({ id: c.id, ...c.properties })) : [];
      })();
      const pipelinesP = cached("pipelines:deals", () => hs(`/crm/v3/pipelines/deals`)).then((r) => (r?.results ?? []).map((p: any) => ({ id: p.id, label: p.label, stages: (p.stages ?? []).sort((x: any, y: any) => x.displayOrder - y.displayOrder).map((s: any) => ({ id: s.id, label: s.label })) })));
      const ownersP = cached("owners", () => hs(`/crm/v3/owners?limit=100&archived=false`)).then((r) => (r?.results ?? []).map((o: any) => ({ id: String(o.id), name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email, email: o.email }))).catch(() => null);
      const [contacts, pipelines, owners] = await Promise.all([contactsP, pipelinesP, ownersP]);
      let ownerId: string | null = null;
      if (owners) {
        ownerId = owners.find((o: any) => o.email?.toLowerCase() === who.toLowerCase())?.id ?? null;
        if (!ownerId) warnings.push(`No HubSpot owner matches ${who}; choose one or leave the deal unassigned.`);
      } else warnings.push("Owners could not be read: add the crm.objects.owners.read scope to the HubSpot token.");
      return reply({ contacts, pipelines, owners, ownerId, warnings });
    }
    if (b.action === "create_deal") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.deal ?? {})) { if (!DEAL_CREATE.has(k)) throw new Fail(`Not allowed to set deal property ${k}`); if (v !== null && v !== "") props[k] = v; }
      if (!String(props.dealname ?? "").trim()) throw new Fail("A deal name is required");
      props.dealname = String(props.dealname).slice(0, 200);
      const pipes = ((await cached("pipelines:deals", () => hs(`/crm/v3/pipelines/deals`)))?.results ?? []);
      const pipe = pipes.find((p: any) => p.id === String(props.pipeline));
      if (!pipe || !(pipe.stages ?? []).some((s: any) => s.id === String(props.dealstage))) throw new Fail("Pick a valid pipeline and stage");
      if (props.dealtype && !DEAL_TYPES.has(String(props.dealtype))) throw new Fail("Unsupported deal type");
      if (props.product___service && !PRODUCT_SERVICE.has(String(props.product___service))) throw new Fail("Unsupported product / service");
      if (props.hubspot_owner_id) props.hubspot_owner_id = idOf(props.hubspot_owner_id);
      if (props.amount != null && !(Number(props.amount) >= 0 && Number(props.amount) < 100000000)) throw new Fail("Invalid amount");
      if (props.closedate && Number.isNaN(Date.parse(String(props.closedate)))) throw new Fail("Invalid close date");
      props.deal_currency_code = "GBP";
      const contactIds = (Array.isArray(b.contactIds) ? b.contactIds : []).slice(0, 5).map(idOf);
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`);   // proves the company exists
      const d = await hs(`/crm/v3/objects/deals`, { method: "POST", body: JSON.stringify({ properties: props, associations: [
        { to: { id: companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_DEAL_TO_COMPANY }] },
        ...contactIds.map((id: string) => ({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_DEAL_TO_CONTACT }] }))] }) });
      await log({ actor: who, kind: "create_deal", ods_code: ods, target: String(props.dealname), hubspot_type: "deal", hubspot_id: String(d.id),
        summary: `Created deal ${props.dealname} on ${co.properties?.name ?? companyId} with ${contactIds.length} contact(s)`, detail: { companyId, properties: props, contactIds } });
      const warnings: string[] = [];
      await noteOn("deals", String(d.id), noteBody(who, `deal created from the practice profile on ${co.properties?.name ?? companyId}`, changes({}, props)), warnings);
      const grouped = await linkIntoGroup(admin, ods, String(d.id), warnings).catch(() => []);
      return reply({ ok: true, dealId: String(d.id), grouped, warnings });
    }
    if (b.action === "create_lead") {       // a Prospecting-pipeline lead at New, before any deal; warns when the contact already has an open lead
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), contactId = idOf(b.contactId);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const name = String(b.name ?? "").trim().slice(0, 200);
      if (!name) throw new Fail("A lead name is required");
      const type = String(b.leadType ?? "NEW_BUSINESS"); if (!LEAD_TYPES.has(type)) throw new Fail("Unsupported lead type");
      const campaign = String(b.campaign ?? ""); if (campaign && !LEAD_CAMPAIGNS.has(campaign)) throw new Fail("Unsupported prospecting campaign");
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`);
      const a = await hs(`/crm/v4/objects/contacts/${contactId}/associations/leads?limit=100`);
      const lids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
      const open = lids.length ? ((await hs(`/crm/v3/objects/leads/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["hs_lead_name", "hs_pipeline", "hs_pipeline_stage", "hs_lead_is_open_v2"], inputs: lids.map((id: string) => ({ id })) }) }))?.results ?? [])
        .filter((l: any) => String(l.properties?.hs_lead_is_open_v2) !== "false").map((l: any) => ({ id: l.id, name: l.properties?.hs_lead_name ?? "Lead", pipeline: l.properties?.hs_pipeline })) : [];
      if (open.length && b.force !== true) return reply({ ok: false, existing: open });
      const props: Record<string, unknown> = { hs_lead_name: name, hs_pipeline: LEAD_PIPELINE, hs_pipeline_stage: LEAD_STAGE_NEW, hs_lead_type: type, gp_ods_code: ods };
      if (campaign) props.prospecting_campaign = campaign;
      if (b.ownerId) props.hubspot_owner_id = idOf(b.ownerId);
      const l = await hs(`/crm/v3/objects/leads`, { method: "POST", body: JSON.stringify({ properties: props, associations: [
        { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD_TO_PRIMARY_CONTACT }] }] }) });
      let companyLinked = true;
      try { await hs(`/crm/v4/objects/leads/${l.id}/associations/default/companies/${companyId}`, { method: "PUT" }); } catch (_) { companyLinked = false; }
      const leadWarn: string[] = [];
      await noteOn("companies", companyId, noteBody(who, `lead created from the practice profile`, [`Lead: none → ${name} (${type}${campaign ? `, ${campaign}` : ""}), pipeline Prospecting, stage New`]), leadWarn);
      await log({ actor: who, kind: "create_lead", ods_code: ods, target: name, hubspot_type: "lead", hubspot_id: String(l.id),
        summary: `Created lead ${name} on ${co.properties?.name ?? companyId}${open.length ? " (contact already had an open lead)" : ""}`, detail: { companyId, contactId, properties: props, companyLinked, existing: open } });
      return reply({ ok: true, leadId: String(l.id), companyLinked, warnings: leadWarn });
    }
    if (b.action === "log_check") {          // the dashboard reports whether HubSpot's recalculated fields matched the tool after a push
      const ods = String(b.ods ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      await log({ actor: who, kind: "push_check", ok: b.ok === true, ods_code: ods, target: String(b.dealName ?? "").slice(0, 120), hubspot_type: "deal", hubspot_id: b.dealId ? idOf(b.dealId) : null,
        summary: b.ok === true ? "HubSpot's Total Discount % and Actual Value per Patient match the tool" : String(b.note ?? "HubSpot's calculated fields did not match the tool").slice(0, 300),
        detail: { hubspot: b.hubspot ?? null, tool: b.tool ?? null } });
      return reply({ ok: true });
    }
    throw new Fail("Unknown action");
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("Unexpected error", 500);
    return reply({ error: f.message }, f.status);
  }
});
