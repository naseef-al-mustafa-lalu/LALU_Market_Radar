// Dashboard -> HubSpot, the actions added after hubspot-push grew large (kept apart so that function is not touched):
//   lead_pipelines        the account's lead pipelines and their stages, for the lead form's required Pipeline choice
//   create_lead           a lead in the pipeline and stage the person chose (never assumed), with the same duplicate warning, company link, note and log as before
//   search_contacts       HubSpot contacts by name, email or company, so a person already there is linked to a network's company instead of being created again
//   add_network_contacts  find-or-create contacts by email and link them to a network's company (the practice flow's add_contacts needs a practice ODS code, which a network has not got)
//   discretionary_read    a deal's Discretionary Discount % (the push preview needs it to show what changes)
//   discretionary_write   set a deal's Discretionary Discount % (a fraction 0..1) after the pricing push, with a note on the deal
// The HubSpot token lives only in this function's secrets. Callers must be signed in AND on the allowed_users list.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const HS = "https://api.hubapi.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const LEAD_TO_PRIMARY_CONTACT = 578;   // HubSpot-defined association type: lead -> primary contact
const LEAD_TYPES = new Set(["NEW_BUSINESS", "RE_ATTEMPTING"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LEAD_CAMPAIGNS = new Set(["PCN Prospecting", "ICB April 26", "Field Based Lead", "ICB Prospecting", "Atlas"]);
const NOTE_TO: Record<string, number> = { companies: 190, deals: 214 };   // HubSpot-defined association types: note -> company / deal

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
const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
const noteBody = (who: string, headline: string, lines: string[] = []) => [esc(`Atlas, ${stamp()}, by ${who}: ${headline}`), ...lines.map((l) => esc("• " + l))].join("<br>");
async function noteOn(obj: string, id: string, body: string, warnings: string[]) {
  try {
    await hs(`/crm/v3/objects/notes`, { method: "POST", body: JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
      associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO[obj] }] }] }) });
  } catch (e) { warnings.push(`Note not added on ${obj} ${id}: ${(e as Error).message}`); }
}

const leadPipelines = async () => ((await cached("pipelines:leads", () => hs(`/crm/v3/pipelines/leads`)))?.results ?? []);
const OPEN = new Set(["NEW", "IN_PROGRESS"]);   // lead stage states a new lead may start in

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!Deno.env.get("HUBSPOT_TOKEN")) throw new Fail("HUBSPOT_TOKEN secret is not set for this function", 500);
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const [{ data: allowed, error: aerr }, { data: u }] = await Promise.all([supa.rpc("am_i_allowed"), supa.auth.getUser()]);
    if (aerr || allowed !== true) throw new Fail("Not authorised", 403);
    const who = u?.user?.email ?? "unknown";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json();
    const log = async (row: Record<string, unknown>) => { try { await admin.from("hubspot_activity").insert({ ok: true, ...row }); } catch (_) { /* logging must never block the action */ } };

    if (b.action === "lead_pipelines") {
      const pipelines = (await leadPipelines()).map((p: any) => ({ id: String(p.id), label: p.label, stages: (p.stages ?? []).sort((x: any, y: any) => x.displayOrder - y.displayOrder)
        .map((s: any) => ({ id: String(s.id), label: s.label, open: OPEN.has(String(s.metadata?.state)) })) }));
      return reply({ pipelines });
    }

    if (b.action === "create_lead") {       // a lead in the chosen pipeline and stage, before any deal; warns when the contact already has an open lead
      const net = b.network === true, ods = String(b.ods ?? "").trim().toUpperCase(), companyId = idOf(b.companyId), contactId = idOf(b.contactId);   // a network's lead has no practice ODS code
      if (!net && !/^[A-Z0-9]{3,12}$/.test(ods)) throw new Fail("Invalid ODS code");
      const name = String(b.name ?? "").trim().slice(0, 200);
      if (!name) throw new Fail("A lead name is required");
      const type = String(b.leadType ?? "NEW_BUSINESS"); if (!LEAD_TYPES.has(type)) throw new Fail("Unsupported lead type");
      const campaign = String(b.campaign ?? ""); if (campaign && !LEAD_CAMPAIGNS.has(campaign)) throw new Fail("Unsupported prospecting campaign");
      const lpipe = (await leadPipelines()).find((p: any) => String(p.id) === String(b.pipeline ?? ""));
      if (!lpipe) throw new Fail("Choose a lead pipeline");
      const lstages = (lpipe.stages ?? []).sort((x: any, y: any) => x.displayOrder - y.displayOrder);
      const lstage = b.stage ? lstages.find((s: any) => String(s.id) === String(b.stage)) : (lstages.find((s: any) => String(s.metadata?.state) === "NEW") ?? lstages[0]);
      if (!lstage || !OPEN.has(String(lstage.metadata?.state))) throw new Fail("Choose an open stage of that pipeline");
      const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`);
      const a = await hs(`/crm/v4/objects/contacts/${contactId}/associations/leads?limit=100`);
      const lids = (a?.results ?? []).map((x: any) => String(x.toObjectId));
      const open = lids.length ? ((await hs(`/crm/v3/objects/leads/batch/read`, { method: "POST", body: JSON.stringify({ properties: ["hs_lead_name", "hs_pipeline", "hs_pipeline_stage", "hs_lead_is_open_v2"], inputs: lids.map((id: string) => ({ id })) }) }))?.results ?? [])
        .filter((l: any) => String(l.properties?.hs_lead_is_open_v2) !== "false").map((l: any) => ({ id: l.id, name: l.properties?.hs_lead_name ?? "Lead", pipeline: l.properties?.hs_pipeline })) : [];
      if (open.length && b.force !== true) return reply({ ok: false, existing: open });
      const props: Record<string, unknown> = { hs_lead_name: name, hs_pipeline: String(lpipe.id), hs_pipeline_stage: String(lstage.id), hs_lead_type: type };
      if (!net) props.gp_ods_code = ods;
      if (campaign) props.prospecting_campaign = campaign;
      if (b.ownerId) props.hubspot_owner_id = idOf(b.ownerId);
      const l = await hs(`/crm/v3/objects/leads`, { method: "POST", body: JSON.stringify({ properties: props, associations: [
        { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD_TO_PRIMARY_CONTACT }] }] }) });
      let companyLinked = true;
      try { await hs(`/crm/v4/objects/leads/${l.id}/associations/default/companies/${companyId}`, { method: "PUT" }); } catch (_) { companyLinked = false; }
      const leadWarn: string[] = [];
      await noteOn("companies", companyId, noteBody(who, `lead created from the practice profile`, [`Lead: none → ${name} (${type}${campaign ? `, ${campaign}` : ""}), pipeline ${lpipe.label}, stage ${lstage.label}`]), leadWarn);
      await log({ actor: who, kind: "create_lead", ods_code: net ? null : ods, target: name, hubspot_type: "lead", hubspot_id: String(l.id),
        summary: `Created lead ${name} on ${co.properties?.name ?? companyId} in ${lpipe.label} (${lstage.label})${open.length ? " (contact already had an open lead)" : ""}`, detail: { companyId, contactId, properties: props, companyLinked, existing: open } });
      return reply({ ok: true, leadId: String(l.id), companyLinked, warnings: leadWarn });
    }

    if (b.action === "search_contacts") {
      const q = String(b.query ?? "").trim().slice(0, 80);
      if (q.length < 2) return reply({ contacts: [] });
      const r = await hs(`/crm/v3/objects/contacts/search`, { method: "POST", body: JSON.stringify({ query: q, limit: 12, properties: ["firstname", "lastname", "jobtitle", "email", "company"] }) });
      return reply({ contacts: (r?.results ?? []).map((c: any) => ({ id: String(c.id), name: `${c.properties?.firstname ?? ""} ${c.properties?.lastname ?? ""}`.trim(), jobtitle: c.properties?.jobtitle ?? "", email: String(c.properties?.email ?? "").toLowerCase(), company: c.properties?.company ?? "" })).filter((c: any) => c.email) });
    }

    if (b.action === "add_network_contacts") {       // find-or-create each contact by email and link it to the network's company; Atlas's own rows for that address are marked as in HubSpot
      const companyId = idOf(b.companyId), warnings: string[] = [], out: any[] = [];
      for (const c of (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 10)) {
        const email = String(c.email ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) { warnings.push(`Skipped a contact without a valid email (${c.name ?? "unnamed"})`); continue; }
        try {
          const found = (await hs(`/crm/v3/objects/contacts/search`, { method: "POST", body: JSON.stringify({ properties: ["email"], limit: 1, filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }) }))?.results ?? [];
          const [first, ...rest] = String(c.name ?? "").trim().split(/\s+/);
          const cid = found[0]?.id ?? String((await hs(`/crm/v3/objects/contacts`, { method: "POST", body: JSON.stringify({ properties: { email, firstname: first || undefined, lastname: rest.join(" ") || undefined, phone: c.phone || undefined, jobtitle: c.jobtitle || undefined } }) })).id);
          await hs(`/crm/v4/objects/contacts/${cid}/associations/default/companies/${companyId}`, { method: "PUT" });
          out.push({ email, id: cid, existed: !!found[0], name: String(c.name ?? "").trim() });
        } catch (e) { warnings.push(`Contact ${email}: ${(e as Error).message}`); }
      }
      if (out.length) {
        const co = await hs(`/crm/v3/objects/companies/${companyId}?properties=name`).catch(() => null);
        await noteOn("companies", companyId, noteBody(who, `${out.length} contact${out.length > 1 ? "s" : ""} added from the network profile`, out.map((c) => `${c.name || c.email} (${c.email}): ${c.existed ? "already in HubSpot, linked" : "created"}`)), warnings);
        const now = new Date().toISOString();
        for (const c of out) { try { await admin.from("contacts").update({ hubspot_status: "Imported", hubspot_contact_id: c.id, hubspot_imported_at: now }).ilike("email", c.email).is("hubspot_contact_id", null); } catch (_) { /* Atlas catches up at the next sync */ } }
        await log({ actor: who, kind: "add_contacts", target: co?.properties?.name ?? companyId, hubspot_type: "company", hubspot_id: companyId, summary: `Added ${out.length} contact(s) to ${co?.properties?.name ?? companyId} from the network profile`, detail: { contacts: out } });
      }
      return reply({ contacts: out, warnings });
    }

    if (b.action === "discretionary_read") {
      const d = await hs(`/crm/v3/objects/deals/${idOf(b.dealId)}?properties=discretionary_discount`);
      return reply({ discretionary_discount: d?.properties?.discretionary_discount ?? null });
    }

    if (b.action === "discretionary_write") {       // after the pricing push: the deal's Discretionary Discount % (a fraction), with a note
      const companyId = idOf(b.companyId), dealId = idOf(b.dealId), value = Number(b.value);
      if (!(Number.isFinite(value) && value >= 0 && value <= 1)) throw new Fail("Discretionary discount out of range");
      const dc = await hs(`/crm/v4/objects/deals/${dealId}/associations/companies?limit=100`);
      if (!(dc?.results ?? []).some((x: any) => String(x.toObjectId) === companyId)) throw new Fail("That deal is not associated with that company");
      const before = (await hs(`/crm/v3/objects/deals/${dealId}?properties=discretionary_discount,dealname`))?.properties ?? {};
      await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: { discretionary_discount: String(value) } }) });
      const warnings: string[] = [];
      const was = before.discretionary_discount === null || before.discretionary_discount === undefined || before.discretionary_discount === "" ? "blank" : String(before.discretionary_discount);
      await noteOn("deals", dealId, noteBody(who, "discretionary discount set from the pricing push", [`Discretionary discount: ${was} → ${value}`]), warnings);
      await log({ actor: who, kind: "push", ods_code: b.ods ? String(b.ods).toUpperCase().slice(0, 12) : null, target: before.dealname ?? dealId, hubspot_type: "deal", hubspot_id: dealId,
        summary: `Set discretionary discount to ${(value * 100).toFixed(1)}% on ${before.dealname ?? dealId}`, detail: { before: before.discretionary_discount ?? null, after: value } });
      return reply({ ok: true, warnings });
    }

    throw new Fail("Unknown action");
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("Unexpected error", 500);
    return reply({ error: f.message }, f.status);
  }
});
