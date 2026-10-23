// outlook-member-sync: nightly re-check of people who registered for the Outlook Data Explorer through Insightly.
// People get on the list by registering (outlook-register). This job only refreshes their organisation details
// and removes anyone whose organisation's membership has lapsed. It never adds people.
//
// Membership rule (same as the MCE Dashboard's membership-sync):
//   an organisation is a member when its "Last Membership Year" (Last_Membership_Year__c) is this year or later
//   (2050 = lifetime / complimentary). Grace period: until March 31, last year's members keep access while renewals come in.
// Rows added by an admin (source = 'manual') are never changed or removed by this sync.
//
// Safety: if Insightly returns fewer than MIN_MEMBER_ORGS members, nothing is changed. If a run would remove more than
// MAX_REMOVE_SHARE of the list at once (once 20+ people have registered), removals are skipped and logged for review.
//
// Runs nightly from pg_cron, or on demand from the Manage access page (admins).
// Secret needed in this project: INSIGHTLY_API_KEY (same key the MCE Dashboard project uses).
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://api.na1.insightly.com/v3.1";
const MIN_GAP_MS = 30 * 60 * 1000;
const MIN_MEMBER_ORGS = 100;
const MAX_REMOVE_SHARE = 0.25;
const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function isAdmin(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const c = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await c.rpc("outlook_is_admin");
  return data === true;
}

async function pageAll(path: string, auth: string, max = 100000) {
  const out: any[] = [];
  for (let skip = 0; skip < max; skip += 500) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${BASE}/${path}${sep}top=500&skip=${skip}`, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`Insightly ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const b = await r.json(); out.push(...b); if (b.length < 500) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const key = (Deno.env.get("INSIGHTLY_API_KEY") ?? "").trim();
  if (!key) return json({ error: "Missing Supabase secret INSIGHTLY_API_KEY" }, 500);

  const admin = await isAdmin(req);
  const { data: last } = await db.from("outlook_sync_log").select("started_at,ok").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!admin && last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true, last: last.started_at });

  const { data: logRow } = await db.from("outlook_sync_log").insert({ note: admin ? "Started by an admin" : "Scheduled run" }).select("id").single();
  const finish = async (fields: Record<string, unknown>) => { await db.from("outlook_sync_log").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", logRow!.id); };

  try {
    let auth = "";
    for (const a of ["Basic " + btoa(key + ":"), "Basic " + btoa(key)]) { const r = await fetch(`${BASE}/Instance`, { headers: { Authorization: a } }); if (r.ok) { auth = a; break; } }
    if (!auth) throw new Error("Insightly did not accept the API key");

    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "numeric" }).formatToParts(now);
    const Y = Number(parts.find((p) => p.type === "year")!.value), month = Number(parts.find((p) => p.type === "month")!.value);
    const minYear = month <= 3 ? Y - 1 : Y;
    const cf = (o: any, n: string) => { const c = (o.CUSTOMFIELDS ?? []).find((x: any) => x.FIELD_NAME === n); const v = c?.FIELD_VALUE; return v == null ? "" : String(v); };

    const orgs = await pageAll("Organisations", auth);
    const members = new Map<number, string>();
    for (const o of orgs) {
      const lmy = Math.trunc(Number(cf(o, "Last_Membership_Year__c")) || 0);
      if (lmy >= minYear) members.set(Number(o.ORGANISATION_ID), String(o.ORGANISATION_NAME ?? ""));
    }
    if (members.size < MIN_MEMBER_ORGS) throw new Error(`Only ${members.size} member organisations found; nothing changed (safety limit ${MIN_MEMBER_ORGS}).`);

    const contacts = await pageAll("Contacts", auth);
    const want = new Map<string, { full_name: string; organization: string; insightly_org_id: number }>();
    for (const c of contacts) {
      const orgId = Number(c.ORGANISATION_ID);
      const email = String(c.EMAIL_ADDRESS ?? "").trim().toLowerCase();
      if (!members.has(orgId) || !EMAIL.test(email)) continue;
      want.set(email, { full_name: [c.FIRST_NAME, c.LAST_NAME].filter(Boolean).join(" ").trim(), organization: members.get(orgId)!, insightly_org_id: orgId });
    }

    const { data: existing, error: e0 } = await db.from("outlook_access").select("email,source");
    if (e0) throw new Error(e0.message);
    const manual = new Set(existing!.filter((r) => r.source === "manual").map((r) => r.email));
    const synced = new Set(existing!.filter((r) => r.source === "insightly").map((r) => r.email));
    const stamp = now.toISOString();

    const upserts = [...want].filter(([email]) => !manual.has(email) && synced.has(email)).map(([email, v]) => ({ email, ...v, source: "insightly", note: "Registered; verified as a member contact in Insightly", last_synced: stamp }));
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await db.from("outlook_access").upsert(upserts.slice(i, i + 500), { onConflict: "email" });
      if (error) throw new Error(error.message);
    }
    const added = upserts.filter((u) => !synced.has(u.email)).length;
    const toRemove = [...synced].filter((e) => !want.has(e));
    let removed = 0, note = `${members.size} member organisations for ${minYear === Y ? Y : `${Y} (incl. ${Y - 1} grace period)`}`;
    if (synced.size >= 20 && toRemove.length > synced.size * MAX_REMOVE_SHARE) {
      note += `; ${toRemove.length} removals skipped (over ${MAX_REMOVE_SHARE * 100}% of the list) — check Insightly before the next run`;
    } else {
      for (let i = 0; i < toRemove.length; i += 200) {
        const { error } = await db.from("outlook_access").delete().eq("source", "insightly").in("email", toRemove.slice(i, i + 200));
        if (error) throw new Error(error.message);
      }
      removed = toRemove.length;
    }
    await finish({ ok: true, member_orgs: members.size, member_emails: want.size, added, updated: upserts.length - added, removed, note });
    return json({ ok: true, member_orgs: members.size, member_emails: want.size, added, removed, note });
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 500);
    await finish({ ok: false, note: msg });
    return json({ error: msg }, 502);
  }
});
