// Pipeline -> NHS Jobs public feed, from Supabase's network. The daily scan normally reads the feed directly from GitHub Actions;
// if NHS Jobs blocks that network (403 from CloudFront) the scan falls back to this function. It fetches ONE page of the public
// search_xml feed and passes the status and body through. Only the pipeline (the service role key) may call it.
const FEED = "https://www.jobs.nhs.uk/api/v1/search_xml";
const UA = "LaluMarketRadar/1.0 (+daily read of the public NHS Jobs feed)";

function sameKey(a: string, b: string): boolean {   // constant-time compare
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!sameKey(bearer, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "")) return new Response("jobs-feed: caller key not accepted", { status: 401 });
  let body: { page?: number; limit?: number; sort?: string } = {};
  try { body = await req.json(); } catch { /* defaults below reject it */ }
  const page = Number(body.page), limit = Number(body.limit ?? 100);
  if (!Number.isInteger(page) || page < 1 || page > 400 || !Number.isInteger(limit) || limit < 1 || limit > 100) return new Response("Bad page or limit", { status: 400 });
  const sort = body.sort === "publicationDateDesc" || !body.sort ? "publicationDateDesc" : "";
  if (!sort) return new Response("Bad sort", { status: 400 });
  const up = await fetch(`${FEED}?limit=${limit}&page=${page}&sort=${sort}`, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  return new Response(await up.text(), { status: up.status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
});
