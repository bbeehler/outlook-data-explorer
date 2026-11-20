/* ---------- public landing page and store (replaces aiacanada.com/reports) ----------
   Signed-out visitors see what's in the hub, members sign in free, non-members join (join.aiacanada.com),
   buy one report ($199) or subscribe to every report ($49/month) through Stripe Checkout. */
const JOIN_URL = 'https://join.aiacanada.com';
const PRICE = { report: 199, monthly: 49 };
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

// Which research reports this user can open (members, admins and subscribers: all)
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
  const signin = signinCard(info);
  // hero
  box.append(h('section', { class: 'lp-hero' },
    h('div', { class: 'lp-hero-copy' },
      h('span', { class: 'lp-eyebrow' }, 'AIA Canada Research Hub'),
      h('h1', {}, 'The research behind the businesses that keep Canada moving'),
      h('p', { class: 'lp-lead' }, 'AIA Canada’s consumer research and the Outlook Study on Canada’s automotive aftermarket, as interactive charts you can explore, download and ask questions about, plus each full report as a PDF.'),
      h('ul', { class: 'lp-ticks' }, ['Every chart as an interactive graph and a table', 'Full reports to download as PDFs', 'Ask the data: plain-language answers with sources', 'Government statistics for context, by province and city'].map(t => h('li', {}, t))),
      h('div', { class: 'lp-ctas' }, h('a', { class: 'btn-ask lp-join', href: JOIN_URL }, 'Become a member'), h('a', { class: 'act lp-plans', href: '#plans', onclick: e => { e.preventDefault(); $('#plans').scrollIntoView({ behavior: 'smooth' }); } }, 'See plans and prices'))),
    signin));
  if (info.notice) box.prepend(h('div', { class: 'lp-notice', role: 'status' }, info.notice));
  // campaign band
  const band = h('section', { class: 'lp-band' },
    h('div', { class: 'lp-band-in' },
      h('span', { class: 'lp-band-kicker' }, 'AIA Canada membership'),
      h('h2', {}, 'We keep Canada moving'),
      h('p', { id: 'lpVehicles' }, 'AIA Canada members keep Canada’s vehicles on the road. Membership includes every report in the Research Hub, free, along with advocacy, events, training and the industry connections that keep your business moving.'),
      h('a', { class: 'btn-ask lp-band-cta', href: JOIN_URL }, 'Join AIA Canada')));
  box.append(band);
  fetch('provinces/data.json').then(r => r.ok ? r.json() : null).then(d => {
    const ca = d && d.places.find(p => p.key === 'ca'); const s = ca && (ca.fleet || []).find(x => x.dims[0].startsWith('Total, road') && x.dims[1] === 'All fuel types');
    if (s) $('#lpVehicles').textContent = `AIA Canada members keep Canada’s ${(s.vals.at(-1) / 1e6).toFixed(1)} million vehicles on the road. Membership includes every report in the Research Hub, free, along with advocacy, events, training and the industry connections that keep your business moving.`;
  }).catch(() => {});
  // reports
  const grid = h('div', { class: 'lp-grid' }, h('p', { class: 'gate-muted' }, 'Loading the reports…'));
  box.append(h('section', { class: 'lp-sec', id: 'reports' }, h('h2', {}, 'Reports in the hub'),
    h('p', { class: 'lp-sub' }, `Free for AIA Canada members. Not a member? Buy a single report for ${money(PRICE.report)} or get every report for ${money(PRICE.monthly)} a month.`), grid));
  loadCatalog().then(list => grid.replaceChildren(...list.map(reportCard)));
  // plans
  box.append(h('section', { class: 'lp-sec', id: 'plans' }, h('h2', {}, 'Choose how you get access'),
    h('div', { class: 'lp-plans-grid' },
      h('div', { class: 'lp-plan lp-plan-main' }, h('span', { class: 'lp-plan-tag' }, 'Best value'), h('h3', {}, 'AIA Canada membership'), h('p', { class: 'lp-price' }, 'Every report included'),
        h('ul', {}, ['All research reports and the Outlook Study, free', 'New reports as soon as they’re published', 'Advocacy, events, training and industry connections'].map(t => h('li', {}, t))),
        h('a', { class: 'btn-ask', href: JOIN_URL }, 'Become a member'),
        h('p', { class: 'gate-muted' }, 'Already a member? ', h('a', { href: '#signin', onclick: e => { e.preventDefault(); $('#email').focus(); $('#email').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Sign in with your work email'), '.')),
      h('div', { class: 'lp-plan' }, h('h3', {}, 'All reports'), h('p', { class: 'lp-price' }, money(PRICE.monthly), h('span', {}, ' a month')),
        h('ul', {}, ['Every report in the hub, including the Outlook Study', 'Full reports as PDFs', 'Ask the data', 'Cancel any time'].map(t => h('li', {}, t))),
        buyBtn('subscription', null, `Subscribe for ${money(PRICE.monthly)}/month`)),
      h('div', { class: 'lp-plan' }, h('h3', {}, 'A single report'), h('p', { class: 'lp-price' }, money(PRICE.report), h('span', {}, ' one time')),
        h('ul', {}, ['One report of your choice, yours to keep', 'Interactive charts and the full PDF', 'Ask the data about that report'].map(t => h('li', {}, t))),
        h('a', { class: 'act', href: '#reports', onclick: e => { e.preventDefault(); $('#reports').scrollIntoView({ behavior: 'smooth' }); } }, 'Choose a report')))));
  // FAQ
  const q = (qq, a) => h('details', { class: 'lp-faq' }, h('summary', {}, qq), h('p', {}, a));
  box.append(h('section', { class: 'lp-sec' }, h('h2', {}, 'Questions'),
    q('I work for an AIA Canada member. How do I get in?', 'Enter your work email in the sign-in box. We check it against our member records and email you a code. Every report is free for members.'),
    q('What do I get when I buy a report?', 'Access in the Research Hub to that report’s interactive charts and tables, the full report as a PDF, and Ask the data for questions about it. It’s yours to keep.'),
    q('How does the monthly plan work?', `For ${money(PRICE.monthly)} a month you can open every report in the hub, including new ones as they’re published. Cancel any time from your account; access continues to the end of the month you’ve paid for.`),
    q('How do I sign in after buying?', 'Use the email address you paid with. We email you a sign-in code; there’s no password.'),
    q('Are taxes included?', 'Prices are in Canadian dollars. Applicable sales taxes are shown at checkout.'),
    q('Is payment secure?', 'Payments are handled by Stripe. AIA Canada never sees or stores your card details.'),
    h('p', { class: 'gate-muted' }, `Questions? Contact ${CFG.contactEmail}.`)));
  box.append(h('section', { class: 'lp-pub' }, h('span', { class: 'pub-tag' }, 'Public data'),
    h('span', {}, 'Government statistics on vehicles in every province are free to everyone: '), h('a', { href: 'provinces/' }, 'Vehicles by province'), h('span', {}, '. These are not AIA Canada research.')));
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
    h('div', { class: 'lp-card-foot' }, h('span', { class: 'lp-free' }, 'Free for members'), buyBtn('report', r.key, `Buy · ${money(PRICE.report)}`, 'act lp-buy')));
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
  card.append(h('h2', {}, 'Members and subscribers'), h('p', {}, 'Sign in with your work email, or the email you bought with. We’ll email you a sign-in code. No password needed.'), form, err,
    h('p', { class: 'gate-muted' }, 'Not a member? ', h('a', { href: JOIN_URL }, 'Join AIA Canada'), ' or ', h('a', { href: '#plans', onclick: e => { e.preventDefault(); $('#plans').scrollIntoView({ behavior: 'smooth' }); } }, 'buy access'), '.'));
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
  const sec = h('section', { class: 'panel storesec', id: 'store' }, h('h2', {}, 'Get more reports'),
    h('p', { class: 'gate-muted' }, `Open every report for ${money(PRICE.monthly)} a month, buy single reports for ${money(PRICE.report)}, or `, h('a', { href: JOIN_URL }, 'become an AIA Canada member'), ' to get them all free.'),
    h('div', { class: 'chips' }, buyBtn('subscription', null, `Subscribe to all reports · ${money(PRICE.monthly)}/month`)));
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
  const box = h('section', { class: 'panel' }, h('h2', {}, 'Store: purchases and subscriptions'), h('p', { class: 'gate-muted' }, 'Loading…'));
  SB.from('hub_entitlements').select('email, kind, report_key, status, current_period_end, amount_cents, currency, created_at').order('created_at', { ascending: false }).limit(500).then(({ data, error }) => {
    if (error) { box.replaceChildren(h('h2', {}, 'Store: purchases and subscriptions'), h('p', {}, 'Could not load purchases.')); return; }
    const titles = Object.fromEntries((CATALOG || []).map(r => [r.key, r.title]));
    const subs = data.filter(r => r.kind === 'subscription' && ['active', 'trialing', 'past_due'].includes(r.status)).length;
    const sales = data.filter(r => r.kind === 'report' && r.status === 'active').length;
    box.replaceChildren(h('h2', {}, 'Store: purchases and subscriptions'),
      h('p', { class: 'gate-muted' }, `${subs} active ${subs === 1 ? 'subscription' : 'subscriptions'}, ${sales} single-report ${sales === 1 ? 'purchase' : 'purchases'}. Refunds and cancellations are handled in Stripe and update here automatically.`),
      data.length ? h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Email', 'What', 'Status', 'Amount'].map(c => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, data.map(r => h('tr', {}, h('td', {}, new Date(r.created_at).toLocaleDateString('en-CA')), h('th', { scope: 'row' }, r.email),
          h('td', {}, r.kind === 'subscription' ? 'All reports, monthly' : (titles[r.report_key] || r.report_key)),
          h('td', {}, r.status + (r.kind === 'subscription' && r.current_period_end ? ` (paid to ${new Date(r.current_period_end).toLocaleDateString('en-CA')})` : '')),
          h('td', {}, r.amount_cents != null ? `$${(r.amount_cents / 100).toFixed(2)} ${String(r.currency || '').toUpperCase()}` : '')))))) : h('p', { class: 'gate-muted' }, 'No purchases yet.'));
  });
  loadCatalog();
  return box;
}
