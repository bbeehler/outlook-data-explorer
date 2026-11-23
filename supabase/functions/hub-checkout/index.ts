// hub-checkout: starts a Stripe Checkout for the Research Hub store. Public (no sign-in needed to buy).
//   { plan: "report", key: "r:<slug>" | "outlook", email? } -> one report, $250 CAD plus GST/HST by province: the PDF and 3 days of access
//   { action: "status", session_id }                        -> after paying: the email used and whether access is ready
// Returns { url } to send the buyer to Stripe. The purchase itself is recorded by hub-stripe-webhook.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stripe, PRICES, ACCESS_DAYS, CURRENCY, AUTO_TAX, TAX_CODE, GST_HST_NO, cors, ORIGINS } from "./stripe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function reportName(key: string) {
  if (key === "outlook") return "Outlook Study 2025";
  if (!key.startsWith("r:")) return null;
  const { data } = await db.from("hub_reports").select("title").eq("slug", key.slice(2)).eq("status", "published").maybeSingle();
  return data?.title ?? null;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  try {
    if (b.action === "status") {
      const id = String(b.session_id ?? "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return reply({ error: "bad session" }, 400);
      const s = await stripe("GET", `checkout/sessions/${id}`);
      const email = String(s.customer_details?.email ?? s.customer_email ?? "").toLowerCase();
      const { count } = await db.from("hub_entitlements").select("id", { count: "exact", head: true }).eq("stripe_session", id);
      return reply({ paid: s.payment_status === "paid" || s.status === "complete", email, ready: (count ?? 0) > 0, plan: s.metadata?.plan ?? "" });
    }
    const origin = ORIGINS.includes(req.headers.get("Origin") ?? "") ? req.headers.get("Origin")! : ORIGINS[0];
    const plan = String(b.plan ?? "");
    const email = String(b.email ?? "").trim().toLowerCase();
    const common: Record<string, unknown> = {
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`,
      allow_promotion_codes: true,
      billing_address_collection: AUTO_TAX ? "required" : "auto",
      automatic_tax: { enabled: AUTO_TAX },
      ...(EMAIL.test(email) ? { customer_email: email } : {}),
    };
    if (plan === "report") {
      const key = String(b.key ?? "");
      const name = await reportName(key);
      if (!name) return reply({ error: "Unknown report" }, 400);
      const s = await stripe("POST", "checkout/sessions", {
        ...common, mode: "payment", customer_creation: "always", invoice_creation: { enabled: true, invoice_data: { custom_fields: [{ name: "GST/HST No.", value: GST_HST_NO }] } },
        line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: PRICES.report, tax_behavior: "exclusive",
          product_data: { name: `${name} (AIA Canada research report)`, tax_code: TAX_CODE, description: `${ACCESS_DAYS} days of access in the AIA Canada Research Hub: the full report as a PDF, interactive charts and Ask the data.` } } }],
        metadata: { plan: "report", report_key: key },
        payment_intent_data: { metadata: { plan: "report", report_key: key } },
      });
      return reply({ url: s.url });
    }
    return reply({ error: "Unknown plan" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: String((e as Error).message ?? e).slice(0, 300) }, 500);
  }
});
