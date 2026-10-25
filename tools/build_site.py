import re
t=open('tools/page.template.html').read()
t=re.sub(r'^<title>.*?</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n','',t)
def rep(a,b):
    global t
    assert a in t, a[:60]
    t=t.replace(a,b,1)
rep("""const DATA = /*__DATA__*/null;
const DS = DATA.datasets;
const BYID = Object.fromEntries(DS.map(d => [d.id, d]));""","""const CFG = window.AIA_EXPLORER_CONFIG;
let DS = [];
let BYID = {};""")
rep("  const K = DATA.kpi;\n","")
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>',
 '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>')
rep("""    <button class="btn-ask" id="askTop" hidden>""","""    <div class="who" id="who" hidden><button type="button" class="pbtn" id="profileBtn" aria-haspopup="true" aria-expanded="false" aria-controls="profileMenu" aria-label="Your account"><span class="avatar" id="avatar" aria-hidden="true"></span><span class="pbtn-email" id="whoEmail"></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="pmenu" id="profileMenu" hidden><div class="pm-head"><span class="pm-label">Signed in as</span><b id="pmEmail"></b><span class="pm-role" id="pmRole"></span></div><div id="pmAdmin"></div><button type="button" class="pm-item" id="signOut">Sign out</button></div></div>
    <button class="btn-ask" id="askTop" hidden>""")
rep("""  { id: 'defs', name: 'Definitions', blurb: 'What counts as the auto care sector, and the vehicle types used in this study.' },""",
"""  { id: 'defs', name: 'Definitions', blurb: 'What counts as the auto care sector, and the vehicle types used in this study.' },
  { id: 'access', name: 'Manage access', blurb: '' },""")
rep("rail.replaceChildren(...TOPICS.map(","rail.replaceChildren(...TOPICS.filter(t => t.id !== 'access' || IS_ADMIN).map(")
rep("t.id !== 'home' && t.id !== 'defs' ?","t.id !== 'home' && t.id !== 'defs' && t.id !== 'access' ?")
rep("TOPICS.filter(t => t.id !== 'home').map(","TOPICS.filter(t => t.id !== 'home' && t.id !== 'access').map(")
rep("  if (current === 'home') return renderHome(main);","  if (current === 'home') return renderHome(main);\n  if (current === 'access') return IS_ADMIN ? renderAccess(main) : renderHome(main);")
rep("`${DS.length - 1} figures","`${Math.max(DS.length - 1, 0)} figures")
# ---- Research Hub ----
rep('<span class="eyebrow">AIA Canada · Outlook Study 2025</span>\n      <span class="name">Outlook Data Explorer</span>',
    '<span class="eyebrow">AIA Canada · Research and data</span>\n      <span class="name">Research Hub</span>')
rep('placeholder="Find a figure: EV share, technicians, F-150…"', 'placeholder="Search reports and data"')
rep("  el.append(h('div', { class: 'foot' }, src, acts));", "  const rel = relatedFor(ds); if (rel) el.append(rel);\n  el.append(h('div', { class: 'foot' }, src, acts));")
i0=t.index("const RULES = `"); j0=t.index("`;", i0)+2
t=t[:i0]+"""const RULES = `You are the data assistant inside the AIA Canada Research Hub, a tool for members of the Automotive Industries Association of Canada (AIA Canada). It holds three kinds of data:
- AIA Canada research reports (consumer surveys such as the Consumer Behaviour Series), with the report named in each figure's source.
- The AIA Canada Outlook Study 2025 (released January 2025, prepared with EY; mostly 2019 to 2023, with S&P Global Mobility forecasts to 2030).
- Economic indicators from Statistics Canada and the Bank of Canada (prices, vehicle registrations, jobs, wages, interest rates), updated twice a month.

Rules:
- Answer only from the figures you are given. Every number you state must come from that data. Never estimate or use outside knowledge for figures.
- After each fact, cite the figure in square brackets with its title or reference and its source type, for example [Outlook Ch. 1, Fig. 1], [Dealership vs. independent report, Figure 3] or [Economy: Vehicle repair and parts prices].
- Make connections across sources when they help: for example, a survey finding about price next to how repair prices have moved. Say clearly that a connection is context, not proof of cause.
- If the data cannot answer the question, say so in one sentence and name the closest figure that might help.
- Values with unit "per cent" are stored as fractions: 0.117 means 11.7 per cent.
- Write in plain Canadian English for busy business owners. Lead with the answer. Keep it short: two to five sentences, or up to five bullets. Use "per cent" in sentences. Do not use the abbreviations AIA or AIAC; write AIA Canada.
- Do not give investment advice.`;"""+t[j0:]
rep("<span class=\"fine\">Answers come only from the Outlook Study figures in this tool and cite them. Check important numbers in the figure before you quote them.</span>",
    "<span class=\"fine\">Answers come only from the reports, Outlook Study and economic data in the hub, and cite them. Check important numbers in the figure before you quote them.</span>")
rep("'Ask about vehicles, jobs, EVs, repair demand or prices. Answers use the Outlook Study figures in this tool and name the figure behind each number.'",
    "'Ask about repair prices, where people get service, EVs, jobs or the economy. Answers use the reports, the Outlook Study and the economic data, and name the figure behind each number.'")
rep('placeholder="Ask about vehicles, jobs, EVs, repair demand…"', 'placeholder="Ask about repair prices, EV owners, jobs…"')
rep("  series.forEach(x => { x.color = ramp ? ramp[all.indexOf(x.name)] : SLOTS[s.slot[x.name] ?? 0]; });",
    "  series.forEach(x => { x.color = ramp ? ramp[all.indexOf(x.name)] : SLOTS[s.slot[x.name] ?? 0]; });\n  if (scaleOf(all)) series.forEach(x => { x.color = scaleColor(x.name) || x.color; });")
rep("        const col = ramp ? ramp[seriesNames(ds).indexOf(n)] : (on ? SLOTS[s.slot[n]] : null);",
    "        const col = on && scaleOf(names) && scaleColor(n) ? scaleColor(n) : ramp ? ramp[seriesNames(ds).indexOf(n)] : (on ? SLOTS[s.slot[n]] : null);")
rep("    case '%': return (v * 100).toFixed(Math.abs(v) < 0.1 && !Number.isInteger(v * 1000) ? 1 : 1) + '%';",
    "    case '%': return (v * 100).toFixed(Math.abs(v) < 0.1 && !Number.isInteger(v * 1000) ? 1 : 1) + '%';\n    case 'rate %': return (v * 100).toFixed(2) + '%';")
rep("const unitLabel = u => ({ '$B': 'billions of dollars',", "const unitLabel = u => ({ 'rate %': 'per cent', '$B': 'billions of dollars',")
# ---- responsive navigation ----
rep('<div class="brand">', '<button class="menu-btn" id="menuBtn" type="button" aria-controls="navPanel" aria-expanded="false" aria-label="Open the menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span class="lbl">Menu</span></button>\n    <div class="brand">')
rep('<button class="btn-ask" id="askTop" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>Ask the data</button>',
    '<button class="btn-ask" id="askTop" hidden aria-label="Ask the data"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg><span class="lbl">Ask the data</span></button>')
rep('<nav class="rail" id="rail" aria-label="Topics"></nav>', '''<div class="navpanel" id="navPanel">
    <div class="nav-head"><b>Research Hub</b><button type="button" class="act" id="navClose">Close</button></div>
    <label class="nav-search" for="q2"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q2" type="search" placeholder="Search reports and data" autocomplete="off"></label>
    <nav class="rail" id="rail" aria-label="Sections"></nav>
  </div>
  <div class="scrim" id="navScrim" hidden></div>''')
for line in ["  .rail { position: static; flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; }\n",
             "  .rail button { white-space: nowrap; border-left: 0; border-bottom: 3px solid transparent; background: var(--surface); border: 1px solid var(--line); }\n",
             "  .rail button[aria-current=\"true\"] { border-bottom: 3px solid var(--accent); }\n",
             "  .rail .sep, .rail .small, .rail .count { display: none; }\n",
             "  .rail a.raillink { white-space: nowrap; border: 1px solid var(--line); background: var(--surface); }\n"]:
    rep(line, '')
# ---- lazy charts: draw only near the screen (iPhone Safari caps total canvas memory) ----
rep("    requestAnimationFrame(() => drawChart(cv.firstChild, ds, R));", "    lazyChart(cv, () => drawChart(cv.firstChild, ds, R));")
rep("      requestAnimationFrame(() => drawChart(cv.firstChild, { ...ds, chart: x.type === 'line' ? 'line' : 'bar' },", "      lazyChart(cv, () => drawChart(cv.firstChild, { ...ds, chart: x.type === 'line' ? 'line' : 'bar' },")
rep("""    viz.append(cv);
    requestAnimationFrame(() => {
      const col = s.band;""", """    viz.append(cv);
    lazyChart(cv, () => {
      const col = s.band;""")
rep("      responsive: true, maintainAspectRatio: false, indexAxis: horiz ? 'y' : 'x',", "      responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2), indexAxis: horiz ? 'y' : 'x',")
i=t.index("(function boot() {"); j=t.index("</script>", i)
t=t[:i]+open('tools/hub.js').read()+"\n"+open('tools/boot_supabase.js').read()+"\n"+t[j:]
rep("@media (max-width: 960px) {",open('tools/extra.css').read()+"\n@media (max-width: 960px) {")
head='''<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Research Hub | AIA Canada</title>
<script src="config.js"></script>
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
'''
open('./index.html','w').write(head+t+'\n</body>\n</html>\n')
print('built', len(head+t))
