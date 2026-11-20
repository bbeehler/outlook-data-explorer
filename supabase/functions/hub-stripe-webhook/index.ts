// hub-stripe-webhook: Stripe tells us about payments here; we record who can open what in hub_entitlements.
// Point a Stripe webhook at https://<project>.supabase.co/functions/v1/hub-stripe-webhook with these events:
//   checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, charge.refunded
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (the endpoint's signing secret, whsec_...).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stripe, verifySignature } from "./stripe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);
// newer Stripe API versions keep the billing period on the subscription's items
const periodEnd = (sub: any) => sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;

async function onCheckout(s: any) {
  const email = String(s.customer_details?.email ?? s.customer_email ?? "").toLowerCase();
  if (!email) throw new Error("checkout without an email");
  const plan = s.metadata?.plan;
  const base = { email, stripe_customer: s.customer ?? null, stripe_session: s.id, amount_cents: s.amount_total ?? null, currency: s.currency ?? null, updated_at: new Date().toISOString() };
  if (plan === "report") {
    if (s.payment_status !== "paid") return; // e.g. delayed payment methods; Stripe sends async_payment_succeeded later
    await db.from("hub_entitlements").upsert({ ...base, kind: "report", report_key: s.metadata.report_key, status: "active", stripe_payment_intent: s.payment_intent ?? null }, { onConflict: "stripe_session" });
  } else if (plan === "subscription") {
    const sub = s.subscription ? await stripe("GET", `subscriptions/${s.subscription}`) : null;
    await db.from("hub_entitlements").upsert({ ...base, kind: "subscription", report_key: null, status: sub?.status ?? "active",
      stripe_subscription: s.subscription ?? null, current_period_end: iso(periodEnd(sub)) }, { onConflict: "stripe_session" });
  }
}

async function onSubscription(sub: any) {
  await db.from("hub_entitlements").update({ status: sub.status, current_period_end: iso(periodEnd(sub)), updated_at: new Date().toISOString() })
    .eq("stripe_subscription", sub.id);
}

async function onRefund(charge: any) {
  if (!charge.refunded || !charge.payment_intent) return; // partial refunds keep access
  await db.from("hub_entitlements").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("stripe_payment_intent", charge.payment_intent);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();
  const payload = await req.text();
  if (!secret || !(await verifySignature(payload, req.headers.get("Stripe-Signature") ?? "", secret))) {
    return new Response("bad signature", { status: 400 });
  }
  const ev = JSON.parse(payload);
  try {
    const o = ev.data?.object;
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") await onCheckout(o);
    else if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") await onSubscription(o);
    else if (ev.type === "charge.refunded") await onRefund(o);
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(ev.type, e);
    return new Response("error", { status: 500 }); // Stripe retries
  }
});
