// hub-account: things a signed-in Research Hub user does with their access.
//   { action: "pdf", key: "r:<slug>" | "outlook" } -> a short-lived download link for the full report PDF (if they can open that report)
//   { action: "portal" }                            -> a Stripe billing portal link to update a card, get receipts or cancel
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stripe, cors, ORIGINS } from "./stripe.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const OUTLOOK_PDF = "outlook/outlook-study-2025.pdf";

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  const uc = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { data: u } = await uc.auth.getUser();
  const email = (u?.user?.email ?? "").toLowerCase();
  if (!email) return reply({ error: "Sign in" }, 401);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  try {
    if (b.action === "pdf") {
      const key = String(b.key ?? "");
      const { data: ok } = await uc.rpc("hub_entitled", { key });
      if (ok !== true) return reply({ error: "not_entitled" }, 403);
      let path = "", name = "report.pdf";
      if (key === "outlook") { path = OUTLOOK_PDF; name = "AIA-Canada-Outlook-Study-2025.pdf"; }
      else if (key.startsWith("r:")) {
        const { data: r } = await db.from("hub_reports").select("file_path,title").eq("slug", key.slice(2)).eq("status", "published").maybeSingle();
        path = r?.file_path ?? "";
        name = `AIA-Canada-${String(r?.title ?? "report").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)}.pdf`;
      }
      if (!path) return reply({ error: "no_pdf" }, 404);
      const { data, error } = await db.storage.from("hub-reports").createSignedUrl(path, 120, { download: name });
      if (error || !data) return reply({ error: "no_pdf" }, 404);
      return reply({ url: data.signedUrl });
    }
    if (b.action === "portal") {
      const { data: e } = await db.from("hub_entitlements").select("stripe_customer").eq("email", email).not("stripe_customer", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!e?.stripe_customer) return reply({ error: "no_customer" }, 404);
      const origin = ORIGINS.includes(req.headers.get("Origin") ?? "") ? req.headers.get("Origin")! : ORIGINS[0];
      const s = await stripe("POST", "billing_portal/sessions", { customer: e.stripe_customer, return_url: `${origin}/` });
      return reply({ url: s.url });
    }
    return reply({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error(err);
    return reply({ error: String((err as Error).message ?? err).slice(0, 300) }, 500);
  }
});
