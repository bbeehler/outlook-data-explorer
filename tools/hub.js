/* ---------- AIA Canada Research Hub: sections, research reports, economy, links between sources, report manager ---------- */
const BASE_TOPICS = TOPICS.filter(t => !['home', 'access'].includes(t.id)).map(t => ({ ...t, group: 'outlook' }));
let REPORTS = [], ECON = null;
const OUTLOOK_TAGS = { sector: ['labour', 'technicians', 'independent-shops'], vehicles: ['vehicles-on-road', 'vehicle-sales', 'vehicle-age'],
  ev: ['ev', 'vehicle-sales'], demand: ['maintenance', 'service-choice', 'driving', 'parts'], economy: ['inflation', 'repair-prices', 'household-finances'], intl: ['ev'] };
const sourceOf = d => d.topic === 'macro' ? 'macro' : String(d.topic).startsWith('r:') ? 'report' : 'outlook';
const tagsOf = d => d.tags || OUTLOOK_TAGS[d.topic] || [];
const fmtDate = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }) : '';
QUESTIONS.splice(0, QUESTIONS.length,
  'Are repair prices rising faster than overall inflation?',
  'Where do Canadians get their vehicles serviced, and why?',
  'How fast is EV adoption growing, and what do EV owners think about maintenance?',
  'How many people work in automotive repair, and how are wages changing?',
  'How many vehicles are on Canadian roads, and how old are they?',
  'What do the latest research reports say about trust in repair shops?');

async function loadHub() {
  const [rep, econ] = await Promise.all([
    SB.from('hub_reports').select('id,slug,title,series,published_on,summary,key_findings,source_url,status,sections').eq('status', 'published').order('published_on', { ascending: false, nullsFirst: false }),
    fetch('economy/data.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  REPORTS = rep.data || [];
  ECON = econ;
  let figs = [];
  if (REPORTS.length) {
    for (let from = 0; ; from += 1000) {
      const { data } = await SB.from('hub_figures').select('payload,report_id,sort').in('report_id', REPORTS.map(r => r.id)).eq('hidden', false).order('sort').range(from, from + 999);
      figs = figs.concat(data || []); if (!data || data.length < 1000) break;
    }
  }
  const order = Object.fromEntries(REPORTS.map((r, i) => [r.id, i]));
  figs.sort((a, b) => order[a.report_id] - order[b.report_id] || a.sort - b.sort);
  const outlook = DS.filter(d => sourceOf(d) === 'outlook');
  // Reports with sections get one page per section (topic r:<slug>~<section key>); charts without a known section go to "Other findings".
  for (const r of REPORTS) {
    const secs = Array.isArray(r.sections) ? r.sections.filter(x => x && x.key) : [];
    const keys = new Set(secs.map(x => x.key));
    const mine = figs.filter(f => f.report_id === r.id);
    if (secs.length && mine.some(f => !keys.has(f.payload.section))) secs.push({ key: 'other', name: 'Other findings', blurb: 'Charts not yet placed in a section.' });
    r._sections = secs.filter(x => mine.some(f => (keys.has(f.payload.section) ? f.payload.section : 'other') === x.key));
    r._keys = keys;
  }
  const topicOf = (r, p) => r._sections.length ? `r:${r.slug}~${r._keys.has(p.section) ? p.section : 'other'}` : 'r:' + r.slug;
  const reportFigs = figs.map(f => { const r = REPORTS.find(x => x.id === f.report_id); return { ...f.payload, topic: topicOf(r, f.payload), source: `AIA Canada, ${r.title}` }; });
  const macro = (ECON && ECON.datasets) || [];
  DS = [...outlook, ...reportFigs, ...macro];
  const seen = new Set(); DS = DS.filter(d => !seen.has(d.id) && seen.add(d.id));
  BYID = Object.fromEntries(DS.map(d => [d.id, d]));
  TOPICS.splice(0, TOPICS.length,
    { id: 'home', name: 'Overview', blurb: '' },
    ...REPORTS.flatMap(r => [{ id: 'r:' + r.slug, name: r.title, label: r.title, group: 'research', blurb: r.summary, report: r },
      ...r._sections.map((sec, i) => ({ id: `r:${r.slug}~${sec.key}`, name: sec.name, label: `${r.title}: ${sec.name}`, group: 'research-sec', parent: 'r:' + r.slug, blurb: sec.blurb, report: r, section: sec, index: i }))]),
    ...BASE_TOPICS,
    { id: 'macro', name: 'Economic indicators', group: 'economy', blurb: 'Prices, vehicle sales, jobs, wages and interest rates from Statistics Canada and the Bank of Canada, updated twice a month.' },
    { id: 'reports', name: 'Research reports', group: 'admin', blurb: '' },
    { id: 'access', name: 'Manage access', group: 'admin', blurb: '' });
}

/* ---------- rail and pages ---------- */
function railButton(t, cls) {
  const n = t.group === 'research' ? DS.filter(d => d.topic === t.id || d.topic.startsWith(t.id + '~')).length : DS.filter(d => d.topic === t.id).length;
  return h('button', { type: 'button', class: cls || null, 'aria-current': String(current === t.id), title: t.name, onclick: () => { closeNav(); go(t.id); } },
    h('span', { class: 'rname' }, t.name), n && t.id !== 'defs' ? h('span', { class: 'count' }, n) : null);
}
// a report in the menu, with its sections listed under it while you're inside that report
function railReport(t) {
  const open = current === t.id || current.startsWith(t.id + '~');
  const subs = open ? TOPICS.filter(x => x.parent === t.id).map(x => railButton(x, 'sub')) : [];
  return [railButton(t, 'rep' + (open ? ' open' : '')), ...subs];
}
function render() {
  RSEQ++;
  if (typeof lazyIO !== 'undefined' && lazyIO) lazyIO.disconnect();
  const rail = $('#rail');
  const grp = g => TOPICS.filter(t => t.group === g);
  rail.replaceChildren(...[
    railButton(TOPICS[0]),
    grp('research').length ? h('div', { class: 'rgroup' }, 'Research reports') : null, ...grp('research').flatMap(railReport),
    h('div', { class: 'rgroup' }, 'Outlook Study 2025'), ...grp('outlook').map(railButton),
    h('div', { class: 'rgroup' }, 'Economy'), ...grp('economy').map(railButton),
    h('a', { class: 'raillink', href: 'https://outlook.aiacanada.com/ontario/' }, h('span', {}, 'Ontario vehicles'), h('span', { class: 'count' }, 'Open data')),
    h('div', { class: 'sep' }), h('div', { class: 'small' }, `${REPORTS.length ? `${REPORTS.length} research report${REPORTS.length === 1 ? '' : 's'}, the` : 'The'} 2025 Outlook Study and ${(ECON && ECON.datasets || []).length} economic indicators.`)].filter(Boolean));
  renderProfile();
  const main = $('#main');
  for (const c of main.querySelectorAll('canvas')) { const ch = CHARTS.get(c); if (ch) { ch.destroy(); CHARTS.delete(c); } }
  main.replaceChildren();
  const q = $('#q').value.trim();
  if (q) return renderSearch(main, q);
  if (current === 'access') return IS_ADMIN ? renderAccess(main) : renderHome(main);
  if (current === 'reports') return IS_ADMIN ? renderReportsAdmin(main) : renderHome(main);
  const t = TOPICS.find(x => x.id === current);
  if (!t || current === 'home') { current = 'home'; return renderHome(main); }
  if (current === 'macro') return renderEconomy(main);
  if (t.section) return renderReportSection(main, t);
  if (t.report) return renderReport(main, t);
  main.append(h('div', { class: 'banner', role: 'note' }, h('span', {}, h('b', {}, 'Member resource. '), 'Contains licensed S&P Global Mobility and IMR Inc. data. Do not redistribute outside AIA Canada membership. Figures are unaudited estimates; see the disclaimer at the bottom of the page.')));
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Outlook Study 2025'), h('h1', {}, t.name), h('p', {}, t.blurb)));
  for (const ds of DS.filter(d => d.topic === current)) main.append(card(ds));
  main.append(pageFoot());
}
function lastVal(a) { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return [a[i], i]; return [null, -1]; }
function renderHome(main) {
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'AIA Canada Research Hub'),
    h('h1', {}, 'Research on Canada’s auto care sector, in one place'),
    h('p', {}, 'AIA Canada’s research reports, the 2025 Outlook Study and the latest economic data, as interactive charts. Compare findings, copy the data, or ask a question in plain language.')));
  const tile = (v, l, s, target) => h('button', { type: 'button', class: 'kpi', onclick: () => jump(target) }, h('span', { class: 'v' }, v), h('span', { class: 'l' }, l), h('span', { class: 's' }, s));
  const tiles = [];
  const sumAt = (d, i) => d.series.filter(x => !/^total$/i.test(x.name)).reduce((t, x) => t + (x.vals[i] || 0), 0);
  try { const v = BYID['vio-national'], vn = v.cats.length - 1; tiles.push(tile(fmt(sumAt(v, vn), 'vehicles'), 'Vehicles in operation', `Dec. ${v.cats[vn]} · Outlook Study`, 'vio-national')); } catch {}
  try { const s = BYID['ev-share'], [a, ai] = lastVal(s.series[0].vals); tiles.push(tile(fmt(a, '%'), 'EV share of new vehicles', `${s.cats[ai]} · Outlook Study`, 'ev-share')); } catch {}
  try { const g = BYID['gdp-trend'], n = g.cats.length - 1; tiles.push(tile(fmt(sumAt(g, n), '$B'), 'Auto care sector GDP', `${g.cats[n]} · Outlook Study`, 'gdp-trend')); } catch {}
  try { const c = BYID['econ-cpi-repair'], [r, ri] = lastVal(c.series[1].vals), [all] = lastVal(c.series[0].vals); tiles.push(tile((r >= 0 ? '+' : '') + fmt(r, '%'), 'Repair and parts prices, past year', `${c.cats[ri]} · all items ${(all >= 0 ? '+' : '') + fmt(all, '%')}`, 'econ-cpi-repair')); } catch {}
  try { const j = BYID['econ-repair-jobs'], [n, ni] = lastVal(j.series[0].vals); tiles.push(tile(Math.round(n).toLocaleString('en-CA'), 'Jobs in automotive repair', `${j.cats[ni]} · Statistics Canada`, 'econ-repair-jobs')); } catch {}
  try { const p = BYID['econ-policy-rate'], [v, vi] = lastVal(p.series[0].vals); tiles.push(tile(fmt(v, p.unit), 'Bank of Canada policy rate', `${p.cats[vi]}`, 'econ-policy-rate')); } catch {}
  if (tiles.length) main.append(h('div', { class: 'kpis' }, tiles));
  if (REPORTS.length) {
    main.append(h('h2', { class: 'sec-h' }, 'Latest research'));
    main.append(h('div', { class: 'topics' }, REPORTS.map(r => h('button', { type: 'button', class: 'tcard', onclick: () => go('r:' + r.slug) },
      h('span', { class: 'ref' }, [r.series, fmtDate(r.published_on)].filter(Boolean).join(' · ')), h('b', {}, r.title),
      h('span', {}, (r.summary || '').length > 180 ? r.summary.slice(0, 177) + '…' : r.summary)))));
  }
  if (SAMPLE) {
    main.append(h('section', { class: 'panel' }, h('h2', {}, 'Ask a question'),
      h('p', { style: 'margin:0;color:var(--ink-2);font-size:14px' }, 'Answers draw on every report, the Outlook Study and the economic data, and name the figure behind each number.'),
      h('div', { class: 'chips' }, QUESTIONS.map(qq => h('button', { type: 'button', class: 'qchip', onclick: () => openDrawer({ ask: qq }) }, qq)))));
  }
  main.append(h('h2', { class: 'sec-h' }, 'Outlook Study 2025 and the economy'));
  main.append(h('div', { class: 'topics' }, [...TOPICS.filter(t => t.group === 'outlook'), TOPICS.find(t => t.id === 'macro')].map(t =>
    h('button', { type: 'button', class: 'tcard', onclick: () => go(t.id) }, h('span', { class: 'ref' }, t.group === 'economy' ? 'Economy' : 'Outlook Study 2025'), h('b', {}, t.name), h('span', {}, t.blurb)))));
  main.append(pageFoot());
}
function renderReport(main, t) {
  const r = t.report;
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, [r.series || 'AIA Canada research', fmtDate(r.published_on)].filter(Boolean).join(' · ')),
    h('h1', {}, r.title), r.summary ? h('p', {}, r.summary) : null));
  const acts = h('div', { class: 'chips' });
  if (r.source_url) acts.append(h('a', { class: 'btn-ask', href: r.source_url, target: '_blank', rel: 'noopener' }, 'Get the full report'));
  if (SAMPLE) acts.append(h('button', { type: 'button', class: 'qchip', onclick: () => openDrawer({ ask: `Summarize the main findings of "${r.title}" and connect them to the economic data where it helps.` }) }, 'Ask about this report'));
  if (acts.childElementCount) main.append(acts);
  const kf = Array.isArray(r.key_findings) ? r.key_findings.filter(Boolean) : [];
  if (kf.length) main.append(h('section', { class: 'panel' }, h('h2', {}, 'Key findings'), h('ul', { class: 'kf' }, kf.map(k => h('li', {}, k)))));
  const mine = DS.filter(d => d.topic === t.id || d.topic.startsWith(t.id + '~'));
  const secs = TOPICS.filter(x => x.parent === t.id);
  if (!mine.length) main.append(h('p', { class: 'empty' }, 'No charts have been published for this report yet.'));
  if (secs.length) {
    main.append(h('h2', { class: 'sec-h' }, 'Sections'));
    main.append(h('div', { class: 'topics secs' }, secs.map((x, i) => { const n = DS.filter(d => d.topic === x.id).length;
      return h('button', { type: 'button', class: 'tcard', onclick: () => go(x.id) }, h('span', { class: 'ref' }, `Section ${i + 1} \u00b7 ${n} chart${n === 1 ? '' : 's'}`), h('b', {}, x.name), x.blurb ? h('span', {}, x.blurb) : null); })));
  } else for (const ds of mine) main.append(card(ds));
  const tags = new Set(mine.flatMap(tagsOf));
  const econ = DS.filter(d => d.topic === 'macro').map(d => [d, tagsOf(d).filter(x => tags.has(x)).length]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
  if (econ.length) {
    main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Connected economic data'), h('p', {}, 'Statistics Canada and Bank of Canada figures on the same topics, to put the findings in context.')));
    for (const ds of econ) main.append(card(ds));
  }
  main.append(pageFoot());
}
function renderReportSection(main, t) {
  const r = t.report, secs = TOPICS.filter(x => x.parent === t.parent), i = secs.indexOf(t);
  main.append(h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('button', { type: 'button', class: 'linkbtn', onclick: () => go(t.parent) }, r.title), h('span', { 'aria-hidden': 'true' }, ' / '), h('span', {}, `Section ${i + 1} of ${secs.length}`)));
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, [r.series || 'AIA Canada research', fmtDate(r.published_on)].filter(Boolean).join(' \u00b7 ')),
    h('h1', {}, t.name), t.blurb ? h('p', {}, t.blurb) : null));
  for (const ds of DS.filter(d => d.topic === t.id)) main.append(card(ds));
  const prev = secs[i - 1], next = secs[i + 1];
  main.append(h('nav', { class: 'secnav', 'aria-label': 'Sections of this report' },
    prev ? h('button', { type: 'button', class: 'tcard', onclick: () => go(prev.id) }, h('span', { class: 'ref' }, '\u2190 Previous section'), h('b', {}, prev.name)) : h('button', { type: 'button', class: 'tcard', onclick: () => go(t.parent) }, h('span', { class: 'ref' }, '\u2190 Back to'), h('b', {}, 'Report overview')),
    next ? h('button', { type: 'button', class: 'tcard nx', onclick: () => go(next.id) }, h('span', { class: 'ref' }, 'Next section \u2192'), h('b', {}, next.name)) : h('button', { type: 'button', class: 'tcard nx', onclick: () => go(t.parent) }, h('span', { class: 'ref' }, 'Done \u2192'), h('b', {}, 'Report overview'))));
  main.append(pageFoot());
}
function renderEconomy(main) {
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Economy'), h('h1', {}, 'The economic backdrop for auto care'),
    h('p', {}, 'Official figures on the prices, sales, jobs and rates that shape demand for repair and parts. Each chart links to research findings on the same topic.')));
  const figs = DS.filter(d => d.topic === 'macro');
  if (!figs.length) main.append(h('p', { class: 'empty' }, 'The economic data is being prepared. Check back shortly.'));
  for (const ds of figs) main.append(card(ds));
  main.append(pageFoot());
}
function pageFoot() {
  const f = h('footer', { class: 'pagefoot' });
  const src = current === 'macro' ? 'macro' : current.startsWith('r:') ? 'report' : current === 'home' ? 'all' : 'outlook';
  if (src === 'outlook' || src === 'all') f.append(
    h('span', {}, 'Outlook Study: © 2024 AIA Canada. Data tool prepared with Ernst & Young LLP. Figures rely on unaudited data from proprietary and public sources and may be revised. AIA Canada and EY make no warranty as to accuracy or completeness.'),
    h('span', {}, 'S&P Global Mobility materials are the copyrighted property of S&P Global Mobility, represent its data and opinions as of original publication, and should not be used for financial or investment purposes. Replacement rates © IMR Inc. All rights reserved.'));
  if (src === 'report' || src === 'all') f.append(h('span', {}, 'Research reports: © AIA Canada. Charts are built from the figures in each published report; see the full report for methodology and sample details. Member resource: do not redistribute.'));
  if (src === 'macro' || src === 'all') f.append(h('span', {}, `Economic data: Statistics Canada (Statistics Canada Open Licence) and the Bank of Canada. Adapted by AIA Canada; this does not constitute an endorsement by Statistics Canada or the Bank of Canada.${ECON && ECON.built ? ' Last updated ' + ECON.built + '.' : ''}`));
  return f;
}
function relatedFor(ds) {
  const mine = new Set(tagsOf(ds)); if (!mine.size) return null;
  const s = sourceOf(ds);
  const hits = DS.filter(d => d !== ds && sourceOf(d) !== s && sourceOf(d) !== 'outlook').map(d => [d, tagsOf(d).filter(x => mine.has(x)).length]).filter(x => x[1] > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!hits.length) return null;
  const label = d => { if (sourceOf(d) === 'macro') return 'Economy'; const t = TOPICS.find(x => x.id === d.topic) || {}; return t.label || t.name || 'Research'; };
  return h('div', { class: 'related' }, h('span', { class: 'ref' }, sourceOf(ds) === 'macro' ? 'What our research says' : 'Related data'),
    hits.map(([d]) => h('button', { type: 'button', class: 'rel', onclick: () => { $('#q').value = ''; jump(d.id); } }, h('span', { class: 'ref' }, label(d)), d.title)));
}
function aiPack(ds) {
  return `You are helping me understand data from the AIA Canada Research Hub (source: ${ds.source}). Using only the data below, tell me in plain language: (1) the main takeaway, (2) the biggest change or difference, and (3) what it could mean for an auto care business. Quote numbers exactly and say if something cannot be answered from this data.\n\n${textFor(ds, st(ds).opt[(ds.cube || {}).dims?.[0]])}`;
}
function score(ds, q) {
  const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 1);
  const syn = { ev: 'electric bev phev ev', evs: 'electric bev phev ev', jobs: 'employment employees labour', workers: 'employment employees labour', cars: 'vehicles', trucks: 'light truck',
    shops: 'businesses enterprises repair independent', parts: 'replacement products imports parts', kms: 'kilometres vkt', driving: 'kilometres vkt trip', price: 'cpi inflation prices repair-prices',
    prices: 'cpi inflation repair-prices', inflation: 'cpi inflation', wages: 'earnings', pay: 'earnings', rates: 'interest rate', interest: 'rate', dealership: 'dealer dealership', dealers: 'dealer dealership',
    trust: 'trust', province: 'provincial region', service: 'service-choice maintenance repair', maintenance: 'maintenance service' };
  const topic = (t => t.label || t.name || '')(TOPICS.find(t => t.id === ds.topic) || {});
  const hay = (ds.title + ' ' + (ds.ref || '') + ' ' + (ds.note || '') + ' ' + topic + ' ' + tagsOf(ds).join(' ') + ' ' + (ds.cats || []).join(' ') + ' ' + (ds.series || []).map(s => s.name).join(' ') + (ds.kind === 'table' ? ds.rows.map(r => r[0]).join(' ') : '') + (ds.kind === 'rank' ? Object.values(ds.rank).flat().map(r => r[0]).join(' ') : '') + (ds.cube ? ds.cube.cats.join(' ') + ' ' + ds.cube.series.join(' ') : '')).toLowerCase();
  let sc = 0;
  for (const w of words) {
    const alts = [w, ...(syn[w] || '').split(' ').filter(Boolean)];
    for (const a of alts) { if (ds.title.toLowerCase().includes(a)) sc += 3; else if (hay.includes(a)) sc += 1; }
  }
  return sc;
}
function catalogue() { return DS.map(d => `${d.id}: ${d.title} [${(t => t.label || t.name)(TOPICS.find(t => t.id === d.topic) || { name: d.topic })}${d.ref ? ', ' + d.ref : ''}]`).join('\n'); }

/* ---------- admin: research report manager ---------- */
let ADM = { view: 'list', id: null }, RSEQ = 0;
function go(id) { if (id === 'reports') ADM = { view: 'list', id: null }; current = id; $('#q').value = ''; render(); window.scrollTo({ top: 0 }); store.set('aia-topic', id); }
async function hubExtract(body) {
  const { data: { session } } = await SB.auth.getSession();
  const r = await fetch(`${CFG.supabaseUrl}/functions/v1/hub-extract`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session ? session.access_token : ''}` }, body: JSON.stringify(body) });
  const txt = (await r.text()).trim();
  try { return JSON.parse(txt); } catch { return { error: r.ok ? 'Unexpected reply from the reader' : `The reader returned ${r.status}` }; }
}
const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\.pdf$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
const STATUS = { draft: 'Draft', processing: 'Reading', review: 'Ready to review', published: 'Published', archived: 'Unpublished' };

function renderReportsAdmin(main) {
  if (ADM.view === 'review' && ADM.id) return renderReview(main, ADM.id);
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Admin'), h('h1', {}, 'Research reports'),
    h('p', {}, 'Upload a research report as a PDF. Claude reads every chart and table and turns them into interactive charts, saved as a draft. Check them, then publish to make the report a section of the hub for members.')));
  const file = h('input', { type: 'file', id: 'hubFile', accept: 'application/pdf' });
  const url = h('input', { type: 'url', id: 'hubUrl', class: 'tsearch', placeholder: 'Or paste a link to the PDF (https://…)' });
  const title = h('input', { id: 'hubTitle', class: 'tsearch', placeholder: 'Title (optional: read from the report)' });
  const series = h('input', { id: 'hubSeries', class: 'tsearch', placeholder: 'Series, e.g. Consumer Behaviour Series (optional)' });
  const date = h('input', { id: 'hubDate', type: 'date', class: 'tsearch', 'aria-label': 'Publication date (optional)' });
  const link = h('input', { id: 'hubLink', type: 'url', class: 'tsearch', placeholder: 'Link to the report in the AIA Canada store (optional)' });
  const prog = h('div', { class: 'prog', role: 'status', 'aria-live': 'polite' });
  const go1 = h('button', { type: 'button', class: 'btn-ask', id: 'hubGo', onclick: async () => {
    const f = file.files[0], u = url.value.trim();
    if (!f && !u) { prog.replaceChildren(h('p', { class: 'gate-err' }, 'Choose a PDF file or paste a link to one.')); return; }
    if (f && f.type && f.type !== 'application/pdf') { prog.replaceChildren(h('p', { class: 'gate-err' }, 'That file is not a PDF.')); return; }
    go1.disabled = true;
    try {
      const base = slugify(title.value || (f ? f.name : u.split('/').pop()));
      const row = { slug: `${base}-${Math.random().toString(36).slice(2, 6)}`, title: title.value.trim(), series: series.value.trim(), source_url: link.value.trim(), status: 'processing' };
      if (date.value) row.published_on = date.value;
      const { data: rep, error } = await SB.from('hub_reports').insert(row).select('id').single();
      if (error) throw new Error(error.message);
      progress(prog, 'Uploading the report…', 0);
      if (f) {
        const path = `${rep.id}.pdf`;
        const up = await SB.storage.from('hub-reports').upload(path, f, { contentType: 'application/pdf', upsert: true });
        if (up.error) throw new Error(up.error.message);
        await SB.from('hub_reports').update({ file_path: path, file_name: f.name }).eq('id', rep.id);
      } else {
        const r = await hubExtract({ report_id: rep.id, action: 'import_url', url: u });
        if (r.error) throw new Error(r.error);
      }
      await readReport(rep.id, true, prog);
    } catch (e) { prog.replaceChildren(h('p', { class: 'gate-err' }, 'Could not upload: ' + (e.message || e))); }
    go1.disabled = false;
  } }, 'Upload and read');
  main.append(h('section', { class: 'panel' }, h('h2', {}, 'Add a report'),
    h('div', { class: 'formgrid' }, h('label', { class: 'fl' }, h('span', {}, 'Report PDF'), file), h('label', { class: 'fl' }, h('span', {}, 'Or a link'), url),
      h('label', { class: 'fl' }, h('span', {}, 'Title'), title), h('label', { class: 'fl' }, h('span', {}, 'Series'), series),
      h('label', { class: 'fl' }, h('span', {}, 'Publication date'), date), h('label', { class: 'fl' }, h('span', {}, 'Store link'), link)),
    h('p', { class: 'gate-muted' }, 'Reading runs on the server and takes a few minutes for a long report. You can close this page or lock your phone; come back to Research reports to see progress. The PDF stays private: members only ever see the charts.'),
    h('div', {}, go1), prog));
  const box = h('section', { class: 'panel' }, h('h2', {}, 'All reports'), h('p', { class: 'gate-muted' }, 'Loading…'));
  main.append(box);
  listReports(box);
}
function progress(el, msg, frac, extra) {
  el.replaceChildren(h('div', { class: 'bar-out' }, h('div', { class: 'bar-in', style: `width:${Math.round((frac || 0) * 100)}%` })), h('p', { class: 'gate-muted' }, msg), extra || '');
}
async function readReport(id, fresh, prog) {
  progress(prog, fresh ? 'Counting pages\u2026' : 'Starting\u2026', 0);
  const s = await hubExtract({ report_id: id, action: 'run', fresh: !!fresh });
  if (s.error) throw new Error(s.error);
  watchReport(id, prog);
}
// Reading runs on the server. This only shows progress, so the page can be closed or the phone locked.
function watchReport(id, prog) {
  let lastDone = -1, since = Date.now();
  const again = (label) => h('button', { type: 'button', class: 'act', onclick: () => readReport(id, false, prog).catch(e => progress(prog, 'Could not restart: ' + e.message, 0)) }, label);
  const tick = async () => {
    if (!prog.isConnected) return;
    try {
      const [{ data: r }, { count }] = await Promise.all([
        SB.from('hub_reports').select('status,chunks_done,chunks_total,error').eq('id', id).single(),
        SB.from('hub_figures').select('id', { count: 'exact', head: true }).eq('report_id', id)]);
      if (!r) return;
      const frac = r.chunks_total ? r.chunks_done / r.chunks_total : 0;
      if (r.chunks_total && r.chunks_done >= r.chunks_total) {
        progress(prog, `Done: ${count || 0} chart${count === 1 ? '' : 's'} found. Opening the review\u2026`, 1);
        setTimeout(() => { if (prog.isConnected) { ADM = { view: 'review', id }; render(); window.scrollTo({ top: 0 }); } }, 900);
        return;
      }
      if (r.error && r.error.startsWith('Stopped')) { progress(prog, r.error, frac, again('Try again from here')); return; }
      if (r.chunks_done !== lastDone) { lastDone = r.chunks_done; since = Date.now(); }
      if (Date.now() - since > 6 * 60 * 1000) { progress(prog, `No progress for a few minutes (part ${r.chunks_done + 1} of ${r.chunks_total}).`, frac, again('Restart from here')); return; }
      progress(prog, `Reading part ${r.chunks_done + 1} of ${r.chunks_total}\u2026 ${count || 0} chart${count === 1 ? '' : 's'} found so far. You can leave this page; reading carries on.`, frac);
    } catch { /* network blip: keep watching */ }
    setTimeout(tick, 4000);
  };
  tick();
}
async function listReports(box) {
  const [{ data: reps, error }, { data: figs }] = await Promise.all([
    SB.from('hub_reports').select('id,slug,title,file_name,series,published_on,status,chunks_done,chunks_total,error,updated_at').order('created_at', { ascending: false }),
    SB.from('hub_figures').select('report_id,hidden,confidence').limit(10000)]);
  if (error) { box.replaceChildren(h('h2', {}, 'All reports'), h('p', {}, 'Could not load the reports.')); return; }
  const count = {}; for (const f of figs || []) { const c = count[f.report_id] ||= { n: 0, check: 0, hidden: 0 }; c.n++; if (f.hidden) c.hidden++; else if (f.confidence !== 'high') c.check++; }
  if (!reps.length) { box.replaceChildren(h('h2', {}, 'All reports'), h('p', { class: 'gate-muted' }, 'No reports yet. Add one above.')); return; }
  const rows = reps.map(r => {
    const c = count[r.id] || { n: 0, check: 0, hidden: 0 };
    const acts = h('div', { class: 'chips' });
    acts.append(h('button', { type: 'button', class: 'act', onclick: () => { ADM = { view: 'review', id: r.id }; render(); window.scrollTo({ top: 0 }); } }, r.status === 'published' ? 'Edit' : 'Review'));
    let live = null;
    if (r.status === 'processing' && r.chunks_done < r.chunks_total) {
      live = h('div', { class: 'prog' });
      const stale = Date.now() - new Date(r.updated_at).getTime() > 6 * 60 * 1000;
      if ((r.error && r.error.startsWith('Stopped')) || stale)
        acts.append(h('button', { type: 'button', class: 'act', onclick: () => readReport(r.id, false, live).catch(e => progress(live, 'Could not restart: ' + e.message, 0)) }, 'Continue reading'));
      else watchReport(r.id, live);
    }
    const del = h('button', { type: 'button', class: 'act', onclick: async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Confirm delete'; return; }
      del.disabled = true;
      await SB.storage.from('hub-reports').remove([`${r.id}.pdf`]);
      const { error: e } = await SB.from('hub_reports').delete().eq('id', r.id);
      if (e) { toast('Could not delete: ' + e.message); del.disabled = false; return; }
      await refreshHub(); listReports(box);
    } }, 'Delete');
    acts.append(del);
    return h('tr', {}, h('th', { scope: 'row' }, r.title || r.file_name || '(untitled)', r.error && r.status !== 'processing' ? h('div', { class: 'gate-err', style: 'font-size:12px;font-weight:500' }, r.error) : null, live),
      h('td', {}, h('span', { class: 'badge b-' + r.status }, STATUS[r.status] || r.status), r.status === 'processing' ? ` ${r.chunks_done}/${r.chunks_total}` : ''),
      h('td', {}, `${c.n - c.hidden}`, c.check ? h('span', { class: 'gate-muted' }, ` (${c.check} to check)`) : ''),
      h('td', {}, new Date(r.updated_at).toLocaleDateString('en-CA')), h('td', {}, acts));
  });
  box.replaceChildren(h('h2', {}, 'All reports'), h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Report', 'Status', 'Charts', 'Updated', ''].map(c => h('th', { scope: 'col' }, c)))), h('tbody', {}, rows))));
}
async function refreshHub() { await loadHub(); }

async function renderReview(main, id) {
  const my = RSEQ;
  const [{ data: r }, { data: figs }] = await Promise.all([SB.from('hub_reports').select('*').eq('id', id).single(), SB.from('hub_figures').select('*').eq('report_id', id).order('sort')]);
  if (my !== RSEQ) return;
  if (!r) { ADM = { view: 'list', id: null }; return render(); }
  main.append(h('div', {}, h('button', { type: 'button', class: 'act', onclick: () => { ADM = { view: 'list', id: null }; render(); } }, '← All reports')));
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Review · ' + (STATUS[r.status] || r.status)), h('h1', {}, r.title || r.file_name || 'Untitled report'),
    h('p', {}, 'Check each chart against the page shown. Edit anything that is off, hide charts members don’t need, then publish.')));
  // details
  const f = { title: h('input', { class: 'tsearch', value: r.title }), series: h('input', { class: 'tsearch', value: r.series }), date: h('input', { type: 'date', class: 'tsearch', value: r.published_on || '' }),
    link: h('input', { type: 'url', class: 'tsearch', value: r.source_url }), summary: h('textarea', { class: 'bulk', rows: '3' }, r.summary), kf: h('textarea', { class: 'bulk', rows: '5' }, (r.key_findings || []).join('\n')) };
  const msg = h('p', { class: 'gate-muted', role: 'status' });
  const save = h('button', { type: 'button', class: 'act', onclick: async () => {
    const upd = { title: f.title.value.trim(), series: f.series.value.trim(), published_on: f.date.value || null, source_url: f.link.value.trim(), summary: f.summary.value.trim(), key_findings: f.kf.value.split('\n').map(s => s.trim()).filter(Boolean) };
    const { error } = await SB.from('hub_reports').update(upd).eq('id', id);
    msg.textContent = error ? 'Could not save: ' + error.message : 'Saved.';
    if (!error && r.status === 'published') await refreshHub();
  } }, 'Save details');
  main.append(h('section', { class: 'panel' }, h('h2', {}, 'Report details'),
    h('div', { class: 'formgrid' }, h('label', { class: 'fl' }, h('span', {}, 'Title'), f.title), h('label', { class: 'fl' }, h('span', {}, 'Series'), f.series),
      h('label', { class: 'fl' }, h('span', {}, 'Publication date'), f.date), h('label', { class: 'fl' }, h('span', {}, 'Store link'), f.link)),
    h('label', { class: 'fl' }, h('span', {}, 'Summary'), f.summary), h('label', { class: 'fl' }, h('span', {}, 'Key findings (one per line)'), f.kf),
    h('div', { class: 'chips' }, save), msg));
  // publish
  const pending = (figs || []).filter(x => !x.hidden && x.confidence !== 'high').length;
  const pub = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
    if (r.status !== 'published' && pending && pub.dataset.armed !== '1') { pub.dataset.armed = '1'; pub.textContent = `Publish anyway (${pending} not checked)`; return; }
    if (r.status !== 'published' && !(r.title || f.title.value.trim())) { toast('Give the report a title first.'); return; }
    const { error } = await SB.from('hub_reports').update({ status: r.status === 'published' ? 'archived' : 'published' }).eq('id', id);
    if (error) { toast('Could not change: ' + error.message); return; }
    await refreshHub(); toast(r.status === 'published' ? 'Unpublished. Members no longer see this report.' : 'Published. Members can see it now.'); render();
  } }, r.status === 'published' ? 'Unpublish' : 'Publish to members');
  const reread = h('button', { type: 'button', class: 'act', onclick: async () => {
    if (reread.dataset.armed !== '1') { reread.dataset.armed = '1'; reread.textContent = 'Confirm: replace all charts'; return; }
    const prog = h('div', { class: 'prog' }); reread.after(prog);
    readReport(id, true, prog).catch(e => progress(prog, 'Stopped: ' + e.message, 0));
  } }, 'Read the PDF again');
  main.append(h('section', { class: 'panel' }, h('h2', {}, 'Publish'),
    h('p', { style: 'margin:0' }, r.status === 'published' ? 'This report is live for members. Unpublish to take it down; your edits are kept.' :
      pending ? `${pending} chart${pending === 1 ? ' has' : 's have'} values read from the chart rather than printed numbers. Check ${pending === 1 ? 'it' : 'them'} against the page (Edit, then Save, or Looks right).` : 'All charts are checked.'),
    h('div', { class: 'chips' }, pub, reread)));
  // sections
  const secs = (Array.isArray(r.sections) ? r.sections : []).map(x => ({ ...x }));
  const secMsg = h('p', { class: 'gate-muted', role: 'status' });
  const secRows = h('div', { class: 'secrows' });
  const drawSecRows = () => secRows.replaceChildren(...secs.map((x, i) => h('div', { class: 'secrow' },
    h('span', { class: 'ref' }, `Section ${i + 1} \u00b7 ${(figs || []).filter(f => f.payload.section === x.key).length} charts`),
    h('input', { class: 'tsearch wide', value: x.name, 'aria-label': `Section ${i + 1} name`, oninput: e => { x.name = e.target.value; } }),
    h('input', { class: 'tsearch wide', value: x.blurb || '', placeholder: 'One line on what this section covers', 'aria-label': `Section ${i + 1} description`, oninput: e => { x.blurb = e.target.value; } }))));
  drawSecRows();
  const sortBtn = h('button', { type: 'button', class: 'act', onclick: async () => {
    if (secs.length && sortBtn.dataset.armed !== '1') { sortBtn.dataset.armed = '1'; sortBtn.textContent = 'Confirm: re-sort all charts'; return; }
    sortBtn.disabled = true; secMsg.textContent = 'Sorting the charts into sections\u2026 (about a minute; you can leave this page)';
    const before = r.updated_at;
    const res = await hubExtract({ report_id: id, action: 'organize' });
    if (res.error) { secMsg.textContent = 'Could not start: ' + res.error; sortBtn.disabled = false; return; }
    for (let k = 0; k < 60; k++) {
      await new Promise(ok => setTimeout(ok, 4000));
      if (!secMsg.isConnected) return;
      const { data } = await SB.from('hub_reports').select('updated_at,error').eq('id', id).single();
      if (data && data.updated_at !== before) { if (data.error && data.error.startsWith('Could not sort')) { secMsg.textContent = data.error; sortBtn.disabled = false; return; }
        if (r.status === 'published') await refreshHub(); toast('Sorted into sections.'); render(); return; }
    }
    secMsg.textContent = 'Still sorting. Come back to this page in a minute.';
  } }, secs.length ? 'Sort into sections again' : 'Sort into sections');
  const saveSecs = h('button', { type: 'button', class: 'act', onclick: async () => {
    const clean = secs.map(x => ({ key: x.key, name: (x.name || '').trim() || 'Untitled section', blurb: (x.blurb || '').trim() }));
    const { error } = await SB.from('hub_reports').update({ sections: clean }).eq('id', id);
    secMsg.textContent = error ? 'Could not save: ' + error.message : 'Section names saved.';
    if (!error) { r.sections = clean; if (r.status === 'published') await refreshHub(); }
  } }, 'Save section names');
  main.append(h('section', { class: 'panel' }, h('h2', {}, 'Sections'),
    h('p', { style: 'margin:0;color:var(--ink-2)' }, secs.length ? 'Members browse the report one section at a time. Rename sections here; to move a chart, use Edit on the chart.' : 'This report is not split into sections yet. Members will see all charts on one page.'),
    secRows, h('div', { class: 'chips' }, secs.length ? saveSecs : null, sortBtn), secMsg));
  // figures, grouped by section
  main.append(h('h2', { class: 'sec-h' }, `Charts (${(figs || []).length})`));
  if (!(figs || []).length) main.append(h('p', { class: 'empty' }, 'No charts were found. If the report has charts, try Read the PDF again.'));
  const keys = new Set(secs.map(x => x.key));
  for (const x of secs) {
    const mine = (figs || []).filter(f => f.payload.section === x.key);
    if (mine.length) main.append(h('h3', { class: 'adm-sec' }, x.name));
    for (const fg of mine) main.append(adminFigure(fg, r));
  }
  const loose = (figs || []).filter(f => !keys.has(f.payload.section));
  if (loose.length && secs.length) main.append(h('h3', { class: 'adm-sec' }, 'Not in a section'));
  for (const fg of loose) main.append(adminFigure(fg, r));
}
function adminFigure(fg, rep) {
  const wrap = h('div', { class: 'admfig' + (fg.hidden ? ' is-hidden' : '') });
  const ds = { ...fg.payload, topic: 'r:' + rep.slug, source: `AIA Canada, ${rep.title || 'research report'}` };
  const set = async (upd, okMsg) => { const { error } = await SB.from('hub_figures').update(upd).eq('id', fg.id); if (error) { toast('Could not save: ' + error.message); return false; } Object.assign(fg, upd); if (okMsg) toast(okMsg); if (rep.status === 'published') await refreshHub(); return true; };
  const draw = () => {
    for (const c of wrap.querySelectorAll('canvas')) { const ch = CHARTS.get(c); if (ch) { ch.destroy(); CHARTS.delete(c); } }
    wrap.className = 'admfig' + (fg.hidden ? ' is-hidden' : '');
    const bar = h('div', { class: 'admbar' }, h('span', { class: 'ref' }, fg.page ? `Page ${fg.page}` : 'Page ?'),
      fg.confidence === 'high' ? h('span', { class: 'badge b-published' }, 'Checked') : h('span', { class: 'badge b-review' }, fg.confidence === 'low' ? 'Estimated values: check' : 'Some values read from the chart: check'),
      fg.hidden ? h('span', { class: 'badge b-archived' }, 'Hidden from members') : null,
      (rep.sections || []).length ? h('span', { class: 'badge' }, ((rep.sections || []).find(x => x.key === fg.payload.section) || { name: 'No section' }).name) : null,
      h('span', { style: 'flex:1' }),
      fg.confidence !== 'high' ? h('button', { type: 'button', class: 'act', onclick: async () => { if (await set({ confidence: 'high' }, 'Marked as checked.')) draw(); } }, 'Looks right') : null,
      h('button', { type: 'button', class: 'act', onclick: () => edit() }, 'Edit'),
      h('button', { type: 'button', class: 'act', onclick: async () => { if (await set({ hidden: !fg.hidden })) draw(); } }, fg.hidden ? 'Show' : 'Hide'),
      (() => { const b = h('button', { type: 'button', class: 'act', onclick: async () => {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirm delete'; return; }
        const { error } = await SB.from('hub_figures').delete().eq('id', fg.id); if (error) { toast('Could not delete'); return; }
        wrap.remove(); if (rep.status === 'published') refreshHub();
      } }, 'Delete'); return b; })());
    delete UI[ds.id];
    wrap.replaceChildren(bar, card(ds));
  };
  const edit = () => {
    const p = fg.payload, isPct = p.unit === '%';
    const chartVal = p.chart === 'stacked' ? (p.orient === 'h' ? 'hstacked' : 'stacked') : p.chart === 'line' ? 'line' : (p.orient === 'h' ? 'hbar' : 'bar');
    const title = h('input', { class: 'tsearch wide', value: p.title });
    const tmp = document.createElement('div'); tmp.innerHTML = p.insight || '';
    const insight = h('textarea', { class: 'bulk', rows: '2', placeholder: 'One sentence takeaway (leave empty for an automatic one)' }, tmp.textContent);
    const chart = h('select', { class: 'sel' }, [['bar', 'Bars'], ['hbar', 'Horizontal bars'], ['stacked', 'Stacked bars'], ['hstacked', 'Horizontal stacked (100%)'], ['line', 'Line']].map(([v, t]) => h('option', { value: v, selected: v === chartVal }, t)));
    const units = [['%', 'Per cent'], ['$', 'Dollars'], ['$M', 'Millions of dollars'], ['$B', 'Billions of dollars'], ['', 'Count'], ['index', 'Index or rating']];
    const custom = !units.some(u => u[0] === p.unit);
    const unit = h('select', { class: 'sel' }, [...units, ...(custom ? [[p.unit, p.unit]] : [])].map(([v, t]) => h('option', { value: v, selected: v === p.unit }, t)));
    const fmtCell = v => v == null ? '' : isPct ? +(v * 100).toFixed(2) : v;
    const csv = [['', ...p.series.map(s => s.name)], ...p.cats.map((c, i) => [c, ...p.series.map(s => fmtCell(s.vals[i]))])].map(r => r.map(x => /[,"]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n');
    const data = h('textarea', { class: 'bulk mono', rows: String(Math.min(16, p.cats.length + 2)) }, csv);
    const note = h('textarea', { class: 'bulk', rows: '2' }, p.note || '');
    const secSel = h('select', { class: 'sel' }, (rep.sections || []).map(x => h('option', { value: x.key, selected: x.key === p.section }, x.name)));
    const err = h('p', { class: 'gate-err', role: 'alert' });
    const saveBtn = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
      const rows = parseCsv(data.value).filter(r => r.some(c => c !== ''));
      if (rows.length < 2 || rows[0].length < 2) { err.textContent = 'The data needs a header row (series names) and at least one row of values.'; return; }
      const names = rows[0].slice(1).map((n, i) => n || `Series ${i + 1}`);
      const pctNow = unit.value === '%';
      const num = s => { const t = String(s).replace(/[$,%\s]/g, ''); if (t === '' || t === '-') return null; const v = Number(t); return isFinite(v) ? (pctNow ? +(v / 100).toFixed(6) : v) : NaN; };
      const cats = rows.slice(1).map(r => r[0]);
      const series = names.map((n, j) => ({ name: n, vals: rows.slice(1).map(r => num(r[j + 1] ?? '')) }));
      if (series.some(s => s.vals.some(v => Number.isNaN(v)))) { err.textContent = 'Some values are not numbers. Use plain numbers like 45 or 1240.'; return; }
      const cv = chart.value;
      const np = { ...p, title: title.value.trim() || p.title, unit: unit.value, cats, series, note: note.value.trim(), ...((rep.sections || []).length ? { section: secSel.value } : {}),
        chart: cv === 'line' ? 'line' : cv.includes('stacked') ? 'stacked' : 'bar' };
      if (cv === 'hbar' || cv === 'hstacked') np.orient = 'h'; else delete np.orient;
      const ins = insight.value.trim(); if (ins) np.insight = esc(ins); else delete np.insight;
      if (await set({ payload: np, confidence: 'high' }, 'Saved.')) { Object.assign(ds, np); draw(); }
    } }, 'Save');
    wrap.replaceChildren(h('div', { class: 'panel editor' }, h('h2', {}, 'Edit chart' + (fg.page ? ` (page ${fg.page})` : '')),
      h('label', { class: 'fl' }, h('span', {}, 'Title'), title), h('label', { class: 'fl' }, h('span', {}, 'Takeaway'), insight),
      h('div', { class: 'chips' }, h('label', { class: 'fl' }, h('span', {}, 'Chart type'), chart), h('label', { class: 'fl' }, h('span', {}, 'Unit'), unit),
        (rep.sections || []).length ? h('label', { class: 'fl' }, h('span', {}, 'Section'), secSel) : null),
      h('label', { class: 'fl' }, h('span', {}, 'Data (first row: series names; first column: categories)' + (isPct ? '. Per cent values as numbers, e.g. 45 for 45%.' : '')), data),
      h('label', { class: 'fl' }, h('span', {}, 'Notes (question, base, footnotes)'), note), err,
      h('div', { class: 'chips' }, saveBtn, h('button', { type: 'button', class: 'act', onclick: draw }, 'Cancel'))));
  };
  draw();
  return wrap;
}
function parseCsv(txt) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',' || c === '\t') { row.push(cell.trim()); cell = ''; }
    else if (c === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  row.push(cell.trim()); rows.push(row);
  return rows;
}

/* Survey answer scales (agree / neutral / disagree, likely / unlikely...) get meaning-based colours: blue = positive, grey = neutral, red = negative. */
const NEG = /disagree|unlikely|not likely|dissatisf|negative|^no\b|poor|worse|less likely|not at all/i, NEU = /neutral|neither|unsure|not sure|don.?t know|no opinion|undecided|somewhat likely or|^other$/i,
  POS = /agree|likely|satisf|positive|^yes\b|good|better|more likely|excellent/i, STRONG = /strongly|very|completely|extremely|definitely/i;
function scaleColor(n) {
  if (NEG.test(n)) return STRONG.test(n) ? '#b3123a' : '--s2';
  if (NEU.test(n)) return '--muted-bar';
  if (POS.test(n)) return STRONG.test(n) ? '#104281' : /somewhat|slightly|fairly/i.test(n) ? '#86b6ef' : '--s1';
  return null;
}
function scaleOf(names) { return names.filter(n => NEG.test(n)).length >= 1 && names.filter(n => scaleColor(n)).length >= 2; }

/* ---------- responsive navigation: left rail on desktop, slide-in menu on tablet and phone ---------- */
const NAV_MQ = matchMedia('(max-width: 1099px)');
function openNav() {
  document.body.classList.add('nav-open'); $('#navScrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#q2').value = $('#q').value;
  setTimeout(() => { const cur = $('#rail [aria-current="true"]'); (cur || $('#navClose')).focus(); }, 60);
}
function closeNav(focusBtn) {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open'); $('#navScrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  if (focusBtn) $('#menuBtn').focus();
}
$('#menuBtn').addEventListener('click', () => document.body.classList.contains('nav-open') ? closeNav(true) : openNav());
$('#navClose').addEventListener('click', () => closeNav(true));
$('#navScrim').addEventListener('click', () => closeNav(true));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav(true); });
NAV_MQ.addEventListener('change', () => { if (!NAV_MQ.matches) closeNav(); });
let q2t;
$('#q2').addEventListener('input', () => { $('#q').value = $('#q2').value; clearTimeout(q2t); q2t = setTimeout(render, 250); });
$('#q2').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); closeNav(); render(); window.scrollTo({ top: 0 }); } });
$('#q').addEventListener('input', () => { $('#q2').value = $('#q').value; });

/* ---------- profile menu (header): email, admin tools for admins, sign out ---------- */
function renderProfile() {
  const email = $('#whoEmail').textContent || '';
  const name = email.split('@')[0].split(/[._-]+/).filter(Boolean);
  $('#avatar').textContent = ((name[0] || '?')[0] + (name[1] ? name[1][0] : '')).toUpperCase();
  $('#pmEmail').textContent = email;
  $('#pmRole').textContent = IS_ADMIN ? 'Admin' : 'Member';
  const adm = $('#pmAdmin');
  adm.replaceChildren(...(IS_ADMIN ? [h('div', { class: 'pm-label pm-sec' }, 'Admin'),
    ...TOPICS.filter(t => t.group === 'admin').map(t => h('button', { type: 'button', class: 'pm-item', role: 'menuitem', 'aria-current': String(current === t.id),
      onclick: () => { closeProfile(); closeNav(); go(t.id); } }, t.name))] : []));
}
function openProfile() { $('#profileMenu').hidden = false; $('#profileBtn').setAttribute('aria-expanded', 'true'); closeNav(); setTimeout(() => { const f = $('#profileMenu .pm-item'); if (f) f.focus(); }, 30); }
function closeProfile(focus) { if ($('#profileMenu').hidden) return; $('#profileMenu').hidden = true; $('#profileBtn').setAttribute('aria-expanded', 'false'); if (focus) $('#profileBtn').focus(); }
$('#profileBtn').addEventListener('click', e => { e.stopPropagation(); $('#profileMenu').hidden ? openProfile() : closeProfile(); });
document.addEventListener('click', e => { if (!$('#profileMenu').hidden && !e.target.closest('#who')) closeProfile(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#profileMenu').hidden) closeProfile(true); });
$('#signOut').addEventListener('click', () => closeProfile());

/* ---------- lazy charts: only charts near the screen exist; ones scrolled far away are freed ---------- */
const LAZY = new WeakMap();
const lazyIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    const el = e.target, fn = LAZY.get(el), cv = el.querySelector('canvas');
    if (!fn || !cv) { lazyIO.unobserve(el); continue; }
    if (!el.isConnected) { if (el.dataset.seen) lazyIO.unobserve(el); continue; } // not on the page yet, or removed
    el.dataset.seen = '1';
    const ch = CHARTS.get(cv);
    if (e.isIntersecting) { if (!ch) fn(); }
    else if (ch) { ch.destroy(); CHARTS.delete(cv); }
  }
}, { rootMargin: '800px 0px' }) : null;
function lazyChart(el, fn) {
  if (!lazyIO) return requestAnimationFrame(fn);
  LAZY.set(el, fn); lazyIO.observe(el);
}
