// hub-extract: turns an uploaded research report (PDF in the private `hub-reports` bucket) into Research Hub figures.
// Admin only. Reading runs on the server, so the admin can close the page or lock their phone:
//   { report_id, action: "run", fresh?: true } -> (fresh: count pages and clear old charts) then read the report in the
//        background, one chunk of PAGES_PER_CHUNK pages per invocation; each invocation starts the next one itself.
//        Replies at once; the page shows progress from hub_reports (chunks_done / chunks_total / status / error).
//   { report_id, action: "import_url", url }   -> fetch the PDF from a link instead of uploading it.
//   { report_id, action: "organize" }           -> sort the charts into the report's own sections (runs in the background;
//        also runs automatically after the last chunk). Saves hub_reports.sections and each figure's payload.section.
// Each chunk is tried twice. Chunk 0 also fills in the report's title, date, summary and key findings.
// When the last chunk is done the report moves to "review"; an admin checks the figures and publishes them.
// Secrets: ANTHROPIC_API_KEY (+ optional ANTHROPIC_WORKSPACE_ID), optional HUB_EXTRACT_MODEL, HUB_PAGES_PER_CHUNK.
// Uses the AIA Canada shared tag list (TAGS) so report figures can be linked to economy series.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const MODEL = (Deno.env.get("HUB_EXTRACT_MODEL") ?? "claude-sonnet-5-5").trim();
const WORKSPACE = (Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "").trim();
const PAGES_PER_CHUNK = Number(Deno.env.get("HUB_PAGES_PER_CHUNK") ?? "4");
const ORIGINS = (Deno.env.get("OUTLOOK_ALLOWED_ORIGINS") ??
  "https://outlook.aiacanada.com,https://research.aiacanada.com,https://bbeehler.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",").map((s) => s.trim());
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hub-extract`;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Shared vocabulary that links report figures to Statistics Canada series and Outlook figures.
export const TAGS = ["service-choice", "dealership", "independent-shops", "repair-prices", "maintenance", "parts", "tires",
  "ev", "ev-charging", "vehicle-sales", "vehicles-on-road", "vehicle-age", "driving", "insurance", "fuel-prices",
  "household-finances", "inflation", "interest-rates", "labour", "technicians", "right-to-repair", "vehicle-data",
  "trust", "digital", "demographics", "regions"];

function cors(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-hub-test", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}

const FIGURE_TOOL = {
  name: "save_figures",
  description: "Save every data chart and data table found on these pages, plus (on the first pages only) the report details.",
  input_schema: {
    type: "object",
    properties: {
      report: {
        type: "object", description: "Only when the pages include the cover or introduction. Leave out otherwise.",
        properties: {
          title: { type: "string" }, series: { type: "string", description: "Report series, e.g. 'Consumer Behaviour Series'. Empty if none." },
          published_on: { type: "string", description: "YYYY-MM-DD, or YYYY-MM-01 if only month and year are shown. Empty if not stated." },
          summary: { type: "string", description: "Two or three plain sentences about the whole report: who was surveyed, when, and what it covers. Only from the pages. Describe the report, never the pages you were given (no 'these pages contain...')." },
          key_findings: { type: "array", items: { type: "string" }, description: "Up to 5 headline findings stated in these pages, each one sentence with its number." },
        },
      },
      figures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer", description: "Page number in the whole document (use the page numbers given in the instructions)." },
            ref: { type: "string", description: "How the report labels it, e.g. 'Figure 7' or 'Table 2'. Empty if unlabelled." },
            section: { type: "string", description: "The report section or chapter this chart sits in, as printed in the page header, chapter title or running title. Empty if not shown." },
            title: { type: "string", description: "Clear, specific title. Add the population and year if the report gives them, e.g. 'Where EV owners get routine maintenance, 2025'." },
            question: { type: "string", description: "The survey question, if shown. Empty otherwise." },
            base: { type: "string", description: "Who answered and how many, e.g. 'EV owners, n=1,012'. Empty if not shown." },
            chart: { type: "string", enum: ["bar", "hbar", "line", "stacked", "hstacked", "table"], description: "Best way to show it. hbar for long category labels or rankings; hstacked for 100% bars such as agree/disagree scales; line only for time series." },
            unit: { type: "string", enum: ["%", "$", "$M", "$B", "count", "index", "other"], description: "% means values are fractions (45% -> 0.45)." },
            unit_label: { type: "string", description: "Only when unit is 'other', e.g. 'km per year' or 'average rating out of 5'." },
            cats: { type: "array", items: { type: "string" }, description: "Category labels in the order shown (x-axis for bar/line, rows for hbar)." },
            series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, vals: { type: "array", items: { type: ["number", "null"] } } }, required: ["name", "vals"] },
              description: "One entry per series/colour/column. vals line up with cats. Use null when a value is not shown. One series named 'Value' if there is only one." },
            insight: { type: "string", description: "One plain sentence with the main takeaway, using numbers from this figure only." },
            note: { type: "string", description: "Notes or footnotes the report gives for this figure (e.g. multiple answers allowed). Empty if none." },
            tags: { type: "array", items: { type: "string", enum: [] as string[] }, description: "1 to 4 topics from the list that this figure is about." },
            confidence: { type: "string", enum: ["high", "medium", "low"], description: "high = every value is printed on the page; medium = some values read from bar lengths or gridlines; low = values are estimates." },
          },
          required: ["page", "title", "chart", "unit", "cats", "series", "insight", "tags", "confidence"],
        },
      },
    },
    required: ["figures"],
  },
};
(FIGURE_TOOL.input_schema.properties.figures.items.properties.tags.items as { enum: string[] }).enum = TAGS;

const RULES = `You are reading pages of an AIA Canada research report so its charts and tables can be shown as interactive charts in the AIA Canada Research Hub.
Find every chart or table that contains data (numbers). Skip photos, icons, decorative graphics and charts without numbers. Do not invent anything.
For each, copy the values exactly as printed. Percentages become fractions (45% -> 0.45). If a value is not printed, read it from the chart as carefully as you can and set confidence to medium or low. Never fill gaps with guesses: use null.
Keep category and series labels as the report words them (shorten only very long labels, keeping the meaning).
A single infographic statistic (e.g. "62% of owners...") with no chart is not a figure; mention it in key_findings instead if it is a headline.
If one chart is split across these pages, save it once.
If a table mixes units (for example dollars in one column and percentages in another), save one figure per unit so each chart has a single unit.
Write titles and insights in plain Canadian English. Call save_figures exactly once with everything you found (an empty list if there is no data on these pages).`;

async function isAdmin(req: Request) {
  // the function calling itself for the next chunk
  if (req.headers.get("x-hub-internal") === "1" && req.headers.get("Authorization") === `Bearer ${SERVICE}`) return true;
  // Short-lived test tokens (table hub_test_tokens, service role only) for automated checks.
  const test = req.headers.get("x-hub-test") ?? "";
  if (test.length >= 32) {
    const { data } = await db.from("hub_test_tokens").select("token").eq("token", test).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (data) return true;
  }
  const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { data } = await uc.rpc("outlook_is_admin");
  return data === true;
}

async function loadPdf(path: string) {
  const { data, error } = await db.storage.from("hub-reports").download(path);
  if (error || !data) throw new Error("Could not open the uploaded file: " + (error?.message ?? "missing"));
  return await PDFDocument.load(new Uint8Array(await data.arrayBuffer()), { ignoreEncryption: true });
}

function toPayload(f: Record<string, any>, report: Record<string, any>, idx: number) {
  const unit = f.unit === "count" ? "" : f.unit === "other" ? String(f.unit_label || "") : f.unit;
  const chart = f.chart === "hbar" ? "bar" : f.chart === "hstacked" ? "stacked" : f.chart === "table" ? "bar" : f.chart;
  const orient = f.chart === "hbar" || f.chart === "hstacked" || (f.chart === "table" && (f.cats?.length ?? 0) > 6) ? "h" : undefined;
  const cats = (f.cats ?? []).map((c: unknown) => String(c));
  const series = (f.series ?? []).map((s: any) => ({ name: String(s.name || "Value"), vals: cats.map((_: string, i: number) => { const v = s.vals?.[i]; return typeof v === "number" && isFinite(v) ? v : null; }) }));
  const noteParts = [f.question ? `Question: ${f.question}` : "", f.base ? `Base: ${f.base}.` : "", f.note || ""].filter(Boolean);
  return {
    id: `${report.slug}-p${f.page ?? 0}-${idx}`,
    topic: `r:${report.slug}`,
    ref: [f.ref, f.page ? `p. ${f.page}` : ""].filter(Boolean).join(", "),
    title: String(f.title || "Untitled figure"),
    unit, chart, ...(orient ? { orient } : {}),
    cats, series,
    source: `AIA Canada, ${report.title || "research report"}`,
    note: noteParts.join(" "),
    insightText: String(f.insight || ""),
    sectionRead: String(f.section || "").slice(0, 120),
    tags: (f.tags ?? []).filter((t: string) => TAGS.includes(t)),
  };
}

async function claude(pdfB64: string, firstPage: number, lastPage: number, totalPages: number, wantMeta: boolean, retry = false): Promise<{ out: { report?: Record<string, any>; figures?: any[] }; truncated: boolean }> {
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Supabase secrets");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(WORKSPACE ? { "anthropic-workspace-id": WORKSPACE } : {}) },
    body: JSON.stringify({
      model: MODEL, max_tokens: 16000, system: RULES,
      tools: [FIGURE_TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
        { type: "text", text: `These are pages ${firstPage} to ${lastPage} of a ${totalPages}-page report. The first page attached is page ${firstPage}, so number pages from there.${wantMeta ? " These pages include the start of the report: also fill in report." : " Do not fill in report."} Answer only by calling save_figures.${retry ? " You must call the save_figures tool now." : ""}` },
      ] }],
    }),
  });
  const raw = await r.text();
  if (!r.ok) {
    let msg = raw.slice(0, 300);
    try { const e = JSON.parse(raw); msg = `${e?.error?.type}: ${e?.error?.message}`; } catch { /* keep raw */ }
    throw new Error(`Claude ${r.status} ${msg}`);
  }
  const j = JSON.parse(raw);
  const use = (j.content ?? []).find((c: any) => c.type === "tool_use");
  if (!use) {
    if (!retry) return claude(pdfB64, firstPage, lastPage, totalPages, wantMeta, true);
    throw new Error("Claude did not return figures");
  }
  return { out: use.input as { report?: Record<string, any>; figures?: any[] }, truncated: j.stop_reason === "max_tokens" };
}

async function work(body: Record<string, any>) {
  const id = String(body.report_id ?? "");
  const { data: rep, error } = await db.from("hub_reports").select("*").eq("id", id).maybeSingle();
  if (error || !rep) return { error: "Report not found" };

  if (body.action === "import_url") {
    // Alternative to uploading: fetch the PDF from a link (e.g. the report file on aiacanada.com) into the private bucket.
    const url = String(body.url ?? "");
    if (!/^https:\/\/[^\s]+$/i.test(url)) return { error: "Use a full https:// link to a PDF" };
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return { error: `The link returned ${r.status}` };
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 52428800) return { error: "The PDF is larger than 50 MB" };
    if (String.fromCharCode(...buf.slice(0, 5)) !== "%PDF-") return { error: "That link is not a PDF file" };
    const path = `${id}.pdf`;
    const { error: e } = await db.storage.from("hub-reports").upload(path, buf, { contentType: "application/pdf", upsert: true });
    if (e) return { error: e.message };
    await db.from("hub_reports").update({ file_path: path, file_name: decodeURIComponent(url.split("/").pop() || "report.pdf").slice(0, 200) }).eq("id", id);
    return { ok: true, bytes: buf.length };
  }

  if (body.action === "run") {
    // start (or resume) a server-side reading job; a new token makes any older job stop
    const token = crypto.randomUUID();
    let next = rep.chunks_done;
    if (body.fresh || !rep.chunks_total) {
      const pdf = await loadPdf(rep.file_path);
      const pages = pdf.getPageCount();
      await db.from("hub_figures").delete().eq("report_id", id);
      await db.from("hub_reports").update({ pages, chunks_total: Math.ceil(pages / PAGES_PER_CHUNK), chunks_done: 0, status: "processing", error: "", run_token: token }).eq("id", id);
      next = 0;
    } else {
      if (next >= rep.chunks_total) return { done: true };
      await db.from("hub_reports").update({ status: "processing", error: "", run_token: token }).eq("id", id);
    }
    EdgeRuntime.waitUntil(step(id, next, token));
    return { started: true, from: next };
  }

  if (body.action === "organize") {
    EdgeRuntime.waitUntil(organize(id));
    return { queued: true };
  }

  if (body.action === "continue") {
    EdgeRuntime.waitUntil(step(id, Number(body.index), String(body.token ?? "")));
    return { queued: true };
  }
  return { error: "Unknown action" };
}

// One chunk per invocation, then hand the next chunk to a fresh invocation (keeps each run well inside time limits).
async function step(id: string, index: number, token: string) {
  const { data: rep } = await db.from("hub_reports").select("*").eq("id", id).maybeSingle();
  if (!rep || rep.run_token !== token || !Number.isInteger(index) || index >= rep.chunks_total) return;
  let r = await readChunk(rep, index);
  if (r.error) r = await readChunk(rep, index); // one retry
  if (r.error) { await db.from("hub_reports").update({ error: `Stopped at pages ${r.pages?.join("-")}: ${r.error}` }).eq("id", id); return; }
  if (r.finished) { // sorting into sections runs as its own invocation
    await fetch(SELF, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}`, "x-hub-internal": "1" },
      body: JSON.stringify({ report_id: id, action: "organize" }) }).catch(() => organize(id));
    return;
  }
  const { data: now } = await db.from("hub_reports").select("run_token").eq("id", id).maybeSingle();
  if (!now || now.run_token !== token) return;
  await fetch(SELF, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}`, "x-hub-internal": "1" },
    body: JSON.stringify({ report_id: id, action: "continue", index: index + 1, token }) }).catch(async (e) => {
    await db.from("hub_reports").update({ error: "Could not start the next part: " + String(e).slice(0, 200) }).eq("id", id);
  });
}

async function readChunk(rep: Record<string, any>, index: number) {
  const id = rep.id;
  {
    const first = index * PAGES_PER_CHUNK + 1, last = Math.min(rep.pages, first + PAGES_PER_CHUNK - 1);
    try {
      const src = await loadPdf(rep.file_path);
      const part = await PDFDocument.create();
      const copied = await part.copyPages(src, Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i));
      copied.forEach((p) => part.addPage(p));
      const b64 = encodeBase64(await part.save());
      const { out, truncated } = await claude(b64, first, last, rep.pages, index === 0);
      // report details from the first pages, without overwriting anything an admin already typed
      const meta: Record<string, unknown> = {};
      if (index === 0 && out.report) {
        const m = out.report;
        if (!rep.title && m.title) meta.title = String(m.title).slice(0, 300);
        if (!rep.series && m.series) meta.series = String(m.series).slice(0, 120);
        if (!rep.published_on && /^\d{4}-\d{2}-\d{2}$/.test(m.published_on ?? "")) meta.published_on = m.published_on;
        if (!rep.summary && m.summary) meta.summary = String(m.summary).slice(0, 1500);
        if (Array.isArray(m.key_findings) && !(rep.key_findings ?? []).length) meta.key_findings = m.key_findings.slice(0, 5).map((s: unknown) => String(s).slice(0, 400));
      }
      const named = { ...rep, ...meta };
      const figs = (out.figures ?? []).filter((f) => Array.isArray(f.cats) && f.cats.length && Array.isArray(f.series) && f.series.length);
      // replace this chunk's figures (sort = chunk * 1000 + position keeps report order)
      await db.from("hub_figures").delete().eq("report_id", id).gte("sort", index * 1000).lt("sort", (index + 1) * 1000);
      if (figs.length) {
        const rows = figs.map((f, i) => {
          const payload: Record<string, any> = toPayload(f, named, index * 100 + i);
          if (payload.insightText) payload.insight = payload.insightText.replace(/[<>&]/g, (c: string) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
          delete payload.insightText;
          return { report_id: id, sort: index * 1000 + i, page: f.page ?? null, payload, confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium" };
        });
        const { error: e2 } = await db.from("hub_figures").insert(rows);
        if (e2) throw new Error(e2.message);
      }
      const { data: now } = await db.from("hub_reports").select("chunks_done").eq("id", id).single();
      const done = Math.max(now?.chunks_done ?? 0, index + 1);
      const finished = done >= rep.chunks_total;
      await db.from("hub_reports").update({ ...meta, chunks_done: done, status: finished ? "review" : "processing",
        error: truncated ? `Pages ${first}-${last} had more figures than fit in one pass; check them or set HUB_PAGES_PER_CHUNK lower.` : "" }).eq("id", id);
      return { pages: [first, last], figures: figs.length, done, total: rep.chunks_total, finished, truncated };
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await db.from("hub_reports").update({ error: `Pages ${first}-${last}: ${msg}` }).eq("id", id);
      return { error: msg, pages: [first, last] };
    }
  }
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  if (!(await isAdmin(req))) return new Response(JSON.stringify({ error: "admins_only" }), { status: 403, headers });
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }
  let result: unknown;
  try { result = await work(body); } catch (e) { result = { error: String((e as Error).message ?? e).slice(0, 500) }; }
  return new Response(JSON.stringify(result), { headers });
});

// ---------- sort charts into the report's own sections ----------
const SECTION_TOOL = {
  name: "save_sections",
  description: "Save the report's sections in reading order and which section each chart belongs to.",
  input_schema: {
    type: "object",
    properties: {
      sections: { type: "array", items: { type: "object", properties: {
        key: { type: "string", description: "Short lowercase id, letters and hyphens, e.g. 'where-owners-go'." },
        name: { type: "string", description: "Section name, 2 to 7 words, as the report names it (shorten if long)." },
        blurb: { type: "string", description: "One plain sentence on what this section covers." } }, required: ["key", "name", "blurb"] } },
      assign: { type: "array", items: { type: "object", properties: { id: { type: "string" }, section: { type: "string" } }, required: ["id", "section"] },
        description: "Every chart id exactly once, with the key of its section." },
    },
    required: ["sections", "assign"],
  },
};
async function organize(id: string, attempt = 1): Promise<void> {
  const { data: rep } = await db.from("hub_reports").select("*").eq("id", id).maybeSingle();
  if (!rep) return;
  const { data: figs } = await db.from("hub_figures").select("id,page,payload").eq("report_id", id).order("sort");
  if (!figs || !figs.length) return;
  const list = figs.map((f) => `${f.id} | page ${f.page ?? "?"} | ${f.payload.title}${f.payload.sectionRead ? ` | heading on page: ${f.payload.sectionRead}` : ""}`).join("\n");
  const content: unknown[] = [];
  try { // the opening pages usually hold the table of contents
    const src = await loadPdf(rep.file_path);
    const part = await PDFDocument.create();
    const n = Math.min(6, src.getPageCount());
    (await part.copyPages(src, Array.from({ length: n }, (_, i) => i))).forEach((p) => part.addPage(p));
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(await part.save()) } });
  } catch { /* sort from titles alone */ }
  content.push({ type: "text", text: `Report: ${rep.title}\nSummary: ${rep.summary}\n\nCharts found in the report (id | PDF page | title | heading if read):\n${list}\n\n` +
    "Group these charts into the report's own sections, in reading order, so members can browse the report section by section. " +
    "Use the report's table of contents and headings where available (the attached pages are its opening pages). Aim for 3 to 9 sections; " +
    "a section needs at least 2 charts unless the report clearly has a one-chart section. Put every chart id in exactly one section. " +
    "Demographics or respondent profile charts go in a final section such as 'About the respondents'. Answer only by calling save_sections." });
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(WORKSPACE ? { "anthropic-workspace-id": WORKSPACE } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, tools: [SECTION_TOOL], tool_choice: { type: "auto" }, messages: [{ role: "user", content }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude ${r.status} ${j?.error?.message ?? ""}`);
    const use = (j.content ?? []).find((c: any) => c.type === "tool_use");
    if (!use) throw new Error("no sections returned");
    const clean = (k: string) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "section";
    const seen = new Set<string>();
    const sections = (use.input.sections ?? []).map((x: any) => { let k = clean(x.key || x.name); while (seen.has(k)) k += "-2"; seen.add(k); return { key: k, name: String(x.name).slice(0, 80), blurb: String(x.blurb ?? "").slice(0, 300), _raw: x.key }; });
    if (!sections.length) throw new Error("no sections returned");
    const byRaw = new Map(sections.map((x: any) => [String(x._raw), x.key]));
    const assign = new Map<string, string>();
    for (const a of use.input.assign ?? []) { const k = byRaw.get(String(a.section)) ?? (seen.has(clean(a.section)) ? clean(a.section) : null); if (k) assign.set(String(a.id), k as string); }
    const fallback = sections[sections.length - 1].key;
    await Promise.all(figs.map((f) => db.from("hub_figures").update({ payload: { ...f.payload, section: assign.get(f.id) ?? f.payload.section ?? fallback } }).eq("id", f.id)));
    await db.from("hub_reports").update({ sections: sections.map(({ key, name, blurb }: any) => ({ key, name, blurb })), error: "" }).eq("id", id);
  } catch (e) {
    if (attempt < 2) return organize(id, attempt + 1);
    await db.from("hub_reports").update({ error: "Could not sort into sections: " + String((e as Error).message ?? e).slice(0, 200) }).eq("id", id);
  }
}
