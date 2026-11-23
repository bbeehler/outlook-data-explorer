/* ---------- Data Studio: datasets admins upload (CSV, Excel, survey crosstab exports) and anyone with access turns into their own reports ---------- */
// Catalogue rows live in hub_datasets; each dataset's parsed data is one JSON file in the private hub-data bucket.
// Two kinds: 'table' (rows and columns: pick a measure, group, split, filter) and 'survey' (crosstab banner tables:
// pick a question and a breakdown such as region or age, see % or weighted counts with significance letters).
const STUDIO = { list: [], data: new Map(), saved: [], cfg: {} };
const STUDIO_ROLES = [['member', 'Members'], ['affiliate', 'Affiliates'], ['buyer', 'Report buyers']];
const SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

async function loadStudio() {
  const { data } = await SB.from('hub_datasets').select('id,slug,title,description,source,kind,meta,hidden_from,status,updated_at,original_name,file_path,sort')
    .order('sort').order('updated_at', { ascending: false });
  STUDIO.list = data || [];
}
async function loadSaved() {
  const { data } = await SB.from('hub_saved_reports').select('id,title,config,dataset_id,updated_at').order('updated_at', { ascending: false });
  STUDIO.saved = data || [];
}
async function studioData(d) {
  const key = d.file_path;
  if (STUDIO.data.has(key)) return STUDIO.data.get(key);
  const { data, error } = await SB.storage.from('hub-data').download(d.file_path);
  if (error || !data) throw new Error('The data for this dataset could not be loaded.');
  const json = JSON.parse(await data.text());
  STUDIO.data.set(key, json);
  return json;
}
const sNum = v => (typeof v === 'number' ? v : (v === '' || v == null ? null : (isFinite(+String(v).replace(/[,$%\s]/g, '')) ? +String(v).replace(/[,$%\s]/g, '') : null)));
const sPct = v => v == null ? '—' : `${Math.round(v * 100)}%`;
const sCount = v => v == null ? '—' : Math.round(v).toLocaleString('en-CA');
const sVal = v => v == null ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-CA') : (+v.toFixed(2)).toLocaleString('en-CA');
const sSlug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'dataset';

function studioRail() {
  if (!STUDIO.list.length && !IS_ADMIN) return null;
  const sub = STUDIO.list.filter(d => d.status === 'published' || IS_ADMIN).slice(0, 10);
  return h('div', { class: 'labdata', role: 'group', 'aria-labelledby': 'labH' },
    h('div', { class: 'lab-h', id: 'labH' }, h('span', { class: 'lab-tag' }, 'Data Studio')),
    railButton({ id: 'studio', name: 'Build a report' }, 'lab', 0),
    ...sub.map(d => railButton({ id: 'studio:' + d.slug, name: d.title }, 'lab sub', 0)),
    IS_ADMIN ? railButton({ id: 'studio:admin', name: 'Manage data' }, 'lab', 0) : null);
}

async function renderStudio(main) {
  const seq = RSEQ;
  const id = current.slice(7);
  if (id === 'admin') return IS_ADMIN ? renderStudioAdmin(main) : go('studio');
  const d = id && STUDIO.list.find(x => x.slug === id);
  if (!d) return renderStudioLibrary(main);
  main.append(h('p', { class: 'loading' }, 'Loading the data…'));
  let data;
  try { data = await studioData(d); } catch (e) { if (seq === RSEQ) main.replaceChildren(h('p', { class: 'loading' }, e.message)); return; }
  if (seq !== RSEQ) return;
  main.replaceChildren();
  if (d.kind === 'survey') renderSurveyBuilder(main, d, data); else renderTableBuilder(main, d, data);
}

function studioHead(eyebrow, title, blurb) {
  return h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow labeyebrow' }, eyebrow), h('h1', {}, title), blurb ? h('p', {}, blurb) : null);
}
function metaLine(d) {
  const m = d.meta || {};
  if (d.kind === 'survey') return `${(m.questions || 0).toLocaleString('en-CA')} questions · ${(m.breakdowns || []).length} ways to break them down${m.base ? ` · ${Math.round(m.base).toLocaleString('en-CA')} respondents` : ''}`;
  return `${(m.rows || 0).toLocaleString('en-CA')} rows · ${(m.columns || []).length} columns`;
}

async function renderStudioLibrary(main) {
  const seq = RSEQ;
  main.append(studioHead('Data Studio', 'Build your own reports', 'Pick a dataset, choose what to look at and how to break it down, and the chart builds as you go. Save a report to come back to it, or download it as a CSV or PDF.'));
  const vis = STUDIO.list.filter(d => d.status === 'published' || IS_ADMIN);
  if (IS_ADMIN) main.append(h('div', { class: 'labbar' }, h('span', {}, `${vis.length} dataset${vis.length === 1 ? '' : 's'} in Data Studio.`), h('button', { type: 'button', class: 'btn-ask', onclick: () => go('studio:admin') }, 'Add or manage data')));
  if (!vis.length) { main.append(h('p', { class: 'loading' }, 'No datasets have been added yet.')); return; }
  main.append(h('div', { class: 'labgrid' }, vis.map(d => h('a', { class: 'tcard labcard', href: '#', onclick: e => { e.preventDefault(); go('studio:' + d.slug); } },
    h('span', { class: 'ref' }, d.kind === 'survey' ? 'Survey' : 'Table', d.status === 'draft' ? ' · draft (admins only)' : '', d.hidden_from && d.hidden_from.length && IS_ADMIN ? ` · hidden from ${d.hidden_from.map(r => STUDIO_ROLES.find(x => x[0] === r)[1].toLowerCase()).join(', ')}` : ''),
    h('b', {}, d.title), d.description ? h('span', { class: 'lab-desc' }, d.description) : null,
    h('span', { class: 'lab-meta' }, metaLine(d)),
    h('span', { class: 'lab-meta' }, [d.source, d.updated_at ? 'Updated ' + new Date(d.updated_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : ''].filter(Boolean).join(' · '))))));
  const box = h('section', { class: 'labsaved' }, h('h2', {}, 'My saved reports'), h('p', { class: 'loading' }, 'Loading…'));
  main.append(box);
  try { await loadSaved(); } catch { STUDIO.saved = []; }
  if (seq !== RSEQ) return;
  const rows = STUDIO.saved.filter(s => STUDIO.list.some(d => d.id === s.dataset_id));
  box.replaceChildren(h('h2', {}, 'My saved reports'), rows.length ? h('ul', { class: 'labsaved-list' }, rows.map(s => {
    const d = STUDIO.list.find(x => x.id === s.dataset_id);
    return h('li', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); STUDIO.cfg[d.slug] = { ...s.config, savedId: s.id, savedTitle: s.title }; go('studio:' + d.slug); } }, s.title),
      h('span', { class: 'lab-meta' }, ` ${d.title} · ${new Date(s.updated_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`),
      h('button', { type: 'button', class: 'act lab-del', 'aria-label': `Delete ${s.title}`, onclick: async () => { if (!confirm(`Delete the saved report "${s.title}"?`)) return; await SB.from('hub_saved_reports').delete().eq('id', s.id); render(); } }, 'Delete'));
  })) : h('p', { class: 'lab-meta' }, 'Reports you save in Data Studio appear here.'));
}

/* ---------- shared builder pieces ---------- */
function seg(label, opts, val, onPick) {
  return h('div', { class: 'labseg', role: 'group', 'aria-label': label }, h('span', { class: 'labseg-l' }, label),
    ...opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(v === val), onclick: () => onPick(v) }, l)));
}
function labField(label, el) { return h('label', { class: 'labfield' }, h('span', {}, label), el); }
function labSelect(opts, val, onChange, aria) {
  return h('select', { class: 'sel', 'aria-label': aria || null, onchange: e => onChange(e.target.value) },
    ...opts.map(o => Array.isArray(o) ? h('option', { value: o[0], selected: o[0] === val }, o[1]) : h('optgroup', { label: o.group }, ...o.items.map(i => h('option', { value: i[0], selected: i[0] === val }, i[1])))));
}
function studioActions(d, getCfg, csvRows, fileBase) {
  const save = async () => {
    const cfg = getCfg();
    const title = prompt('Name this report', cfg.savedTitle || '');
    if (!title) return;
    const body = { title: title.trim().slice(0, 140), config: { ...cfg, savedId: undefined, savedTitle: undefined }, dataset_id: d.id, updated_at: new Date().toISOString() };
    const r = cfg.savedId ? await SB.from('hub_saved_reports').update(body).eq('id', cfg.savedId).select('id').single() : await SB.from('hub_saved_reports').insert(body).select('id').single();
    if (r.error) return toast('The report could not be saved. Try again.');
    STUDIO.cfg[d.slug] = { ...cfg, savedId: r.data.id, savedTitle: body.title };
    toast('Saved to My saved reports');
  };
  const csv = () => {
    const rows = csvRows();
    const txt = rows.map(r => r.map(c => { const s = c == null ? '' : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv' })), download: `${fileBase}.csv` }); document.body.append(a); a.click(); a.remove();
    hubLog && hubLog('studio_csv', null, { dataset: d.slug });
  };
  return h('div', { class: 'labacts' },
    h('button', { type: 'button', class: 'btn-ask', onclick: save }, 'Save report'),
    h('button', { type: 'button', class: 'act', onclick: csv }, 'Download CSV'),
    h('button', { type: 'button', class: 'act', onclick: () => { document.body.classList.add('labprint'); window.print(); setTimeout(() => document.body.classList.remove('labprint'), 500); } }, 'Print or save as PDF'));
}
function labChart(box, cfg, height) {
  const cv = h('canvas', { role: 'img', 'aria-label': cfg.label || 'Chart' });
  box.style.height = height + 'px';
  box.replaceChildren(cv);
  const ink = css('--ink-2'), grid = css('--line-soft') || '#e3e8ef';
  const horiz = cfg.indexAxis === 'y';
  const valAxis = { grid: { color: grid }, ticks: { color: ink, callback: cfg.tick || (v => v) }, beginAtZero: true, stacked: !!cfg.stacked, max: cfg.max };
  const catAxis = { grid: { display: false }, stacked: !!cfg.stacked, ticks: { color: ink, autoSkip: false, callback: function (v) { const l = this.getLabelForValue(v); return String(l).length > 46 ? String(l).slice(0, 44) + '…' : l; } } };
  requestAnimationFrame(() => {
    const ch = new Chart(cv, { type: cfg.type || 'bar', data: cfg.data, options: {
      responsive: true, maintainAspectRatio: false, animation: false, indexAxis: cfg.indexAxis || 'x',
      plugins: { legend: { display: cfg.data.datasets.length > 1, position: 'bottom', labels: { color: ink, boxWidth: 12 } },
        tooltip: { callbacks: { label: x => `${x.dataset.label}: ${cfg.tip ? cfg.tip(horiz ? x.parsed.x : x.parsed.y, x) : (horiz ? x.parsed.x : x.parsed.y)}` } } },
      scales: horiz ? { x: valAxis, y: catAxis } : { x: catAxis, y: valAxis } } });
    CHARTS.set(cv, ch);
  });
}
const labColors = n => Array.from({ length: n }, (_, i) => n === 1 ? css('--lab') : colorOf(SLOTS[i % SLOTS.length]));

/* ---------- survey builder ---------- */
function surveyBreakdowns(data, qi) {
  const q = data.questions[qi];
  const out = [['total', 'Everyone (total)']];
  const seen = new Set();
  for (const b of data.banners) {
    if (!q.t[b.id]) continue;
    for (const g of b.groups) { const key = `${b.id}|${g.name}`; if (seen.has(g.name)) continue; seen.add(g.name); out.push([key, g.name]); }
  }
  return out;
}
function renderSurveyBuilder(main, d, data) {
  const cfg = STUDIO.cfg[d.slug] = Object.assign({ q: 0, by: 'total', show: 'pct', nets: false, view: 'chart', find: '' }, STUDIO.cfg[d.slug] || {});
  if (!data.questions[cfg.q]) cfg.q = 0;
  const redo = () => { main.replaceChildren(); renderSurveyBuilder(main, d, data); };
  main.append(h('div', { class: 'labcrumb' }, h('a', { href: '#', onclick: e => { e.preventDefault(); go('studio'); } }, 'Data Studio'), ' / ', d.title));
  main.append(studioHead('Data Studio · Survey', d.title, d.description || metaLine(d)));
  // question picker: a filter box over the list of questions
  const list = data.questions.map((q, i) => [String(i), q.text]);
  const f = cfg.find.trim().toLowerCase();
  const shown = f ? list.filter(([, t]) => t.toLowerCase().includes(f)) : list;
  if (!shown.some(([i]) => +i === cfg.q) && shown.length && f) cfg.q = +shown[0][0];
  const findBox = h('input', { type: 'search', class: 'sel labfind', placeholder: 'Filter questions, e.g. "warranty" or "Q13"', value: cfg.find, 'aria-label': 'Filter questions' });
  let ft; findBox.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(() => { cfg.find = findBox.value; const pos = findBox.selectionStart; redo(); const nb = $('.labfind'); if (nb) { nb.focus(); nb.setSelectionRange(pos, pos); } }, 250); });
  const bys = surveyBreakdowns(data, cfg.q);
  if (!bys.some(b => b[0] === cfg.by)) {
    const name = cfg.by.split('|')[1]; const alt = bys.find(b => b[1] === name); cfg.by = alt ? alt[0] : 'total';
  }
  main.append(h('section', { class: 'labctl' },
    labField(`Question (${shown.length.toLocaleString('en-CA')} of ${list.length.toLocaleString('en-CA')})`, h('div', { class: 'labq' }, findBox,
      labSelect(shown.length ? shown : [['', 'No questions match']], String(cfg.q), v => { if (v !== '') { cfg.q = +v; redo(); } }, 'Question'))),
    h('div', { class: 'labrow' },
      labField('Break down by', labSelect(bys, cfg.by, v => { cfg.by = v; redo(); }, 'Break down by')),
      seg('Show', [['pct', '% of respondents'], ['n', 'Weighted count']], cfg.show, v => { cfg.show = v; redo(); }),
      seg('View', [['chart', 'Chart'], ['table', 'Table']], cfg.view, v => { cfg.view = v; redo(); }),
      h('label', { class: 'labcheck' }, h('input', { type: 'checkbox', checked: cfg.nets, onchange: e => { cfg.nets = e.target.checked; redo(); } }), ' Include NET (combined) answers'))));
  // the table for this question and breakdown
  const q = data.questions[cfg.q];
  let bid, group;
  if (cfg.by === 'total') { bid = Object.keys(q.t)[0]; group = null; } else { [bid] = cfg.by.split('|'); const b = data.banners.find(x => x.id === bid); group = b.groups.find(g => g.name === cfg.by.split('|')[1]); }
  const tb = q.t[bid];
  const banner = data.banners.find(x => x.id === bid);
  const cols = group ? [1, ...group.cols] : [1]; // column 1 is Total in every banner
  const colName = i => i === 1 ? 'Total' : banner.labels[i];
  const rows = tb.r.filter(r => cfg.nets || !r[1]);
  const val = (r, i) => cfg.show === 'pct' ? r[2][i] : r[3][i];
  const out = h('section', { class: 'labout', id: 'labout' });
  const smallBase = i => tb.bu && tb.bu[i] != null && tb.bu[i] < 50;
  out.append(h('h2', { class: 'labq-title' }, q.text),
    h('p', { class: 'lab-meta' }, `Respondents: ${cols.map(i => `${group ? colName(i) + ' ' : ''}${sCount(tb.bu ? tb.bu[i] : tb.bw[i])}`).join(' · ')}${cols.some(smallBase) ? ' · † fewer than 50 respondents: read with caution' : ''}`));
  const tip = cfg.show === 'pct' ? v => sPct(v) : v => sCount(v);
  if (cfg.view === 'chart') {
    const box = h('div', { class: 'labchart' }); out.append(box);
    const colors = group ? [css('--muted-bar') || '#b8c2d1', ...labColors(cols.length - 1)] : labColors(1);
    labChart(box, { indexAxis: 'y', label: q.text, tip, tick: cfg.show === 'pct' ? v => Math.round(v * 100) + '%' : v => sCount(v), max: cfg.show === 'pct' ? 1 : undefined,
      data: { labels: rows.map(r => r[0]), datasets: cols.map((i, k) => ({ label: colName(i) + (smallBase(i) ? ' †' : ''), data: rows.map(r => val(r, i)), backgroundColor: colors[k], borderRadius: 2, maxBarThickness: 26 })) } },
      Math.max(220, rows.length * Math.min(cols.length, 9) * (cols.length > 4 ? 11 : 16) + rows.length * 16 + 80));
    if (tb.m) out.append(h('p', { class: 'lab-meta' }, `Average: ${cols.map(i => `${group ? colName(i) + ' ' : ''}${sVal(tb.m[i])}`).join(' · ')}`));
  } else {
    const hasSig = group && rows.some(r => cols.some(i => r[4] && r[4][i] && r[4][i] !== '-'));
    out.append(h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Answer'), ...cols.map(i => h('th', {}, colName(i), group && i !== 1 && banner.letters ? h('span', { class: 'siglet' }, banner.letters[i]) : null, smallBase(i) ? ' †' : '')))),
      h('tbody', {}, ...rows.map(r => h('tr', { class: r[1] ? 'labnet' : null }, h('th', {}, r[0]), ...cols.map(i => h('td', {}, cfg.show === 'pct' ? sPct(r[2][i]) : sCount(r[3][i]),
        r[4] && r[4][i] && r[4][i] !== '-' && group && i !== 1 ? h('sup', { class: 'sig' }, r[4][i]) : null)))),
        tb.m ? h('tr', { class: 'labnet' }, h('th', {}, 'Average'), ...cols.map(i => h('td', {}, sVal(tb.m[i])))) : null,
        h('tr', { class: 'labbase' }, h('th', {}, 'Respondents (unweighted)'), ...cols.map(i => h('td', {}, sCount(tb.bu ? tb.bu[i] : null)))),
        h('tr', { class: 'labbase' }, h('th', {}, 'Weighted base'), ...cols.map(i => h('td', {}, sCount(tb.bw ? tb.bw[i] : null))))))));
    if (hasSig) out.append(h('p', { class: 'lab-meta' }, 'A letter beside a result means it is significantly higher than the column with that letter (shown next to each column name). ',
      /p\s*<=\s*0?\.05/.test(data.sigNote || '') && /p\s*<=\s*0?\.01/.test(data.sigNote || '') ? 'Lower-case letters: 95% confidence. Upper-case letters: 99% confidence.' : data.sigNote ? `Source note: ${data.sigNote}` : ''));
  }
  out.append(h('p', { class: 'lab-src' }, `Source: ${d.source || 'AIA Canada'}${data.caption ? ` · ${data.caption}` : ''}`));
  main.append(out, studioActions(d, () => ({ ...cfg }),
    () => [['Answer', ...cols.map(colName)], ...rows.map(r => [r[0], ...cols.map(i => cfg.show === 'pct' ? (r[2][i] == null ? '' : +(r[2][i] * 100).toFixed(1)) : (r[3][i] == null ? '' : Math.round(r[3][i])))]),
      ...(tb.m ? [['Average', ...cols.map(i => tb.m[i] ?? '')]] : []), ['Respondents (unweighted)', ...cols.map(i => tb.bu ? tb.bu[i] ?? '' : '')], [], [`Question: ${q.text}`], [`Values: ${cfg.show === 'pct' ? '% of respondents' : 'weighted count'}`], [`Source: ${d.source || 'AIA Canada'}`]],
    sSlug(`${d.slug}-${q.code || 'question'}-${group ? group.name : 'total'}`)));
}

/* ---------- table builder ---------- */
function renderTableBuilder(main, d, data) {
  const C = data.columns;
  const nums = C.filter(c => c.type === 'number');
  const cats = C.filter(c => c.type !== 'number');
  const cfg = STUDIO.cfg[d.slug] = Object.assign({ measure: nums[0] ? nums[0].key : '__count', agg: 'sum', by: (cats.find(c => c.type === 'date') || cats[0] || {}).key || '', split: '', fcol: '', fvals: [], view: 'chart', chart: '' }, STUDIO.cfg[d.slug] || {});
  const redo = () => { main.replaceChildren(); renderTableBuilder(main, d, data); };
  const ix = Object.fromEntries(C.map((c, i) => [c.key, i]));
  const label = k => (C.find(c => c.key === k) || {}).label || k;
  main.append(h('div', { class: 'labcrumb' }, h('a', { href: '#', onclick: e => { e.preventDefault(); go('studio'); } }, 'Data Studio'), ' / ', d.title));
  main.append(studioHead('Data Studio · Table', d.title, d.description || metaLine(d)));
  const distinct = k => { const s = new Map(); for (const r of data.rows) { const v = r[ix[k]]; if (v !== '' && v != null) s.set(String(v), (s.get(String(v)) || 0) + 1); } return [...s.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); };
  const fvals = cfg.fcol ? distinct(cfg.fcol).slice(0, 200) : [];
  main.append(h('section', { class: 'labctl' }, h('div', { class: 'labrow' },
    labField('Measure', labSelect([['__count', 'Number of rows'], ...nums.map(c => [c.key, c.label])], cfg.measure, v => { cfg.measure = v; redo(); }, 'Measure')),
    cfg.measure !== '__count' ? labField('Calculate', labSelect([['sum', 'Total'], ['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest']], cfg.agg, v => { cfg.agg = v; redo(); }, 'Calculate')) : null,
    labField('Group by', labSelect([['', 'Nothing (one total)'], ...cats.map(c => [c.key, c.label])], cfg.by, v => { cfg.by = v; redo(); }, 'Group by')),
    labField('Split by', labSelect([['', 'No split'], ...cats.filter(c => c.key !== cfg.by).map(c => [c.key, c.label])], cfg.split, v => { cfg.split = v; redo(); }, 'Split by'))),
    h('div', { class: 'labrow' },
      labField('Filter', labSelect([['', 'No filter'], ...cats.map(c => [c.key, c.label])], cfg.fcol, v => { cfg.fcol = v; cfg.fvals = []; redo(); }, 'Filter column')),
      cfg.fcol ? h('div', { class: 'labchips', role: 'group', 'aria-label': `Values of ${label(cfg.fcol)}` }, ...fvals.slice(0, 40).map(v => h('button', { type: 'button', class: 'labchip', 'aria-pressed': String(cfg.fvals.includes(v)),
        onclick: () => { cfg.fvals = cfg.fvals.includes(v) ? cfg.fvals.filter(x => x !== v) : [...cfg.fvals, v]; redo(); } }, v))) : null,
      seg('View', [['chart', 'Chart'], ['table', 'Table']], cfg.view, v => { cfg.view = v; redo(); }))));
  // compute
  const rows = data.rows.filter(r => !cfg.fcol || !cfg.fvals.length || cfg.fvals.includes(String(r[ix[cfg.fcol]])));
  const byKey = r => cfg.by ? String(r[ix[cfg.by]] ?? '') : 'Total';
  const spKey = r => cfg.split ? String(r[ix[cfg.split]] ?? '') : '';
  const isDate = cfg.by && (C[ix[cfg.by]].type === 'date' || /^\d{4}([-/]\d{1,2})?([-/]\d{1,2})?$/.test(byKey(rows[0] || [])));
  let splits = cfg.split ? (() => { const t = new Map(); for (const r of rows) t.set(spKey(r), (t.get(spKey(r)) || 0) + (cfg.measure === '__count' ? 1 : Math.abs(sNum(r[ix[cfg.measure]]) || 0))); return [...t.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); })() : [''];
  const other = splits.length > 8; if (other) splits = [...splits.slice(0, 7), 'Other'];
  const acc = new Map();
  for (const r of rows) {
    const g = byKey(r); let s = spKey(r); if (other && !splits.slice(0, 7).includes(s)) s = 'Other';
    const v = cfg.measure === '__count' ? 1 : sNum(r[ix[cfg.measure]]);
    if (v == null) continue;
    const k = g + '\u0001' + s; const a = acc.get(k) || { s: 0, n: 0, min: Infinity, max: -Infinity }; a.s += v; a.n++; a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); acc.set(k, a);
  }
  const agg = a => !a ? null : cfg.measure === '__count' ? a.n : cfg.agg === 'avg' ? a.s / a.n : cfg.agg === 'min' ? a.min : cfg.agg === 'max' ? a.max : a.s;
  let groups = [...new Set(rows.map(byKey))];
  const tot = g => splits.reduce((s, sp) => s + (agg(acc.get(g + '\u0001' + sp)) || 0), 0);
  groups.sort(isDate ? (a, b) => (a < b ? -1 : a > b ? 1 : 0) : (a, b) => tot(b) - tot(a));
  if (!isDate && groups.length > 40) groups = groups.slice(0, 40);
  const mLabel = cfg.measure === '__count' ? 'Number of rows' : `${{ sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[cfg.agg]} ${label(cfg.measure)}`;
  const out = h('section', { class: 'labout', id: 'labout' });
  out.append(h('h2', { class: 'labq-title' }, `${mLabel}${cfg.by ? ` by ${label(cfg.by)}` : ''}${cfg.split ? `, split by ${label(cfg.split)}` : ''}`),
    h('p', { class: 'lab-meta' }, `${rows.length.toLocaleString('en-CA')} of ${data.rows.length.toLocaleString('en-CA')} rows${cfg.fcol && cfg.fvals.length ? ` · ${label(cfg.fcol)}: ${cfg.fvals.join(', ')}` : ''}${!isDate && [...new Set(rows.map(byKey))].length > 40 ? ' · top 40 shown' : ''}`));
  if (cfg.view === 'chart') {
    const box = h('div', { class: 'labchart' }); out.append(box);
    const line = isDate && groups.length > 2;
    const colors = labColors(splits.length);
    labChart(box, { type: line ? 'line' : 'bar', indexAxis: !line && groups.length > 8 ? 'y' : 'x', stacked: !line && cfg.split && cfg.agg === 'sum', tip: sVal, tick: v => compact ? compact(v) : v, label: mLabel,
      data: { labels: groups, datasets: splits.map((sp, k) => ({ label: sp || mLabel, data: groups.map(g => agg(acc.get(g + '\u0001' + sp))), backgroundColor: colors[k], borderColor: colors[k], borderWidth: line ? 2.5 : 0, pointRadius: line ? 2 : 0, tension: .2, maxBarThickness: 34 })) } },
      !line && groups.length > 8 ? Math.max(260, groups.length * 22 + 70) : 340);
  } else {
    out.append(h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, cfg.by ? label(cfg.by) : ''), ...splits.map(sp => h('th', {}, sp || mLabel)))),
      h('tbody', {}, ...groups.map(g => h('tr', {}, h('th', {}, g), ...splits.map(sp => h('td', {}, sVal(agg(acc.get(g + '\u0001' + sp)))))))))));
  }
  out.append(h('p', { class: 'lab-src' }, `Source: ${d.source || 'AIA Canada'}`));
  main.append(out, studioActions(d, () => ({ ...cfg }),
    () => [[cfg.by ? label(cfg.by) : '', ...splits.map(sp => sp || mLabel)], ...groups.map(g => [g, ...splits.map(sp => { const v = agg(acc.get(g + '\u0001' + sp)); return v == null ? '' : +(+v).toFixed(4); })]), [], [`Source: ${d.source || 'AIA Canada'}`]],
    sSlug(`${d.slug}-${cfg.measure}-${cfg.by || 'total'}`)));
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
    const up = await SB.storage.from('hub-data').upload(path, new Blob([JSON.stringify(p.data)], { type: 'application/json' }), { contentType: 'application/json', upsert: true });
    if (up.error) { status.textContent = 'Upload failed: ' + up.error.message; return; }
    const row = { title, description: descIn.value.trim(), source: srcIn.value.trim(), kind: p.kind, file_path: path, original_name: st.file.name, meta: p.meta,
      hidden_from: STUDIO_ROLES.map(r => r[0]).filter(r => hide[r].checked), status: draft.checked ? 'draft' : 'published', updated_at: new Date().toISOString() };
    const r = existing ? await SB.from('hub_datasets').update(row).eq('id', existing.id) : await SB.from('hub_datasets').insert({ ...row, slug });
    if (r.error) { status.textContent = 'Saving failed: ' + r.error.message; await SB.storage.from('hub-data').remove([path]); return; }
    if (existing && existing.file_path !== path) await SB.storage.from('hub-data').remove([existing.file_path]);
    await loadStudio();
    toast(existing ? 'Dataset updated' : 'Dataset published');
    go('studio:' + slug);
  }
  // existing datasets
  main.append(h('section', { class: 'labctl' }, h('h2', {}, 'Datasets'), STUDIO.list.length ? h('div', { class: 'tbl-wrap labtbl' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Dataset', 'Type', 'Hidden from', 'Status', 'Updated', ''].map(x => h('th', {}, x)))),
    h('tbody', {}, ...STUDIO.list.map(d => h('tr', {}, h('th', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); go('studio:' + d.slug); } }, d.title), h('span', { class: 'lab-meta' }, ' ' + d.original_name)),
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
