// Dashboard button -> starts the "HubSpot sync" GitHub workflow now. Same pattern as trigger-patient-load: the GitHub token lives only in this
// function's secrets, and callers must be signed in AND on the allowed_users list.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const REPO = "naseef-al-mustafa-lalu/LALU_Market_Radar";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) return reply({ error: "GITHUB_TOKEN secret is not set for this function" }, 500);
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data, error } = await supa.rpc("am_i_allowed");
  if (error || data !== true) return reply({ error: "Not authorised" }, 403);
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/hubspot.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lalu-market-radar",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) return reply({ error: `GitHub refused the request (${r.status}): ${(await r.text()).slice(0, 200)}` }, 502);
  return reply({ ok: true });
});
