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
const COMPANY_CREATE = new Set(["name", "partner_organisation_code", "patient_list_size", "address", "city", "zip", "phone", "website", "country"]);
const NETWORK_TYPES = new Set(["p145802630_pcns", "p145802630_icbs"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEAL_READ = ["dealname", "dealstage", "amount", "size_tier", "size_discount", "speed_discount", "term_length_discount", "term_length_years",
  "total_discount", "value_per_patient", "actual_value_per_patient_calculated", "patient_list_size", "commercial_model"];
const COMPANY_WRITE = new Set(["patient_list_size"]);
const DEAL_WRITE = new Set(["size_tier", "size_discount", "speed_discount", "term_length_discount", "term_length_years", "value_per_patient", "commercial_model"]);
const COMMERCIAL_MODEL = new Set(["Subscription", "eMR+ SAR Only"]);   // ReportSure - MS - All Reports / ReportSure - MS - SAR Only
const VALUE_PER_PATIENT = new Set(["£0.05", "£0.06", "£0.07", "£0.08", "£0.10"]);

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

async function readPair(companyId: string, dealId: string) {
  const [company, deal, deals] = await Promise.all([
    hs(`/crm/v3/objects/companies/${companyId}?properties=${COMPANY_READ.join(",")}`),
    hs(`/crm/v3/objects/deals/${dealId}?properties=${DEAL_READ.join(",")}`),
    dealsOf(companyId),
  ]);
  if (!deals.some((d: any) => d.id === dealId)) throw new Fail("That deal is not associated with that company");
  return { company: { id: company.id, ...company.properties }, deal: { id: deal.id, ...deal.properties } };
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

      const before = await readPair(companyId, dealId);   // also proves the deal belongs to the company
      if (Object.keys(companyProps).length) await hs(`/crm/v3/objects/companies/${companyId}`, { method: "PATCH", body: JSON.stringify({ properties: companyProps }) });
      if (Object.keys(dealProps).length) await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: dealProps }) });

      await admin.from("hubspot_links").upsert({ ods_code: ods, company_id: companyId, company_name: before.company.name ?? null, deal_id: dealId, deal_name: before.deal.dealname ?? null,
        linked_by: who, linked_at: new Date().toISOString(), last_pushed_at: new Date().toISOString() }, { onConflict: "ods_code" });
      await admin.from("hubspot_push_log").insert({ ods_code: ods, company_id: companyId, deal_id: dealId, pushed_by: who,
        before_values: { company: before.company, deal: before.deal }, written_values: { company: companyProps, deal: dealProps } });
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
        props.partner_organisation_code = ods;
        companyId = String((await hs(`/crm/v3/objects/companies`, { method: "POST", body: JSON.stringify({ properties: props }) })).id);
      }
      const done: any = { companyId, contacts: [] as any[], networks: [] as string[] };
      for (const c of (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 10)) {
        const email = String(c.email ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) { warnings.push(`Skipped a contact without a valid email (${c.name ?? "unnamed"})`); continue; }
        try {
          const found = (await hs(`/crm/v3/objects/contacts/search`, { method: "POST", body: JSON.stringify({ properties: ["email", "createdate"], limit: 1,
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }) }))?.results ?? [];
          const [first, ...rest] = String(c.name ?? "").trim().split(/\s+/);
          const cid = found[0]?.id ?? String((await hs(`/crm/v3/objects/contacts`, { method: "POST", body: JSON.stringify({ properties: { email, firstname: first || undefined, lastname: rest.join(" ") || undefined,
            phone: c.phone || undefined, jobtitle: c.jobtitle || undefined } }) })).id);
          await hs(`/crm/v4/objects/contacts/${cid}/associations/default/companies/${companyId}`, { method: "PUT" });
          done.contacts.push({ email, id: cid, existed: !!found[0] });
        } catch (e) { warnings.push(`Contact ${email}: ${(e as Error).message}`); }
      }
      for (const n of (Array.isArray(b.networks) ? b.networks : []).slice(0, 4)) {
        if (!NETWORK_TYPES.has(String(n.type))) continue;
        try { await hs(`/crm/v4/objects/companies/${companyId}/associations/default/${n.type}/${idOf(n.id)}`, { method: "PUT" }); done.networks.push(`${n.type}:${n.id}`); }
        catch (e) { warnings.push(`Association to ${n.type === "p145802630_pcns" ? "PCN" : "ICB"} record: ${(e as Error).message}`); }
      }
      const now = new Date().toISOString();
      await admin.from("gp_practices").update({ hubspot_company_id: companyId, hubspot_company_imported_at: now, hubspot_synced_at: now }).eq("ods_code", ods);
      for (const c of done.contacts) await admin.from("contacts").update({ hubspot_status: "Imported", hubspot_contact_id: c.id, hubspot_imported_at: now }).eq("ods_code", ods).ilike("email", c.email);
      await admin.from("hubspot_push_log").insert({ ods_code: ods, company_id: companyId, pushed_by: who, before_values: null, written_values: { action: b.action, done, warnings } });
      return reply({ ok: true, ...done, warnings });
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
