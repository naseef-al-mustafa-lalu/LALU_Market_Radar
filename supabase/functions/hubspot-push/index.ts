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
  "total_discount", "value_per_patient", "actual_value_per_patient_calculated", "patient_list_size", "commercial_model"];
const COMPANY_WRITE = new Set(["patient_list_size"]);
const DEAL_WRITE = new Set(["size_tier", "size_discount", "speed_discount", "term_length_discount", "term_length_years", "value_per_patient", "commercial_model"]);
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
const LINE_TO_DEAL = 20;   // HubSpot-defined association type: line item -> deal

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
  const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/contacts?limit=20`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const d = await hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["firstname", "lastname", "jobtitle", "email", "lifecyclestage"], inputs: ids.map((id: string) => ({ id })) }) });
  return (d?.results ?? []).map((x: any) => ({ id: x.id, ...x.properties }));
}

async function leadsOf(companyId: string) {
  const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/leads?limit=50`);
  const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
  if (!ids.length) return [];
  const [d, pipes] = await Promise.all([
    hs(`/crm/v3/objects/leads/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["hs_lead_name", "hs_pipeline", "hs_pipeline_stage", "hs_lead_is_open_v2", "hs_createdate"], inputs: ids.map((id: string) => ({ id })) }) }),
    hs(`/crm/v3/pipelines/leads`).catch(() => null),
  ]);
  const stage = new Map<string, string>();
  for (const pl of pipes?.results ?? []) for (const st of pl.stages ?? []) stage.set(String(st.id), `${st.label} (${pl.label})`);
  return (d?.results ?? []).map((x: any) => ({ id: x.id, name: x.properties?.hs_lead_name ?? "Lead", stage: stage.get(String(x.properties?.hs_pipeline_stage)) ?? "", open: String(x.properties?.hs_lead_is_open_v2) !== "false" }));
}

// Find-or-create each contact by email and associate it with the company; mirrors the result onto the tool's own contacts table.
async function importContacts(admin: any, companyId: string, ods: string, list: any[], warnings: string[]) {
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
      out.push({ email, id: cid, existed: !!found[0] });
    } catch (e) { warnings.push(`Contact ${email}: ${(e as Error).message}`); }
  }
  const now = new Date().toISOString();
  for (const c of out) await admin.from("contacts").update({ hubspot_status: "Imported", hubspot_contact_id: c.id, hubspot_imported_at: now }).eq("ods_code", ods).ilike("email", c.email);
  return out;
}

async function readPair(companyId: string, dealId: string) {
  const [company, deal, deals, lineItems] = await Promise.all([
    hs(`/crm/v3/objects/companies/${companyId}?properties=${COMPANY_READ.join(",")}`),
    hs(`/crm/v3/objects/deals/${dealId}?properties=${DEAL_READ.join(",")}`),
    dealsOf(companyId),
    lineItemsOf(dealId).catch(() => null),   // null when the token lacks the line item scope; the dashboard then says so
  ]);
  if (!deals.some((d: any) => d.id === dealId)) throw new Fail("That deal is not associated with that company");
  return { company: { id: company.id, ...company.properties }, deal: { id: deal.id, ...deal.properties }, lineItems };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!Deno.env.get("HUBSPOT_TOKEN")) throw new Fail("HUBSPOT_TOKEN secret is not set for this function", 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: allowed, error: aerr } = await supa.rpc("am_i_allowed");
    if (aerr || allowed !== true) throw new Fail("Not authorised", 403);
    const { data: u } = await supa.auth.getUser();
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
    if (b.action === "deals") return reply({ deals: await dealsOf(idOf(b.companyId)) });
    if (b.action === "read") return reply(await readPair(idOf(b.companyId), idOf(b.dealId)));

    if (b.action === "write") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), dealId = idOf(b.dealId);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const dealProps: Record<string, unknown> = {}, companyProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.deal ?? {})) { if (!DEAL_WRITE.has(k)) throw new Fail(`Not allowed to write deal property ${k}`); dealProps[k] = v; }
      for (const [k, v] of Object.entries(b.company ?? {})) { if (!COMPANY_WRITE.has(k)) throw new Fail(`Not allowed to write company property ${k}`); companyProps[k] = v; }
      for (const k of ["size_discount", "speed_discount", "term_length_discount"]) if (k in dealProps && !(Number(dealProps[k]) >= 0 && Number(dealProps[k]) <= 1)) throw new Fail(`${k} out of range`);
      if ("value_per_patient" in dealProps && !VALUE_PER_PATIENT.has(String(dealProps.value_per_patient))) throw new Fail("Unsupported Value per Patient option");
      if ("commercial_model" in dealProps && !COMMERCIAL_MODEL.has(String(dealProps.commercial_model))) throw new Fail("Unsupported Commercial Model option");
      if ("term_length_years" in dealProps && !["1", "2", "3"].includes(String(dealProps.term_length_years))) throw new Fail("Term length must be 1, 2 or 3");
      if ("size_tier" in dealProps && !/^Tier [1-5]$/.test(String(dealProps.size_tier))) throw new Fail("Invalid size tier");
      if ("patient_list_size" in companyProps && !(Number(companyProps.patient_list_size) >= 0)) throw new Fail("Invalid list size");

      const li = b.lineItem ?? null;
      if (li) {
        if (!LINE_PRODUCTS.has(String(li.productId))) throw new Fail("Unsupported product for the line item");
        if (!(Number.isInteger(li.quantity) && li.quantity > 0 && li.quantity <= 2000000)) throw new Fail("Invalid line item quantity");
        if (!(Number(li.netUnit) > 0 && Number(li.netUnit) < 100)) throw new Fail("Invalid line item unit price");
        if (![1, 12, 24, 36].includes(Number(li.termMonths))) throw new Fail("Term must be 1, 12, 24 or 36 months");
        if (!["annually", "monthly"].includes(String(li.frequency)) || !["FIXED", "AUTOMATICALLY_RENEW"].includes(String(li.terms))) throw new Fail("Invalid billing settings");
        if (li.payments != null && !(Number.isInteger(li.payments) && li.payments >= 1 && li.payments <= 3)) throw new Fail("Invalid number of payments");
      }
      const before = await readPair(companyId, dealId);   // also proves the deal belongs to the company
      if (li && before.lineItems == null) throw new Fail("The HubSpot token cannot read line items: add the crm.objects.line_items.read and write scopes (and e-commerce for products). Nothing was written.");
      if (Object.keys(companyProps).length) await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: companyProps }) });
      if (Object.keys(dealProps).length) await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: dealProps }) });

      let lineResult: any = null;
      if (li) {
        const ours = before.lineItems.filter((x: any) => LINE_PRODUCTS.has(String(x.hs_product_id)));
        if (ours.length > 1) throw new Fail("This deal has more than one Lalu Care line item. Remove the extras in HubSpot first.");
        const billing = { hs_recurring_billing_period: `P${Number(li.termMonths)}M`, recurringbillingfrequency: String(li.frequency), hs_recurring_billing_terms: String(li.terms),
          ...(li.payments != null ? { hs_recurring_billing_number_of_payments: String(li.payments) } : {}) };
        let lineId: string, action: string;
        if (ours.length && String(ours[0].hs_product_id) === String(li.productId)) {
          lineId = ours[0].id; action = "updated";
          await hs(`/crm/v3/objects/line_items/${lineId}`, { method: "PATCH", body: JSON.stringify({ properties: { quantity: String(li.quantity), ...billing } }) });
        } else {
          if (ours.length) { await hs(`/crm/v3/objects/line_items/${ours[0].id}`, { method: "DELETE" }); }   // the tool's own line, for a different product
          const c = await hs(`/crm/v3/objects/line_items`, { method: "POST", body: JSON.stringify({ properties: { hs_product_id: String(li.productId), quantity: String(li.quantity), ...billing },
            associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LINE_TO_DEAL }] }] }) });
          lineId = String(c.id); action = ours.length ? "replaced" : "created";
        }
        const cur = await hs(`/crm/v3/objects/line_items/${lineId}?properties=price,quantity`);
        const unit = Number(cur.properties?.price);
        if (!(unit > 0)) throw new Fail("The line item has no unit price; check the product's price in HubSpot");
        const discount = Math.max(0, Math.round((unit - Number(li.netUnit)) * 10000) / 10000);   // flat per-unit discount: HubSpot's unit price less the calculator's net price
        await hs(`/crm/v3/objects/line_items/${lineId}`, { method: "PATCH", body: JSON.stringify({ properties: { discount: String(discount), hs_discount_percentage: "" } }) });
        lineResult = { id: lineId, action, unit, discount };
      }
      await admin.from("hubspot_links").upsert({ ods_code: ods, company_id: companyId, company_name: before.company.name ?? null, deal_id: dealId, deal_name: before.deal.dealname ?? null,
        linked_by: who, linked_at: new Date().toISOString(), last_pushed_at: new Date().toISOString() }, { onConflict: "ods_code" });
      await log({ actor: who, kind: "push", ods_code: ods, target: before.deal.dealname ?? before.company.name ?? null, hubspot_type: "deal", hubspot_id: dealId,
        summary: `Pushed pricing to ${before.deal.dealname ?? "deal"}: ${Object.keys(dealProps).length} deal field(s)${Object.keys(companyProps).length ? ", company list size" : ""}${lineResult ? `, line item ${lineResult.action}` : ""}`,
        detail: { companyId, dealId, before: { company: before.company, deal: before.deal, lineItems: before.lineItems }, written: { company: companyProps, deal: dealProps, lineItem: li, lineResult } } });
      return reply({ ok: true, ...(await readPair(companyId, dealId)) });
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
      } else {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b.company ?? {})) { if (!COMPANY_CREATE.has(k)) throw new Fail(`Not allowed to set company property ${k}`); if (v !== null && v !== "") props[k] = v; }
        if (!props.name || String(props.partner_organisation_code ?? "").toUpperCase() !== ods) throw new Fail("A name and the matching GP ODS Code are required");
        if (props.company_status && !COMPANY_STATUS.has(String(props.company_status))) throw new Fail("Unsupported Company Status for a new company");
        props.partner_organisation_code = ods;
        companyId = String((await hs(`/crm/v3/objects/companies`, { method: "POST", body: JSON.stringify({ properties: props }) })).id);
      }
      const done: any = { companyId, contacts: [] as any[], networks: [] as string[] };
      done.contacts = await importContacts(admin, companyId, ods, Array.isArray(b.contacts) ? b.contacts : [], warnings);
      for (const n of (Array.isArray(b.networks) ? b.networks : []).slice(0, 4)) {
        if (!NETWORK_TYPES.has(String(n.type))) continue;
        try { await hs(`/crm/v4/objects/companies/${companyId}/associations/default/${n.type}/${idOf(n.id)}`, { method: "PUT" }); done.networks.push(`${n.type}:${n.id}`); }
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
    if (b.action === "add_contacts") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), warnings: string[] = [];
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`);
      const done = await importContacts(admin, companyId, ods, Array.isArray(b.contacts) ? b.contacts : [], warnings);
      await log({ actor: who, kind: "add_contacts", ods_code: ods, target: String(co.properties?.name ?? ""), hubspot_type: "company", hubspot_id: companyId,
        summary: `Added ${done.length} contact(s) to ${co.properties?.name ?? companyId}`, detail: { done, warnings } });
      return reply({ ok: true, contacts: done, warnings });
    }
    if (b.action === "deal_prefill") {      // what the create-deal form needs: the company's contacts, pipelines and stages, owners, and the signed-in user's owner
      const companyId = idOf(b.companyId), warnings: string[] = [];
      const a = await hs(`/crm/v4/objects/companies/${companyId}/associations/contacts?limit=10`);
      const ids = (a?.results ?? []).map((x: any) => String(x.toObjectId)).slice(0, 5);
      const contacts = ids.length ? ((await hs(`/crm/v3/objects/contacts/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["firstname", "lastname", "jobtitle", "email"], inputs: ids.map((id: string) => ({ id })) }) }))?.results ?? []).map((c: any) => ({ id: c.id, ...c.properties })) : [];
      const pipelines = ((await hs(`/crm/v3/pipelines/deals`))?.results ?? []).map((p: any) => ({ id: p.id, label: p.label, stages: (p.stages ?? []).sort((x: any, y: any) => x.displayOrder - y.displayOrder).map((s: any) => ({ id: s.id, label: s.label })) }));
      let owners: any[] | null = null, ownerId: string | null = null;
      try {
        owners = ((await hs(`/crm/v3/owners?limit=100&archived=false`))?.results ?? []).map((o: any) => ({ id: String(o.id), name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email, email: o.email }));
        ownerId = owners.find((o) => o.email?.toLowerCase() === who.toLowerCase())?.id ?? null;
        if (!ownerId) warnings.push(`No HubSpot owner matches ${who}; choose one or leave the deal unassigned.`);
      } catch (_) { warnings.push("Owners could not be read: add the crm.objects.owners.read scope to the HubSpot token."); }
      return reply({ contacts, pipelines, owners, ownerId, warnings });
    }
    if (b.action === "create_deal") {
      const ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId);
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.deal ?? {})) { if (!DEAL_CREATE.has(k)) throw new Fail(`Not allowed to set deal property ${k}`); if (v !== null && v !== "") props[k] = v; }
      if (!String(props.dealname ?? "").trim()) throw new Fail("A deal name is required");
      props.dealname = String(props.dealname).slice(0, 200);
      const pipes = ((await hs(`/crm/v3/pipelines/deals`))?.results ?? []);
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
      return reply({ ok: true, dealId: String(d.id) });
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
      await log({ actor: who, kind: "create_lead", ods_code: ods, target: name, hubspot_type: "lead", hubspot_id: String(l.id),
        summary: `Created lead ${name} on ${co.properties?.name ?? companyId}${open.length ? " (contact already had an open lead)" : ""}`, detail: { companyId, contactId, properties: props, companyLinked, existing: open } });
      return reply({ ok: true, leadId: String(l.id), companyLinked });
    }
    if (b.action === "log_check") {          // the dashboard reports whether HubSpot's recalculated fields matched the tool after a push
      const ods = String(b.ods ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      await log({ actor: who, kind: "push_check", ok: b.ok === true, ods_code: ods, target: String(b.dealName ?? "").slice(0, 120), hubspot_type: "deal", hubspot_id: b.dealId ? idOf(b.dealId) : null,
        summary: b.ok === true ? "HubSpot's Total Discount % and Actual Value per Patient match the tool" : String(b.note ?? "HubSpot's calculated fields did not match the tool").slice(0, 300),
        detail: { hubspot: b.hubspot ?? null, tool: b.tool ?? null } });
      return reply({ ok: true });
    }
    if (b.action === "unlink") {
      const ods = String(b.ods ?? "").trim().toUpperCase();
      const { error } = await admin.from("hubspot_links").delete().eq("ods_code", ods);
      if (error) throw new Fail("Could not unlink");
      return reply({ ok: true });
    }
    throw new Fail("Unknown action");
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("Unexpected error", 500);
    return reply({ error: f.message }, f.status);
  }
});
