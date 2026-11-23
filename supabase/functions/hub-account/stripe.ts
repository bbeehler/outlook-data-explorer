// Shared by the hub's Stripe functions. tools/sync_shared.sh copies it into each function folder as stripe.ts (deploys bundle one folder).
// Talks to Stripe's REST API directly (form-encoded), so no SDK is needed.
export const STRIPE_KEY = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
export const PRICES = {
  report: Number(Deno.env.get("HUB_PRICE_REPORT_CENTS") ?? "25000"),  // $250 CAD for one report
};
export const ACCESS_DAYS = Number(Deno.env.get("HUB_REPORT_ACCESS_DAYS") ?? "3"); // days of Research Hub access a purchase gives
export const CURRENCY = "cad";
// Pin the API version for the hub's own requests. The AIA Canada account's default is older (2022), which can't do
// $0 orders (100%-off promotion codes need 2023-08-16 or later). Other integrations on the account are unaffected.
export const STRIPE_VERSION = "2024-06-20";
export const AUTO_TAX = (Deno.env.get("STRIPE_AUTOMATIC_TAX") ?? "").trim() === "true"; // turn on once Stripe Tax is set up

function form(obj: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  if (!STRIPE_KEY) throw new Error("STRIPE_SECRET_KEY is not set in Supabase secrets");
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": STRIPE_VERSION },
    body: body ? form(body).join("&") : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${j?.error?.message ?? "error"}`);
  return j;
}

// Stripe-Signature check (HMAC-SHA256 of "timestamp.payload"), with a 5-minute tolerance
export async function verifySignature(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

export const ORIGINS = (Deno.env.get("OUTLOOK_ALLOWED_ORIGINS") ??
  "https://research.aiacanada.com,https://outlook.aiacanada.com,https://aia-research-hub.pages.dev,https://bbeehler.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",").map((s) => s.trim());
export function cors(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
