/* ---------- Data Studio: raw data admins upload (CSV, Excel, survey crosstab exports; APIs later) that anyone with access builds reports from ---------- */
// Catalogue rows live in hub_datasets; each dataset's parsed data is one JSON file in the private hub-data bucket.
// Every dataset is treated as raw rows and columns. A report is a title plus any number of blocks; each block picks its
// own dataset, visual (bar, column, stacked, line, area, pie, table, number, raw rows), rows, series, value, calculation,
// filters, sort and top-N. Reports save to hub_saved_reports; the open report is also kept in this browser as a draft.
const STUDIO = { list: [], kpis: [], data: new Map(), saved: [], report: null };
const STUDIO_ROLES = [['member', 'Members'], ['affiliate', 'Affiliates'], ['buyer', 'Report buyers']];
const SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

async function loadStudio() {
  const [ds, kp] = await Promise.all([
    SB.from('hub_datasets').select('id,slug,title,description,source,kind,meta,hidden_from,status,updated_at,original_name,file_path,sort').order('sort').order('updated_at', { ascending: false }),
    SB.from('hub_kpis').select('id,name,description,formula,format,hidden_from,status,sort,updated_at').order('sort').order('name')]);
  STUDIO.list = ds.data || [];
  STUDIO.kpis = kp.data || [];
}

/* ---------- KPIs: admin-defined formulas over columns, e.g. sum([Labour sales]) / count() ---------- */
// Grammar: numbers, + - * /, brackets, and calculations sum avg min max count distinct, each over a [Column] (count() alone
// counts rows). A column is matched by its name or key, ignoring case and punctuation, so one KPI works on every dataset
// that has those columns. Never eval'd: it's parsed into a small tree here.
const KPI_FNS = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count', distinct: 'Count of different values' };
function kpiParse(src) {
  const toks = [], re = /\s*(?:(\d+(?:\.\d+)?)|\[([^\]]*)\]|([A-Za-z_]+)|(\S))/y;
  let m; re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] != null) toks.push({ t: 'num', v: +m[1] }); else if (m[2] != null) toks.push({ t: 'col', v: m[2].trim() });
    else if (m[3] != null) toks.push({ t: 'id', v: m[3].toLowerCase() }); else if (m[4] != null) toks.push({ t: 'op', v: m[4] });
  }
  if (!toks.length) throw new Error('Enter a formula.');
  let p = 0; const terms = [], seen = new Map();
  const peek = () => toks[p], eat = v => { const t = toks[p]; if (!t || t.v !== v) throw new Error(`Expected "${v}"${t ? ` before "${t.v}"` : ' at the end'}.`); p++; };
  const expr = () => { let a = term(); while (peek() && (peek().v === '+' || peek().v === '-')) { const op = toks[p++].v; a = { n: 'bin', op, a, b: term() }; } return a; };
  const term = () => { let a = factor(); while (peek() && (peek().v === '*' || peek().v === '/')) { const op = toks[p++].v; a = { n: 'bin', op, a, b: factor() }; } return a; };
  const factor = () => {
    const t = toks[p++];
    if (!t) throw new Error('The formula ends too early.');
    if (t.t === 'num') return { n: 'num', v: t.v };
    if (t.v === '-' && t.t === 'op') return { n: 'neg', a: factor() };
    if (t.v === '(' && t.t === 'op') { const e = expr(); eat(')'); return e; }
    if (t.t === 'col') throw new Error(`Put [${t.v}] inside a calculation, like sum([${t.v}]).`);
    if (t.t === 'id') {
      if (!KPI_FNS[t.v]) throw new Error(`"${t.v}" isn't a calculation. Use ${Object.keys(KPI_FNS).join(', ')}.`);
      eat('(');
      let col = null;
      if (peek() && peek().t === 'col') { col = toks[p++].v; if (!col) throw new Error('A column name is empty.'); }
      else if (t.v !== 'count') throw new Error(`${t.v}() needs a column, like ${t.v}([Column]).`);
      eat(')');
      const k = t.v + '|' + (col || '');
      if (!seen.has(k)) { seen.set(k, terms.length); terms.push({ fn: t.v, col }); }
      return { n: 'agg', ti: seen.get(k) };
    }
    throw new Error(`Unexpected "${t.v}".`);
  };
  const ast = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}".`);
  return { ast, terms };
}
function kpiParsed(k) { if (k._src !== k.formula) { k._src = k.formula; try { k._p = kpiParse(k.formula); k._err = null; } catch (e) { k._p = null; k._err = e.message; } } return k._p; }
function kpiFindCol(cols, name) { const n = sSlug(name); return cols.find(c => sSlug(c.key) === n) || cols.find(c => sSlug(c.label) === n); }
// the columns a KPI names that a dataset doesn't have
function kpiMissing(p, cols) { return [...new Set(p.terms.filter(t => t.col && !kpiFindCol(cols, t.col)).map(t => t.col))]; }
// a KPI ready to run on one dataset, or null if the formula is broken or a column is missing
function kpiPlan(k, cols) {
  const p = kpiParsed(k); if (!p || kpiMissing(p, cols).length) return null;
  return { ast: p.ast, terms: p.terms.map(t => ({ fn: t.fn, key: t.col ? kpiFindCol(cols, t.col).key : null })) };
}
function kpiEval(node, get) {
  switch (node.n) {
    case 'num': return node.v;
    case 'neg': { const x = kpiEval(node.a, get); return x == null ? null : -x; }
    case 'agg': return get(node.ti);
    default: { const a = kpiEval(node.a, get), b = kpiEval(node.b, get); if (a == null || b == null) return null;
      if (node.op === '+') return a + b; if (node.op === '-') return a - b; if (node.op === '*') return a * b; return b === 0 ? null : a / b; }
  }
}
const termAccs = n => Array.from({ length: n }, () => ({ s: 0, n: 0, c: 0, min: Infinity, max: -Infinity, set: null }));
function termAdd(accs, T, r) {
  for (let t = 0; t < T.length; t++) {
    const a = accs[t], fn = T[t].fn, i = T[t].i; a.c++;
    if (i == null) continue;
    const v0 = r[i];
    if (fn === 'distinct') { if (v0 !== '' && v0 != null) (a.set || (a.set = new Set())).add(String(v0)); continue; }
    if (fn === 'count') { if (v0 !== '' && v0 != null) a.n++; continue; }
    const v = typeof v0 === 'number' ? v0 : sNum(v0); if (v == null) continue;
    a.s += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v;
  }
}
function termVal(a, T) {
  if (T.fn === 'count') return T.i == null ? a.c : a.n;
  if (T.fn === 'distinct') return a.set ? a.set.size : 0;
  if (!a.n) return null;
  return T.fn === 'avg' ? a.s / a.n : T.fn === 'min' ? a.min : T.fn === 'max' ? a.max : a.s;
}
const kpiFmt = k => k && k.format === 'percent' ? true : k && k.format === 'currency' ? 'cur' : false;
const kpiOf = v => typeof v === 'string' && v.startsWith('kpi:') ? STUDIO.kpis.find(k => k.id === v.slice(4)) || null : null;
const dsCols = d => d.kind === 'survey' ? SURVEY_COLS : ((d.meta || {}).columns || []);
function colLabel(raw, k) { if (k === '__count') return 'Rows'; const kp = kpiOf(k); if (kp) return kp.name; return (raw.columns.find(c => c.key === k) || {}).label || k; }
async function loadSaved() {
  const { data } = await SB.from('hub_saved_reports').select('id,title,config,dataset_id,updated_at').order('updated_at', { ascending: false });
  STUDIO.saved = data || [];
}
// Data files are gzip-compressed (about a tenth of the size) and kept in the browser's cache after the first download.
// The cache key is the file path, which changes whenever an admin replaces the data, so a cached copy is never stale.
const GZ = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function gzip(text) { return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob(); }
async function blobText(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return blob.text();
}
const LABCACHE = 'aia-data-studio-v1';
async function cacheGet(path) { try { const c = await caches.open(LABCACHE); const r = await c.match('/lab-cache/' + path); return r ? r.text() : null; } catch { return null; } }
async function cachePut(path, text) {
  try { const c = await caches.open(LABCACHE); await c.put('/lab-cache/' + path, new Response(text, { headers: { 'content-type': 'application/json' } }));
    // drop copies of files that have since been replaced
    const keep = new Set(STUDIO.list.map(d => '/lab-cache/' + d.file_path)); for (const req of await c.keys()) if (!keep.has(new URL(req.url).pathname)) c.delete(req); } catch { /* storage unavailable: fine, it just downloads next time */ }
}
const LOADING = new Map();
function studioData(d) {
  const key = d.file_path;
  if (STUDIO.data.has(key)) return Promise.resolve(STUDIO.data.get(key));
  if (LOADING.has(key)) return LOADING.get(key);
  const job = (async () => {
    let text = await cacheGet(key);
    if (text == null) {
      const { data, error } = await SB.storage.from('hub-data').download(d.file_path);
      if (error || !data) throw new Error('The data for this dataset could not be loaded.');
      const head = new Uint8Array(await data.slice(0, 2).arrayBuffer());
      text = await blobText(data);
      cachePut(key, text);
      // older uploads were saved uncompressed: an admin opening one compresses it in place for everyone
      if (IS_ADMIN && GZ && !(head[0] === 0x1f && head[1] === 0x8b)) gzip(text).then(gz => SB.storage.from('hub-data').upload(key, gz, { contentType: 'application/json', upsert: true })).catch(() => {});
    }
    const json = JSON.parse(text);
    STUDIO.data.set(key, json);
    return json;
  })();
  LOADING.set(key, job);
  job.finally(() => LOADING.delete(key));
  return job;
}
// After sign-in, quietly fetch the datasets in the background so Data Studio opens without a wait.
function studioPrefetch() {
  const go2 = () => { for (const d of STUDIO.list.filter(x => x.status === 'published' || IS_ADMIN).slice(0, 4)) studioRaw(d.id).catch(() => {}); };
  if ('requestIdleCallback' in window) requestIdleCallback(go2, { timeout: 4000 }); else setTimeout(go2, 2500);
}
const sNum = v => (typeof v === 'number' ? v : (v === '' || v == null ? null : (isFinite(+String(v).replace(/[,$%\s]/g, '')) ? +String(v).replace(/[,$%\s]/g, '') : null)));
const sPct = v => v == null ? '—' : `${Math.round(v * 100)}%`;
const sCount = v => v == null ? '—' : Math.round(v).toLocaleString('en-CA');
const sVal = v => v == null ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-CA') : (+v.toFixed(2)).toLocaleString('en-CA');
const sSlug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'dataset';

/* ---------- raw data: every dataset becomes rows and columns the builder can slice any way ---------- */
// Tables are stored as rows already. Survey crosstab exports are stored compactly and unrolled here into one row per
// question x answer x segment, so people can pick questions, answers, breakdowns and segments like any other column.
const SURVEY_COLS = [
  { key: 'q', label: 'Question', type: 'category' }, { key: 'code', label: 'Question code', type: 'category' },
  { key: 'answer', label: 'Answer', type: 'category' }, { key: 'atype', label: 'Answer type', type: 'category' },
  { key: 'bd', label: 'Breakdown', type: 'category' }, { key: 'seg', label: 'Segment', type: 'category' },
  { key: 'pct', label: '% of respondents', type: 'number', fmt: 'pct' }, { key: 'wc', label: 'Weighted count', type: 'number' },
  { key: 'avg', label: 'Average score', type: 'number' }, { key: 'base', label: 'Respondents (unweighted)', type: 'number' },
  { key: 'wbase', label: 'Weighted base', type: 'number' }, { key: 'sig', label: 'Significance letters', type: 'category' }];
function surveyToRaw(s) {
  const rows = [];
  for (const q of s.questions) {
    const done = new Set();
    for (const b of s.banners) {
      const t = q.t[b.id]; if (!t) continue;
      const parts = done.has('Total') ? [] : [['Total', 'Total', [1]]];
      for (const g of b.groups) if (!done.has(g.name)) parts.push([g.name, null, g.cols]);
      for (const [bd, , cols] of parts) {
        done.add(bd);
        for (const c of cols) {
          const seg = bd === 'Total' ? 'Total' : b.labels[c];
          const base = t.bu ? t.bu[c] : null, wbase = t.bw ? t.bw[c] : null;
          for (const r of t.r) rows.push([q.text, q.code, r[0], r[1] ? 'NET' : 'Answer', bd, seg, r[2][c], r[3][c], null, base, wbase, r[4] && r[4][c] && r[4][c] !== '-' ? r[4][c] : '']);
          if (t.m) rows.push([q.text, q.code, 'Average', 'Average', bd, seg, null, null, t.m[c], base, wbase, '']);
        }
      }
    }
  }
  return { columns: SURVEY_COLS, rows };
}
async function studioRaw(id) {
  const d = STUDIO.list.find(x => x.id === id);
  if (!d) throw new Error('This dataset is no longer available.');
  const key = 'raw:' + d.file_path;
  if (STUDIO.data.has(key)) return STUDIO.data.get(key);
  const json = await studioData(d);
  const raw = d.kind === 'survey' || json.questions ? surveyToRaw(json) : { columns: json.columns, rows: json.rows };
  raw.ix = Object.fromEntries(raw.columns.map((c, i) => [c.key, i]));
  raw.d = d;
  STUDIO.data.delete(d.file_path); // keep only the unrolled copy
  STUDIO.data.set(key, raw);
  return raw;
}

function studioRail() {
  if (!STUDIO.list.length && !IS_ADMIN) return null;
  return h('div', { class: 'labdata', role: 'group', 'aria-labelledby': 'labH' },
    h('div', { class: 'lab-h', id: 'labH' }, h('span', { class: 'lab-tag' }, 'Data Studio')),
    railButton({ id: 'studio', name: 'Build a report' }, 'lab', 0),
    railButton({ id: 'studio:mine', name: 'My reports' }, 'lab', 0),
    IS_ADMIN ? railButton({ id: 'studio:admin', name: 'Manage data' }, 'lab', 0) : null,
    IS_ADMIN ? railButton({ id: 'studio:kpis', name: 'KPIs' }, 'lab', 0) : null);
}
function studioHead(eyebrow, title, blurb) {
  return h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow labeyebrow' }, eyebrow), h('h1', {}, title), blurb ? h('p', {}, blurb) : null);
}
function metaLine(d) {
  const m = d.meta || {};
  if (d.kind === 'survey') return `Survey: ${(m.questions || 0).toLocaleString('en-CA')} questions, ${(m.breakdowns || []).length} breakdowns${m.base ? `, ${Math.round(m.base).toLocaleString('en-CA')} respondents` : ''}`;
  return `${(m.rows || 0).toLocaleString('en-CA')} rows, ${(m.columns || []).length} columns`;
}
function labField(label, el) { return h('label', { class: 'labfield' }, h('span', {}, label), el); }
function labSelect(opts, val, onChange, aria) {
  return h('select', { class: 'sel', 'aria-label': aria || null, onchange: e => onChange(e.target.value) },
    ...opts.map(o => Array.isArray(o) ? h('option', { value: o[0], selected: o[0] === val }, o[1]) : h('optgroup', { label: o.group }, ...o.items.map(i => h('option', { value: i[0], selected: i[0] === val }, i[1])))));
}
const labColors = n => Array.from({ length: n }, (_, i) => n === 1 ? css('--lab') : colorOf(SLOTS[i % SLOTS.length]));

async function renderStudio(main) {
  const id = current.slice(7);
  if (id === 'admin') return IS_ADMIN ? renderStudioAdmin(main) : go('studio');
  if (id === 'kpis') return IS_ADMIN ? renderKpiAdmin(main) : go('studio');
  if (id === 'mine') return renderMyReports(main);
  return renderReportBuilder(main);
}

/* ---------- the report: a title and any number of blocks ---------- */
const VIZ = [['bar', 'Bar chart (horizontal)'], ['column', 'Column chart'], ['stacked', 'Stacked columns'], ['stacked100', '100% stacked columns'], ['line', 'Line chart'], ['area', 'Area chart'],
  ['pie', 'Pie chart'], ['doughnut', 'Doughnut chart'], ['table', 'Table'], ['number', 'Single number'], ['rows', 'Raw data rows']];
const AGG = [['sum', 'Total'], ['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest'], ['count', 'Count of rows'], ['distinct', 'Count of different values']];
let BLK = 0;
const newId = () => 'b' + Date.now().toString(36) + (BLK++);
function draftSave() { try { localStorage.setItem('aia-studio-draft', JSON.stringify(STUDIO.report)); } catch { /* private mode */ } }
function draftLoad() { try { return JSON.parse(localStorage.getItem('aia-studio-draft') || 'null'); } catch { return null; } }
function blankReport() { return { title: '', blocks: [], savedId: null }; }

async function defaultBlock(dsId, viz) {
  const raw = await studioRaw(dsId);
  const C = raw.columns, ix = raw.ix;
  const b = { id: newId(), ds: dsId, viz: viz || 'column', x: '', series: '', value: '__count', agg: 'count', filters: [], sort: 'data', top: 0, title: '', open: true };
  if (raw.d.kind === 'survey') {
    const firstQ = raw.rows.length ? raw.rows[0][ix.q] : '';
    Object.assign(b, { viz: viz || 'bar', x: 'answer', series: 'seg', value: 'pct', agg: 'avg', filters: [{ col: 'q', vals: [firstQ] }, { col: 'bd', vals: ['Total'] }, { col: 'atype', vals: ['Answer'] }] });
    if (viz === 'number') Object.assign(b, { x: '', series: '', value: 'base', agg: 'max' }); // respondents for the question
    return b;
  }
  const date = C.find(c => c.type === 'date'), cat = C.find(c => c.type === 'category'), num = C.find(c => c.type === 'number');
  b.x = (date || cat || {}).key || '';
  if (num) { b.value = num.key; b.agg = 'sum'; }
  if (!viz) b.viz = date ? 'line' : 'column';
  if (viz === 'number') b.x = '';
  return b;
}

async function renderReportBuilder(main) {
  const seq = RSEQ;
  if (!STUDIO.report) STUDIO.report = draftLoad() || blankReport();
  const R = STUDIO.report;
  R.blocks = R.blocks.filter(b => STUDIO.list.some(d => d.id === b.ds));
  const usable = STUDIO.list.filter(d => d.status === 'published' || IS_ADMIN);
  main.append(studioHead('Data Studio', 'Build a report', 'Add charts, tables and figures from any dataset. For each one, choose the data, the type of visual, what goes on the rows and in the series, what to calculate, and any filters. Save the report to come back to it, or print it to PDF.'));
  if (!usable.length) { main.append(h('p', { class: 'loading' }, IS_ADMIN ? 'No data yet. Add a dataset under Manage data.' : 'No data has been added to Data Studio yet.')); return; }
  const titleIn = h('input', { class: 'sel labtitle', value: R.title, placeholder: 'Untitled report', 'aria-label': 'Report title', oninput: e => { R.title = e.target.value; draftSave(); } });
  const blocksBox = h('div', { class: 'labblocks' });
  const addBar = (where) => h('div', { class: 'labadd' + (where ? ' labadd-' + where : '') }, h('span', {}, 'Add'),
    ...[['column', 'Chart'], ['table', 'Table'], ['number', 'Number'], ['rows', 'Raw data']].map(([v, l]) => h('button', { type: 'button', class: 'act', onclick: async () => {
      const ds = (R.blocks.at(-1) || {}).ds || usable[0].id;
      const b = await defaultBlock(ds, v); R.blocks.push(b); draftSave(); blocksBox.append(blockCard(b)); blocksBox.lastChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } }, '+ ' + l)));
  const save = async () => {
    const title = (R.title || '').trim() || prompt('Name this report', '');
    if (!title) return;
    R.title = title; titleIn.value = title;
    const config = { title, blocks: R.blocks.map(b => ({ ...b, open: false })) };
    const body = { title: title.slice(0, 140), config, dataset_id: (R.blocks[0] || {}).ds || null, updated_at: new Date().toISOString() };
    const r = R.savedId ? await SB.from('hub_saved_reports').update(body).eq('id', R.savedId).select('id').single() : await SB.from('hub_saved_reports').insert(body).select('id').single();
    if (r.error) return toast('The report could not be saved. Try again.');
    R.savedId = r.data.id; draftSave(); toast('Saved to My reports');
    const btn = $('.labreport-head .btn-ask'); if (btn) btn.textContent = 'Save changes';
  };
  main.append(h('section', { class: 'labreport' },
    h('div', { class: 'labreport-head' }, labField('Report title', titleIn),
      h('div', { class: 'labacts' }, h('button', { type: 'button', class: 'btn-ask', onclick: save }, R.savedId ? 'Save changes' : 'Save report'),
        h('button', { type: 'button', class: 'act', onclick: () => { document.body.classList.add('labprint'); window.print(); setTimeout(() => document.body.classList.remove('labprint'), 500); } }, 'Print or save as PDF'),
        h('button', { type: 'button', class: 'act', onclick: () => { if (R.blocks.length && !confirm('Start a new, empty report? Unsaved changes to this one are lost.')) return; STUDIO.report = blankReport(); draftSave(); render(); } }, 'New report'))),
    R.savedId ? h('p', { class: 'lab-meta' }, 'Editing a saved report. Save changes to update it in My reports.') : null),
    blocksBox, addBar('bottom'));
  if (!R.blocks.length) { blocksBox.append(h('p', { class: 'loading' }, 'Loading the data\u2026')); R.blocks.push(await defaultBlock(usable[0].id)); draftSave(); blocksBox.replaceChildren(); }
  if (seq !== RSEQ) return;
  for (const b of R.blocks) blocksBox.append(blockCard(b));
}

/* ---------- one block ---------- */
function blockCard(b) {
  const el = h('section', { class: 'labblock', 'data-id': b.id });
  paintBlock(el, b);
  return el;
}
function moveBlock(b, dir) {
  const R = STUDIO.report, i = R.blocks.indexOf(b), j = i + dir;
  if (j < 0 || j >= R.blocks.length) return;
  [R.blocks[i], R.blocks[j]] = [R.blocks[j], R.blocks[i]]; draftSave();
  const box = $('.labblocks'), el = box.querySelector(`[data-id="${b.id}"]`), other = box.querySelector(`[data-id="${R.blocks[i].id}"]`);
  if (dir < 0) box.insertBefore(el, other); else box.insertBefore(other, el);
}
async function paintBlock(el, b) {
  for (const c of el.querySelectorAll('canvas')) freeChart(c);
  const ready = STUDIO.data.has('raw:' + ((STUDIO.list.find(x => x.id === b.ds) || {}).file_path));
  if (!ready && !el.firstChild) el.append(h('p', { class: 'loading' }, 'Loading the data\u2026'));
  let raw;
  try { raw = await studioRaw(b.ds); } catch (e) { el.replaceChildren(h('p', { class: 'loading' }, e.message)); return; }
  const R = STUDIO.report;
  const C = raw.columns, label = k => colLabel(raw, k);
  const redo = () => { draftSave(); paintBlock(el, b); };
  const cats = C.filter(c => c.type !== 'number'), nums = C.filter(c => c.type === 'number');
  const kp = kpiOf(b.value);
  if (String(b.value).startsWith('kpi:') ? !(kp && kpiPlan(kp, C)) : (b.value !== '__count' && !C.some(c => c.key === b.value))) { b.value = nums[0] ? nums[0].key : '__count'; b.agg = nums[0] ? 'sum' : 'count'; }
  // what this block shows
  const res = computeBlock(b, raw);
  const auto = autoTitle(b, raw, label);
  const head = h('div', { class: 'blkhead' },
    h('input', { class: 'blktitle', value: b.title, placeholder: auto, 'aria-label': 'Block title', oninput: e => { b.title = e.target.value; draftSave(); } }),
    h('div', { class: 'blktools' },
      h('button', { type: 'button', class: 'act', 'aria-expanded': String(!!b.open), onclick: () => { b.open = !b.open; redo(); } }, b.open ? 'Done' : 'Edit'),
      h('button', { type: 'button', class: 'act', title: 'Move up', 'aria-label': 'Move up', onclick: () => moveBlock(b, -1) }, '↑'),
      h('button', { type: 'button', class: 'act', title: 'Move down', 'aria-label': 'Move down', onclick: () => moveBlock(b, 1) }, '↓'),
      h('button', { type: 'button', class: 'act', title: 'Duplicate', onclick: () => { const c = { ...JSON.parse(JSON.stringify(b)), id: newId(), open: true }; R.blocks.splice(R.blocks.indexOf(b) + 1, 0, c); draftSave(); el.after(blockCard(c)); } }, 'Duplicate'),
      h('button', { type: 'button', class: 'act lab-del', title: 'Remove', onclick: () => { R.blocks.splice(R.blocks.indexOf(b), 1); draftSave(); for (const c of el.querySelectorAll('canvas')) freeChart(c); el.remove(); } }, 'Remove')));
  const kids = [head];
  if (b.open) kids.push(blockControls(b, raw, cats, nums, label, redo));
  kids.push(blockOutput(b, raw, res, label, auto));
  el.replaceChildren(...kids);
}
function autoTitle(b, raw, label) {
  const qf = raw.d.kind === 'survey' && b.filters.find(f => f.col === 'q' && f.vals.length === 1);
  if (qf) return qf.vals[0];
  if (b.viz === 'rows') return `${raw.d.title}: data rows`;
  const m = kpiOf(b.value) ? kpiOf(b.value).name : b.value === '__count' || (b.agg === 'count' && b.value === '__count') ? 'Number of rows' : b.agg === 'count' ? `Count of ${label(b.value)}` : `${(AGG.find(a => a[0] === b.agg) || [])[1]} ${label(b.value)}`;
  return `${m}${b.x ? ` by ${label(b.x)}` : ''}${b.series ? ` and ${label(b.series)}` : ''}`;
}
function blockControls(b, raw, cats, nums, label, redo) {
  const ds = STUDIO.list.filter(d => d.status === 'published' || IS_ADMIN);
  const colOpts = [['', 'None'], ...cats.map(c => [c.key, c.label]), ...nums.map(c => [c.key, c.label + ' (number)'])];
  const isChart = !['table', 'number', 'rows'].includes(b.viz);
  const box = h('div', { class: 'blkctl' });
  box.append(h('div', { class: 'labrow' },
    labField('Data', labSelect(ds.map(d => [d.id, d.title]), b.ds, async v => { const nb = await defaultBlock(v, b.viz); Object.assign(b, { ...nb, id: b.id, title: '', open: true }); redo(); }, 'Dataset')),
    labField('Show as', labSelect(VIZ, b.viz, v => { b.viz = v; if (v === 'number') { b.x = ''; b.series = ''; } if ((v === 'pie' || v === 'doughnut') && !b.x) b.x = b.series; redo(); }, 'Visual type'))));
  if (b.viz !== 'rows') box.append(h('div', { class: 'labrow' },
    b.viz !== 'number' ? labField(isChart && b.viz !== 'bar' ? 'Categories (x-axis)' : 'Rows', labSelect(colOpts, b.x, v => { b.x = v; if (b.series === v) b.series = ''; redo(); }, 'Rows')) : null,
    b.viz !== 'number' && b.viz !== 'pie' && b.viz !== 'doughnut' ? labField(b.viz === 'table' ? 'Columns' : 'Series (colours)', labSelect(colOpts.filter(o => !o[0] || o[0] !== b.x), b.series, v => { b.series = v; redo(); }, 'Series')) : null,
    labField('Value', labSelect(valueOpts(raw, cats, nums), b.value, v => {
      b.value = v; const col = raw.columns.find(c => c.key === v);
      if (v.startsWith('kpi:')) b.agg = 'kpi';
      else if (v === '__count') b.agg = 'count'; else if (col && col.type !== 'number') b.agg = 'distinct'; else if (['count', 'distinct'].includes(b.agg)) b.agg = col && col.fmt === 'pct' ? 'avg' : 'sum';
      redo(); }, 'Value')),
    b.value !== '__count' && !kpiOf(b.value) ? labField('Calculate', labSelect((raw.columns.find(c => c.key === b.value) || {}).type === 'number' ? AGG : AGG.filter(a => ['count', 'distinct'].includes(a[0])), b.agg, v => { b.agg = v; redo(); }, 'Calculate')) : null,
    b.viz !== 'number' ? labField('Sort', labSelect([['data', 'As in the data'], ['desc', 'Highest first'], ['asc', 'Lowest first'], ['az', 'A to Z']], b.sort, v => { b.sort = v; redo(); }, 'Sort')) : null,
    b.viz !== 'number' ? labField('Show', labSelect([['0', 'All'], ['5', 'Top 5'], ['10', 'Top 10'], ['20', 'Top 20'], ['50', 'Top 50']], String(b.top || 0), v => { b.top = +v; redo(); }, 'How many')) : null));
  // filters
  const fbox = h('div', { class: 'labfilters' }, h('span', { class: 'labseg-l' }, 'Filters'));
  b.filters.forEach((f, i) => fbox.append(filterRow(b, raw, f, i, redo)));
  fbox.append(h('button', { type: 'button', class: 'act', onclick: () => { b.filters.push({ col: (raw.columns.find(c => c.type !== 'number') || raw.columns[0]).key, vals: [], open: true }); redo(); } }, '+ Add filter'));
  box.append(fbox);
  return box;
}
// the Value list: KPIs that work on this dataset first, then the dataset's own columns
function valueOpts(raw, cats, nums) {
  const cols = [['__count', 'Number of rows'], ...nums.map(c => [c.key, c.label]), ...cats.map(c => [c.key, c.label + ' (count values)'])];
  const kpis = STUDIO.kpis.filter(k => kpiPlan(k, raw.columns)).map(k => ['kpi:' + k.id, k.name + (k.status === 'draft' ? ' (draft)' : '')]);
  return kpis.length ? [{ group: 'KPIs', items: kpis }, { group: 'Columns', items: cols }] : cols;
}
function distinctVals(raw, col) {
  const key = 'dv:' + col; if (raw[key]) return raw[key];
  const i = raw.ix[col], seen = new Map();
  for (const r of raw.rows) { const v = r[i]; if (v === '' || v == null) continue; const s = String(v); seen.set(s, (seen.get(s) || 0) + 1); }
  return (raw[key] = [...seen.keys()]);
}
function filterRow(b, raw, f, i, redo) {
  const vals = distinctVals(raw, f.col);
  const row = h('div', { class: 'labfilter' });
  const summary = f.vals.length ? (f.vals.length === 1 ? f.vals[0] : `${f.vals.length} selected`) : 'Any value';
  row.append(labSelect(raw.columns.map(c => [c.key, c.label]), f.col, v => { f.col = v; f.vals = []; f.open = true; redo(); }, 'Filter column'),
    h('button', { type: 'button', class: 'sel labfv', 'aria-expanded': String(!!f.open), onclick: () => { f.open = !f.open; redo(); } }, String(summary).length > 70 ? String(summary).slice(0, 68) + '…' : summary, ' ▾'),
    h('button', { type: 'button', class: 'act', 'aria-label': 'Remove filter', onclick: () => { b.filters.splice(i, 1); redo(); } }, '✕'));
  if (f.open) {
    const list = h('div', { class: 'labfv-list' });
    const find = h('input', { type: 'search', class: 'sel', placeholder: `Search ${vals.length.toLocaleString('en-CA')} values`, 'aria-label': 'Search values' });
    const draw = () => {
      const q = find.value.trim().toLowerCase();
      const shown = (q ? vals.filter(v => v.toLowerCase().includes(q)) : vals).slice(0, 300);
      list.replaceChildren(...shown.map(v => h('label', { class: 'labcheck' }, h('input', { type: 'checkbox', checked: f.vals.includes(v), onchange: e => {
        f.vals = e.target.checked ? [...f.vals, v] : f.vals.filter(x => x !== v); draftSave(); refreshOut(); } }), ' ' + v)));
      if (!shown.length) list.append(h('p', { class: 'lab-meta' }, 'No values match.'));
    };
    // update the output without rebuilding the open value list
    const refreshOut = () => { const card = row.closest('.labblock'); const out = card.querySelector('.blkout'); for (const c of out.querySelectorAll('canvas')) freeChart(c); const lbl = k => colLabel(raw, k);
      out.replaceWith(blockOutput(b, raw, computeBlock(b, raw), lbl, autoTitle(b, raw, lbl))); row.querySelector('.labfv').firstChild.textContent = f.vals.length ? (f.vals.length === 1 ? f.vals[0].slice(0, 68) : `${f.vals.length} selected`) : 'Any value'; card.querySelector('.blktitle').placeholder = autoTitle(b, raw, lbl); };
    find.addEventListener('input', draw);
    draw();
    row.append(h('div', { class: 'labfv-panel' }, find,
      h('div', { class: 'labfv-acts' }, h('button', { type: 'button', class: 'act', onclick: () => { f.vals = [...new Set([...f.vals, ...vals.filter(v => v.toLowerCase().includes(find.value.trim().toLowerCase()))])]; draftSave(); draw(); refreshOut(); } }, 'Select all shown'),
        h('button', { type: 'button', class: 'act', onclick: () => { f.vals = []; draftSave(); draw(); refreshOut(); } }, 'Clear'),
        h('button', { type: 'button', class: 'act', onclick: () => { f.open = false; redo(); } }, 'Done')), list));
  }
  return row;
}

/* ---------- the numbers ---------- */
function computeBlock(b, raw) {
  const ix = raw.ix;
  const fs = b.filters.filter(f => f.vals && f.vals.length && ix[f.col] != null).map(f => [ix[f.col], new Set(f.vals)]);
  const rows = raw.rows.filter(r => fs.every(([i, s]) => s.has(String(r[i] ?? ''))));
  if (b.viz === 'rows') return { rows };
  if (String(b.value).startsWith('kpi:')) return computeKpi(b, raw, rows);
  const xi = b.x ? ix[b.x] : null, si = b.series ? ix[b.series] : null, vi = b.value === '__count' ? null : ix[b.value];
  const agg = b.value === '__count' ? 'count' : b.agg;
  const xs = [], ss = [], xseen = new Set(), sseen = new Set(), acc = new Map();
  for (const r of rows) {
    const x = xi == null ? 'All' : String(r[xi] ?? ''), s = si == null ? '' : String(r[si] ?? '');
    if (!xseen.has(x)) { xseen.add(x); xs.push(x); } if (!sseen.has(s)) { sseen.add(s); ss.push(s); }
    const k = x + '\u0001' + s;
    let a = acc.get(k); if (!a) acc.set(k, a = { s: 0, n: 0, c: 0, min: Infinity, max: -Infinity, set: null });
    a.c++;
    if (vi == null) continue;
    const raw0 = r[vi];
    if (agg === 'distinct') { if (raw0 !== '' && raw0 != null) (a.set || (a.set = new Set())).add(String(raw0)); continue; }
    if (agg === 'count') { if (raw0 !== '' && raw0 != null) a.n++; continue; }
    const v = typeof raw0 === 'number' ? raw0 : sNum(raw0); if (v == null) continue;
    a.s += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v;
  }
  const val = (x, s) => { const a = acc.get(x + '\u0001' + s); if (!a) return null;
    if (agg === 'count') return vi == null ? a.c : a.n; if (agg === 'distinct') return a.set ? a.set.size : 0; if (!a.n) return null;
    return agg === 'avg' ? a.s / a.n : agg === 'min' ? a.min : agg === 'max' ? a.max : a.s; };
  const tot = x => ss.reduce((t, s) => t + (val(x, s) || 0), 0);
  const X = orderX(b, xs, tot);
  const pctCol = vi != null && raw.columns[vi].fmt === 'pct' && !['count', 'distinct'].includes(agg) && agg !== 'sum' || (vi != null && raw.columns[vi].fmt === 'pct' && agg === 'sum');
  const grand = (() => { if (agg === 'count' || agg === 'distinct' || agg === 'sum') return X.reduce((t, x) => t + tot(x), 0);
    let s = 0, n = 0, mn = Infinity, mx = -Infinity; for (const a of acc.values()) { s += a.s; n += a.n; mn = Math.min(mn, a.min); mx = Math.max(mx, a.max); } return !n ? null : agg === 'avg' ? s / n : agg === 'min' ? mn : mx; })();
  return { rows, X, S: ss, val, pct: pctCol, grand, agg };
}
function orderX(b, xs, tot) {
  let X = xs.slice();
  if (b.sort === 'desc') X.sort((p, q) => tot(q) - tot(p)); else if (b.sort === 'asc') X.sort((p, q) => tot(p) - tot(q)); else if (b.sort === 'az') X.sort((p, q) => p.localeCompare(q, 'en', { numeric: true }));
  if (b.top) X = (b.sort === 'data' || b.sort === 'az' ? X.slice().sort((p, q) => tot(q) - tot(p)).slice(0, b.top).sort((p, q) => X.indexOf(p) - X.indexOf(q)) : X.slice(0, b.top));
  return X;
}
// a KPI block: each calculation the formula needs is gathered per row/series group, then the formula runs on each group
function computeKpi(b, raw, rows) {
  const k = kpiOf(b.value), plan = k && kpiPlan(k, raw.columns);
  const T = plan ? plan.terms.map(t => ({ fn: t.fn, i: t.key == null ? null : raw.ix[t.key] })) : [];
  const xi = b.x ? raw.ix[b.x] : null, si = b.series ? raw.ix[b.series] : null;
  const xs = [], ss = [], xseen = new Set(), sseen = new Set(), acc = new Map(), all = termAccs(T.length);
  for (const r of rows) {
    const x = xi == null ? 'All' : String(r[xi] ?? ''), s = si == null ? '' : String(r[si] ?? '');
    if (!xseen.has(x)) { xseen.add(x); xs.push(x); } if (!sseen.has(s)) { sseen.add(s); ss.push(s); }
    const key = x + '\u0001' + s;
    let a = acc.get(key); if (!a) acc.set(key, a = termAccs(T.length));
    termAdd(a, T, r); termAdd(all, T, r);
  }
  const run = a => plan ? kpiEval(plan.ast, ti => termVal(a[ti], T[ti])) : null;
  const memo = new Map();
  const val = (x, s) => { const key = x + '\u0001' + s; if (!memo.has(key)) { const a = acc.get(key); memo.set(key, a ? run(a) : null); } return memo.get(key); };
  const tot = x => ss.reduce((t, s) => t + (val(x, s) || 0), 0);
  return { rows, X: orderX(b, xs, tot), S: ss, val, pct: kpiFmt(k), grand: run(all), agg: 'kpi' };
}
const fmtMoney = (v, short) => (v < 0 ? '-' : '') + '$' + (short && Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toLocaleString('en-CA', { maximumFractionDigits: 1 }) + 'M'
  : Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const fmtFull = (v, pct) => v == null ? '—' : pct === 'cur' ? fmtMoney(v) : pct ? `${(v * 100).toFixed(Math.abs(v) < .1 ? 1 : 0)}%` : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-CA') : (+v.toFixed(2)).toLocaleString('en-CA');
const fmtV = (v, pct) => v == null ? '—' : pct === 'cur' ? fmtMoney(v, true) : pct ? `${(v * 100).toFixed(Math.abs(v) < .1 ? 1 : 0)}%` : Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString('en-CA', { maximumFractionDigits: 1 }) + 'M' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-CA') : (+v.toFixed(2)).toLocaleString('en-CA');

function blockOutput(b, raw, res, label, auto) {
  const out = h('div', { class: 'blkout' });
  const title = b.title || auto;
  if (b.viz === 'rows') {
    const C = raw.columns;
    out.append(h('p', { class: 'lab-meta' }, `${res.rows.length.toLocaleString('en-CA')} rows${res.rows.length > 200 ? ' (first 200 shown; the CSV has them all)' : ''}`),
      h('div', { class: 'tbl-wrap labtbl' }, h('table', {}, h('thead', {}, h('tr', {}, ...C.map(c => h('th', {}, c.label)))),
        h('tbody', {}, ...res.rows.slice(0, 200).map(r => h('tr', {}, ...C.map((c, i) => h('td', {}, c.fmt === 'pct' ? fmtV(r[i], true) : r[i] == null ? '' : typeof r[i] === 'number' ? fmtV(r[i]) : String(r[i])))))))));
    out.append(blockFoot(b, raw, () => [C.map(c => c.label), ...res.rows.map(r => r.map(v => v ?? ''))], title));
    return out;
  }
  const { X, S, val, pct } = res;
  if (!res.rows.length) { out.append(h('p', { class: 'lab-meta' }, 'No rows match these filters.')); return out; }
  if (b.viz === 'number') {
    out.append(h('div', { class: 'blknum' }, h('b', {}, fmtFull(res.grand, pct)), h('span', {}, `${title} · ${res.rows.length.toLocaleString('en-CA')} rows`)));
    out.append(blockFoot(b, raw, () => [[title], [res.grand ?? '']], title));
    return out;
  }
  const sName = s => s || (b.value === '__count' ? 'Rows' : label(b.value));
  if (b.viz === 'table') {
    out.append(h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, b.x ? label(b.x) : ''), ...S.map(s => h('th', {}, sName(s))), S.length > 1 && ['sum', 'count', 'distinct'].includes(res.agg) && !pct ? h('th', {}, 'Total') : null)),
      h('tbody', {}, ...X.map(x => h('tr', {}, h('th', {}, x), ...S.map(s => h('td', {}, fmtFull(val(x, s), pct))),
        S.length > 1 && ['sum', 'count', 'distinct'].includes(res.agg) && !pct ? h('td', { class: 'blktot' }, fmtFull(S.reduce((t, s) => t + (val(x, s) || 0), 0))) : null))))));
  } else {
    const box = h('div', { class: 'labchart' }); out.append(box);
    const pie = b.viz === 'pie' || b.viz === 'doughnut';
    const horiz = b.viz === 'bar';
    const stacked = b.viz === 'stacked' || b.viz === 'stacked100';
    const colors = pie ? labColors(Math.max(2, X.length)) : labColors(S.length);
    let datasets = S.map((s, k) => ({ label: sName(s), data: X.map(x => val(x, s)), backgroundColor: colors[k], borderColor: colors[k], borderWidth: b.viz === 'line' || b.viz === 'area' ? 2.5 : 0,
      fill: b.viz === 'area' ? (stacked ? 'origin' : 'origin') : false, pointRadius: b.viz === 'line' ? 2 : 0, tension: .2, maxBarThickness: 40, borderRadius: 2 }));
    if (b.viz === 'area') datasets.forEach(d => { d.backgroundColor = d.borderColor + '55'; });
    if (b.viz === 'stacked100') datasets = datasets.map(d => ({ ...d, data: d.data.map((v, i) => { const t = S.reduce((a, s, k) => a + (datasets[k].data[i] || 0), 0); return t ? (v || 0) / t : null; }) }));
    if (pie) datasets = [{ label: sName(S[0]), data: X.map(x => val(x, S[0])), backgroundColor: X.map((_, i) => colors[i % colors.length]), borderColor: css('--surface') || '#fff', borderWidth: 2 }];
    const asPct = pct === true || b.viz === 'stacked100', unit = b.viz === 'stacked100' ? true : pct;
    const height = pie ? 360 : horiz ? Math.max(240, X.length * Math.max(18, Math.min(S.length, 8) * 12) + 90) : 360;
    labChart(box, { type: pie ? b.viz : (b.viz === 'line' || b.viz === 'area') ? 'line' : 'bar', indexAxis: horiz ? 'y' : 'x', stacked, pie, label: title,
      tip: v => fmtV(v, unit), tick: v => asPct ? Math.round(v * 100) + '%' : fmtV(v, unit), max: b.viz === 'stacked100' ? 1 : undefined, data: { labels: X, datasets } }, height);
    if (pie && S.length > 1) out.append(h('p', { class: 'lab-meta' }, `Pie charts show one series: ${sName(S[0])}. Use a column or bar chart to compare series.`));
  }
  out.append(blockFoot(b, raw, () => [[b.x ? label(b.x) : '', ...S.map(sName)], ...X.map(x => [x, ...S.map(s => { const v = val(x, s); return v == null ? '' : +(+v).toFixed(6); })])], title));
  return out;
}
function blockFoot(b, raw, csvRows, title) {
  const fl = b.filters.filter(f => f.vals.length).map(f => `${(raw.columns.find(c => c.key === f.col) || {}).label}: ${f.vals.length > 3 ? f.vals.length + ' values' : f.vals.join(', ')}`);
  return h('div', { class: 'blkfoot' }, h('span', { class: 'lab-src' }, `${raw.d.title} · ${raw.d.source || 'AIA Canada'}${fl.length ? ' · Filters: ' + fl.join('; ') : ''}`),
    h('button', { type: 'button', class: 'act', onclick: () => {
      const txt = csvRows().map(r => r.map(c => { const s = c == null ? '' : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
      const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv' })), download: `${sSlug(title)}.csv` }); document.body.append(a); a.click(); a.remove();
    } }, 'Download CSV'));
}
function labChart(box, cfg, height) {
  const cv = h('canvas', { role: 'img', 'aria-label': cfg.label || 'Chart' });
  box.style.height = height + 'px';
  box.replaceChildren(cv);
  const ink = css('--ink-2'), grid = css('--line-soft') || '#e3e8ef';
  const horiz = cfg.indexAxis === 'y';
  const valAxis = { grid: { color: grid }, ticks: { color: ink, callback: cfg.tick || (v => v) }, beginAtZero: true, stacked: !!cfg.stacked, max: cfg.max };
  const catAxis = { grid: { display: false }, stacked: !!cfg.stacked, ticks: { color: ink, autoSkip: !horiz, maxRotation: 50, callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 40 ? l.slice(0, 38) + '…' : l; } } };
  requestAnimationFrame(() => {
    const ch = new Chart(cv, { type: cfg.type || 'bar', data: cfg.data, options: {
      responsive: true, maintainAspectRatio: false, animation: false, indexAxis: cfg.indexAxis || 'x',
      plugins: { legend: { display: cfg.pie || cfg.data.datasets.length > 1, position: 'bottom', labels: { color: ink, boxWidth: 12 } },
        tooltip: { callbacks: { label: x => `${cfg.pie ? x.label : x.dataset.label}: ${cfg.tip ? cfg.tip(cfg.pie ? x.parsed : horiz ? x.parsed.x : x.parsed.y) : ''}` } } },
      scales: cfg.pie ? {} : horiz ? { x: valAxis, y: catAxis } : { x: catAxis, y: valAxis } } });
    CHARTS.set(cv, ch);
  });
}

/* ---------- my saved reports ---------- */
async function renderMyReports(main) {
  const seq = RSEQ;
  main.append(studioHead('Data Studio', 'My reports', 'Reports you have saved. Open one to keep working on it, or print it.'));
  const box = h('div', {}, h('p', { class: 'loading' }, 'Loading…')); main.append(box);
  try { await loadSaved(); } catch { STUDIO.saved = []; }
  if (seq !== RSEQ) return;
  if (!STUDIO.saved.length) { box.replaceChildren(h('p', { class: 'lab-meta' }, 'Nothing saved yet.'), h('button', { type: 'button', class: 'btn-ask', onclick: () => go('studio') }, 'Build a report')); return; }
  box.replaceChildren(h('ul', { class: 'labsaved-list' }, STUDIO.saved.map(s => h('li', {},
    h('a', { href: '#', onclick: e => { e.preventDefault(); STUDIO.report = { title: s.title, blocks: (s.config.blocks || []).map(b => ({ ...b, open: false })), savedId: s.id }; draftSave(); go('studio'); } }, s.title),
    h('span', { class: 'lab-meta' }, ` ${(s.config.blocks || []).length} ${(s.config.blocks || []).length === 1 ? 'block' : 'blocks'} · saved ${new Date(s.updated_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`),
    h('button', { type: 'button', class: 'act lab-del', 'aria-label': `Delete ${s.title}`, onclick: async () => { if (!confirm(`Delete the saved report "${s.title}"?`)) return; await SB.from('hub_saved_reports').delete().eq('id', s.id); if (STUDIO.report && STUDIO.report.savedId === s.id) STUDIO.report.savedId = null; render(); } }, 'Delete')))));
}
async function openInBuilder(id) {
  if (!STUDIO.report) STUDIO.report = draftLoad() || blankReport();
  STUDIO.report.blocks.push(await defaultBlock(id)); draftSave(); go('studio');
}

/* ---------- importing files (admins) ---------- */
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = SHEETJS; s.onload = () => ok(window.XLSX); s.onerror = () => no(new Error('The spreadsheet reader could not be loaded.')); document.head.append(s); });
}
// Survey crosstab ("banner table") exports: each table has a title row, a row of breakdown group names, a row of column labels,
// a "Column Names" row of letters, Weighted/Unweighted Total rows, then per answer a % row, a weighted count row and a
// significance-letters row. One sheet per banner (set of breakdowns); the same questions repeat on each sheet.
function isSurveyBook(sheets) { return sheets.some(s => s.rows.some(r => String(r[0]).trim() === 'Column Names')); }
function parseSurvey(sheets) {
  const banners = [], qmap = new Map(); let caption = '', sigNote = '';
  for (const s of sheets) for (const r of s.rows) { const a = String(r[0] || '').trim(); if (!sigNote && /^column comparison symbols/i.test(a)) sigNote = a.replace(/^column comparison symbols:\s*/i, ''); }
  const clean = v => (typeof v === 'string' ? v.trim() : v);
  const isBlankRest = r => r.slice(1).every(c => c === '' || c == null);
  for (const s of sheets) {
    const rows = s.rows;
    let banner = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() !== 'Column Names') continue;
      const labels = rows[i - 1].map(clean), letters = rows[i].map(clean), grow = rows[i - 2] || [];
      let title = '';
      for (let j = i - 3; j >= Math.max(0, i - 6); j--) { const t = clean(rows[j][0]); if (t && t !== 'Back to TOC') { title = String(t); break; } }
      if (!banner) {
        const id = 'b' + (banners.length + 1);
        const groups = []; let cur = null;
        for (let c = 2; c < labels.length; c++) {
          if (labels[c] === '' || labels[c] == null) continue;
          const g = clean(grow[c]);
          if (g) { cur = { name: String(g), cols: [] }; groups.push(cur); }
          if (!cur) { cur = { name: 'Breakdown', cols: [] }; groups.push(cur); }
          cur.cols.push(c);
        }
        banner = { id, sheet: s.name, labels: labels.map(String), letters: letters.map(String), groups };
        banners.push(banner);
      }
      const t = { bw: null, bu: null, r: [], m: null };
      const nums = r => r.slice(0, banner.labels.length).map((v, c) => c === 0 ? null : (typeof v === 'number' ? v : sNum(v)));
      const round = (a, d) => a.map(v => v == null ? null : +v.toFixed(d));
      let k = i + 1;
      for (; k < rows.length; k++) {
        const r = rows[k], a = clean(r[0]);
        if (a === 'Back to TOC' || a === 'Column Names') break;
        if (a && isBlankRest(r)) { if (!caption && /survey|study/i.test(a)) caption = a; break; }
        if (!a) continue;
        if (/^weighted total$/i.test(a)) { t.bw = round(nums(r), 1); continue; }
        if (/^unweighted total$/i.test(a)) { t.bu = round(nums(r), 0); continue; }
        if (/^(mean|average)$/i.test(a)) { t.m = round(nums(r), 2); continue; }
        if (/^(median|std|standard deviation|sigma|minimum|maximum)/i.test(a)) continue;
        const pctRow = nums(r);
        if (pctRow.slice(1).every(v => v == null)) continue; // a label line such as "Column Comparisons", not an answer
        const nRow = rows[k + 1] && !clean(rows[k + 1][0]) ? nums(rows[k + 1]) : null;
        const sigRow = nRow && rows[k + 2] && !clean(rows[k + 2][0]) && rows[k + 2].slice(1).some(v => typeof v === 'string' && v.trim()) ? rows[k + 2].slice(0, banner.labels.length).map(v => (typeof v === 'string' ? v.trim() : '')) : null;
        t.r.push([String(a), /^NET\b/i.test(String(a)), round(pctRow, 4), nRow ? round(nRow, 1) : pctRow.map(() => null), sigRow]);
        k += sigRow ? 2 : nRow ? 1 : 0;
      }
      i = k - 1;
      const text = title.replace(/\s+by\s+Banner\s*#?\s*\d+\s*$/i, '').trim();
      if (!text || !t.r.length) continue;
      const code = (text.match(/^([A-Za-z]{1,3}\d+[A-Za-z0-9_]*)\s*:/) || [])[1] || '';
      if (!qmap.has(text)) qmap.set(text, { code, text, t: {} });
      qmap.get(text).t[banner.id] = t;
    }
  }
  const questions = [...qmap.values()];
  const base = questions.length && Object.values(questions[0].t)[0].bu ? Object.values(questions[0].t)[0].bu[1] : null;
  const breakdowns = [...new Set(banners.flatMap(b => b.groups.map(g => g.name)))];
  return { kind: 'survey', data: { caption, sigNote, banners, questions }, meta: { questions: questions.length, breakdowns, base, banners: banners.length } };
}
function parseFlat(rows) {
  // header = first row with at least two filled cells
  let hi = rows.findIndex(r => r.filter(c => c !== '' && c != null).length >= 2);
  if (hi < 0) throw new Error('No header row found in this sheet.');
  const head = rows[hi].map((c, i) => String(c ?? '').trim() || `Column ${i + 1}`);
  const body = rows.slice(hi + 1).filter(r => r.some(c => c !== '' && c != null));
  const width = head.length;
  const used = new Set();
  const columns = head.map((l, i) => {
    let key = sSlug(l).replace(/-/g, '_') || `c${i}`; while (used.has(key)) key += '_'; used.add(key);
    const vals = body.map(r => r[i]).filter(v => v !== '' && v != null);
    const numShare = vals.length ? vals.filter(v => sNum(v) != null).length / vals.length : 0;
    const dateLike = vals.length && vals.slice(0, 200).every(v => v instanceof Date || /^\d{4}([-/]\d{1,2}){0,2}$|^(Q[1-4] )?\d{4}( Q[1-4])?$|^[A-Z][a-z]{2,8}\.? \d{4}$/.test(String(v).trim()));
    const yearOnly = vals.length && vals.slice(0, 200).every(v => /^\d{4}$/.test(String(v).trim()));
    const type = dateLike && (!numShare || yearOnly || /year|date|month|period|quarter/i.test(l)) ? 'date' : numShare >= 0.9 ? 'number' : 'category';
    return { key, label: l, type };
  });
  const out = body.map(r => columns.map((c, i) => { let v = r[i]; if (v instanceof Date) v = v.toISOString().slice(0, 10); if (c.type === 'number') return sNum(v); return v == null ? '' : String(v).trim(); }));
  return { kind: 'table', data: { columns, rows: out }, meta: { rows: out.length, columns: columns.map(c => ({ key: c.key, label: c.label, type: c.type })) }, width };
}
async function readUpload(file) {
  const X = await loadSheetJS();
  const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return wb.SheetNames.map(n => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
}

function renderStudioAdmin(main) {
  main.append(h('div', { class: 'labcrumb' }, h('a', { href: '#', onclick: e => { e.preventDefault(); go('studio'); } }, 'Data Studio'), ' / Manage data'));
  main.append(studioHead('Data Studio · Admin', 'Add and manage data', 'Upload a CSV or Excel file. Ordinary tables (one header row, then rows of data) and survey crosstab exports (banner tables) are both recognised. Only admins see this page.'));
  const st = { parsed: null, sheets: null, sheet: '', file: null };
  const work = h('section', { class: 'labctl' });
  const file = h('input', { type: 'file', accept: '.csv,.xlsx,.xls,.xlsm,.tsv,.txt', 'aria-label': 'Data file' });
  const status = h('p', { class: 'lab-meta', role: 'status' });
  work.append(h('h2', {}, 'Add data'), h('div', { class: 'labrow' }, file), status);
  const form = h('div', { class: 'labform' });
  work.append(form);
  main.append(work);
  const titleIn = h('input', { class: 'sel', 'aria-label': 'Title' }), descIn = h('textarea', { class: 'sel', rows: 2, 'aria-label': 'Description' }), srcIn = h('input', { class: 'sel', value: 'AIA Canada', 'aria-label': 'Source' });
  const hide = Object.fromEntries(STUDIO_ROLES.map(([r]) => [r, h('input', { type: 'checkbox' })]));
  const draft = h('input', { type: 'checkbox' });
  const replaceSel = h('select', { class: 'sel', 'aria-label': 'New or replace' }, h('option', { value: '' }, 'Add as a new dataset'), ...STUDIO.list.map(d => h('option', { value: d.id }, `Replace the data in "${d.title}"`)));
  replaceSel.addEventListener('change', () => { const d = STUDIO.list.find(x => x.id === replaceSel.value); if (d) { titleIn.value = d.title; descIn.value = d.description; srcIn.value = d.source; for (const [r] of STUDIO_ROLES) hide[r].checked = d.hidden_from.includes(r); draft.checked = d.status === 'draft'; } });
  const showParsed = () => {
    const p = st.parsed;
    const preview = p.kind === 'survey'
      ? h('div', {}, h('p', {}, h('b', {}, 'Survey crosstab detected. '), `${p.meta.questions.toLocaleString('en-CA')} questions, ${p.meta.banners} breakdown sheets, ${p.meta.base ? Math.round(p.meta.base).toLocaleString('en-CA') + ' respondents' : ''}.`),
        h('p', { class: 'lab-meta' }, 'Breakdowns: ' + p.meta.breakdowns.join(', ')),
        h('p', { class: 'lab-meta' }, 'First questions: ' + p.data.questions.slice(0, 4).map(q => q.text.slice(0, 80)).join(' · ')))
      : h('div', {}, h('p', {}, h('b', {}, 'Table detected. '), `${p.meta.rows.toLocaleString('en-CA')} rows, ${p.data.columns.length} columns. Check each column's name and type.`),
        h('div', { class: 'tbl-wrap labtbl' }, h('table', {}, h('thead', {}, h('tr', {}, ...p.data.columns.map(c => h('th', {},
          h('input', { class: 'sel labcolname', value: c.label, 'aria-label': `Name for ${c.label}`, oninput: e => { c.label = e.target.value; } }),
          labSelect([['category', 'Category'], ['date', 'Date or period'], ['number', 'Number']], c.type, v => { c.type = v; }, `Type of ${c.label}`))))),
          h('tbody', {}, ...p.data.rows.slice(0, 6).map(r => h('tr', {}, ...r.map(v => h('td', {}, v == null ? '' : String(v)))))))));
    form.replaceChildren(preview,
      st.sheets && st.sheets.length > 1 && p.kind === 'table' ? labField('Sheet', labSelect(st.sheets.map(s => [s.name, s.name]), st.sheet, v => { st.sheet = v; parseNow(); }, 'Sheet')) :'',
      labField('Save as', replaceSel), labField('Title', titleIn), labField('Description (shown in the library)', descIn), labField('Source', srcIn),
      h('fieldset', { class: 'labhide' }, h('legend', {}, 'Hide this dataset from'), ...STUDIO_ROLES.map(([r, l]) => h('label', { class: 'labcheck' }, hide[r], ' ' + l)),
        h('label', { class: 'labcheck' }, draft, ' Keep as a draft (admins only)')),
      h('div', { class: 'labacts' }, h('button', { type: 'button', class: 'btn-ask', onclick: publish }, 'Publish to Data Studio')));
    if (!titleIn.value) titleIn.value = p.kind === 'survey' && p.data.caption ? p.data.caption.replace(/\s*\(.*$/, '').replace(/^AIA\s*[–-]\s*/, '') : st.file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  };
  const parseNow = () => {
    try {
      if (isSurveyBook(st.sheets)) st.parsed = parseSurvey(st.sheets.filter(s => !/^toc$/i.test(s.name)));
      else { const s = st.sheets.find(x => x.name === st.sheet) || st.sheets[0]; st.sheet = s.name; st.parsed = parseFlat(s.rows); }
      status.textContent = '';
      showParsed();
    } catch (e) { status.textContent = e.message || 'The file could not be read.'; form.replaceChildren(); }
  };
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    st.file = f; status.textContent = `Reading ${f.name}…`; form.replaceChildren();
    try { st.sheets = await readUpload(f); parseNow(); } catch (e) { status.textContent = e.message || 'The file could not be read.'; }
  });
  async function publish() {
    const p = st.parsed; if (!p) return;
    const title = titleIn.value.trim(); if (!title) return toast('Give the dataset a title.');
    status.textContent = 'Publishing…';
    const existing = STUDIO.list.find(x => x.id === replaceSel.value);
    let slug = existing ? existing.slug : sSlug(title); if (!existing) { let n = 2; const base = slug; while (STUDIO.list.some(x => x.slug === slug)) slug = `${base}-${n++}`; }
    const path = `${slug}/${Date.now()}.json`;
    if (p.kind === 'table') p.meta.columns = p.data.columns.map(c => ({ key: c.key, label: c.label, type: c.type }));
    const text = JSON.stringify(p.data);
    const body = GZ ? await gzip(text) : new Blob([text], { type: 'application/json' });
    const up = await SB.storage.from('hub-data').upload(path, body, { contentType: 'application/json', upsert: true });
    if (!up.error) cachePut(path, text);
    if (up.error) { status.textContent = 'Upload failed: ' + up.error.message; return; }
    const row = { title, description: descIn.value.trim(), source: srcIn.value.trim(), kind: p.kind, file_path: path, original_name: st.file.name, meta: p.meta,
      hidden_from: STUDIO_ROLES.map(r => r[0]).filter(r => hide[r].checked), status: draft.checked ? 'draft' : 'published', updated_at: new Date().toISOString() };
    const r = existing ? await SB.from('hub_datasets').update(row).eq('id', existing.id) : await SB.from('hub_datasets').insert({ ...row, slug });
    if (r.error) { status.textContent = 'Saving failed: ' + r.error.message; await SB.storage.from('hub-data').remove([path]); return; }
    if (existing && existing.file_path !== path) await SB.storage.from('hub-data').remove([existing.file_path]);
    await loadStudio();
    toast(existing ? 'Dataset updated' : 'Dataset published');
    const nd = STUDIO.list.find(x => x.slug === slug); if (nd) openInBuilder(nd.id); else go('studio');
  }
  // existing datasets
  main.append(h('section', { class: 'labctl' }, h('h2', {}, 'Datasets'), STUDIO.list.length ? h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Dataset', 'Type', 'Hidden from', 'Status', 'Updated', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, ...STUDIO.list.map(d => h('tr', {}, h('th', {}, h('a', { href: '#', title: 'Add a block on this dataset to the report builder', onclick: e => { e.preventDefault(); openInBuilder(d.id); } }, d.title), h('span', { class: 'lab-meta' }, ' ' + d.original_name)),
      h('td', {}, d.kind === 'survey' ? 'Survey' : 'Table'),
      h('td', {}, h('div', { class: 'labhide-inline' }, ...STUDIO_ROLES.map(([r, l]) => h('label', { class: 'labcheck' }, h('input', { type: 'checkbox', checked: d.hidden_from.includes(r), onchange: async e => {
        const nh = e.target.checked ? [...new Set([...d.hidden_from, r])] : d.hidden_from.filter(x => x !== r);
        const res = await SB.from('hub_datasets').update({ hidden_from: nh }).eq('id', d.id); if (res.error) { toast('Not saved'); e.target.checked = !e.target.checked; return; } d.hidden_from = nh; toast('Saved'); } }), ' ' + l)))),
      h('td', {}, labSelect([['published', 'Published'], ['draft', 'Draft']], d.status, async v => { const res = await SB.from('hub_datasets').update({ status: v }).eq('id', d.id); if (!res.error) { d.status = v; toast('Saved'); render(); } }, `Status of ${d.title}`)),
      h('td', {}, new Date(d.updated_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })),
      h('td', {}, h('button', { type: 'button', class: 'act lab-del', onclick: async () => {
        if (!confirm(`Delete "${d.title}"? Saved reports built on it are deleted too. This can't be undone.`)) return;
        const res = await SB.from('hub_datasets').delete().eq('id', d.id); if (res.error) return toast('Not deleted: ' + res.error.message);
        await SB.storage.from('hub-data').remove([d.file_path]); await loadStudio(); render(); } }, 'Delete'))))))) : h('p', { class: 'lab-meta' }, 'Nothing added yet.'),
    h('p', { class: 'lab-meta' }, 'Live API sources are coming next: they will refresh on a schedule into the same kind of dataset.')));
}

/* ---------- admin: KPIs ---------- */
const KPI_FORMATS = [['number', 'Number'], ['currency', 'Dollars ($)'], ['percent', 'Percent']];
function renderKpiAdmin(main) {
  main.append(h('div', { class: 'labcrumb' }, h('a', { href: '#', onclick: e => { e.preventDefault(); go('studio'); } }, 'Data Studio'), ' / KPIs'));
  main.append(studioHead('Data Studio · Admin', 'KPIs', 'Define the measures people can pick as the Value when they build a report. A KPI is a formula over columns, so one definition works on every dataset that has those columns, including API data from shop platforms. Only admins see this page.'));
  const blank = () => ({ id: null, name: '', description: '', formula: '', format: 'number', status: 'draft', hidden_from: [] });
  let ed = blank();
  const nameIn = h('input', { class: 'sel', 'aria-label': 'KPI name', maxlength: 120 });
  const descIn = h('textarea', { class: 'sel', rows: 2, 'aria-label': 'Description' });
  const fIn = h('textarea', { class: 'sel labkpi-f', rows: 3, spellcheck: 'false', 'aria-label': 'Formula', placeholder: 'sum([Labour sales]) / count()' });
  const fmtSel = h('select', { class: 'sel', 'aria-label': 'Show as' }, ...KPI_FORMATS.map(([v, l]) => h('option', { value: v }, l)));
  const statusSel = h('select', { class: 'sel', 'aria-label': 'Status' }, h('option', { value: 'draft' }, 'Draft (admins only)'), h('option', { value: 'published' }, 'Published'));
  const hide = Object.fromEntries(STUDIO_ROLES.map(([r]) => [r, h('input', { type: 'checkbox' })]));
  const testSel = h('select', { class: 'sel', 'aria-label': 'Test on dataset' }, ...STUDIO.list.map(d => h('option', { value: d.id }, d.title)));
  const chips = h('div', { class: 'labchips' });
  const preview = h('div', { class: 'labkpi-prev', role: 'status' });
  const formH = h('h2', {}, 'New KPI');
  const insert = (text, back = 0) => {
    const s = fIn.selectionStart ?? fIn.value.length, e = fIn.selectionEnd ?? s;
    fIn.value = fIn.value.slice(0, s) + text + fIn.value.slice(e);
    fIn.focus(); const at = s + text.length - back; fIn.setSelectionRange(at, at); check();
  };
  const fnBtns = h('div', { class: 'labchips' }, h('span', { class: 'labseg-l' }, 'Calculations'),
    ...Object.entries(KPI_FNS).map(([fn, l]) => h('button', { type: 'button', class: 'act', title: l, onclick: () => {
      const s = fIn.selectionStart, e = fIn.selectionEnd, sel = fIn.value.slice(s, e);
      if (sel && /^\[.*\]$/.test(sel)) insert(`${fn}(${sel})`); else insert(`${fn}()`, 1);
    } }, `${fn}( )`)),
    ...['+', '-', '*', '/', '(', ')'].map(o => h('button', { type: 'button', class: 'act', onclick: () => insert(o === '(' || o === ')' ? o : ` ${o} `) }, o)));
  const drawChips = () => {
    const d = STUDIO.list.find(x => x.id === testSel.value);
    chips.replaceChildren(h('span', { class: 'labseg-l' }, 'Columns'), ...(d ? dsCols(d) : []).map(c => h('button', { type: 'button', class: 'act' + (c.type === 'number' ? ' labchip-n' : ''), title: c.type === 'number' ? 'Number column' : 'Text column (use count or distinct)', onclick: () => insert(`[${c.label}]`) }, c.label)));
  };
  let seq = 0, timer = 0;
  const check = () => { clearTimeout(timer); timer = setTimeout(runPreview, 200); };
  async function runPreview() {
    const my = ++seq;
    const k = { formula: fIn.value, format: fmtSel.value };
    const p = kpiParsed(k);
    if (!fIn.value.trim()) { preview.replaceChildren(h('p', { class: 'lab-meta' }, 'Write a formula, or build one with the buttons above. Example: sum([Labour sales]) / count([Repair order])')); return; }
    if (!p) { preview.replaceChildren(h('p', { class: 'labkpi-err' }, k._err)); return; }
    const works = STUDIO.list.filter(d => !kpiMissing(p, dsCols(d)).length);
    const kids = [h('p', { class: 'lab-meta' }, works.length ? `Works with ${works.length} of ${STUDIO.list.length} datasets: ${works.map(d => d.title).join(', ')}` : 'No current dataset has all these columns yet. That’s fine: it will appear for any dataset added later that does.')];
    const d = STUDIO.list.find(x => x.id === testSel.value);
    if (d) {
      const miss = kpiMissing(p, dsCols(d));
      if (miss.length) kids.unshift(h('p', { class: 'labkpi-err' }, `"${d.title}" has no column called ${miss.map(m => `[${m}]`).join(', ')}.`));
      else {
        kids.unshift(h('p', { class: 'lab-meta' }, 'Calculating…')); preview.replaceChildren(...kids);
        try {
          const raw = await studioRaw(d.id); if (my !== seq) return;
          const tmp = { id: '__test', ...k }; STUDIO.kpis.push(tmp);
          try { const res = computeKpi({ value: 'kpi:__test', x: '', series: '', sort: 'data', top: 0 }, raw, raw.rows);
            kids[0] = h('p', { class: 'labkpi-val' }, h('b', {}, fmtFull(res.grand, kpiFmt(k))), h('span', {}, ` on all ${raw.rows.length.toLocaleString('en-CA')} rows of "${d.title}"`)); }
          finally { STUDIO.kpis.splice(STUDIO.kpis.indexOf(tmp), 1); }
        } catch (e) { kids[0] = h('p', { class: 'labkpi-err' }, e.message); }
      }
    }
    if (my === seq) preview.replaceChildren(...kids);
  }
  const fill = k => {
    ed = { ...k }; nameIn.value = k.name; descIn.value = k.description; fIn.value = k.formula; fmtSel.value = k.format; statusSel.value = k.status;
    for (const [r] of STUDIO_ROLES) hide[r].checked = k.hidden_from.includes(r);
    formH.textContent = k.id ? `Edit "${k.name}"` : 'New KPI'; check();
  };
  async function save() {
    const name = nameIn.value.trim(), formula = fIn.value.trim();
    if (!name) return toast('Give the KPI a name.');
    try { kpiParse(formula); } catch (e) { return toast('Fix the formula first: ' + e.message); }
    if (STUDIO.kpis.some(k => k.id !== ed.id && k.name.toLowerCase() === name.toLowerCase())) return toast('There is already a KPI with that name.');
    const row = { name, description: descIn.value.trim(), formula, format: fmtSel.value, status: statusSel.value,
      hidden_from: STUDIO_ROLES.map(r => r[0]).filter(r => hide[r].checked), updated_at: new Date().toISOString() };
    const r = ed.id ? await SB.from('hub_kpis').update(row).eq('id', ed.id) : await SB.from('hub_kpis').insert(row);
    if (r.error) return toast('Not saved: ' + r.error.message);
    await loadStudio(); toast(ed.id ? 'KPI updated' : 'KPI added'); render();
  }
  [nameIn, fIn].forEach(x => x.addEventListener('input', check));
  fmtSel.addEventListener('change', check);
  testSel.addEventListener('change', () => { drawChips(); check(); });
  main.append(h('section', { class: 'labctl' }, formH,
    labField('Name (what people see in the Value list)', nameIn), labField('Description', descIn),
    labField('Test on', testSel), chips, fnBtns,
    labField('Formula', fIn), preview,
    h('div', { class: 'labrow' }, labField('Show as', fmtSel), labField('Status', statusSel)),
    h('fieldset', { class: 'labhide' }, h('legend', {}, 'Hide this KPI from'), ...STUDIO_ROLES.map(([r, l]) => h('label', { class: 'labcheck' }, hide[r], ' ' + l))),
    h('details', { class: 'labkpi-help' }, h('summary', {}, 'How formulas work'),
      h('ul', {},
        h('li', {}, 'Name columns in square brackets: [Labour sales]. Capitals, spaces and punctuation don’t matter, so [labour_sales] matches a column called "Labour sales".'),
        h('li', {}, 'Wrap each column in a calculation: sum, avg, min, max, count (non-empty values) or distinct (different values). count() on its own counts rows.'),
        h('li', {}, 'Combine them with + - * / and brackets. Dividing by zero shows a dash, not an error.'),
        h('li', {}, 'For a percent, the formula should give a fraction, such as sum([Parts sales]) / sum([Total sales]). Choose "Percent" and 0.42 shows as 42%.'),
        h('li', {}, 'The formula runs on each bar, row or slice separately, after filters, so a KPI broken down by province gives each province its own figure.'))),
    h('div', { class: 'labacts' }, h('button', { type: 'button', class: 'btn-ask', onclick: save }, 'Save KPI'),
      h('button', { type: 'button', class: 'act', onclick: () => fill(blank()) }, 'Clear'))));
  drawChips(); fill(blank());
  // existing KPIs
  main.append(h('section', { class: 'labctl' }, h('h2', {}, 'KPIs'), STUDIO.kpis.length ? h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['KPI', 'Formula', 'Shows as', 'Works with', 'Status', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, ...STUDIO.kpis.map(k => { const p = kpiParsed(k); const n = p ? STUDIO.list.filter(d => !kpiMissing(p, dsCols(d)).length).length : 0;
      return h('tr', {}, h('th', {}, k.name, k.description ? h('span', { class: 'lab-meta' }, ' ' + k.description) : null),
        h('td', {}, h('code', { class: 'labkpi-code' }, k.formula)),
        h('td', {}, (KPI_FORMATS.find(f => f[0] === k.format) || [])[1]),
        h('td', {}, p ? `${n} dataset${n === 1 ? '' : 's'}` : h('span', { class: 'labkpi-err' }, 'Formula error')),
        h('td', {}, labSelect([['published', 'Published'], ['draft', 'Draft']], k.status, async v => { const res = await SB.from('hub_kpis').update({ status: v, updated_at: new Date().toISOString() }).eq('id', k.id); if (res.error) return toast('Not saved'); k.status = v; toast('Saved'); }, `Status of ${k.name}`)),
        h('td', {}, h('button', { type: 'button', class: 'act', onclick: () => { fill(k); main.querySelector('.labctl').scrollIntoView({ behavior: 'smooth' }); } }, 'Edit'), ' ',
          h('button', { type: 'button', class: 'act lab-del', onclick: async () => {
            if (!confirm(`Delete the KPI "${k.name}"? Saved reports that use it switch to a plain column.`)) return;
            const res = await SB.from('hub_kpis').delete().eq('id', k.id); if (res.error) return toast('Not deleted: ' + res.error.message);
            await loadStudio(); render(); } }, 'Delete'))); })))) : h('p', { class: 'lab-meta' }, 'No KPIs yet. They’ll show up here, and in everyone’s Value list once published.')));
}
