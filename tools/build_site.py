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
rep("""    <button class="btn-ask" id="askTop" hidden>""","""    <div class="who" id="who" hidden><span id="whoEmail"></span><button type="button" id="signOut">Sign out</button></div>
    <button class="btn-ask" id="askTop" hidden>""")
rep("""  { id: 'defs', name: 'Definitions', blurb: 'What counts as the auto care sector, and the vehicle types used in this study.' },""",
"""  { id: 'defs', name: 'Definitions', blurb: 'What counts as the auto care sector, and the vehicle types used in this study.' },
  { id: 'access', name: 'Manage access', blurb: '' },""")
rep("rail.replaceChildren(...TOPICS.map(","rail.replaceChildren(...TOPICS.filter(t => t.id !== 'access' || IS_ADMIN).map(")
rep("t.id !== 'home' && t.id !== 'defs' ?","t.id !== 'home' && t.id !== 'defs' && t.id !== 'access' ?")
rep("TOPICS.filter(t => t.id !== 'home').map(","TOPICS.filter(t => t.id !== 'home' && t.id !== 'access').map(")
rep("  if (current === 'home') return renderHome(main);","  if (current === 'home') return renderHome(main);\n  if (current === 'access') return IS_ADMIN ? renderAccess(main) : renderHome(main);")
rep("`${DS.length - 1} figures","`${Math.max(DS.length - 1, 0)} figures")
i=t.index("(function boot() {"); j=t.index("</script>", i)
t=t[:i]+open('tools/boot_supabase.js').read()+"\n"+t[j:]
rep("@media (max-width: 960px) {",open('tools/extra.css').read()+"\n@media (max-width: 960px) {")
head='''<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Outlook Data Explorer | AIA Canada</title>
<script src="config.js"></script>
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
'''
open('./index.html','w').write(head+t+'\n</body>\n</html>\n')
print('built', len(head+t))
