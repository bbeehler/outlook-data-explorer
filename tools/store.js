/* ---------- public landing page and store (replaces aiacanada.com/reports) ----------
   Signed-out visitors see what's in the hub, members sign in free, non-members join (join.aiacanada.com),
   become an Industry Engagement Network affiliate (free access), or buy one report ($250, with 3 days of access to it in the hub)
   through Stripe Checkout. */
const JOIN_URL = 'https://join.aiacanada.com';
const AFFILIATE_URL = 'https://join.aiacanada.com/join-aia-canada/become-an-industry-engagement-network-affiliate';
const PRICE = { report: 250, days: 3 };
let ACCESS = null;      // what the signed-in user can open (from hub_access)
let CATALOG = null;     // published reports, for the landing page and the in-hub store
const OUTLOOK_ITEM = { key: 'outlook', title: 'Outlook Study 2025', series: 'AIA Canada with EY', published_on: '2025-01-15',
  summary: 'The size and outlook of Canada’s automotive aftermarket: vehicles on the road, the shift to EVs, demand for repair and parts, prices, the workforce and how Canada compares, with forecasts.',
  key_findings: [], charts: null, sections: 8, has_pdf: true };

async function loadCatalog() {
  if (CATALOG) return CATALOG;
  const { data } = await SB.rpc('hub_catalog');
  CATALOG = [...(data || []), OUTLOOK_ITEM];
  return CATALOG;
}
const money = n => '$' + n.toLocaleString('en-CA');
const fmtMonth = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }) : '';

async function checkout(plan, key) {
  const { data: { session } } = await SB.auth.getSession();
  try {
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/hub-checkout`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey },
      body: JSON.stringify({ plan, key, email: session ? session.user.email : undefined }) });
    const j = await r.json();
    if (j.url) { location.href = j.url; return; }
    toast(j.error && /STRIPE_SECRET_KEY/.test(j.error) ? 'Online purchases are being set up. Please try again soon.' : 'Checkout could not start. Please try again.');
  } catch { toast('Checkout could not start. Check your connection and try again.'); }
}
function buyBtn(plan, key, label, cls = 'btn-ask') {
  const b = h('button', { type: 'button', class: cls, onclick: async () => { b.disabled = true; const t = b.textContent; b.textContent = 'Opening secure checkout…'; await checkout(plan, key); b.disabled = false; b.textContent = t; } }, label);
  return b;
}

async function accountCall(body) {
  const { data: { session } } = await SB.auth.getSession();
  const r = await fetch(`${CFG.supabaseUrl}/functions/v1/hub-account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session ? session.access_token : ''}` }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
function pdfBtn(key) {
  const b = h('button', { type: 'button', class: 'btn-ask pdfbtn', onclick: async () => {
    b.disabled = true; b.textContent = 'Preparing the PDF…';
    const j = await accountCall({ action: 'pdf', key });
    b.disabled = false; b.textContent = 'Download the full report (PDF)';
    if (j.url) location.href = j.url;
    else toast(j.error === 'no_pdf' ? 'The PDF for this report isn’t available yet.' : 'The PDF could not be prepared. Please try again.');
  } }, 'Download the full report (PDF)');
  return b;
}
async function openPortal() {
  const j = await accountCall({ action: 'portal' });
  if (j.url) location.href = j.url; else toast('Your billing details could not be opened. Contact ' + CFG.contactEmail + '.');
}

// Which research reports this user can open (members, affiliates and admins: all; buyers: what they bought, for 3 days)
function canOpen(key) {
  if (!ACCESS) return true;
  return ACCESS.member || ACCESS.admin || ACCESS.subscribed || (ACCESS.reports || []).includes(key);
}
const fullAccess = () => !ACCESS || ACCESS.member || ACCESS.admin || ACCESS.subscribed;

/* After Stripe sends the buyer back: wait for the purchase to be recorded, then sign them in with the email they used */
async function checkoutReturn() {
  const qs = new URLSearchParams(location.search);
  const state = qs.get('checkout'), sid = qs.get('session_id');
  if (!state) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  if (state === 'cancel') return { cancelled: true };
  let st = null;
  for (let i = 0; i < 10; i++) {
    try { st = await (await fetch(`${CFG.supabaseUrl}/functions/v1/hub-checkout`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify({ action: 'status', session_id: sid }) })).json(); } catch {}
    if (st && st.ready) break;
    await new Promise(ok => setTimeout(ok, 2000));
  }
  return st || { paid: false };
}

/* ---------- the landing page ---------- */
function renderLanding(box, info = {}) {
  box.className = 'landing';
  const go = id => e => { e.preventDefault(); const el = $('#' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const ico = d => h('span', { class: 'lp-ico', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>` });
  if (info.notice) box.append(h('div', { class: 'lp-notice', role: 'status' }, info.notice));

  // 1. Hero: the promise, proof and sign-in
  const proof = h('div', { class: 'lp-proof' });
  box.append(h('section', { class: 'lp-hero' },
    h('div', { class: 'lp-hero-copy' },
      h('span', { class: 'lp-eyebrow' }, 'AIA Canada Research Hub'),
      h('h1', {}, 'Know what Canada’s drivers will do ', h('em', {}, 'before your competitors do.')),
      h('p', { class: 'lp-tag' }, 'Built for decisions not just dashboards.'),
      h('p', { class: 'lp-lead' }, 'The only research built for Canada’s automotive aftermarket: what vehicle owners think, where they take their vehicles, what the market is worth and where it’s heading. Interactive, searchable and ready for your next business decision.'),
      h('div', { class: 'lp-ctas' },
        h('a', { class: 'btn-ask lp-cta-main', href: '#plans', onclick: go('plans') }, 'Get access'),
        h('a', { class: 'lp-cta-ghost', href: '#reports', onclick: go('reports') }, 'See what’s inside →')),
      proof),
    signinCard(info)));
  const stat = (v, l) => h('div', { class: 'lp-stat' }, h('b', {}, v), h('span', {}, l));
  const setProof = (reports, charts, vehicles) => proof.replaceChildren(
    stat(String(reports), 'research reports'), stat(charts ? charts + '+' : '200+', 'interactive charts'), stat(vehicles || '27.6M', 'vehicles tracked'), stat('13', 'provinces and territories'));
  setProof(4, 0, '');
  let VEH = '';
  fetch('provinces/data.json').then(r => r.ok ? r.json() : null).then(d => {
    const ca = d && d.places.find(p => p.key === 'ca'); const s = ca && (ca.fleet || []).find(x => x.dims[0].startsWith('Total, road') && x.dims[1] === 'All fuel types');
    if (s) { VEH = (s.vals.at(-1) / 1e6).toFixed(1) + 'M'; const v = $('#lpVehicles'); if (v) v.textContent = `AIA Canada members keep Canada’s ${(s.vals.at(-1) / 1e6).toFixed(1)} million vehicles on the road.`; }
    if (CATALOG) setProof(CATALOG.length, CATALOG.reduce((t, r) => t + (r.charts || 0), 62), VEH);
  }).catch(() => {});

  // 2. Big numbers pulled from the reports themselves
  const teaser = h('div', { class: 'lp-teaser' });
  box.append(h('section', { class: 'lp-sec lp-insights' },
    h('div', { class: 'lp-sec-head' }, h('span', { class: 'lp-kicker' }, 'A taste of what’s inside'), h('h2', {}, 'Answers you won’t find anywhere else')), teaser));

  // 3. What you get
  const feat = (icon, t, d) => h('div', { class: 'lp-feat' }, ico(icon), h('h3', {}, t), h('p', {}, d));
  box.append(h('section', { class: 'lp-sec' },
    h('div', { class: 'lp-sec-head' }, h('span', { class: 'lp-kicker' }, 'Why the Research Hub'), h('h2', {}, 'From finding to decision in minutes')),
    h('div', { class: 'lp-feats' },
      feat('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>', 'Every chart, interactive', 'Hundreds of charts from AIA Canada’s research. Filter, switch to the table, and copy the numbers straight into your plan or presentation.'),
      feat('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6M11 8v6"/>', 'Ask the data', 'Ask a question in plain language and get an answer drawn only from the research, with the chart behind every number.'),
      feat('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15l3 3 3-3"/>', 'The full reports as PDFs', 'Download the designed report to share with your team, your board or your lender.'),
      feat('<path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/>', 'Context you can trust', 'Research linked to Statistics Canada and provincial data on prices, jobs and the vehicles on the road, by province and city.'))));

  // 4. Campaign band
  box.append(h('section', { class: 'lp-band' },
    h('div', { class: 'lp-band-in' },
      h('span', { class: 'lp-band-kicker' }, 'AIA Canada membership'),
      h('h2', {}, 'We keep Canada moving'),
      h('p', {}, h('span', { id: 'lpVehicles' }, 'AIA Canada members keep Canada’s vehicles on the road.'), ' Membership puts every report in the Research Hub in your hands, free, along with the advocacy, events, training and industry connections that keep your business moving.'),
      h('div', { class: 'lp-ctas' }, h('a', { class: 'btn-ask', href: JOIN_URL }, 'Join AIA Canada'), h('a', { class: 'lp-cta-ghost lp-on-dark', href: AFFILIATE_URL }, 'Or become an affiliate →')))));

  // 5. Pricing
  box.append(h('section', { class: 'lp-sec', id: 'plans' },
    h('div', { class: 'lp-sec-head' }, h('span', { class: 'lp-kicker' }, 'Pricing'), h('h2', {}, 'Choose how you get access'), h('p', { class: 'lp-sub' }, 'Members and affiliates get the whole hub free. Everyone else can buy the report they need.')),
    h('div', { class: 'lp-plans-grid' },
      h('div', { class: 'lp-plan lp-plan-main' }, h('span', { class: 'lp-plan-tag' }, 'Best value'), h('h3', {}, 'AIA Canada membership'), h('p', { class: 'lp-price' }, 'Free', h('span', {}, ' with membership')),
        h('ul', {}, ['Every report and the Outlook Study', 'New research the day it’s published', 'Advocacy, events, training and industry connections'].map(t => h('li', {}, t))),
        h('a', { class: 'btn-ask', href: JOIN_URL }, 'Become a member'),
        h('p', { class: 'lp-plan-note' }, 'Already a member? ', h('a', { href: '#signin', onclick: e => { e.preventDefault(); $('#email').focus(); $('#email').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Sign in'), '.')),
      h('div', { class: 'lp-plan lp-plan-aff' }, h('span', { class: 'lp-plan-tag lp-tag-ink' }, 'Free access'), h('h3', {}, 'Industry affiliate'), h('p', { class: 'lp-price' }, 'Free', h('span', {}, ' as an affiliate')),
        h('ul', {}, ['Every report in the Research Hub', 'Join AIA Canada’s Industry Engagement Network', 'Stay connected with the industry'].map(t => h('li', {}, t))),
        h('a', { class: 'btn-ask', href: AFFILIATE_URL }, 'Become an affiliate'),
        h('p', { class: 'lp-plan-note' }, 'Already an affiliate? ', h('a', { href: '#signin', onclick: e => { e.preventDefault(); $('#email').focus(); $('#email').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Sign in'), '.')),
      h('div', { class: 'lp-plan' }, h('h3', {}, 'Single report'), h('p', { class: 'lp-price' }, money(PRICE.report), h('span', {}, ' per report')),
        h('ul', {}, ['The full report as a PDF, yours to keep', `${PRICE.days} days in the Research Hub with that report`, 'Interactive charts, tables and Ask the data'].map(t => h('li', {}, t))),
        h('a', { class: 'act lp-plan-btn', href: '#reports', onclick: go('reports') }, 'Choose a report ↓')))));

  // 6. The reports
  const grid = h('div', { class: 'lp-grid' }, h('p', { class: 'gate-muted' }, 'Loading the reports…'));
  box.append(h('section', { class: 'lp-sec', id: 'reports' },
    h('div', { class: 'lp-sec-head' }, h('span', { class: 'lp-kicker' }, 'The research'), h('h2', {}, 'Reports in the hub'),
      h('p', { class: 'lp-sub' }, 'Free for members and affiliates. Or buy one for ', h('strong', {}, money(PRICE.report)), ` and get the PDF plus ${PRICE.days} days in the hub.`)), grid));
  loadCatalog().then(list => {
    grid.replaceChildren(...list.map(reportCard));
    setProof(list.length, list.reduce((t, r) => t + (r.charts || 0), 62), VEH);
    // big numbers: the first finding with a figure in each report
    const big = [];
    for (const r of list) for (const f of (r.key_findings || [])) {
      const m = /(\d{1,3}(?:[.,]\d+)?\s?%|\$\s?\d[\d,.]*\s?(?:billion|million|[BMK])?|\d[\d,.]*\s?(?:billion|million))/i.exec(f);
      if (m && f.length < 220) { big.push({ v: m[1].replace(/\s/g, ''), f, r }); break; }
    }
    teaser.replaceChildren(...big.slice(0, 3).map(x => h('figure', { class: 'lp-big' }, h('b', {}, x.v), h('figcaption', {}, x.f), h('span', { class: 'ref' }, x.r.title))));
    if (!big.length) teaser.closest('section').hidden = true;
  });

  // 7. Questions
  const q = (qq, a) => h('details', { class: 'lp-faq' }, h('summary', {}, qq), h('p', {}, a));
  box.append(h('section', { class: 'lp-sec' }, h('div', { class: 'lp-sec-head' }, h('h2', {}, 'Questions')),
    q('I work for an AIA Canada member. How do I get in?', 'Enter your work email in the sign-in box. We check it against our member records and email you a code. Every report is free for members.'),
    q('How do I get free access as an affiliate?', 'Join AIA Canada’s Industry Engagement Network as an affiliate. Once you’re on our records, sign in with your work email here.'),
    q('What do I get when I buy a report?', `${PRICE.days} days of access to that report in the Research Hub, starting when you pay: its interactive charts and tables, Ask the data, and the full report as a PDF. Download the PDF during your ${PRICE.days} days; it’s yours to keep.`),
    q('How do I sign in after buying?', 'Use the email address you paid with. We email you a sign-in code; there’s no password.'),
    q('Are taxes included?', 'Prices are in Canadian dollars. Applicable sales taxes are shown at checkout.'),
    q('Is payment secure?', 'Payments are handled by Stripe. AIA Canada never sees or stores your card details.'),
    h('p', { class: 'gate-muted' }, `Questions? Contact ${CFG.contactEmail}.`)));
  box.append(siteFooter());
}
// Footer in the style of aiacanada.com: who we are, how to reach us, where to go next
function siteFooter() {
  const col = (title, links) => h('div', { class: 'ft-col' }, h('h3', {}, title), h('ul', {}, links.map(([t, u]) => h('li', {}, h('a', { href: u }, t)))));
  return h('footer', { class: 'site-foot' },
    h('div', { class: 'ft-in' },
      h('div', { class: 'ft-brand' },
        h('a', { class: 'ft-mark', href: 'https://www.aiacanada.com/' }, h('b', {}, 'AIA'), h('span', {}, 'Canada')),
        h('p', { class: 'ft-name' }, 'Automotive Industries Association of Canada'),
        h('p', { class: 'ft-tag' }, 'We keep Canada moving.'),
        h('address', {}, '180 Elgin St, Suite 1400', h('br'), 'Ottawa, ON K2P 2K3', h('br'),
          h('a', { href: 'tel:+18008082920' }, 'Toll free: 1-800-808-2920'), h('br'), h('a', { href: 'mailto:info@aiacanada.com' }, 'info@aiacanada.com'))),
      col('AIA Canada', [['aiacanada.com', 'https://www.aiacanada.com/'], ['Become a member', JOIN_URL], ['Become an affiliate', AFFILIATE_URL], ['Media kit', 'https://www.aiacanada.com/media/media-kit/']]),
      col('Research Hub', [['Get access', '#plans'], ['Reports in the hub', '#reports'], ['Sign in', '#signin'], ['Contact us', 'mailto:' + CFG.contactEmail]]),
      col('Our family', [['CCIF', 'https://www.ccif.ca/'], ['I-CAR Canada', 'https://www.i-car.ca/']])),
    h('div', { class: 'ft-bottom' }, h('span', {}, `\u00a9 ${new Date().getFullYear()} Automotive Industries Association of Canada. All rights reserved.`),
      h('a', { href: 'https://aiacanada.com/privacy-policy/' }, 'Privacy policy')));
}
function reportCard(r) {
  const finding = (r.key_findings || [])[0];
  const stats = [r.charts ? `${r.charts} charts` : null, r.sections ? `${r.sections} sections` : null, r.has_pdf ? 'Full PDF' : null].filter(Boolean).join(' · ');
  return h('article', { class: 'lp-card' },
    h('span', { class: 'ref' }, [r.series, fmtMonth(r.published_on)].filter(Boolean).join(' · ')),
    h('h3', {}, r.title),
    h('p', {}, (r.summary || '').length > 280 ? r.summary.slice(0, 277) + '…' : r.summary),
    finding ? h('p', { class: 'lp-finding' }, finding) : null,
    stats ? h('span', { class: 'lp-stats' }, stats) : null,
    h('div', { class: 'lp-card-foot' }, h('span', { class: 'lp-free' }, 'Free for members and affiliates'), buyBtn('report', r.key, `Buy · ${money(PRICE.report)}`, 'act lp-buy')));
}
function signinCard(info) {
  const card = h('div', { class: 'lp-signin', id: 'signin' });
  const form = h('form', { class: 'gate-form' },
    h('label', { for: 'email' }, 'Work email'),
    h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@company.com', value: info.email || '' }),
    h('button', { type: 'submit', class: 'btn-ask' }, 'Sign in'));
  const err = h('p', { class: 'gate-err', role: 'alert' }, info.error || ''); err.hidden = !info.error;
  const fail = (msg) => { const btn = form.querySelector('button'); btn.disabled = false; btn.textContent = 'Sign in'; err.hidden = false; err.textContent = msg; };
  form.addEventListener('submit', e => { e.preventDefault(); requestCode($('#email').value.trim().toLowerCase(), form.querySelector('button'), fail); });
  card.append(h('span', { class: 'lp-signin-tag' }, 'Members \u00b7 affiliates \u00b7 buyers'), h('h2', {}, 'Sign in to the hub'), h('p', {}, 'Use your work email, or the email you bought with. We’ll email you a sign-in code. No password needed.'), form, err,
    h('p', { class: 'gate-muted' }, 'Not a member? ', h('a', { href: JOIN_URL }, 'Join AIA Canada'), ', ', h('a', { href: AFFILIATE_URL }, 'become an affiliate'), ' or ', h('a', { href: '#plans', onclick: e => { e.preventDefault(); $('#plans').scrollIntoView({ behavior: 'smooth' }); } }, 'buy a report'), '.'));
  if (info.autoSend && info.email) setTimeout(() => requestCode(info.email, form.querySelector('button'), fail), 50);
  return card;
}
async function requestCode(email, btn, fail) {
  btn.disabled = true; btn.textContent = 'Checking your access…';
  let status = 'unavailable';
  try {
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/outlook-register`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify({ email }) });
    status = (await r.json()).status || 'unavailable';
  } catch {}
  if (status === 'denied') return gate('notmember', { email });
  if (status === 'invalid') return fail('Enter a full email address, such as name@company.com.');
  if (status === 'rate_limited') return fail('Too many tries in a short time. Wait an hour, then try again.');
  if (status !== 'approved') return fail(`We could not check your access right now. Try again in a few minutes, or contact ${CFG.contactEmail}.`);
  btn.textContent = 'Sending your sign-in code…';
  const { error } = await SB.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) {
    return fail(/email rate limit/i.test(error.message) || error.code === 'over_email_send_rate_limit'
      ? `We can’t send sign-in emails right now because too many were sent in the past hour. Please try again later, or contact ${CFG.contactEmail}.`
      : /security purposes|seconds/i.test(error.message) ? 'A code was sent a moment ago. Check your email, or wait a minute and try again.' : 'The sign-in email could not be sent. Try again in a few minutes.');
  }
  gate('sent', { email });
}

/* ---------- inside the hub: reports this user hasn't got yet ---------- */
function storeSection() {
  if (fullAccess()) return null;
  const until = Object.values(ACCESS.until || {}).sort().at(-1);
  const sec = h('section', { class: 'panel storesec', id: 'store' }, h('h2', {}, 'Get more reports'),
    until ? h('p', { class: 'lp-until' }, `Your access ends ${new Date(until).toLocaleString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}; download the PDF before then.`) : null,
    h('p', { class: 'gate-muted' }, `Buy another report for ${money(PRICE.report)} (${PRICE.days} days of access), or get every report free: `, h('a', { href: JOIN_URL }, 'become an AIA Canada member'), ' or ', h('a', { href: AFFILIATE_URL }, 'an Industry Engagement Network affiliate'), '.'),
    h('div', { class: 'chips' }, h('a', { class: 'btn-ask', href: AFFILIATE_URL }, 'Become an affiliate'), h('a', { class: 'act', href: JOIN_URL }, 'Become a member')));
  const grid = h('div', { class: 'lp-grid' });
  sec.append(grid);
  loadCatalog().then(list => grid.replaceChildren(...list.filter(r => !canOpen(r.key)).map(reportCard)));
  return sec;
}

/* ---------- admin: the Outlook Study PDF and store purchases ---------- */
function outlookPdfPanel() {
  const file = h('input', { type: 'file', accept: 'application/pdf', id: 'outlookPdf' });
  const msg = h('p', { class: 'gate-muted', role: 'status' }, 'Members and buyers download this from the Outlook Study page. Uploading replaces the current file.');
  const btn = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
    const f = file.files[0];
    if (!f || (f.type && f.type !== 'application/pdf')) { msg.textContent = 'Choose the Outlook Study PDF first.'; return; }
    btn.disabled = true; msg.textContent = 'Uploading…';
    const { error } = await SB.storage.from('hub-reports').upload('outlook/outlook-study-2025.pdf', f, { upsert: true, contentType: 'application/pdf' });
    btn.disabled = false; msg.textContent = error ? 'Upload failed: ' + error.message : 'Uploaded. The Outlook Study PDF is now available to download.';
  } }, 'Upload');
  return h('section', { class: 'panel' }, h('h2', {}, 'Outlook Study PDF'), msg, h('div', { class: 'chips' }, file, btn));
}
function purchasesPanel() {
  const box = h('section', { class: 'panel' }, h('h2', {}, 'Store: report purchases'), h('p', { class: 'gate-muted' }, 'Loading\u2026'));
  SB.from('hub_entitlements').select('email, kind, report_key, status, current_period_end, amount_cents, currency, created_at').order('created_at', { ascending: false }).limit(500).then(({ data, error }) => {
    if (error) { box.replaceChildren(h('h2', {}, 'Store: report purchases'), h('p', {}, 'Could not load purchases.')); return; }
    const titles = Object.fromEntries((CATALOG || []).map(r => [r.key, r.title]));
    const live = data.filter(r => r.kind === 'report' && r.status === 'active' && r.current_period_end && new Date(r.current_period_end) > new Date()).length;
    const sales = data.filter(r => r.kind === 'report' && r.status === 'active').length;
    box.replaceChildren(h('h2', {}, 'Store: report purchases'),
      h('p', { class: 'gate-muted' }, `${sales} report ${sales === 1 ? 'purchase' : 'purchases'} in total; ${live} still within ${PRICE.days} days of access. Refunds are made in Stripe and end access here automatically.`),
      data.length ? h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Email', 'What', 'Status', 'Amount'].map(c => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, data.map(r => h('tr', {}, h('td', {}, new Date(r.created_at).toLocaleDateString('en-CA')), h('th', { scope: 'row' }, r.email),
          h('td', {}, r.kind === 'subscription' ? 'All reports, monthly' : (titles[r.report_key] || r.report_key)),
          h('td', {}, r.status === 'active' && r.current_period_end ? (new Date(r.current_period_end) > new Date() ? `Access until ${new Date(r.current_period_end).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Access ended') : r.status),
          h('td', {}, r.amount_cents != null ? `$${(r.amount_cents / 100).toFixed(2)} ${String(r.currency || '').toUpperCase()}` : '')))))) : h('p', { class: 'gate-muted' }, 'No purchases yet.'));
  });
  loadCatalog();
  return box;
}
