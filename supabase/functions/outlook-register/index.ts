// outlook-register: the "Get access" check for the Outlook Data Explorer.
// A visitor submits a work email. Approved when ANY of these is true:
//   1. the email is already on outlook_access (added by an admin, or registered before and still a member)
//   2. the email belongs to an active Data Portal admin
//   3. Insightly has a contact with this email linked to an organisation whose Last Membership Year is current
//      (this year or later; 2050 = lifetime; last year's members still count until March 31). Same rule as the MCE Dashboard.
// When 3 approves, the email is added to outlook_access (source = 'insightly'); the nightly outlook-member-sync
// re-checks it and removes it if the organisation's membership lapses.
// The page sends the sign-in link only after an approval, so non-members never get an account.
// Every request is logged in outlook_registrations. Limits: 10 requests per IP and 5 per email per hour.
// Admins can also send { email, check: true } to get a full diagnosis (what Insightly holds and why the email would be
// approved or denied) without adding anyone, sending anything or logging a request.
// Secret needed: INSIGHTLY_API_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://api.na1.insightly.com/v3.1";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ORIGINS = (Deno.env.get("OUTLOOK_ALLOWED_ORIGINS") ??
  "https://outlook.aiacanada.com,https://bbeehler.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",").map((s) => s.trim());
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function cors(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}

// Admin-only dry run: explains the decision for one email. Changes nothing.
async function diagnose(req: Request, email: string, raw: string) {
  const authz = req.headers.get("Authorization") ?? "";
  const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data: isAdm } = await uc.rpc("outlook_is_admin");
  if (isAdm !== true) return { error: "admins_only" };
  const out: Record<string, unknown> = { email };
  const { data: listed } = await db.from("outlook_access").select("source, organization, added_at").eq("email", email).maybeSingle();
  out.on_list = listed ?? null;
  const { data: adm } = await db.from("profiles").select("id").eq("email", email).eq("role", "admin").eq("membership_status", "active").maybeSingle();
  out.portal_admin = !!adm;
  const key = (Deno.env.get("INSIGHTLY_API_KEY") ?? "").trim();
  if (!key) { out.insightly = "INSIGHTLY_API_KEY is not set"; out.verdict = listed || adm ? "approved" : "unavailable"; return out; }
  try {
    let auth = "";
    for (const a of ["Basic " + btoa(key + ":"), "Basic " + btoa(key)]) { const r = await fetch(`${BASE}/Instance`, { headers: { Authorization: a } }); if (r.ok) { auth = a; break; } }
    if (!auth) throw new Error("Insightly did not accept the API key");
    const get = async (path: string) => { const r = await fetch(`${BASE}/${path}`, { headers: { Authorization: auth } }); if (r.status === 404) return null; if (!r.ok) throw new Error(`Insightly ${r.status}`); return r.json(); };
    const found: any[] = []; const seen = new Set<number>();
    for (const v of new Set([email, raw])) for (const c of (await get(`Contacts/Search?field_name=EMAIL_ADDRESS&field_value=${encodeURIComponent(v)}&brief=false&top=20`) ?? [])) if (!seen.has(c.CONTACT_ID)) { seen.add(c.CONTACT_ID); found.push(c); }
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "numeric" }).formatToParts(new Date());
    const Y = Number(parts.find((p) => p.type === "year")!.value), month = Number(parts.find((p) => p.type === "month")!.value);
    const minYear = month <= 3 ? Y - 1 : Y;
    out.rule = `Organisation's Last Membership Year must be ${minYear} or later`;
    const cf = (o: any, n: string) => { const c = (o.CUSTOMFIELDS ?? []).find((x: any) => x.FIELD_NAME === n); return c?.FIELD_VALUE == null ? "" : String(c.FIELD_VALUE); };
    const contacts = [];
    for (const c of found.filter((c) => String(c.EMAIL_ADDRESS ?? "").trim().toLowerCase() === email)) {
      const orgId = Number(c.ORGANISATION_ID) || 0;
      const o = orgId ? await get(`Organisations/${orgId}`) : null;
      const lmy = o ? Math.trunc(Number(cf(o, "Last_Membership_Year__c")) || 0) : null;
      contacts.push({ name: [c.FIRST_NAME, c.LAST_NAME].filter(Boolean).join(" "), contact_id: c.CONTACT_ID, organisation: o ? o.ORGANISATION_NAME : null, organisation_id: orgId || null, last_membership_year: lmy, member: lmy != null && lmy >= minYear });
    }
    out.insightly_contacts = contacts;
    const memberHit = contacts.find((c) => c.member);
    out.verdict = listed || adm || memberHit ? "approved" : "denied";
    out.reason = listed ? `Already on the access list (${listed.source === "manual" ? "added by hand" : "registered member"})`
      : adm ? "Data Portal admin"
      : memberHit ? `Contact at ${memberHit.organisation}, Last Membership Year ${memberHit.last_membership_year}`
      : !contacts.length ? "No Insightly contact has this exact email address"
      : contacts.every((c) => !c.organisation_id) ? "Insightly contact found, but it is not linked to an organisation"
      : `Contact found, but the organisation's membership is not current (Last Membership Year ${contacts.map((c) => c.last_membership_year ?? "none").join(", ")})`;
  } catch (e) {
    out.insightly = String((e as Error).message ?? e); out.verdict = listed || adm ? "approved" : "unavailable";
  }
  return out;
}

Deno.serve(async (req) => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let raw = "", check = false;
  try { const b = await req.json(); raw = String(b.email ?? "").trim(); check = b.check === true; } catch { /* fall through */ }
  const email = raw.toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return reply({ status: "invalid" }, 400);
  if (check) return reply(await diagnose(req, email, raw));
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64);
  const log = async (result: string, organization = "", note = "") => { await db.from("outlook_registrations").insert({ email, ip, result, organization, note }); };

  // Rate limits
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const [byIp, byEmail] = await Promise.all([
    ip ? db.from("outlook_registrations").select("id", { count: "exact", head: true }).eq("ip", ip).gte("requested_at", hourAgo) : Promise.resolve({ count: 0 }),
    db.from("outlook_registrations").select("id", { count: "exact", head: true }).eq("email", email).gte("requested_at", hourAgo),
  ]);
  if ((byIp.count ?? 0) >= 10 || (byEmail.count ?? 0) >= 5) { await log("rate_limited"); return reply({ status: "rate_limited" }); }

  // 1. Already on the list
  const { data: listed } = await db.from("outlook_access").select("email").eq("email", email).maybeSingle();
  if (listed) { await log("approved_list"); return reply({ status: "approved" }); }

  // 2. Data Portal admin
  const { data: adm } = await db.from("profiles").select("id").eq("email", email).eq("role", "admin").eq("membership_status", "active").maybeSingle();
  if (adm) { await log("approved_admin"); return reply({ status: "approved" }); }

  // 3. Insightly member contact
  const key = (Deno.env.get("INSIGHTLY_API_KEY") ?? "").trim();
  if (!key) { await log("error", "", "INSIGHTLY_API_KEY not set"); return reply({ status: "unavailable" }); }
  try {
    // Insightly accepts the key either with or without a trailing colon depending on account; try both (as MCE's sync does).
    let auth = "";
    for (const a of ["Basic " + btoa(key + ":"), "Basic " + btoa(key)]) { const r = await fetch(`${BASE}/Instance`, { headers: { Authorization: a } }); if (r.ok) { auth = a; break; } }
    if (!auth) throw new Error("Insightly did not accept the API key");
    const get = async (path: string) => {
      const r = await fetch(`${BASE}/${path}`, { headers: { Authorization: auth } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Insightly ${r.status}`);
      return r.json();
    };
    const contacts: any[] = [];
    const seen = new Set<number>();
    for (const v of new Set([email, raw])) {
      if (!v) continue;
      const found = await get(`Contacts/Search?field_name=EMAIL_ADDRESS&field_value=${encodeURIComponent(v)}&brief=false&top=20`) ?? [];
      for (const c of found) if (!seen.has(c.CONTACT_ID)) { seen.add(c.CONTACT_ID); contacts.push(c); }
    }
    const matches = contacts.filter((c) => String(c.EMAIL_ADDRESS ?? "").trim().toLowerCase() === email);
    if (!matches.length) { await log("denied_not_found"); return reply({ status: "denied" }); }
    const orgIds = [...new Set(matches.map((c) => Number(c.ORGANISATION_ID)).filter((n) => n > 0))];
    if (!orgIds.length) { await log("denied_no_org", "", "Contact found but not linked to an organisation"); return reply({ status: "denied" }); }

    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "numeric" }).formatToParts(new Date());
    const Y = Number(parts.find((p) => p.type === "year")!.value), month = Number(parts.find((p) => p.type === "month")!.value);
    const minYear = month <= 3 ? Y - 1 : Y;
    const cf = (o: any, n: string) => { const c = (o.CUSTOMFIELDS ?? []).find((x: any) => x.FIELD_NAME === n); return c?.FIELD_VALUE == null ? "" : String(c.FIELD_VALUE); };

    let lapsedName = "";
    for (const id of orgIds) {
      const o = await get(`Organisations/${id}`);
      if (!o) continue;
      const lmy = Math.trunc(Number(cf(o, "Last_Membership_Year__c")) || 0);
      const name = String(o.ORGANISATION_NAME ?? "");
      if (lmy >= minYear) {
        const c = matches.find((m) => Number(m.ORGANISATION_ID) === id) ?? matches[0];
        const { error } = await db.from("outlook_access").upsert({
          email, full_name: [c.FIRST_NAME, c.LAST_NAME].filter(Boolean).join(" ").trim(), organization: name,
          insightly_org_id: id, source: "insightly", note: "Registered; verified as a member contact in Insightly", last_synced: new Date().toISOString(),
        }, { onConflict: "email" });
        if (error) throw new Error(error.message);
        await log("approved_member", name);
        return reply({ status: "approved" });
      }
      lapsedName ||= `${name} (last membership year ${lmy || "none"})`;
    }
    await log("denied_lapsed", lapsedName);
    return reply({ status: "denied" });
  } catch (e) {
    await log("error", "", String((e as Error).message ?? e).slice(0, 300));
    return reply({ status: "unavailable" });
  }
});
