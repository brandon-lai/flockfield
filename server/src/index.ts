// Worker entry: CORS, country lookup, IP hashing, and routing to the single
// pasture Durable Object. The client is served from elsewhere (Vercel); this
// Worker is only the realtime backend.

import { PastureDO, type Env } from "./pasture";

export { PastureDO };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function country(req: Request): string {
  // CF-IPCountry is free with every request. Country only; no IP is stored.
  const c = (req.headers.get("CF-IPCountry") ?? (req as { cf?: { country?: string } }).cf?.country ?? "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "XX";
}

const withCors = (r: Response) => {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const stub = env.PASTURE.get(env.PASTURE.idFromName("main"));

    if (url.pathname === "/ws") return stub.fetch(new Request("https://pasture/ws", req));

    if (url.pathname === "/register") {
      if (req.method !== "POST") return withCors(new Response("POST only", { status: 405 }));
      if (!env.IP_HASH_SECRET) return withCors(Response.json({ error: "misconfigured" }, { status: 500 }));
      const ip = req.headers.get("CF-Connecting-IP") ?? "local";
      const r = await stub.fetch("https://pasture/register", {
        method: "POST",
        headers: { "x-ip-hash": await hmac(env.IP_HASH_SECRET, ip), "x-country": country(req) },
      });
      return withCors(r);
    }

    if (url.pathname === "/stats") return withCors(await stub.fetch("https://pasture/stats"));
    if (url.pathname === "/") return withCors(new Response("Flock pasture server. The pasture itself is at https://flockfield.vercel.app\n"));
    return withCors(new Response("not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
