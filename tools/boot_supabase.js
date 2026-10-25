/* ---------- sign-in, data loading and access management (Supabase) ---------- */
const SB = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
let IS_ADMIN = false, LOADED_FOR = null;
const INITIAL_HASH = (location.hash || '').slice(1);

function gate(kind, info = {}) {
  document.querySelector('.wrap').classList.add('gated');
  document.body.classList.add('is-gated'); if (typeof closeNav === 'function') closeNav();
  $('#rail').hidden = true; $('#askTop').hidden = true; $('.search').hidden = true;
  const main = $('#main');
  for (const c of main.querySelectorAll('canvas')) { freeChart(c); }
  main.replaceChildren();
  const box = h('section', { class: 'gate', 'aria-live': 'polite' });
  if (kind === 'loading') {
    box.append(h('p', { class: 'gate-muted' }, info.msg || 'Loading the Research Hub…'));
  } else if (kind === 'signin') {
    const form = h('form', { class: 'gate-form' },
      h('label', { for: 'email' }, 'Work email'),
      h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@company.com', value: info.email || '' }),
      h('button', { type: 'submit', class: 'btn-ask' }, 'Check my access'));
    const err = h('p', { class: 'gate-err', role: 'alert' }, info.error || '');
    err.hidden = !info.error;
    const fail = (msg) => { const btn = form.querySelector('button'); btn.disabled = false; btn.textContent = 'Check my access'; err.hidden = false; err.textContent = msg; };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#email').value.trim().toLowerCase();
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking your membership\u2026';
      let status = 'unavailable';
      try {
        const r = await fetch(`${CFG.supabaseUrl}/functions/v1/outlook-register`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify({ email }) });
        status = (await r.json()).status || 'unavailable';
      } catch {}
      if (status === 'denied') return gate('notmember', { email });
      if (status === 'invalid') return fail('Enter a full email address, such as name@company.com.');
      if (status === 'rate_limited') return fail('Too many tries in a short time. Wait an hour, then try again.');
      if (status !== 'approved') return fail(`We could not check membership right now. Try again in a few minutes, or contact ${CFG.contactEmail}.`);
      btn.textContent = 'Sending your sign-in link\u2026';
      const { error } = await SB.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) return fail(/rate|security purposes|seconds/i.test(error.message) ? 'A link was sent a moment ago. Wait a minute, then try again.' : 'The link could not be sent. Try again in a few minutes.');
      gate('sent', { email });
    });
    box.append(h('span', { class: 'eyebrow' }, 'For AIA Canada members'),
      h('h1', {}, 'Get access to the AIA Canada Research Hub'),
      h('p', {}, 'Enter the work email your company has on file with AIA Canada. We\u2019ll check it against our member records and email you a sign-in link. No password needed. Already registered? Use the same form to sign in.'),
      form, err,
      h('p', { class: 'gate-muted' }, `Questions about access? Contact ${CFG.contactEmail}.`));
  } else if (kind === 'notmember') {
    const contact = h('a', { href: `mailto:${CFG.contactEmail}?subject=${encodeURIComponent('Research Hub access')}&body=${encodeURIComponent(`Hello,\n\nI would like access to the AIA Canada Research Hub. My work email is ${info.email}.\n\nCompany:\nName:\n`)}` }, CFG.contactEmail);
    box.append(h('h1', {}, 'We couldn\u2019t confirm a current membership for this email'),
      h('p', {}, h('span', {}, 'We checked '), h('strong', {}, info.email), h('span', {}, ' against AIA Canada\u2019s member records and didn\u2019t find a current membership.')),
      h('p', {}, 'The Research Hub is a member benefit. If your company is a member, try the email address AIA Canada has on file for you. If you think this is a mistake, or you\u2019d like to become a member, contact:'),
      h('p', { class: 'contact-line' }, contact, h('button', { type: 'button', class: 'act', onclick: () => copyText(CFG.contactEmail, 'Email address copied.') }, 'Copy')),
      h('button', { type: 'button', class: 'act', onclick: () => gate('signin', { email: info.email }) }, 'Try a different email'));
  } else if (kind === 'sent') {
    box.append(h('h1', {}, 'Check your email'),
      h('p', {}, h('span', {}, 'We sent a sign-in link to '), h('strong', {}, info.email), h('span', {}, '. Open it on this device. The link works once and expires after an hour.')),
      h('p', { class: 'gate-muted' }, 'No email after a few minutes? Check your junk folder.'),
      h('button', { type: 'button', class: 'act', onclick: () => gate('signin', { email: info.email }) }, 'Use a different email'));
  } else if (kind === 'denied') {
    box.append(h('h1', {}, 'You’re signed in, but not on the access list yet'),
      h('p', {}, h('span', {}, 'You’re signed in as '), h('strong', {}, info.email), h('span', {}, `. The Research Hub is limited to approved members and staff. Ask ${CFG.contactEmail} to add this address, then sign in again.`)),
      h('button', { type: 'button', class: 'act', onclick: signOut }, 'Sign out'));
  } else if (kind === 'error') {
    box.append(h('h1', {}, 'The data could not be loaded'), h('p', {}, 'Check your connection and reload the page.'),
      h('button', { type: 'button', class: 'act', onclick: () => location.reload() }, 'Reload'));
  }
  main.append(box);
}

async function signOut() { await SB.auth.signOut(); LOADED_FOR = null; IS_ADMIN = false; SAMPLE = null; $('#who').hidden = true; gate('signin'); }
$('#signOut').addEventListener('click', signOut);

async function loadApp(session) {
  if (LOADED_FOR === session.user.id) return;
  LOADED_FOR = session.user.id;
  $('#whoEmail').textContent = session.user.email; $('#who').hidden = false;
  gate('loading');
  const { data, error } = await SB.from('outlook_figures').select('payload').eq('edition', '2025').order('sort');
  if (error) { LOADED_FOR = null; gate('error'); return; }
  if (!data.length) { gate('denied', { email: session.user.email }); return; }
  DS = data.map(r => r.payload);
  BYID = Object.fromEntries(DS.map(d => [d.id, d]));
  // Check admin rights, load the hub content and check whether AI answers are on, all before the first draw,
  // so the page is drawn once (drawing twice made charts appear and then blank out while the page rebuilt).
  const aiCheck = askFn({ ping: true }).then(r => r.ok ? r.json() : null).then(j => !!(j && j.enabled)).catch(() => false);
  const [adm] = await Promise.all([SB.rpc('outlook_is_admin'), loadHub().catch(e => console.warn('Research Hub content', e))]);
  IS_ADMIN = adm.data === true;
  const aiOn = await Promise.race([aiCheck, new Promise(ok => setTimeout(() => ok(null), 4000))]);
  if (aiOn) { SAMPLE = remoteSample(); $('#askTop').hidden = false; }
  DOWNLOADS = { save: async ({ filename, data }) => {
    const url = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); return { status: 'saved' };
  } };
  document.querySelector('.wrap').classList.remove('gated'); document.body.classList.remove('is-gated'); $('#rail').hidden = false; $('.search').hidden = false;
  if (TOPICS.some(t => t.id === INITIAL_HASH)) current = INITIAL_HASH;
  render();
  if (BYID[INITIAL_HASH]) jump(INITIAL_HASH);
  if (aiOn === null) aiCheck.then(on => { if (on) { SAMPLE = remoteSample(); $('#askTop').hidden = false; } }); // slow check: just show the button
}

async function askFn(body, signal) {
  const { data: { session } } = await SB.auth.getSession();
  return fetch(`${CFG.supabaseUrl}/functions/v1/outlook-ask`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session ? session.access_token : ''}` },
    body: JSON.stringify(body),
  });
}

/* Same shape as the in-Claude sample() so the rest of the page is unchanged */
function remoteSample() {
  const fn = async (turns, opts = {}) => {
    const msgs = [];
    for (const t of (typeof turns === 'string' ? [{ role: 'user', content: turns }] : turns)) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === t.role) last.content += '\n\n' + t.content; else msgs.push({ role: t.role, content: t.content });
    }
    let res;
    try { res = await askFn({ messages: msgs }, opts.signal); }
    catch (e) { throw { code: e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', message: String(e) }; }
    if (res.status === 429) throw { code: 'rate_limited', message: 'rate limited' };
    if (res.status === 401) throw { code: 'session_expired', message: 'sign in' };
    if (res.status === 403) throw { code: 'not_granted', message: 'no access' };
    if (res.status === 413) throw { code: 'prompt_too_large', message: 'too large' };
    if (!res.ok) { const j = await res.json().catch(() => ({})); const map = { key_rejected: 'ai_key', no_credit: 'ai_credit', model_unavailable: 'ai_model', not_configured: 'ai_off' }; throw { code: map[j.error] || 'upstream_error', message: 'HTTP ' + res.status }; }
    const j = await res.json();
    if (!j.text) throw { code: 'empty_completion', message: 'empty' };
    if (opts.onText) opts.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: 'default' };
  };
  fn.limits = async () => ({ maxPromptBytes: 65536 });
  return fn;
}

/* ---------- access list (admins only) ---------- */
async function renderAccess(main) {
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Admin'), h('h1', {}, 'Manage access'),
    h('p', {}, 'People on this list can sign in with their email and see the Research Hub. Removing someone takes effect the next time they load the page.')));
  const panel = h('section', { class: 'panel' });
  const ta = h('textarea', { id: 'bulk', rows: '4', class: 'bulk', placeholder: 'One or more emails, separated by commas or new lines' });
  const org = h('input', { id: 'bulkOrg', class: 'tsearch', placeholder: 'Organization (optional)' });
  const msg = h('p', { class: 'gate-muted', role: 'status' });
  const add = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
    const emails = [...new Set(ta.value.toLowerCase().split(/[\s,;]+/).map(s => s.trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))];
    if (!emails.length) { msg.textContent = 'Enter at least one valid email address.'; return; }
    add.disabled = true;
    const { error } = await SB.from('outlook_access').upsert(emails.map(email => ({ email, organization: org.value.trim(), source: 'manual' })), { onConflict: 'email', ignoreDuplicates: true });
    add.disabled = false;
    if (error) { msg.textContent = 'Could not add: ' + error.message; return; }
    ta.value = ''; msg.textContent = `Added ${emails.length} ${emails.length === 1 ? 'address' : 'addresses'}. Send them the page link; they sign in with that email.`;
    list();
  } }, 'Add to list');
  panel.append(h('h2', {}, 'Add people by hand'), h('p', { class: 'gate-muted' }, 'For staff, partners or anyone not in Insightly as a member contact.'), ta, h('div', { class: 'chips' }, org, add), msg);
  const listBox = h('section', { class: 'panel' }, h('h2', {}, 'Current list'));
  main.append(panel, listBox);
  const syncBox = h('section', { class: 'panel' });
  main.insertBefore(syncBox, panel);
  async function syncStatus() {
    const { data: runs } = await SB.from('outlook_sync_log').select('started_at, finished_at, ok, member_orgs, member_emails, added, removed, note').order('started_at', { ascending: false }).limit(1);
    const r = runs && runs[0];
    const btn = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Checking\u2026 (about a minute)';
      try {
        const { data: { session } } = await SB.auth.getSession();
        const res = await fetch(`${CFG.supabaseUrl}/functions/v1/outlook-member-sync`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session.access_token}` }, body: '{}' });
        const j = await res.json().catch(() => ({}));
        toast(j.ok ? `Re-check done: ${j.removed} removed for lapsed membership.` : (j.error || 'The re-check did not finish.'));
      } catch { toast('The sync did not finish. Try again in a few minutes.'); }
      syncStatus(); list(); directory();
    } }, 'Re-check members now');
    let line;
    if (!r) line = 'The nightly re-check has not run yet. It starts once the Insightly key is set up.';
    else if (!r.finished_at) line = `A sync started ${new Date(r.started_at).toLocaleString('en-CA')} and is still running.`;
    else if (r.ok) line = `Last re-check ${new Date(r.finished_at).toLocaleString('en-CA')}: ${r.member_orgs} member organisations in Insightly; ${r.removed} registered ${r.removed === 1 ? 'person' : 'people'} removed for lapsed membership. ${r.note.includes('skipped') ? r.note : ''}`;
    else line = `Last sync failed ${new Date(r.started_at).toLocaleString('en-CA')}: ${r.note}`;
    syncBox.replaceChildren(h('h2', {}, 'How members get access'),
      h('p', { style: 'margin:0;color:var(--ink-2)' }, 'Members register with their work email. The site checks Insightly on the spot: if the email belongs to a contact at an organisation whose Last Membership Year is this year or later, they\u2019re approved and sent a sign-in link. Otherwise they\u2019re turned away and given your contact. Every night, registered members are re-checked and removed if their organisation\u2019s membership has lapsed. People you add by hand stay until you remove them.'),
      h('p', { class: 'gate-muted' }, line), h('div', {}, btn));
  }
  syncStatus();

  // Troubleshooting 1: check one email against the same rules registration uses, without adding or emailing anyone.
  const checkBox = h('section', { class: 'panel', id: 'checkBox' });
  const ckIn = h('input', { id: 'checkEmail', type: 'email', class: 'tsearch', placeholder: 'name@company.com', autocomplete: 'off' });
  const ckOut = h('div', { role: 'status' });
  const ckBtn = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
    const email = ckIn.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ckOut.replaceChildren(h('p', { class: 'gate-muted' }, 'Enter a full email address.')); return; }
    ckBtn.disabled = true; ckOut.replaceChildren(h('p', { class: 'gate-muted' }, 'Checking Insightly…'));
    try {
      const { data: { session } } = await SB.auth.getSession();
      const res = await fetch(`${CFG.supabaseUrl}/functions/v1/outlook-register`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ email, check: true }) });
      const j = await res.json().catch(() => ({}));
      ckOut.replaceChildren(...checkResult(j));
    } catch { ckOut.replaceChildren(h('p', {}, 'The check did not finish. Try again.')); }
    ckBtn.disabled = false;
  } }, 'Check');
  ckIn.addEventListener('keydown', e => { if (e.key === 'Enter') ckBtn.click(); });
  function checkResult(j) {
    if (j.error === 'admins_only') return [h('p', {}, 'Only Data Portal admins can run this check.')];
    if (j.status === 'invalid') return [h('p', {}, 'That is not a valid email address.')];
    const V = { approved: ['ok', 'Would be approved'], denied: ['no', 'Would be denied'], unavailable: ['warn', 'Can’t tell right now'] }[j.verdict] || ['warn', 'Unknown'];
    const out = [h('p', { class: 'verdict verdict-' + V[0] }, h('strong', {}, V[1]), j.reason ? ' — ' + j.reason : '')];
    if (j.insightly) out.push(h('p', { class: 'gate-muted' }, 'Insightly: ' + j.insightly));
    if (j.rule) out.push(h('p', { class: 'gate-muted' }, 'Rule today: ' + j.rule + ' (2050 = lifetime).'));
    const facts = [];
    facts.push('On the access list: ' + (j.on_list ? `yes (${j.on_list.source === 'manual' ? 'added by hand' : 'registered member'}${j.on_list.organization ? ', ' + j.on_list.organization : ''})` : 'no'));
    facts.push('Data Portal admin: ' + (j.portal_admin ? 'yes' : 'no'));
    out.push(h('ul', { class: 'facts' }, facts.map(f => h('li', {}, f))));
    if (Array.isArray(j.insightly_contacts)) {
      out.push(j.insightly_contacts.length
        ? h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Insightly contact', 'Organisation', 'Last Membership Year', 'Counts as member'].map(c => h('th', { scope: 'col' }, c)))),
            h('tbody', {}, j.insightly_contacts.map(c => h('tr', {}, h('th', { scope: 'row' }, c.name || '(no name)'), h('td', {}, c.organisation || 'Not linked to an organisation'), h('td', {}, c.last_membership_year == null ? '—' : String(c.last_membership_year || 'blank')), h('td', {}, c.member ? 'Yes' : 'No'))))))
        : h('p', { class: 'gate-muted' }, 'No Insightly contact has this exact email address. Check for a typo or an old address on the contact record.'));
    }
    return out;
  }
  checkBox.append(h('h2', {}, 'Check an email'),
    h('p', { class: 'gate-muted' }, 'Runs the same check as registration, live against Insightly, and explains the answer. It does not add the person or send them anything.'),
    h('div', { class: 'chips' }, ckIn, ckBtn), ckOut);
  main.insertBefore(checkBox, panel);

  // Troubleshooting 2: the member directory as of the last sync (organisations and their contacts).
  const dirBox = h('section', { class: 'panel', id: 'dirBox' });
  main.insertBefore(dirBox, panel);
  let dq = '', dStatus = 'current';
  async function directory() {
    let orgs = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await SB.from('outlook_member_orgs').select('org_id, name, last_membership_year, status, contacts, contacts_with_email, synced_at').order('name').range(from, from + 999);
      if (error) { dirBox.replaceChildren(h('h2', {}, 'Member directory'), h('p', {}, 'Could not load the directory.')); return; }
      orgs = orgs.concat(data); if (data.length < 1000) break;
    }
    const cur = orgs.filter(o => o.status === 'current');
    const synced = orgs.reduce((m, o) => o.synced_at > m ? o.synced_at : m, '');
    const head = [h('h2', {}, 'Member directory'),
      h('p', { class: 'gate-muted' }, orgs.length
        ? `As of the last sync (${new Date(synced).toLocaleString('en-CA')}): ${cur.length} current member organisations, ${cur.reduce((n, o) => n + o.contacts_with_email, 0)} contacts with an email who can register. Organisations that lapsed last year are listed too, so you can see why someone is turned away.`
        : 'Empty until the member sync runs with the Insightly key in place. Use “Re-check members now” above once the key is set.')];
    if (!orgs.length) { dirBox.replaceChildren(...head); return; }
    const search = h('input', { id: 'dirSearch', type: 'search', class: 'tsearch', placeholder: 'Find an organisation, person or email', value: dq });
    const sel = h('select', { id: 'dirStatus', class: 'tsearch', onchange: e => { dStatus = e.target.value; draw(); } },
      [['current', 'Current members'], ['lapsed', 'Lapsed'], ['all', 'All']].map(([v, t]) => h('option', { value: v, selected: v === dStatus }, t)));
    const people = h('div', {});
    const body = h('tbody', {});
    const more = h('p', { class: 'gate-muted' });
    const byId = new Map(orgs.map(o => [o.org_id, o]));
    let seq = 0;
    const draw = async () => {
      const f = dq.toLowerCase().trim();
      const rows = orgs.filter(o => (dStatus === 'all' || o.status === dStatus) && (!f || o.name.toLowerCase().includes(f)));
      body.replaceChildren(...rows.slice(0, 300).map(orgRow));
      more.textContent = rows.length > 300 ? `Showing 300 of ${rows.length}. Search to narrow the list.` : rows.length ? '' : 'No organisations match.';
      const my = ++seq;
      if (f.length < 3) { people.replaceChildren(); return; }
      const like = `%${f.replace(/[%_,()]/g, ' ')}%`;
      const { data } = await SB.from('outlook_member_contacts').select('org_id, email, full_name').or(`email.ilike.${like},full_name.ilike.${like}`).order('full_name').limit(50);
      if (my !== seq) return;
      people.replaceChildren(...(data && data.length ? [h('h3', {}, `People matching “${dq.trim()}”`), h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Organisation', 'Can register'].map(c => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, data.map(c => { const o = byId.get(c.org_id); return h('tr', {}, h('th', { scope: 'row' }, c.full_name || '(no name)'), h('td', {}, c.email || 'No valid email in Insightly'), h('td', {}, o ? o.name : ''), h('td', {}, !c.email ? 'No: needs an email' : o && o.status === 'current' ? 'Yes' : 'No: membership lapsed')); }))))] : []));
    };
    function orgRow(o) {
      const tr = h('tr', {});
      const btn = h('button', { type: 'button', class: 'act', 'aria-expanded': 'false', onclick: async () => {
        const nxt = tr.nextElementSibling;
        if (nxt && nxt.classList.contains('dir-contacts')) { nxt.remove(); btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Contacts'; return; }
        btn.disabled = true;
        const { data } = await SB.from('outlook_member_contacts').select('email, full_name').eq('org_id', o.org_id).order('full_name').limit(1000);
        btn.disabled = false; btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Hide';
        tr.after(h('tr', { class: 'dir-contacts' }, h('td', { colspan: '5' }, (data || []).length
          ? h('ul', { class: 'facts' }, data.map(c => h('li', {}, (c.full_name || '(no name)') + ' — ', c.email ? c.email : h('em', {}, 'no valid email, can’t register'))))
          : h('p', { class: 'gate-muted' }, 'No contacts linked to this organisation in Insightly.'))));
      } }, 'Contacts');
      const yr = o.last_membership_year >= 2050 ? 'Lifetime' : String(o.last_membership_year);
      tr.append(h('th', { scope: 'row' }, o.name), h('td', {}, o.status === 'current' ? 'Current' : 'Lapsed'), h('td', {}, yr), h('td', {}, `${o.contacts_with_email} of ${o.contacts}`), h('td', {}, btn));
      return tr;
    }
    let t;
    search.addEventListener('input', () => { dq = search.value; clearTimeout(t); t = setTimeout(draw, 250); });
    dirBox.replaceChildren(...head, h('div', { class: 'chips' }, search, sel), people,
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Organisation', 'Status', 'Last Membership Year', 'Contacts with email', ''].map(c => h('th', { scope: 'col' }, c)))), body)), more);
    draw();
  }
  directory();

  const reqBox = h('section', { class: 'panel' });
  main.append(reqBox);
  const LABEL = { approved_member: 'Approved: member contact', approved_list: 'Approved: already on list', approved_admin: 'Approved: portal admin', denied_not_found: 'Denied: email not in Insightly', denied_no_org: 'Denied: contact has no organisation', denied_lapsed: 'Denied: membership not current', rate_limited: 'Blocked: too many tries', error: 'Could not check' };
  let onlyDenied = false;
  async function requests() {
    const { data } = await SB.from('outlook_registrations').select('requested_at, email, result, organization').order('requested_at', { ascending: false }).limit(300);
    const rows = (data || []).filter(r => !onlyDenied || r.result.startsWith('denied'));
    const toggle = h('label', { class: 'gate-muted', style: 'display:flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', id: 'onlyDenied', checked: onlyDenied, onchange: e => { onlyDenied = e.target.checked; requests(); } }), 'Show only denied requests (people to follow up with)');
    reqBox.replaceChildren(h('h2', {}, 'Recent access requests'), toggle,
      rows.length ? h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Email', 'Result', 'Organisation'].map(c => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, rows.slice(0, 100).map(r => h('tr', {}, h('td', {}, new Date(r.requested_at).toLocaleString('en-CA')), h('th', { scope: 'row' }, r.email), h('td', {}, LABEL[r.result] || r.result), h('td', {}, r.organization)))))) : h('p', { class: 'gate-muted' }, 'No requests yet.'));
  }
  requests();
  let q = '';
  async function list() {
    const { data, error } = await SB.from('outlook_access').select('email, full_name, organization, added_at, source').order('organization').order('email').limit(10000);
    const usage = await SB.from('outlook_ai_log').select('id', { count: 'exact', head: true }).gte('asked_at', new Date(Date.now() - 30 * 864e5).toISOString());
    const nIns = data ? data.filter(r => r.source === 'insightly').length : 0;
    listBox.replaceChildren(h('h2', {}, `People with access (${data ? data.length : 0}: ${nIns} registered members, ${data ? data.length - nIns : 0} added by hand)`));
    if (usage.count != null) listBox.append(h('p', { class: 'gate-muted' }, `${usage.count} AI questions asked in the last 30 days.`));
    if (error) { listBox.append(h('p', {}, 'Could not load the list.')); return; }
    const search = h('input', { id: 'accessSearch', type: 'search', class: 'tsearch', placeholder: 'Find a person or company', value: q });
    const body = h('tbody', {});
    const draw = () => {
      const f = q.toLowerCase();
      const rows = data.filter(r => !f || (r.email + ' ' + r.full_name + ' ' + r.organization).toLowerCase().includes(f));
      body.replaceChildren(...rows.slice(0, 200).map(r => {
        let act;
        if (r.source === 'insightly') act = h('span', { class: 'gate-muted', title: 'Verified in Insightly; re-checked nightly' }, 'Member (Insightly)');
        else {
          act = h('button', { type: 'button', class: 'act', onclick: async () => {
            if (act.dataset.armed !== '1') { act.dataset.armed = '1'; act.textContent = 'Confirm remove'; return; }
            act.disabled = true;
            const { error: e2 } = await SB.from('outlook_access').delete().eq('email', r.email);
            if (e2) { act.disabled = false; toast('Could not remove ' + r.email); } else list();
          } }, 'Remove');
        }
        return h('tr', {}, h('th', { scope: 'row' }, r.email), h('td', {}, r.full_name), h('td', {}, r.organization), h('td', {}, new Date(r.added_at).toLocaleDateString('en-CA')), h('td', {}, act));
      }));
      more.textContent = rows.length > 200 ? `Showing 200 of ${rows.length}. Search to narrow the list.` : '';
    };
    const more = h('p', { class: 'gate-muted' });
    search.addEventListener('input', () => { q = search.value; draw(); });
    listBox.append(search, h('div', { class: 'tbl-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Email', 'Name', 'Organization', 'Added', ''].map(c => h('th', { scope: 'col' }, c)))), body)), more);
    draw();
  }
  list();
}

/* ---------- boot ---------- */
(async function boot() {
  const err = new URLSearchParams(location.hash.slice(1)).get('error_description');
  gate('loading', { msg: 'Checking your sign-in…' });
  SB.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) loadApp(session);
    if (event === 'SIGNED_OUT') { LOADED_FOR = null; gate('signin'); }
  });
  const { data: { session } } = await SB.auth.getSession();
  if (session) loadApp(session);
  else gate('signin', { error: err ? 'That sign-in link has expired or was already used. Request a new one.' : '' });
})();